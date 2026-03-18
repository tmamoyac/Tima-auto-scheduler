import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { directorAuthErrorResponse } from "@/lib/auth/directorContext";
import { getProgramContextForRequest, getProgramIdFromRequest } from "@/lib/auth/schedulerContext";

const MAX_MONTHS_PER_RESIDENT = 12;

export async function GET(request: NextRequest) {
  const supabase = createSupabaseServerClient(request);
  const programIdFromQuery = getProgramIdFromRequest(request.nextUrl.searchParams);
  let ctx;
  try {
    ctx = await getProgramContextForRequest(supabase, supabaseAdmin, programIdFromQuery);
  } catch (e) {
    const res = directorAuthErrorResponse(e);
    if (res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { programId, supabase: db } = ctx;

  const { data: residents, error: resErr } = await db
    .from("residents")
    .select("id, first_name, last_name, pgy, is_active")
    .eq("program_id", programId)
    .order("pgy")
    .order("last_name");

  if (resErr) {
    return NextResponse.json({ error: resErr.message }, { status: 500 });
  }

  const residentList = (residents ?? []) as {
    id: string;
    first_name: string;
    last_name: string;
    pgy: number;
    is_active: boolean;
  }[];
  const activeIds = residentList.filter((r) => r.is_active).map((r) => r.id);

  let requirements: { resident_id: string; rotation_id: string; min_months_required: number }[] = [];
  if (activeIds.length > 0) {
    const { data: reqRows, error: reqErr } = await db
      .from("resident_rotation_requirements")
      .select("resident_id, rotation_id, min_months_required")
      .in("resident_id", activeIds);
    if (reqErr) {
      return NextResponse.json({ error: reqErr.message }, { status: 500 });
    }
    requirements = (reqRows ?? []) as typeof requirements;
  }

  const noStore = { headers: { "Cache-Control": "no-store, max-age=0" } as HeadersInit };
  return NextResponse.json(
    {
      residents: residentList.map((r) => ({
        id: r.id,
        first_name: r.first_name,
        last_name: r.last_name,
        pgy: r.pgy,
        is_active: r.is_active,
      })),
      requirements,
    },
    noStore
  );
}

type ReqRow = { resident_id: string; rotation_id: string; min_months_required: number };

export async function PUT(request: NextRequest) {
  const supabase = createSupabaseServerClient(request);
  const programIdFromQuery = getProgramIdFromRequest(request.nextUrl.searchParams);
  let ctx;
  try {
    ctx = await getProgramContextForRequest(supabase, supabaseAdmin, programIdFromQuery);
  } catch (e) {
    const res = directorAuthErrorResponse(e);
    if (res) return NextResponse.json({ error: res.error }, { status: res.status });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { programId, supabase: db } = ctx;

  let body: { requirements?: ReqRow[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rows = Array.isArray(body.requirements) ? body.requirements : [];
  const validRows: ReqRow[] = rows.filter(
    (r) =>
      typeof r.resident_id === "string" &&
      r.resident_id &&
      typeof r.rotation_id === "string" &&
      r.rotation_id &&
      Number.isInteger(r.min_months_required) &&
      r.min_months_required >= 0
  );

  const { data: residents, error: resErr } = await db
    .from("residents")
    .select("id")
    .eq("program_id", programId)
    .eq("is_active", true);

  if (resErr) {
    return NextResponse.json({ error: resErr.message }, { status: 500 });
  }
  const activeResidentIds = new Set((residents ?? []).map((r: { id: string }) => r.id));
  if (activeResidentIds.size === 0) {
    return NextResponse.json({ error: "No active residents in program" }, { status: 400 });
  }

  const { data: rotations, error: rotErr } = await db
    .from("rotations")
    .select("id")
    .eq("program_id", programId);

  if (rotErr) {
    return NextResponse.json({ error: rotErr.message }, { status: 500 });
  }
  const rotationIds = new Set((rotations ?? []).map((r: { id: string }) => r.id));

  const byResident = new Map<string, Map<string, number>>();
  for (const r of validRows) {
    if (!activeResidentIds.has(r.resident_id)) {
      return NextResponse.json(
        { error: `Resident ${r.resident_id} is not an active resident in this program` },
        { status: 400 }
      );
    }
    if (!rotationIds.has(r.rotation_id)) {
      return NextResponse.json(
        { error: `Rotation ${r.rotation_id} is not in this program` },
        { status: 400 }
      );
    }
    if (!byResident.has(r.resident_id)) byResident.set(r.resident_id, new Map());
    const m = byResident.get(r.resident_id)!;
    m.set(r.rotation_id, (m.get(r.rotation_id) ?? 0) + r.min_months_required);
  }

  for (const rid of activeResidentIds) {
    const m = byResident.get(rid);
    if (!m) {
      return NextResponse.json(
        {
          error:
            "Each active resident must have a full row: missing requirements for at least one resident. Use Copy from PGY template or enter months for everyone.",
        },
        { status: 400 }
      );
    }
    let sum = 0;
    for (const v of m.values()) sum += v;
    if (sum > MAX_MONTHS_PER_RESIDENT) {
      return NextResponse.json(
        {
          error: `Resident column cannot exceed ${MAX_MONTHS_PER_RESIDENT} months (got ${sum}).`,
        },
        { status: 400 }
      );
    }
  }

  const toInsert: { resident_id: string; rotation_id: string; min_months_required: number }[] = [];
  for (const [residentId, rotMap] of byResident) {
    for (const [rotationId, minMonths] of rotMap) {
      if (minMonths > 0) {
        toInsert.push({ resident_id: residentId, rotation_id: rotationId, min_months_required: minMonths });
      }
    }
  }

  const activeIdList = [...activeResidentIds];
  const { error: delErr } = await db
    .from("resident_rotation_requirements")
    .delete()
    .in("resident_id", activeIdList);

  if (delErr) {
    return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  if (toInsert.length > 0) {
    const { error: insErr } = await db.from("resident_rotation_requirements").insert(toInsert);
    if (insErr) {
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, count: toInsert.length });
}
