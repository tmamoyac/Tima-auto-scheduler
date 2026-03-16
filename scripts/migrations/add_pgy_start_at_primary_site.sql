-- Require a chosen PGY level to start the academic year (first month) at primary site.
-- Run in Supabase SQL Editor.

alter table programs
  add column if not exists require_pgy_start_at_primary_site boolean not null default false;

comment on column programs.require_pgy_start_at_primary_site is 'When true, residents with PGY = pgy_start_at_primary_site must be assigned to a primary-site rotation in the first month of the academic year.';

alter table programs
  add column if not exists pgy_start_at_primary_site integer not null default 4;

comment on column programs.pgy_start_at_primary_site is 'PGY level that must start the academic year at primary site when require_pgy_start_at_primary_site is true.';
