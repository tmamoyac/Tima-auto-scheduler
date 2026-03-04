-- Auth + RLS for director-only access (program-scoped).
-- Run in Supabase SQL Editor.
--
-- Assumptions:
-- - Each director has exactly one program.
-- - You will manually create a director user in Supabase Auth, then insert a row into `profiles`.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  program_id uuid not null references programs(id) on delete restrict,
  role text not null default 'director',
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

drop policy if exists profiles_select_own on profiles;
create policy profiles_select_own
  on profiles for select
  using (auth.uid() = id);

drop policy if exists profiles_update_own on profiles;
create policy profiles_update_own
  on profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Helper snippets (inline only) used by policies:
-- - program-scoped table with program_id:
--   exists (select 1 from profiles p where p.id = auth.uid() and p.program_id = <table>.program_id)
-- - academic-year scoped table:
--   exists (select 1 from profiles p join academic_years ay on ay.id = <table>.academic_year_id
--          where p.id = auth.uid() and p.program_id = ay.program_id)

-- programs
alter table programs enable row level security;
drop policy if exists programs_rw_own on programs;
create policy programs_rw_own
  on programs for all
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.program_id = programs.id))
  with check (exists (select 1 from profiles p where p.id = auth.uid() and p.program_id = programs.id));

-- academic_years (program_id)
alter table academic_years enable row level security;
drop policy if exists academic_years_rw_own on academic_years;
create policy academic_years_rw_own
  on academic_years for all
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.program_id = academic_years.program_id))
  with check (exists (select 1 from profiles p where p.id = auth.uid() and p.program_id = academic_years.program_id));

-- months (academic_year_id -> academic_years.program_id)
alter table months enable row level security;
drop policy if exists months_rw_own on months;
create policy months_rw_own
  on months for all
  using (
    exists (
      select 1
      from profiles p
      join academic_years ay on ay.id = months.academic_year_id
      where p.id = auth.uid()
        and p.program_id = ay.program_id
    )
  )
  with check (
    exists (
      select 1
      from profiles p
      join academic_years ay on ay.id = months.academic_year_id
      where p.id = auth.uid()
        and p.program_id = ay.program_id
    )
  );

-- residents (program_id)
alter table residents enable row level security;
drop policy if exists residents_rw_own on residents;
create policy residents_rw_own
  on residents for all
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.program_id = residents.program_id))
  with check (exists (select 1 from profiles p where p.id = auth.uid() and p.program_id = residents.program_id));

-- rotations (program_id)
alter table rotations enable row level security;
drop policy if exists rotations_rw_own on rotations;
create policy rotations_rw_own
  on rotations for all
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.program_id = rotations.program_id))
  with check (exists (select 1 from profiles p where p.id = auth.uid() and p.program_id = rotations.program_id));

-- rotation_requirements (program_id)
alter table rotation_requirements enable row level security;
drop policy if exists rotation_requirements_rw_own on rotation_requirements;
create policy rotation_requirements_rw_own
  on rotation_requirements for all
  using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.program_id = rotation_requirements.program_id)
  )
  with check (
    exists (select 1 from profiles p where p.id = auth.uid() and p.program_id = rotation_requirements.program_id)
  );

-- vacation_requests (resident_id -> residents.program_id)
alter table vacation_requests enable row level security;
drop policy if exists vacation_requests_rw_own on vacation_requests;
create policy vacation_requests_rw_own
  on vacation_requests for all
  using (
    exists (
      select 1
      from profiles p
      join residents r on r.id = vacation_requests.resident_id
      where p.id = auth.uid()
        and p.program_id = r.program_id
    )
  )
  with check (
    exists (
      select 1
      from profiles p
      join residents r on r.id = vacation_requests.resident_id
      where p.id = auth.uid()
        and p.program_id = r.program_id
    )
  );

-- fixed_assignment_rules (academic_year_id -> academic_years.program_id)
alter table fixed_assignment_rules enable row level security;
drop policy if exists fixed_assignment_rules_rw_own on fixed_assignment_rules;
create policy fixed_assignment_rules_rw_own
  on fixed_assignment_rules for all
  using (
    exists (
      select 1
      from profiles p
      join academic_years ay on ay.id = fixed_assignment_rules.academic_year_id
      where p.id = auth.uid()
        and p.program_id = ay.program_id
    )
  )
  with check (
    exists (
      select 1
      from profiles p
      join academic_years ay on ay.id = fixed_assignment_rules.academic_year_id
      where p.id = auth.uid()
        and p.program_id = ay.program_id
    )
  );

-- schedule_versions (academic_year_id -> academic_years.program_id)
alter table schedule_versions enable row level security;
drop policy if exists schedule_versions_rw_own on schedule_versions;
create policy schedule_versions_rw_own
  on schedule_versions for all
  using (
    exists (
      select 1
      from profiles p
      join academic_years ay on ay.id = schedule_versions.academic_year_id
      where p.id = auth.uid()
        and p.program_id = ay.program_id
    )
  )
  with check (
    exists (
      select 1
      from profiles p
      join academic_years ay on ay.id = schedule_versions.academic_year_id
      where p.id = auth.uid()
        and p.program_id = ay.program_id
    )
  );

-- assignments (schedule_version_id -> schedule_versions.academic_year_id -> academic_years.program_id)
alter table assignments enable row level security;
drop policy if exists assignments_rw_own on assignments;
create policy assignments_rw_own
  on assignments for all
  using (
    exists (
      select 1
      from profiles p
      join schedule_versions sv on sv.id = assignments.schedule_version_id
      join academic_years ay on ay.id = sv.academic_year_id
      where p.id = auth.uid()
        and p.program_id = ay.program_id
    )
  )
  with check (
    exists (
      select 1
      from profiles p
      join schedule_versions sv on sv.id = assignments.schedule_version_id
      join academic_years ay on ay.id = sv.academic_year_id
      where p.id = auth.uid()
        and p.program_id = ay.program_id
    )
  );

