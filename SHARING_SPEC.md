# Sharing & Collaboration Spec

Minimal, shippable model for sharing schedules with multiple users per program.

---

## Roles

| Role     | Description                         |
|----------|-------------------------------------|
| **director** | Program owner. Full access + can invite/remove users. |
| **member**   | Editor. Can edit setup, generate schedules, view. Cannot manage team. |
| **viewer**   | Read-only. Can view Setup and Schedule. Cannot edit or generate. |

---

## Permissions Matrix

| Action                    | director | member | viewer |
|---------------------------|----------|--------|--------|
| View Setup                | ✓        | ✓      | ✓      |
| Edit residents, rotations, etc. | ✓  | ✓      | ✗      |
| Edit vacation, requirements, preferences | ✓ | ✓ | ✗      |
| Generate schedule         | ✓        | ✓      | ✗      |
| View schedule             | ✓        | ✓      | ✓      |
| Invite / remove users     | ✓        | ✗      | ✗      |

---

## Data Model

### `profiles` (existing, extend `role`)

- `role`: `'director' | 'member' | 'viewer'` (already has default `'director'`, add `member`, `viewer`)

### `invites` (new table)

```
invites
  id            uuid PK
  program_id    uuid FK → programs
  email         text (lowercase, trimmed)
  role          text ('member' | 'viewer')
  invited_by    uuid FK → auth.users
  created_at    timestamptz
  expires_at    timestamptz (e.g. 7 days)
  UNIQUE(program_id, email) -- one pending invite per email per program
```

- RLS: only directors of the program can INSERT/SELECT/DELETE.
- On signup or login: if `auth.users.email` matches a row in `invites` with `expires_at > now()`:
  - Insert into `profiles` (or update if user changed programs via invite).
  - Delete the invite row.

---

## Invite Flow

### 1. Director invites

1. Director clicks "Invite" in Team section.
2. Modal/form: email, role (member / viewer).
3. API creates row in `invites`.
4. User sees message: "Invitation sent to X. They can sign up or log in with that email to join."

**No magic link.** Invitee uses standard signup or login with that email. On first successful auth after invite, backend reconciles invite → profile.

### 2. Invitee accepts (implicit)

1. Invitee goes to `/login` (or signs up at `/login` if you add signup).
2. Enters invited email + password.
3. On successful auth, API checks `invites` for matching email.
4. If found and not expired: insert `profiles`, delete invite.
5. Redirect to `/admin/scheduler`.

### 3. Edge cases

- **Invitee already has account with different program:**  
  - Option A (simplest): One user, one program. Reject with "You are already in another program."
  - Option B: Allow multi-program (larger change). Not in v1.
- **Invite expired:** Show "This invitation has expired."
- **Duplicate invite:** `UNIQUE(program_id, email)` prevents duplicates. Show "Already invited." if they try again.

---

## UI Entry Points

| Location        | Component / Action                               | Visible to |
|----------------|---------------------------------------------------|------------|
| Setup tab      | "Team" section (collapsible drawer, like Vacation) | director only |
| Team section   | List: email, role, "Remove" (directors only)      | director   |
| Team section   | "Invite" button                                  | director   |
| Invite modal   | Email input, role dropdown (Member / Viewer)      | director   |
| TopNav         | (Optional) "Invited" badge if user has pending invite from different device | all |

---

## Acceptance Criteria

### AC1: Director can invite by email
- [ ] Director sees "Team" section in Setup.
- [ ] Director can enter email + role (member/viewer) and submit.
- [ ] Invite is stored with 7-day expiry.
- [ ] UI shows "Invitation sent to X."

### AC2: Invitee can join via login
- [ ] User with invited email signs up or logs in.
- [ ] If matching invite exists and not expired, profile is created with invited role.
- [ ] Invite row is deleted.
- [ ] User is redirected to scheduler.

### AC3: Member can edit and generate
- [ ] Member sees Setup and Schedule.
- [ ] Member can edit residents, rotations, vacation, requirements, etc.
- [ ] Member can generate schedule.
- [ ] Member does not see Team section.

### AC4: Viewer is read-only
- [ ] Viewer sees Setup and Schedule.
- [ ] Viewer cannot edit any fields.
- [ ] Viewer cannot generate schedule.
- [ ] All edit/action buttons are hidden or disabled for viewer.

### AC5: Director can remove users
- [ ] Director sees "Remove" next to each non-director in Team list.
- [ ] Remove deletes profile row; user loses access to program.

### AC6: Expired invites
- [ ] Login with invited email after expiry does not create profile.
- [ ] (Optional) Show "Invitation expired" message on login.

---

## Implementation Order

1. Migration: add `member`/`viewer` to `role` constraint, create `invites` table + RLS.
2. API: `POST /api/admin/invites`, `GET /api/admin/invites`, `DELETE /api/admin/invites/[id]`, `GET /api/admin/team`.
3. Auth: in login/signup handler, check `invites` and reconcile.
4. `requireDirectorContext` → `requireProgramContext`: return `{ userId, programId, role, academicYearId }`. Use `role` for permission checks.
5. API routes: guard write/delete with `role !== 'viewer'`.
6. UI: Team section, invite modal, role-based hiding of edit controls.

---

## Out of Scope (v1)

- Magic link / passwordless invite
- Multi-program per user
- Audit log of invites
- Resend invite
- Bulk invite
