-- Program-level preference: avoid scheduling residents into consult rotations in consecutive months.
-- Run in Supabase SQL Editor.

alter table programs
  add column if not exists avoid_back_to_back_consult boolean not null default false;

comment on column programs.avoid_back_to_back_consult is 'When true, scheduler deprioritizes consult for a resident if they had consult the previous month.';
