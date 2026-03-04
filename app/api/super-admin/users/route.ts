import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/auth/superAdmin";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function GET() {
  try {
    const supabase = createSupabaseServerClient();
    await requireSuperAdmin(supabase);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "UNAUTHENTICATED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ data: usersData, error: usersErr }, { data: profilesData, error: profilesErr }] =
    await Promise.all([
      supabaseAdmin.auth.admin.listUsers({ perPage: 1000 }),
      supabaseAdmin.from("profiles").select("id, program_id, role, is_active, created_at"),
    ]);

  if (usersErr) return NextResponse.json({ error: usersErr.message }, { status: 500 });
  if (profilesErr) return NextResponse.json({ error: profilesErr.message }, { status: 500 });

  const profiles = (profilesData ?? []) as {
    id: string;
    program_id: string;
    role: string;
    is_active: boolean;
    created_at: string;
  }[];
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  const programsRes = await supabaseAdmin.from("programs").select("id, name");
  const programs = (programsRes.data ?? []) as { id: string; name: string }[];
  const programByName = new Map(programs.map((p) => [p.id, p.name]));

  const users = (usersData?.users ?? []).map((u) => {
    const profile = profileById.get(u.id);
    return {
      id: u.id,
      email: u.email ?? "",
      created_at: u.created_at,
      program_id: profile?.program_id ?? null,
      program_name: profile?.program_id ? programByName.get(profile.program_id) ?? "—" : "No program",
      role: profile?.role ?? null,
      is_active: profile?.is_active ?? true,
    };
  });

  return NextResponse.json(users);
}

export async function POST(request: NextRequest) {
  try {
    const supabase = createSupabaseServerClient();
    await requireSuperAdmin(supabase);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "UNAUTHENTICATED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { email: string; password: string; program_id: string; role: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { email, password, program_id, role } = body;
  if (!email || !password || !program_id || !role) {
    return NextResponse.json(
      { error: "email, password, program_id, role required" },
      { status: 400 }
    );
  }

  const { data: newUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email: email.trim().toLowerCase(),
    password,
    email_confirm: true,
  });

  if (createErr) return NextResponse.json({ error: createErr.message }, { status: 400 });

  const { error: profileErr } = await supabaseAdmin.from("profiles").insert({
    id: newUser.user.id,
    program_id: program_id,
    role: role,
    is_active: true,
  });

  if (profileErr) {
    await supabaseAdmin.auth.admin.deleteUser(newUser.user.id);
    return NextResponse.json({ error: profileErr.message }, { status: 500 });
  }

  return NextResponse.json({
    id: newUser.user.id,
    email: newUser.user.email,
    program_id,
    role,
    is_active: true,
  });
}
