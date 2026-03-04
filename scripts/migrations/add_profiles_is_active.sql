-- Add is_active to profiles for super admin user management.
-- Run in Supabase SQL Editor.

alter table profiles
  add column if not exists is_active boolean not null default true;

comment on column profiles.is_active is 'When false, user cannot access the app. Super admin can toggle.';
