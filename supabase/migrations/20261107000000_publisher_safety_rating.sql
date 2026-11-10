-- Reviewer's manual safety confidence (1-100), set in the review form.
-- Null until a reviewer sets one. Apply this before deploying publisher-api:
-- the review queue selects this column and fails without it.
alter table public.publisher_submissions
  add column if not exists safety_rating smallint
  check (safety_rating is null or safety_rating between 1 and 100);
