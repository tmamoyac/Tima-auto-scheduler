-- Per-resident rotation targets (replaces PGY-only matrix for scheduling when present).

create table if not exists resident_rotation_requirements (
  id uuid primary key default gen_random_uuid(),
  resident_id uuid not null references residents(id) on delete cascade,
  rotation_id uuid not null references rotations(id) on delete cascade,
  min_months_required int not null check (min_months_required >= 0),
  unique (resident_id, rotation_id)
);

create index if not exists resident_rotation_requirements_resident_id_idx
  on resident_rotation_requirements (resident_id);

comment on table resident_rotation_requirements is 'Target months per rotation per resident; scheduler uses these when any row exists for that resident, else falls back to rotation_requirements by PGY.';

alter table resident_rotation_requirements enable row level security;

drop policy if exists resident_rotation_requirements_rw_own on resident_rotation_requirements;
create policy resident_rotation_requirements_rw_own
  on resident_rotation_requirements for all
  using (
    exists (
      select 1
      from profiles p
      join residents r on r.id = resident_rotation_requirements.resident_id
      where p.id = auth.uid()
        and p.program_id = r.program_id
    )
  )
  with check (
    exists (
      select 1
      from profiles p
      join residents r on r.id = resident_rotation_requirements.resident_id
      where p.id = auth.uid()
        and p.program_id = r.program_id
    )
  );
