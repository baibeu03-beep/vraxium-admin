// app/api/schools/search/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

const ALLOWED_TYPES = new Set(["elementary", "middle", "high", "university"]);
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

type SchoolRow = {
  id: string;
  school_name: string;
  school_type: string;
  region: string | null;
  address: string | null;
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  const typeParam = searchParams.get("type")?.trim();
  const region = searchParams.get("region")?.trim();
  const limitParam = searchParams.get("limit");

  if (!q) {
    return NextResponse.json({ schools: [] });
  }

  if (typeParam && !ALLOWED_TYPES.has(typeParam)) {
    return NextResponse.json(
      { error: `Unknown school type: ${typeParam}` },
      { status: 400 },
    );
  }

  const parsedLimit = limitParam ? Number(limitParam) : DEFAULT_LIMIT;
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;

  const escaped = q.replace(/[%_]/g, (m) => `\\${m}`);

  let query = supabaseAdmin
    .from("schools")
    .select("id, school_name, school_type, region, address")
    .ilike("school_name", `%${escaped}%`)
    .order("school_name", { ascending: true })
    .limit(limit);

  if (typeParam) {
    query = query.eq("school_type", typeParam);
  }
  if (region) {
    query = query.eq("region", region);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as SchoolRow[];
  // 프론트 호환: name / school_name, schoolType / school_type 양쪽 다 내려준다.
  const schools = rows.map((row) => ({
    id: row.id,
    name: row.school_name,
    school_name: row.school_name,
    schoolType: row.school_type,
    school_type: row.school_type,
    region: row.region,
    address: row.address,
  }));

  return NextResponse.json({ schools });
}
