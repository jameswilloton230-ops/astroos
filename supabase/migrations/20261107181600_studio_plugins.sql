create table if not exists public.publisher_catalog_plugins (
  plugin_id text primary key check (plugin_id ~ '^[a-z0-9][a-z0-9.-]{2,127}$'),
  name text not null,
  version text not null,
  publisher text not null,
  description text not null,
  compatible_studio text not null,
  file text not null,
  size bigint not null check (size > 0),
  release_notes text not null,
  published_at timestamptz not null default now()
);

create table if not exists public.publisher_plugin_owners (
  plugin_id text primary key references public.publisher_catalog_plugins(plugin_id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.publisher_plugin_submissions (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  plugin_id text not null check (plugin_id ~ '^[a-z0-9][a-z0-9.-]{2,127}$'),
  type text not null check (type in ('new', 'update')),
  version text not null,
  metadata jsonb not null,
  changelog text not null,
  package_path text not null,
  review_package_path text,
  status text not null default 'pending'
    check (status in ('pending', 'changes_requested', 'rejected', 'published', 'withdrawn')),
  review_note text,
  safety_rating integer check (safety_rating between 1 and 100),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists publisher_plugin_owners_owner_idx
  on public.publisher_plugin_owners(owner_id);
create index if not exists publisher_plugin_submissions_owner_idx
  on public.publisher_plugin_submissions(owner_id, created_at desc);
create index if not exists publisher_plugin_submissions_review_idx
  on public.publisher_plugin_submissions(status, created_at)
  where status in ('pending', 'changes_requested');
create unique index if not exists publisher_one_active_plugin_submission_idx
  on public.publisher_plugin_submissions(plugin_id)
  where status in ('pending', 'changes_requested');

alter table public.publisher_catalog_plugins enable row level security;
alter table public.publisher_plugin_owners enable row level security;
alter table public.publisher_plugin_submissions enable row level security;

grant select on public.publisher_catalog_plugins to anon, authenticated;
grant select on public.publisher_plugin_owners, public.publisher_plugin_submissions to authenticated;

drop policy if exists "Published Studio plugins are publicly readable" on public.publisher_catalog_plugins;
create policy "Published Studio plugins are publicly readable"
  on public.publisher_catalog_plugins for select
  to anon, authenticated
  using (true);

drop policy if exists "Publishers can read their Studio plugin ownership" on public.publisher_plugin_owners;
create policy "Publishers can read their Studio plugin ownership"
  on public.publisher_plugin_owners for select
  to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists "Publishers can read their Studio plugin submissions" on public.publisher_plugin_submissions;
create policy "Publishers can read their Studio plugin submissions"
  on public.publisher_plugin_submissions for select
  to authenticated
  using (owner_id = (select auth.uid()));

create or replace function public.commit_publisher_plugin_publish(
  p_submission_id uuid,
  p_plugin jsonb
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
  select owner_id, plugin_id, type, status
    into v_submission
    from public.publisher_plugin_submissions
    where id = p_submission_id
    for update;

  if not found or v_submission.status not in ('pending', 'changes_requested') then
    raise exception 'Studio plugin submission is no longer awaiting review';
  end if;
  if p_plugin->>'plugin_id' is distinct from v_submission.plugin_id then
    raise exception 'Published Studio plugin ID does not match submission';
  end if;

  select owner_id
    into v_owner_id
    from public.publisher_plugin_owners
    where plugin_id = v_submission.plugin_id;

  if v_submission.type = 'new' and v_owner_id is not null then
    raise exception 'Studio plugin ID is already owned';
  end if;
  if v_submission.type = 'update' and (v_owner_id is null or v_owner_id <> v_submission.owner_id) then
    raise exception 'Publisher does not own this Studio plugin';
  end if;

  insert into public.publisher_catalog_plugins
    select (jsonb_populate_record(null::public.publisher_catalog_plugins, p_plugin)).*
    on conflict (plugin_id) do update set
      name = excluded.name,
      version = excluded.version,
      publisher = excluded.publisher,
      description = excluded.description,
      compatible_studio = excluded.compatible_studio,
      file = excluded.file,
      size = excluded.size,
      release_notes = excluded.release_notes,
      published_at = excluded.published_at;

  if v_submission.type = 'new' then
    insert into public.publisher_plugin_owners(plugin_id, owner_id)
      values (v_submission.plugin_id, v_submission.owner_id);
  end if;

  update public.publisher_plugin_submissions
    set status = 'published',
        reviewed_at = now(),
        review_note = null
    where id = p_submission_id;
end;
$$;

revoke all on function public.commit_publisher_plugin_publish(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.commit_publisher_plugin_publish(uuid, jsonb) to service_role;
