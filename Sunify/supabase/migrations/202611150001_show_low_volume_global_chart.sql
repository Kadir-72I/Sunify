create or replace function public.get_sunify_global_top(result_limit integer default 10)
returns table(track_id text, title text, artist text, thumbnail text, play_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select p.track_id, p.title, p.artist, p.thumbnail, p.play_count
  from public.sunify_global_plays p
  where p.play_count >= 1
  order by p.play_count desc, p.updated_at desc
  limit least(greatest(coalesce(result_limit, 10), 1), 20);
$$;

revoke all on function public.get_sunify_global_top(integer) from public;
grant execute on function public.get_sunify_global_top(integer) to anon, authenticated;
