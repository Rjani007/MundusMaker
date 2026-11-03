-- Player wikis on the MundusMaker website (docs/website.md).
--
-- A GM signs in on the website and uploads the ZIP that MundusMaker's
-- Export player wiki makes. Its files go to the public "wikis" bucket under a
-- random 12-character id, and players read them through the website's viewer
-- without an account. Only the player edition is ever uploaded, and the
-- desktop app never talks to Supabase.
--
-- The free plan's 1 GB of file storage is shared with every other project in
-- the organization, so each GM gets a small allowance (public.wiki_limits).

create table public.wikis (
  id text primary key check (id ~ '^[a-z0-9]{12}$'),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default '' check (char_length(title) <= 200),
  pages integer not null default 0 check (pages between 0 and 100000),
  images integer not null default 0 check (images between 0 and 100000),
  bytes bigint not null default 0 check (bytes >= 0),
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index wikis_owner on public.wikis (owner);
alter table public.wikis enable row level security;

-- Everything the website and the policies below need to agree on.
create function public.wiki_limits() returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('wikis', 3, 'bytes', 20 * 1024 * 1024, 'fileBytes', 3 * 1024 * 1024)
$$;

-- The file names a MundusMaker player wiki has. Anything else is refused, so
-- the bucket can't host other pages.
create function public.wiki_file_name_ok(name text) returns boolean
language sql immutable set search_path = '' as $$
  select name ~ '^[a-z0-9]{12}/((index|timeline|maps|handouts|entry-[0-9]{1,6}|category-[0-9]{2,4})\.html|assets/(wiki\.css|search-index\.js)|images/[0-9a-f]{24}\.(png|jpg|webp))$'
$$;

-- Security definer, so storage policies can look at wikis without the
-- table's own policies getting in the way.
create function public.owns_wiki(wiki text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.wikis w where w.id = wiki and w.owner = auth.uid())
$$;

-- How many wikis the signed-in GM has. A policy on wikis can't count wikis
-- itself (Postgres calls that recursion), so it asks this instead.
create function public.my_wiki_count() returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.wikis w where w.owner = auth.uid()
$$;

-- Bytes the signed-in GM has stored across their wikis.
create function public.wiki_bytes_used() returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint
  from storage.objects o
  join public.wikis w on w.id = split_part(o.name, '/', 1)
  where o.bucket_id = 'wikis' and w.owner = auth.uid()
$$;

revoke execute on function public.owns_wiki(text) from public, anon;
revoke execute on function public.my_wiki_count() from public, anon;
revoke execute on function public.wiki_bytes_used() from public, anon;
grant execute on function public.owns_wiki(text) to authenticated;
grant execute on function public.my_wiki_count() to authenticated;
grant execute on function public.wiki_bytes_used() to authenticated;

create policy "GMs see their own wikis" on public.wikis
  for select to authenticated using (owner = (select auth.uid()));
create policy "GMs add wikis, up to their limit" on public.wikis
  for insert to authenticated with check (
    owner = (select auth.uid()) and public.my_wiki_count() < (public.wiki_limits() ->> 'wikis')::int);
create policy "GMs update their own wikis" on public.wikis
  for update to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy "GMs remove their own wikis" on public.wikis
  for delete to authenticated using (owner = (select auth.uid()));

-- Public, because players read without signing in. Nobody can list it
-- (there is no select policy for anon), and an id can't be guessed.
-- Pages and the search index are stored as text/plain: the viewer reads them
-- as text, and a page opened straight from storage shows as text, not a site.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('wikis', 'wikis', true, 3145728, array['text/plain', 'text/css', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Uploads are checked against what is already stored, so a GM can go over
-- the allowance by at most one file.
create policy "GMs upload into their own wikis" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'wikis' and public.wiki_file_name_ok(name) and public.owns_wiki(split_part(name, '/', 1))
    and public.wiki_bytes_used() < (public.wiki_limits() ->> 'bytes')::bigint);
create policy "GMs replace files in their own wikis" on storage.objects
  for update to authenticated
  using (bucket_id = 'wikis' and public.owns_wiki(split_part(name, '/', 1)))
  with check (
    bucket_id = 'wikis' and public.wiki_file_name_ok(name) and public.owns_wiki(split_part(name, '/', 1))
    and public.wiki_bytes_used() < (public.wiki_limits() ->> 'bytes')::bigint);
create policy "GMs list their own wiki files" on storage.objects
  for select to authenticated using (bucket_id = 'wikis' and public.owns_wiki(split_part(name, '/', 1)));
create policy "GMs remove files from their own wikis" on storage.objects
  for delete to authenticated using (bucket_id = 'wikis' and public.owns_wiki(split_part(name, '/', 1)));
