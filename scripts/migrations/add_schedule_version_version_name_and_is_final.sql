-- Run in Supabase SQL Editor after schedule_versions exists.
-- Adds version_name (for display/rename) and is_final (one final version per year).

alter table schedule_versions
  add column if not exists version_name text;

alter table schedule_versions
  add column if not exists is_final boolean default false;

comment on column schedule_versions.version_name is 'Display name, e.g. "Proposal 1" or "Final v01"';
comment on column schedule_versions.is_final is 'When true, this version is the chosen final schedule for the academic year';
