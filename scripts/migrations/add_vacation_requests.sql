-- Run this in Supabase SQL Editor (or via migration tool) to create vacation_requests table.

create table if not exists vacation_requests (
  id uuid primary key default gen_random_uuid(),
  resident_id uuid not null references residents(id) on delete cascade,
  month_id uuid not null references months(id) on delete cascade,
  unique (resident_id, month_id)
);

create index if not exists vacation_requests_resident_id_idx on vacation_requests(resident_id);
create index if not exists vacation_requests_month_id_idx on vacation_requests(month_id);
