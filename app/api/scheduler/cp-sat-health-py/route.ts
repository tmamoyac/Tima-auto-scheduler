import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Proxies to Vercel Python function GET /api/cp_sat_vercel/health (same deployment). */
export async function GET(request: NextRequest) {
  const target = new URL("/api/cp_sat_vercel/health", request.url);
  const res = await fetch(target, {
    method: "GET",
    cache: "no-store",
    headers: {
      cookie: request.headers.get("cookie") ?? "",
    },
  });
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json; charset=utf-8",
    },
  });
}
