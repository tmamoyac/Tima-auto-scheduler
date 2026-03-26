import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Proxies JSON POST to Vercel Python function POST /api/cp_sat_vercel/solve (same deployment). */
export async function POST(request: NextRequest) {
  const target = new URL("/api/cp_sat_vercel/solve", request.url);
  const body = await request.text();
  const auth = request.headers.get("authorization");
  const headers: Record<string, string> = {
    "content-type": request.headers.get("content-type") ?? "application/json",
  };
  if (auth) headers.authorization = auth;

  const res = await fetch(target, {
    method: "POST",
    body,
    headers,
    cache: "no-store",
  });
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json; charset=utf-8",
    },
  });
}
