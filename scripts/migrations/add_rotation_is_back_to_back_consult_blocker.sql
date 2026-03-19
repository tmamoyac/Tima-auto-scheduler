-- Mark rotations that count as "strenuous consult" for the back-to-back consult rule.
-- Run in Supabase SQL Editor.

alter table rotations
  add column if not exists is_back_to_back_consult_blocker boolean not null default false;

comment on column rotations.is_back_to_back_consult_blocker is
  'When true, this rotation is used by the scheduler to avoid back-to-back (and 3-in-a-row) "strenuous consult" months.';

-- No-op change to force a fresh Vercel rebuild/deploy.

