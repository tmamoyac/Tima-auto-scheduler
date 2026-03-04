import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/auth/superAdmin";
import { supabaseAdmin } from "@/lib/supabase/admin";

async function guard() {
  try {
    const supabase = createSupabaseServerClient();
    await requireSuperAdmin(supabase);
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "UNAUTHENTICATED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const errRes = await guard();
  if (errRes) return errRes;

  const { id } = await params;
  let body: { is_active?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.is_active === undefined) {
    return NextResponse.json({ error: "is_active required" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("programs")
    .update({ is_active: Boolean(body.is_active) })
    .eq("id", id)
    .select("id, name, is_active")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Program not found" }, { status: 404 });
  return NextResponse.json(data);
}
