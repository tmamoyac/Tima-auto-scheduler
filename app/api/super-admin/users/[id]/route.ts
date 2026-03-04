import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/auth/superAdmin";
import { supabaseAdmin } from "@/lib/supabase/admin";

async function guard(request: NextRequest) {
  try {
    const supabase = createSupabaseServerClient(request);
    await requireSuperAdmin(supabase);
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "UNAUTHENTICATED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

const VALID_ROLES = ["director", "member", "viewer", "super_admin"] as const;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const errRes = await guard(request);
  if (errRes) return errRes;

  const { id } = await params;
  let body: { is_active?: boolean; role?: string; program_id?: string; email?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const hasAny =
    body.is_active !== undefined ||
    body.role !== undefined ||
    body.program_id !== undefined ||
    body.email !== undefined;

  if (!hasAny) {
    return NextResponse.json(
      { error: "At least one of is_active, role, program_id, email required" },
      { status: 400 }
    );
  }

  if (body.email !== undefined) {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email || !EMAIL_REGEX.test(email)) {
      return NextResponse.json({ error: "Invalid email format" }, { status: 400 });
    }
    const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(id, {
      email,
      email_confirm: true,
    });
    if (authErr) return NextResponse.json({ error: authErr.message }, { status: 400 });
  }

  if (body.program_id !== undefined) {
    const programId = typeof body.program_id === "string" ? body.program_id.trim() : "";
    if (!programId) {
      return NextResponse.json({ error: "program_id required when provided" }, { status: 400 });
    }
    const { data: prog } = await supabaseAdmin
      .from("programs")
      .select("id")
      .eq("id", programId)
      .maybeSingle();
    if (!prog) {
      return NextResponse.json({ error: "Program not found" }, { status: 400 });
    }
  }

  if (body.role !== undefined) {
    const role = typeof body.role === "string" ? body.role.trim() : "";
    if (!VALID_ROLES.includes(role as (typeof VALID_ROLES)[number])) {
      return NextResponse.json(
        { error: "role must be one of: director, member, viewer, super_admin" },
        { status: 400 }
      );
    }
  }

  const profileUpdates: { is_active?: boolean; program_id?: string; role?: string } = {};
  if (body.is_active !== undefined) profileUpdates.is_active = Boolean(body.is_active);
  if (body.program_id !== undefined) profileUpdates.program_id = body.program_id.trim();
  if (body.role !== undefined) profileUpdates.role = body.role.trim();

  if (Object.keys(profileUpdates).length > 0) {
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .update(profileUpdates)
      .eq("id", id)
      .select()
      .single();

    if (profileErr) return NextResponse.json({ error: profileErr.message }, { status: 500 });
    if (!profile) return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const { data: user } = await supabaseAdmin.auth.admin.getUserById(id);
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("program_id, role, is_active")
    .eq("id", id)
    .single();

  const programsRes = await supabaseAdmin.from("programs").select("id, name");
  const programs = (programsRes.data ?? []) as { id: string; name: string }[];
  const programByName = new Map(programs.map((p) => [p.id, p.name]));

  return NextResponse.json({
    id,
    email: user?.user?.email ?? "",
    program_id: profile?.program_id ?? null,
    program_name: profile?.program_id ? programByName.get(profile.program_id) ?? "—" : "No program",
    role: profile?.role ?? null,
    is_active: profile?.is_active ?? true,
  });
}
