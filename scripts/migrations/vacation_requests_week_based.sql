-- Week-based vacation: add start_date/end_date, migrate from month_id, then drop month_id.
-- Run in Supabase SQL Editor after vacation_requests and months exist.

-- 1) Add new columns (nullable first for backfill)
alter table vacation_requests
  add column if not exists start_date date,
  add column if not exists end_date date;

-- 2) Backfill from months for existing rows
update vacation_requests v
set
  start_date = m.start_date,
  end_date = m.end_date
from months m
where v.month_id = m.id
  and v.start_date is null;

-- 3) Drop old unique constraint (name may vary; this matches typical pg naming)
alter table vacation_requests
  drop constraint if exists vacation_requests_resident_id_month_id_key;

-- 4) Drop month_id column
alter table vacation_requests
  drop column if exists month_id;

-- 5) Remove any rows that could not be backfilled (e.g. orphaned month_id), then set not null
delete from vacation_requests where start_date is null or end_date is null;

alter table vacation_requests
  alter column start_date set not null,
  alter column end_date set not null;

create unique index if not exists vacation_requests_resident_start_unique
  on vacation_requests (resident_id, start_date);

-- Optional: ensure months has start_date/end_date for generator overlap logic
alter table months
  add column if not exists start_date date,
  add column if not exists end_date date;

comment on column vacation_requests.start_date is 'First day of vacation (inclusive)';
comment on column vacation_requests.end_date is 'Last day of vacation (inclusive)';
