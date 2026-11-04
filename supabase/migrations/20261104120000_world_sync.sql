-- MundusMaker in the browser: each GM's worlds, kept in their account
-- (docs/website.md, "The app in the browser").
--
-- The app runs in the GM's browser and keeps its files there (web/memfs.js,
-- web/store.js). What travels between their browsers is each world's
-- world.json, entries and pictures (web/sync.js): one row per file here, and
-- the bytes as objects in the private "sync" bucket, named by their SHA-256.
-- A change names the revision it was based on, and sync_commit refuses it if
-- the file moved on since, so two browsers never silently overwrite each
-- other. Revisions grow per GM in commit order (sync_heads is locked for the
-- whole commit), so a browser that has seen revision N has seen everything
-- before it.

-- Everything the app and the policies below need to agree on (web/sync.js LIMITS).
create function public.sync_limits() returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('bytes', 100 * 1024 * 1024, 'fileBytes', 20 * 1024 * 1024, 'files', 20000)
$$;

-- The files that travel: a world's world.json, entries and pictures. Never
-- history, exports or anything whose name starts with a dot (web/sync.js PATH_RE).
-- Postgres allows repeat counts up to 255, so the whole length is checked apart.
create function public.sync_path_ok(p text) returns boolean
language sql immutable set search_path = '' as $$
  select char_length(p) <= 450
    and p ~ '^worlds/[a-z0-9][a-z0-9-]{0,127}/(?:world\.json|entities/[^/.][^/]*\.json|assets/[^/.][^/]*)$'
$$;

create table public.sync_files (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  path text not null check (public.sync_path_ok(path)),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint not null default 0 check (size >= 0),
  deleted boolean not null default false,
  rev bigint not null check (rev > 0),
  device text not null default '' check (char_length(device) <= 120),
  updated_at timestamptz not null default now(),
  primary key (owner, path),
  check (deleted or sha256 is not null)
);
create index sync_files_by_rev on public.sync_files (owner, rev);
alter table public.sync_files enable row level security;
-- changes go through sync_commit only
create policy "GMs read their own files" on public.sync_files
  for select to authenticated using (owner = (select auth.uid()));

create table public.sync_heads (
  owner uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  rev bigint not null default 0
);
alter table public.sync_heads enable row level security;
create policy "GMs read their own head" on public.sync_heads
  for select to authenticated using (owner = (select auth.uid()));

-- Private: only the GM who stored an object can read it. Objects are named
-- "<user id>/<sha256>" and never change, so there is no update policy.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sync', 'sync', false, 20971520, array['application/octet-stream'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create function public.sync_object_ok(name text) returns boolean
language sql stable set search_path = '' as $$
  select name ~ '^[0-9a-f-]{36}/[0-9a-f]{64}$' and split_part(name, '/', 1) = (select auth.uid())::text
$$;

-- Bytes the signed-in GM has in the sync bucket.
create function public.sync_bytes_stored() returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint
  from storage.objects o
  where o.bucket_id = 'sync' and split_part(o.name, '/', 1) = auth.uid()::text
$$;

-- Uploads are checked against what is already stored, so a GM can go over
-- the allowance by at most one file (as with player wikis).
create policy "GMs store their own world files" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'sync' and public.sync_object_ok(name)
    and public.sync_bytes_stored() < (public.sync_limits() ->> 'bytes')::bigint);
create policy "GMs read their own world files" on storage.objects
  for select to authenticated using (bucket_id = 'sync' and split_part(name, '/', 1) = (select auth.uid())::text);
create policy "GMs remove their own world files" on storage.objects
  for delete to authenticated using (bucket_id = 'sync' and split_part(name, '/', 1) = (select auth.uid())::text);

