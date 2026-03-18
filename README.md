## Cassava auto scheduler

Shareable scheduler app for a single program director (Supabase + Next.js).

## Getting Started

### 1) Create `.env.local`

Create a `.env.local` file with:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

Optional (only needed to run `scripts/seed.js` locally):

- `SUPABASE_SERVICE_ROLE_KEY`

### 2) Create the DB tables (Supabase SQL Editor)

In Supabase → **SQL Editor** → **New query**, run your migration SQL files in `scripts/migrations/` (at minimum you need the scheduler tables and auth/RLS):

- `scripts/migrations/add_schedule_versions_and_assignments.sql`
- `scripts/migrations/add_fixed_assignment_rules.sql`
- `scripts/migrations/vacation_requests_week_based.sql`
- `scripts/migrations/auth_profiles_and_rls.sql`
- `scripts/migrations/add_resident_rotation_requirements.sql` — per-resident rotation targets (Setup → Rotation requirements). Until you save the per-resident grid, the scheduler still uses the PGY requirements matrix. A column may total less than 12; those extra months stay unassigned when you generate.

### 3) Create the director login (Supabase Auth)

In Supabase → **Authentication**:

- Create a user (email + password) for the program director.
- Insert a `profiles` row mapping the user to the program:

```sql
insert into profiles (id, program_id)
values ('<auth.users.id>', '<programs.id>');
```

### 4) Run the dev server

Run:

```bash
npm run dev
```

Open `http://localhost:3000/login`, sign in, then you’ll land on the scheduler.

## Deploy to Vercel (free tier)

### 1) Push to GitHub

- Create a GitHub repo
- Push this project (ensure `.env.local` is not committed; it's in `.gitignore`)

### 2) Create a Vercel project

- [Vercel](https://vercel.com) → **New Project** → import your GitHub repo

### 3) Add env vars in Vercel

In Vercel → Project → **Settings** → **Environment Variables** (Production):

| Variable | Value |
|----------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Your Supabase anon key |
| `NEXT_PUBLIC_APP_URL` | Your Vercel URL (e.g. `https://your-app.vercel.app`) — set after first deploy; required for password reset links |

Optional: `SUPABASE_SERVICE_ROLE_KEY` — add only if you use Super Admin (user management / password reset). Do not add for basic director-only use.

### 4) Configure Supabase Auth URLs

In Supabase → **Authentication** → **URL Configuration**:

- **Site URL**: `https://your-app.vercel.app` (your Vercel URL)
- **Redirect URLs**: add `https://your-app.vercel.app/auth/callback` (keep `http://localhost:3000/auth/callback` for local dev)

### 5) Share the login link

After deploy, share with the program director: `https://your-app.vercel.app/login` and their credentials.

## Notes

- **Protected routes**: `/admin/*`, `/api/admin/*`, and `/api/scheduler/*` require login (see `middleware.ts`).
- **Program scoping**: access is enforced by Supabase RLS policies (see `scripts/migrations/auth_profiles_and_rls.sql`).

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

Next.js deploy docs: https://nextjs.org/docs/app/building-your-application/deploying
