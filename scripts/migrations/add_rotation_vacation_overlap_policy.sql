-- Per-rotation vacation overlap policy for the scheduler (allowed | avoid | prohibited).
alter table rotations
  add column if not exists vacation_overlap_policy text not null default 'allowed'
  check (vacation_overlap_policy in ('allowed', 'avoid', 'prohibited'));

comment on column rotations.vacation_overlap_policy is
  'allowed: may assign during vacation-overlap months; avoid: soft penalty in CP-SAT; prohibited: hard forbid in CP-SAT.';

-- Legacy: UCI Irvine used a hard-coded prohibited rule; migrate to rotation config.
update rotations
set vacation_overlap_policy = 'prohibited'
where trim(name) = 'UCI Irvine';
