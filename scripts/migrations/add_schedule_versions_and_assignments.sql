-- Run this in Supabase SQL Editor to create schedule_versions and assignments tables.
-- Required for "Generate new schedule" to work.

create table if not exists schedule_versions (
  id uuid primary key default gen_random_uuid(),
  academic_year_id uuid not null references academic_years(id) on delete cascade,
  version_name text,
  is_final boolean default false,
  created_at timestamptz default now()
);

create index if not exists schedule_versions_academic_year_id_idx on schedule_versions(academic_year_id);

create table if not exists assignments (
  id uuid primary key default gen_random_uuid(),
  schedule_version_id uuid not null references schedule_versions(id) on delete cascade,
  resident_id uuid not null references residents(id) on delete cascade,
  month_id uuid not null references months(id) on delete cascade,
  rotation_id uuid references rotations(id) on delete set null,
  unique (schedule_version_id, resident_id, month_id)
);

create index if not exists assignments_schedule_version_id_idx on assignments(schedule_version_id);
create index if not exists assignments_resident_id_idx on assignments(resident_id);
create index if not exists assignments_month_id_idx on assignments(month_id);
