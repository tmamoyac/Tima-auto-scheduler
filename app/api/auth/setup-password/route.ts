import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * One-time password setup when locked out.
 * Requires SETUP_SECRET in .env.local (set a random string, use it once, then remove).
 */
export async function POST(request: NextRequest) {
  try {
    const secret = (process.env.SETUP_SECRET ?? "").trim();
    if (!secret) {
      return NextResponse.json(
        { error: "Setup not configured. Add SETUP_SECRET to .env.local and restart the server." },
        { status: 500 }
      );
    }

    let body: { email?: string; password?: string; setupKey?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const setupKey = typeof body.setupKey === "string" ? body.setupKey.trim() : "";

    if (!email || !password || !setupKey) {
      return NextResponse.json(
        { error: "Email, password, and setup key are required." },
        { status: 400 }
      );
    }

    if (setupKey !== secret) {
      return NextResponse.json({ error: "Invalid setup key. Check SETUP_SECRET in .env.local." }, { status: 403 });
    }

    if (password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
    }

    const { data, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    if (listErr) {
      return NextResponse.json(
        { error: listErr.message || "Failed to list users. Check SUPABASE_SERVICE_ROLE_KEY." },
        { status: 500 }
      );
    }

    const user = data?.users?.find(
      (u) => u.email?.toLowerCase() === email.toLowerCase()
    );

    if (!user) {
      return NextResponse.json(
        { error: `No user found with email ${email}. Create the user in Supabase first (Auth > Users).` },
        { status: 404 }
      );
    }

    const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(user.id, { password });
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true, message: "Password set. You can now sign in." });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: msg },
      { status: 500 }
    );
  }
}
