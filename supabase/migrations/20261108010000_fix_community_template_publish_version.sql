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
  select owner_id, template_id, type, version, status
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
