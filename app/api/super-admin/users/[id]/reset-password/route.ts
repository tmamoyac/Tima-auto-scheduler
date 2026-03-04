import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSuperAdmin } from "@/lib/auth/superAdmin";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = createSupabaseServerClient();
    await requireSuperAdmin(supabase);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "UNAUTHENTICATED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const { data: user } = await supabaseAdmin.auth.admin.getUserById(id);
  if (!user?.user?.email) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const redirectTo = `${baseUrl}/auth/callback`;
  // For local dev: ensure Supabase Dashboard > Auth > URL Configuration includes http://localhost:3000/auth/callback

  const { error } = await supabaseAdmin.auth.resetPasswordForEmail(user.user.email, {
    redirectTo,
  });

  if (error) {
    const hint =
      (error.message.toLowerCase().includes("redirect") || error.message.toLowerCase().includes("email")) &&
      baseUrl.includes("localhost")
        ? " Ensure Auth redirect URLs include this app's /auth/callback."
        : "";
    return NextResponse.json({ error: error.message + hint }, { status: 400 });
  }

  return NextResponse.json({
    message: "Password reset email sent. Check the user's inbox.",
  });
}