-- Apply a batch of changes: [{ path, sha256 (null = deleted), size, base }],
-- where base is the revision the browser last saw for that path (0 = none).
-- Each answer is { path, rev } when kept, { path, conflict, rev } when the
-- file moved on since base, { path, missing } when its bytes were never
-- stored, or { path, refused } for a path, file or allowance the account
-- does not take. The GM's head row stays locked until the commit ends.
create function public.sync_commit(changes jsonb, device text default '') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  lim jsonb := public.sync_limits();
  head bigint;
  live integer;
  item jsonb;
  p text;
  sha text;
  sz bigint;
  base bigint;
  cur_rev bigint;
  cur_deleted boolean;
  results jsonb := '[]'::jsonb;
  label text := left(coalesce(device, ''), 120);
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if jsonb_typeof(changes) is distinct from 'array' or jsonb_array_length(changes) > 500 then
    raise exception 'changes must be a list of at most 500' using errcode = '22023';
  end if;
  insert into public.sync_heads (owner) values (me) on conflict (owner) do nothing;
  select h.rev into head from public.sync_heads h where h.owner = me for update;
  select count(*)::int into live from public.sync_files f where f.owner = me and not f.deleted;

  for item in select value from jsonb_array_elements(changes) loop
    p := item ->> 'path';
    sha := nullif(item ->> 'sha256', '');
    sz := coalesce((item ->> 'size')::bigint, 0);
    base := coalesce((item ->> 'base')::bigint, 0);
    if p is null or not public.sync_path_ok(p) then
      results := results || jsonb_build_object('path', p, 'refused', 'path');
      continue;
    end if;
    if sha is not null and (sha !~ '^[0-9a-f]{64}$' or sz < 0 or sz > (lim ->> 'fileBytes')::bigint) then
      results := results || jsonb_build_object('path', p, 'refused', 'file');
      continue;
    end if;
    cur_rev := null;
    cur_deleted := null;
    select f.rev, f.deleted into cur_rev, cur_deleted from public.sync_files f where f.owner = me and f.path = p for update;
    if coalesce(cur_rev, 0) <> base then
      results := results || jsonb_build_object('path', p, 'conflict', true, 'rev', coalesce(cur_rev, 0));
      continue;
    end if;
    if sha is null then
      if cur_rev is not null and not cur_deleted then
        head := head + 1;
        update public.sync_files set deleted = true, sha256 = null, size = 0, rev = head, device = label, updated_at = now()
        where owner = me and path = p;
        live := live - 1;
        results := results || jsonb_build_object('path', p, 'rev', head);
      else
        results := results || jsonb_build_object('path', p, 'rev', coalesce(cur_rev, 0));
      end if;
      continue;
    end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'sync' and o.name = me::text || '/' || sha) then
      results := results || jsonb_build_object('path', p, 'missing', true);
      continue;
    end if;
    if (cur_rev is null or cur_deleted) and live >= (lim ->> 'files')::int then
      results := results || jsonb_build_object('path', p, 'refused', 'full');
      continue;
    end if;
    head := head + 1;
    insert into public.sync_files (owner, path, sha256, size, deleted, rev, device, updated_at)
    values (me, p, sha, sz, false, head, label, now())
    on conflict (owner, path) do update set sha256 = excluded.sha256, size = excluded.size, deleted = false,
      rev = excluded.rev, device = excluded.device, updated_at = excluded.updated_at;
    if cur_rev is null or cur_deleted then live := live + 1; end if;
    results := results || jsonb_build_object('path', p, 'rev', head);
  end loop;

  update public.sync_heads set rev = head where owner = me;
  return jsonb_build_object('rev', head, 'results', results);
end
$$;

-- What the GM uses, for Settings.
create function public.sync_usage() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'bytes', public.sync_bytes_stored(),
    'files', (select count(*) from public.sync_files f where f.owner = auth.uid() and not f.deleted),
    'limits', public.sync_limits())
$$;

-- Objects no file uses any more (old versions, deleted pictures), a day after
-- they were stored, so a browser still sending a change never loses its upload.
-- The browser removes them through the Storage API, which also frees the bytes.
create function public.sync_orphans() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(o.sha), '{}')
  from (
    select split_part(s.name, '/', 2) as sha
    from storage.objects s
    where s.bucket_id = 'sync' and split_part(s.name, '/', 1) = auth.uid()::text
      and s.created_at < now() - interval '1 day'
      and not exists (select 1 from public.sync_files f
        where f.owner = auth.uid() and not f.deleted and f.sha256 = split_part(s.name, '/', 2))
    limit 1000
  ) o
$$;

revoke execute on function public.sync_bytes_stored() from public, anon;
revoke execute on function public.sync_commit(jsonb, text) from public, anon;
revoke execute on function public.sync_usage() from public, anon;
revoke execute on function public.sync_orphans() from public, anon;
grant execute on function public.sync_bytes_stored() to authenticated;
grant execute on function public.sync_commit(jsonb, text) to authenticated;
grant execute on function public.sync_usage() to authenticated;
grant execute on function public.sync_orphans() to authenticated;
