-- Fixed assignment rules: pin resident to rotation for a given month (used when not on vacation).
-- Run in Supabase SQL Editor.

create table if not exists fixed_assignment_rules (
  id uuid primary key default gen_random_uuid(),
  academic_year_id uuid not null references academic_years(id) on delete cascade,
  resident_id uuid not null references residents(id) on delete cascade,
  month_id uuid not null references months(id) on delete cascade,
  rotation_id uuid not null references rotations(id) on delete cascade,
  unique (academic_year_id, resident_id, month_id)
);

create index if not exists fixed_assignment_rules_academic_year_id_idx on fixed_assignment_rules(academic_year_id);
create index if not exists fixed_assignment_rules_resident_id_idx on fixed_assignment_rules(resident_id);
create index if not exists fixed_assignment_rules_month_id_idx on fixed_assignment_rules(month_id);

comment on table fixed_assignment_rules is 'If resident is not on vacation in that month, assign this rotation when generating schedule.';
