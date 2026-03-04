-- Mark rotations that count as "consult" for the back-to-back consult rule.
-- Run in Supabase SQL Editor.

alter table rotations
  add column if not exists is_consult boolean not null default false;

comment on column rotations.is_consult is 'When true, counts as consult for "avoid back-to-back consult months" rule.';
