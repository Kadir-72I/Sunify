-- Per-account cloud schema and an atomic full snapshot sync.
-- RLS policies are owner-only; the sync RPC runs with caller privileges so
-- auth.uid() and those policies remain in force.

create table if not exists public.user_playlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text,
  name text not null,
  cover_url text not null default '',
  tracks jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.user_playlists
  add column if not exists client_id text;
alter table public.user_playlists
  add column if not exists cover_url text not null default '';
alter table public.user_playlists
  add column if not exists tracks jsonb not null default '[]'::jsonb;
alter table public.user_playlists
  add column if not exists created_at timestamptz not null default now();

create unique index if not exists user_playlists_owner_client_id_uidx
  on public.user_playlists (user_id, client_id)
  where client_id is not null;
create index if not exists user_playlists_owner_idx
  on public.user_playlists (user_id);

create table if not exists public.user_analytics (
  user_id uuid primary key references auth.users(id) on delete cascade,
  liked_tracks jsonb not null default '[]'::jsonb,
  listening_stats jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_analytics
  add column if not exists liked_tracks jsonb not null default '[]'::jsonb;
alter table public.user_analytics
  add column if not exists listening_stats jsonb not null default '{}'::jsonb;
alter table public.user_analytics
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists user_analytics_owner_uidx
  on public.user_analytics (user_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_playlists_user_id_auth_fkey') then
    alter table public.user_playlists
      add constraint user_playlists_user_id_auth_fkey
      foreign key (user_id) references auth.users(id) on delete cascade not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_analytics_user_id_auth_fkey') then
    alter table public.user_analytics
      add constraint user_analytics_user_id_auth_fkey
      foreign key (user_id) references auth.users(id) on delete cascade not valid;
  end if;
end;
$$;

alter table public.user_playlists enable row level security;
alter table public.user_analytics enable row level security;

revoke all on public.user_playlists from anon;
revoke all on public.user_analytics from anon;
grant select, insert, update, delete on public.user_playlists to authenticated;
grant select, insert, update, delete on public.user_analytics to authenticated;

-- Remove any older broad policies too: permissive policies are OR-combined.
do $$
declare policy_row record;
begin
  for policy_row in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public' and tablename in ('user_playlists', 'user_analytics')
  loop
    execute format('drop policy %I on %I.%I', policy_row.policyname, policy_row.schemaname, policy_row.tablename);
  end loop;
end;
$$;

create policy sunify_playlists_select_own on public.user_playlists
  for select to authenticated using (user_id = (select auth.uid()));
create policy sunify_playlists_insert_own on public.user_playlists
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy sunify_playlists_update_own on public.user_playlists
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy sunify_playlists_delete_own on public.user_playlists
  for delete to authenticated using (user_id = (select auth.uid()));

create policy sunify_analytics_select_own on public.user_analytics
  for select to authenticated using (user_id = (select auth.uid()));
create policy sunify_analytics_insert_own on public.user_analytics
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy sunify_analytics_update_own on public.user_analytics
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy sunify_analytics_delete_own on public.user_analytics
  for delete to authenticated using (user_id = (select auth.uid()));

create or replace function public.sync_sunify_account_data(
  p_playlists jsonb,
  p_liked_tracks jsonb,
  p_listening_stats jsonb
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  incoming_ids text[];
  playlist_row record;
  playlist_client_id text;
begin
  if owner_id is null then raise exception 'authenticated user required'; end if;
  if coalesce(jsonb_typeof(p_playlists), 'null') <> 'array'
    or coalesce(jsonb_typeof(p_liked_tracks), 'null') <> 'array'
    or coalesce(jsonb_typeof(p_listening_stats), 'null') <> 'object' then
    raise exception 'invalid account data payload';
  end if;

  select coalesce(array_agg(
    coalesce(nullif(btrim(item.value->>'id'), ''), 'generated_' || md5(item.value::text || ':' || item.ordinality::text))
  ), array[]::text[])
  into incoming_ids
  from jsonb_array_elements(p_playlists) with ordinality as item(value, ordinality);

  delete from public.user_playlists p
  where p.user_id = owner_id
    and (p.client_id is null or not (p.client_id = any(incoming_ids)));

  for playlist_row in
    select item.value, item.ordinality
    from jsonb_array_elements(p_playlists) with ordinality as item(value, ordinality)
  loop
    if jsonb_typeof(playlist_row.value) <> 'object'
      or length(btrim(coalesce(playlist_row.value->>'name', ''))) = 0 then
      raise exception 'invalid playlist entry';
    end if;
    if playlist_row.value ? 'tracks' and jsonb_typeof(playlist_row.value->'tracks') <> 'array' then
      raise exception 'invalid playlist tracks';
    end if;
    playlist_client_id := coalesce(
      nullif(btrim(playlist_row.value->>'id'), ''),
      'generated_' || md5(playlist_row.value::text || ':' || playlist_row.ordinality::text)
    );

    insert into public.user_playlists (user_id, client_id, name, cover_url, tracks, created_at)
    values (
      owner_id,
      playlist_client_id,
      left(btrim(playlist_row.value->>'name'), 200),
      left(coalesce(playlist_row.value->>'cover', playlist_row.value->>'cover_url', ''), 2000),
      coalesce(playlist_row.value->'tracks', '[]'::jsonb),
      coalesce(nullif(playlist_row.value->>'created_at', '')::timestamptz, now())
    )
    on conflict (user_id, client_id) where client_id is not null
    do update set
      name = excluded.name,
      cover_url = excluded.cover_url,
      tracks = excluded.tracks,
      created_at = excluded.created_at;
  end loop;

  insert into public.user_analytics (user_id, liked_tracks, listening_stats, updated_at)
  values (owner_id, p_liked_tracks, p_listening_stats, now())
  on conflict (user_id) do update set
    liked_tracks = excluded.liked_tracks,
    listening_stats = excluded.listening_stats,
    updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.sync_sunify_account_data(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.sync_sunify_account_data(jsonb, jsonb, jsonb) to authenticated;
