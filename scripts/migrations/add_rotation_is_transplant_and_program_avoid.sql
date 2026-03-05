-- Mark rotations that count as "transplant" for the back-to-back transplant rule.
-- Program preference: avoid back-to-back transplant months.
-- Run in Supabase SQL Editor.

alter table rotations
  add column if not exists is_transplant boolean not null default false;

comment on column rotations.is_transplant is 'When true, counts as transplant for "avoid back-to-back transplant months" rule.';

alter table programs
  add column if not exists avoid_back_to_back_transplant boolean not null default false;

comment on column programs.avoid_back_to_back_transplant is 'When true, scheduler deprioritizes transplant for a resident if they had transplant the previous month.';
