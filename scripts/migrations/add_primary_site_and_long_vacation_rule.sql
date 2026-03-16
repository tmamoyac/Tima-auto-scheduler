-- Primary-site rotations and "prefer primary site for long vacation" rule.
-- Run in Supabase SQL Editor.

alter table rotations
  add column if not exists is_primary_site boolean not null default false;

comment on column rotations.is_primary_site is 'When true, rotation is at program primary/main site; used when "prefer primary-site for long vacation" rule is on.';

alter table programs
  add column if not exists prefer_primary_site_for_long_vacation boolean not null default false;

comment on column programs.prefer_primary_site_for_long_vacation is 'When true, scheduler prefers primary-site rotations for residents who have at least one vacation of 2+ weeks.';
