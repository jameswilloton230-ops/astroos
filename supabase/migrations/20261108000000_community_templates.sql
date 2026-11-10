create table if not exists public.publisher_catalog_templates (
  template_id text primary key check (template_id ~ '^[a-z0-9][a-z0-9.-]{2,127}$'),
  name text not null,
  version text not null,
  author text not null,
  description text not null,
  category text not null,
  file text not null,
  size bigint not null check (size > 0),
  published_at timestamptz not null default now()
);

create table if not exists public.publisher_template_owners (
  template_id text primary key references public.publisher_catalog_templates(template_id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.publisher_template_submissions (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  template_id text not null check (template_id ~ '^[a-z0-9][a-z0-9.-]{2,127}$'),
  type text not null check (type in ('new', 'update')),
  version text not null,
  metadata jsonb not null,
  package_path text not null,
  review_package_path text,
  status text not null default 'pending'
    check (status in ('pending', 'changes_requested', 'rejected', 'published', 'withdrawn')),
  review_note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists publisher_template_owners_owner_idx
  on public.publisher_template_owners(owner_id);
create index if not exists publisher_template_submissions_owner_idx
  on public.publisher_template_submissions(owner_id, created_at desc);
create index if not exists publisher_template_submissions_review_idx
  on public.publisher_template_submissions(status, created_at)
  where status in ('pending', 'changes_requested');
create unique index if not exists publisher_one_active_template_submission_idx
  on public.publisher_template_submissions(template_id)
  where status in ('pending', 'changes_requested');

alter table public.publisher_catalog_templates enable row level security;
alter table public.publisher_template_owners enable row level security;
alter table public.publisher_template_submissions enable row level security;

grant select on public.publisher_catalog_templates to anon, authenticated;
grant select on public.publisher_template_owners, public.publisher_template_submissions to authenticated;

drop policy if exists "Published Studio templates are publicly readable" on public.publisher_catalog_templates;
create policy "Published Studio templates are publicly readable"
  on public.publisher_catalog_templates for select
  to anon, authenticated
  using (true);

drop policy if exists "Publishers can read their Studio template ownership" on public.publisher_template_owners;
create policy "Publishers can read their Studio template ownership"
  on public.publisher_template_owners for select
  to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists "Publishers can read their Studio template submissions" on public.publisher_template_submissions;
create policy "Publishers can read their Studio template submissions"
  on public.publisher_template_submissions for select
  to authenticated
  using (owner_id = (select auth.uid()));

create or replace function public.commit_publisher_template_publish(
  p_submission_id uuid,
  p_template jsonb
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
  select owner_id, template_id, type, status
    into v_submission
    from public.publisher_template_submissions
    where id = p_submission_id
    for update;

  if not found or v_submission.status not in ('pending', 'changes_requested') then
    raise exception 'Community template submission is no longer awaiting review';
  end if;
  if p_template->>'template_id' is distinct from v_submission.template_id
    or p_template->>'version' is distinct from v_submission.version then
    raise exception 'Published community template identity does not match submission';
  end if;

  select owner_id
    into v_owner_id
    from public.publisher_template_owners
    where template_id = v_submission.template_id;

  if v_submission.type = 'new' and v_owner_id is not null then
    raise exception 'Community template ID is already owned';
  end if;
  if v_submission.type = 'new'
    and exists (
      select 1
        from public.publisher_catalog_templates
        where template_id = v_submission.template_id
    ) then
    raise exception 'Community template ID is already published';
  end if;
  if v_submission.type = 'update' and (v_owner_id is null or v_owner_id <> v_submission.owner_id) then
    raise exception 'Publisher does not own this community template';
  end if;

  insert into public.publisher_catalog_templates
    select (jsonb_populate_record(null::public.publisher_catalog_templates, p_template)).*
    on conflict (template_id) do update set
      name = excluded.name,
      version = excluded.version,
      author = excluded.author,
      description = excluded.description,
      category = excluded.category,
      file = excluded.file,
      size = excluded.size,
      published_at = excluded.published_at;

  if v_submission.type = 'new' then
    insert into public.publisher_template_owners(template_id, owner_id)
      values (v_submission.template_id, v_submission.owner_id);
  end if;

  update public.publisher_template_submissions
    set status = 'published',
        reviewed_at = now(),
        review_note = null
    where id = p_submission_id;
end;
$$;

revoke all on function public.commit_publisher_template_publish(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.commit_publisher_template_publish(uuid, jsonb) to service_role;
