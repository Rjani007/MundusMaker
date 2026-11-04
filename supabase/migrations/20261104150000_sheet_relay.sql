-- The publisher-sheet relay's daily allowance (docs/website.md).
--
-- The sheet-download Edge Function fetches a publisher's free character sheet
-- for a signed-in GM using the app in the browser, whose own fetch the
-- publishers' servers refuse. It asks sheet_relay_allow first, with the GM's
-- own sign-in, so it serves only signed-in GMs and at most 20 sheets a day
-- each: there are three sheets to fetch, and every download uses the
-- project's shared allowance of outgoing traffic.

create table public.sheet_relay_log (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  at timestamptz not null default now()
);
create index sheet_relay_log_by_owner on public.sheet_relay_log (owner, at);
alter table public.sheet_relay_log enable row level security;
-- no policies: only sheet_relay_allow reads or writes it

create function public.sheet_relay_allow() returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  used integer;
begin
  if me is null then return false; end if;
  delete from public.sheet_relay_log where owner = me and at < now() - interval '1 day';
  select count(*)::int into used from public.sheet_relay_log where owner = me;
  if used >= 20 then return false; end if;
  insert into public.sheet_relay_log (owner) values (me);
  return true;
end
$$;

revoke execute on function public.sheet_relay_allow() from public, anon;
grant execute on function public.sheet_relay_allow() to authenticated;
