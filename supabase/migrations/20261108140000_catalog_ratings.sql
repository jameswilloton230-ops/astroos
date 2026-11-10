create table if not exists public.publisher_catalog_ratings (
  id bigint generated always as identity primary key,
  catalog_type text not null check (catalog_type in ('apps', 'plugins', 'templates')),
  item_id text not null check (length(btrim(item_id)) between 1 and 160),
  user_id uuid not null references auth.users(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  review text not null default '' check (char_length(review) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (catalog_type, item_id, user_id)
);

create index if not exists publisher_catalog_ratings_item_idx
  on public.publisher_catalog_ratings(catalog_type, item_id, created_at desc);

alter table public.publisher_catalog_ratings enable row level security;

grant select on public.publisher_catalog_ratings to authenticated;

drop policy if exists "Users can read their own catalog ratings"
  on public.publisher_catalog_ratings;
create policy "Users can read their own catalog ratings"
  on public.publisher_catalog_ratings for select
  to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.get_catalog_rating_summaries(
  p_catalog_type text,
  p_item_ids text[]
)
returns table(item_id text, average_rating numeric, rating_count bigint)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if p_catalog_type is null or p_catalog_type not in ('apps', 'plugins', 'templates') then
    raise exception 'Unsupported catalog type';
  end if;
  if coalesce(cardinality(p_item_ids), 0) > 1000 then
    raise exception 'Too many catalog items requested';
  end if;

  return query
    select ratings.item_id, round(avg(ratings.rating)::numeric, 1), count(*)
    from public.publisher_catalog_ratings as ratings
    where ratings.catalog_type = p_catalog_type
      and ratings.item_id = any(coalesce(p_item_ids, array[]::text[]))
    group by ratings.item_id;
end;
$function$;

create or replace function public.get_catalog_rating_reviews(
  p_catalog_type text,
  p_item_id text
)
returns table(rating smallint, review text, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $function$
  select ratings.rating, ratings.review, ratings.created_at
  from public.publisher_catalog_ratings as ratings
  where ratings.catalog_type = p_catalog_type
    and ratings.item_id = p_item_id
    and ratings.review <> ''
  order by ratings.created_at desc
  limit 50;
$function$;

create or replace function public.submit_catalog_rating(
  p_catalog_type text,
  p_item_id text,
  p_rating smallint,
  p_review text default ''
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_review text := btrim(coalesce(p_review, ''));
begin
  if auth.uid() is null or not exists (
    select 1
    from auth.users as users
    where users.id = auth.uid()
      and users.email_confirmed_at is not null
  ) then
    raise exception 'Sign in with a verified email to rate catalog items.'
      using errcode = '42501';
  end if;
  if p_catalog_type is null or p_catalog_type not in ('apps', 'plugins', 'templates') then
    raise exception 'Unsupported catalog type';
  end if;
  if p_item_id is null or length(btrim(p_item_id)) not between 1 and 160 then
    raise exception 'Invalid catalog item';
  end if;
  if p_catalog_type = 'apps' and btrim(p_item_id) !~ '^[a-z0-9][a-z0-9._-]{1,119}$' then
    raise exception 'Invalid app ID';
  elsif p_catalog_type = 'plugins' and not exists (
    select 1 from public.publisher_catalog_plugins as catalog
    where catalog.plugin_id = btrim(p_item_id)
  ) then
    raise exception 'Catalog item is not published';
  elsif p_catalog_type = 'templates' and not exists (
    select 1 from public.publisher_catalog_templates as catalog
    where catalog.template_id = btrim(p_item_id)
  ) then
    raise exception 'Catalog item is not published';
  end if;
  if p_rating not between 1 and 5 then
    raise exception 'Rating must be between 1 and 5';
  end if;
  if char_length(normalized_review) > 1000 then
    raise exception 'Reviews must be 1000 characters or fewer';
  end if;

  insert into public.publisher_catalog_ratings (
    catalog_type, item_id, user_id, rating, review
  )
  values (
    p_catalog_type, btrim(p_item_id), auth.uid(), p_rating, normalized_review
  )
  on conflict (catalog_type, item_id, user_id)
  do update set
    rating = excluded.rating,
    review = excluded.review,
    updated_at = now();
end;
$function$;

revoke all on function public.get_catalog_rating_summaries(text, text[]) from public;
revoke all on function public.get_catalog_rating_reviews(text, text) from public;
revoke all on function public.submit_catalog_rating(text, text, smallint, text) from public;
grant execute on function public.get_catalog_rating_summaries(text, text[]) to anon, authenticated;
grant execute on function public.get_catalog_rating_reviews(text, text) to anon, authenticated;
grant execute on function public.submit_catalog_rating(text, text, smallint, text) to authenticated;
