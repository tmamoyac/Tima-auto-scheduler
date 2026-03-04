-- Program-level preference: do not assign consult rotation in months when resident has vacation.
-- Run in Supabase SQL Editor.

alter table programs
  add column if not exists no_consult_when_vacation_in_month boolean not null default false;

comment on column programs.no_consult_when_vacation_in_month is 'When true, months with vacation are never assigned a consult rotation; a non-consult rotation may be assigned if capacity exists.';
