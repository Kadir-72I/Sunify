-- Keep an anonymous per-day aggregate so the shared Daily Mix chart does not
-- need to retain one database row for every play. The original table remains
-- the all-time chart.
create table if not exists public.sunify_daily_plays (
  play_date date not null,
  track_key text not null,
  track_id text not null default '',
  title text not null,
  artist text not null default '',
  thumbnail text not null default '',
  play_count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (play_date, track_key)
);

create index if not exists sunify_daily_plays_date_rank_idx
  on public.sunify_daily_plays (play_date, play_count desc, updated_at desc);

alter table public.sunify_daily_plays enable row level security;
revoke all on public.sunify_daily_plays from anon, authenticated;

create or replace function public.record_sunify_play(track_id text, track_title text, track_artist text, track_thumbnail text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_key text;
  local_play_date date;
begin
  if length(trim(coalesce(track_title, ''))) = 0 then
    raise exception 'track title is required';
  end if;
  normalized_key := lower(trim(coalesce(track_artist, ''))) || '|' || lower(trim(track_title));
  local_play_date := (now() at time zone 'Europe/Istanbul')::date;

  insert into public.sunify_global_plays (track_key, track_id, title, artist, thumbnail, play_count, updated_at)
  values (normalized_key, left(coalesce(track_id, ''), 200), left(trim(track_title), 300), left(coalesce(track_artist, ''), 300), left(coalesce(track_thumbnail, ''), 1000), 1, now())
  on conflict (track_key) do update set
    track_id = case when excluded.track_id <> '' then excluded.track_id else sunify_global_plays.track_id end,
    title = excluded.title,
    artist = excluded.artist,
    thumbnail = case when excluded.thumbnail <> '' then excluded.thumbnail else sunify_global_plays.thumbnail end,
    play_count = sunify_global_plays.play_count + 1,
    updated_at = now();

  insert into public.sunify_daily_plays (play_date, track_key, track_id, title, artist, thumbnail, play_count, updated_at)
  values (local_play_date, normalized_key, left(coalesce(track_id, ''), 200), left(trim(track_title), 300), left(coalesce(track_artist, ''), 300), left(coalesce(track_thumbnail, ''), 1000), 1, now())
  on conflict (play_date, track_key) do update set
    track_id = case when excluded.track_id <> '' then excluded.track_id else sunify_daily_plays.track_id end,
    title = excluded.title,
    artist = excluded.artist,
    thumbnail = case when excluded.thumbnail <> '' then excluded.thumbnail else sunify_daily_plays.thumbnail end,
    play_count = sunify_daily_plays.play_count + 1,
    updated_at = now();
end;
$$;

create or replace function public.get_sunify_daily_top(result_limit integer default 25)
returns table(track_id text, title text, artist text, thumbnail text, play_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select p.track_id, p.title, p.artist, p.thumbnail, p.play_count
  from public.sunify_daily_plays p
  where p.play_date = (now() at time zone 'Europe/Istanbul')::date
  order by p.play_count desc, p.updated_at desc
  limit least(greatest(coalesce(result_limit, 25), 1), 25);
$$;

revoke all on function public.record_sunify_play(text, text, text, text) from public;
revoke all on function public.get_sunify_daily_top(integer) from public;
grant execute on function public.record_sunify_play(text, text, text, text) to anon, authenticated;
grant execute on function public.get_sunify_daily_top(integer) to anon, authenticated;
