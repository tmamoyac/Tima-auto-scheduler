import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = createSupabaseServerClient(request);
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login?logout=1", request.url));
}

