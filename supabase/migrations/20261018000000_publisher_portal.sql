create extension if not exists pgcrypto with schema extensions;

create table if not exists public.publisher_catalog_apps (
  app_id text primary key check (app_id ~ '^[a-z0-9][a-z0-9._-]{1,119}$'),
  name text not null,
  version text not null,
  author text not null,
  description text not null,
  categories text[] not null default '{}',
  icon text,
  file text not null,
  size text not null,
  screenshots jsonb not null default '[]'::jsonb,
  links jsonb not null default '{}'::jsonb,
  release_notes text not null,
  version_history jsonb not null default '[]'::jsonb,
  published_at timestamptz not null default now()
);

create table if not exists public.publisher_app_owners (
  app_id text primary key references public.publisher_catalog_apps(app_id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists publisher_app_owners_owner_id_idx
  on public.publisher_app_owners(owner_id);

create table if not exists public.publisher_submissions (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  app_id text not null check (app_id ~ '^[a-z0-9][a-z0-9._-]{1,119}$'),
  type text not null check (type in ('new', 'update')),
  version text not null,
  metadata jsonb not null,
  changelog text not null,
  package_path text not null,
  review_package_path text,
  status text not null default 'pending'
    check (status in ('pending', 'changes_requested', 'rejected', 'published', 'withdrawn')),
  review_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

alter table public.publisher_submissions
  add column if not exists review_package_path text;

create index if not exists publisher_submissions_owner_idx
  on public.publisher_submissions(owner_id, created_at desc);
create index if not exists publisher_submissions_review_idx
  on public.publisher_submissions(status, created_at)
  where status in ('pending', 'changes_requested');
create unique index if not exists publisher_one_active_submission_per_app_idx
  on public.publisher_submissions(app_id)
  where status in ('pending', 'changes_requested');

alter table public.publisher_catalog_apps enable row level security;
alter table public.publisher_app_owners enable row level security;
alter table public.publisher_submissions enable row level security;

grant select on public.publisher_catalog_apps to anon, authenticated;
grant select on public.publisher_app_owners, public.publisher_submissions to authenticated;

drop policy if exists "Published apps are publicly readable" on public.publisher_catalog_apps;
create policy "Published apps are publicly readable"
  on public.publisher_catalog_apps for select
  to anon, authenticated
  using (true);

drop policy if exists "Publishers can read their app ownership" on public.publisher_app_owners;
create policy "Publishers can read their app ownership"
  on public.publisher_app_owners for select
  to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists "Publishers can read their submissions" on public.publisher_submissions;
create policy "Publishers can read their submissions"
  on public.publisher_submissions for select
  to authenticated
  using (owner_id = (select auth.uid()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('publisher-submissions', 'publisher-submissions', false, 26214400, array['application/json', 'application/octet-stream']),
  ('published-packages', 'published-packages', true, 26214400, array['application/json', 'application/octet-stream'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Publishers upload only to their own submission folder" on storage.objects;
create policy "Publishers upload only to their own submission folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'publisher-submissions'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Publishers read only their own submission files" on storage.objects;
create policy "Publishers read only their own submission files"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'publisher-submissions'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Publishers remove only their own submission files" on storage.objects;
create policy "Publishers remove only their own submission files"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'publisher-submissions'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "Published packages are publicly readable" on storage.objects;
create policy "Published packages are publicly readable"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'published-packages');

create or replace function public.commit_publisher_publish(
  p_submission_id uuid,
  p_app jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_submission record;
  v_owner_id uuid;
begin
  select owner_id, app_id, type, status
    into v_submission
    from public.publisher_submissions
    where id = p_submission_id
    for update;

  if not found or v_submission.status not in ('pending', 'changes_requested') then
    raise exception 'Submission is no longer awaiting review';
  end if;
  if p_app->>'app_id' is distinct from v_submission.app_id then
    raise exception 'Published app ID does not match submission';
  end if;

  select owner_id
    into v_owner_id
    from public.publisher_app_owners
    where app_id = v_submission.app_id;

  if v_submission.type = 'new' and v_owner_id is not null then
    raise exception 'App ID is already owned';
  end if;
  if v_submission.type = 'update' and (v_owner_id is null or v_owner_id <> v_submission.owner_id) then
    raise exception 'Publisher does not own this app';
  end if;

  insert into public.publisher_catalog_apps
    select (jsonb_populate_record(null::public.publisher_catalog_apps, p_app)).*
    on conflict (app_id) do update set
      name = excluded.name,
      version = excluded.version,
      author = excluded.author,
      description = excluded.description,
      categories = excluded.categories,
      icon = excluded.icon,
      file = excluded.file,
      size = excluded.size,
      screenshots = excluded.screenshots,
      links = excluded.links,
      release_notes = excluded.release_notes,
      version_history = excluded.version_history,
      published_at = excluded.published_at;

  if v_submission.type = 'new' then
    insert into public.publisher_app_owners(app_id, owner_id)
      values (v_submission.app_id, v_submission.owner_id);
  end if;

  update public.publisher_submissions
    set status = 'published',
        reviewed_at = now(),
        review_note = null
    where id = p_submission_id;
end;
$$;

revoke all on function public.commit_publisher_publish(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.commit_publisher_publish(uuid, jsonb) to service_role;
