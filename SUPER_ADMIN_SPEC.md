# Super Admin Spec

App owner can manage all users: create users, activate/deactivate, reset passwords.

---

## Super Admin Identity

**Env var:** `SUPER_ADMIN_EMAILS`

- Comma-separated list of emails (e.g. `owner@example.com,admin@example.com`)
- Case-insensitive
- No DB table; configured per environment
- If a super admin also has a `profiles` row (program director), they get both super-admin and program access

---

## Capabilities

| Action | Description |
|--------|-------------|
| **List users** | View all auth users + their profiles (program, role, is_active) |
| **Create user** | Create auth user (email + temp password) + profile (program, role) |
| **Activate / Deactivate** | Toggle `profiles.is_active`; deactivated users cannot access the app |
| **Reset password** | Send password reset email via Supabase Auth |
| **Set password** | Set a temporary password (for support when user can't receive email) |

---

## Data Model

### `profiles` (extend)

Add column:

```
is_active  boolean not null default true
```

- When `false`, user cannot access any program-scoped routes (login succeeds at Auth layer, but app rejects)
- Super admins bypass this check when accessing super-admin routes

### RLS

- Super admin APIs use `supabaseAdmin` (service role) and bypass RLS
- `profiles.is_active` updates: only super admin can change (via API, not RLS)

---

## Auth / Access Control

### `isSuperAdmin(email: string): boolean`
- Parse `SUPER_ADMIN_EMAILS`, normalize, check membership
- Used in API routes and server components

### Super admin routes
- `/admin/super` — Super Admin UI (list users, create, activate, reset)
- `/api/super-admin/*` — All super-admin APIs
- Protected: require authenticated user AND `isSuperAdmin(user.email)`
- Return 403 if not super admin

### Deactivated users
- `requireDirectorContext` (and future `requireProgramContext`): if `profile.is_active === false`, throw `DEACTIVATED`
- Super admin is never deactivated for super-admin routes (check `isSuperAdmin` before `is_active`)

---

## UI Entry Points

| Location | Component | Description |
|----------|------------|-------------|
| TopNav (when super admin) | "Super Admin" link | Visible only when `user.email` in SUPER_ADMIN_EMAILS |
| `/admin/super` | Super Admin page | User list + actions |

### Super Admin page layout

1. **User list** (table)
   - Email, program name, role, active (Y/N), created
   - Actions: Activate/Deactivate, Reset password, Set password
2. **Create user** (form or modal)
   - Email, temporary password, program (dropdown), role (director/member/viewer)
   - Submit → create auth user + profile

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/super-admin/users` | List all users (auth + profile joined) |
| POST | `/api/super-admin/users` | Create user + profile. Body: `{ email, password, program_id, role }` |
| PATCH | `/api/super-admin/users/[id]` | Update. Body: `{ is_active?: boolean }` |
| POST | `/api/super-admin/users/[id]/reset-password` | Send password reset email |
| POST | `/api/super-admin/users/[id]/set-password` | Set password. Body: `{ password }` |
| GET | `/api/super-admin/programs` | List programs (for create-user dropdown) |

---

## Acceptance Criteria

### AC1: Super admin access
- [ ] Only users with email in `SUPER_ADMIN_EMAILS` can access `/admin/super` and `/api/super-admin/*`
- [ ] Others get 403
- [ ] "Super Admin" link in TopNav only for super admins

### AC2: List users
- [ ] Super admin sees table of users with email, program, role, is_active
- [ ] Users without profile shown with "No program" (or excluded, per preference)

### AC3: Create user
- [ ] Super admin can create user with email, temp password, program, role
- [ ] Auth user and profile are created
- [ ] User can log in with that email and password

### AC4: Activate / deactivate
- [ ] Toggle `is_active` in profile
- [ ] Deactivated user cannot access app (redirect or 403 after login)
- [ ] Activate restores access

### AC5: Reset password
- [ ] "Reset password" sends Supabase password recovery email
- [ ] User receives email and can set new password

### AC6: Set password
- [ ] "Set password" allows super admin to set a temp password
- [ ] User can log in with that password (and optionally change it later)

---

## Implementation Order

1. Migration: add `is_active` to profiles
2. `lib/auth/superAdmin.ts`: `isSuperAdmin(email)`, `requireSuperAdmin(supabase)`
3. Update `requireDirectorContext`: throw `DEACTIVATED` when `!profile.is_active` (and not super admin)
4. API routes: `/api/super-admin/*` with `requireSuperAdmin`
5. Super Admin page: `/admin/super` with user list and create form
6. TopNav: conditional "Super Admin" link

---

## Env

Add to `.env.example`:

```
SUPER_ADMIN_EMAILS=owner@example.com
```
