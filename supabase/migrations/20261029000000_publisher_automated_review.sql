alter table public.publisher_submissions
  add column if not exists automated_review jsonb;

alter table public.publisher_submissions
  drop constraint if exists publisher_submissions_status_check;

alter table public.publisher_submissions
  add constraint publisher_submissions_status_check
  check (status in (
    'pending',
    'changes_requested',
    'rejected',
    'automated_rejected',
    'published',
    'withdrawn'
  ));
