-- Add is_active to programs for super admin program management.
-- Run in Supabase SQL Editor.

alter table programs
  add column if not exists is_active boolean not null default true;

comment on column programs.is_active is 'When false, program is hidden from switcher and directors cannot access. Super admin can toggle.';
