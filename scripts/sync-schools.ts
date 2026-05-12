/**
 * scripts/sync-schools.ts
 *
 * career.go.kr 학교 OpenAPI → Supabase public.schools upsert.
 *
 * 실행:
 *   npm run sync:schools
 *   (or) pnpm sync:schools
 *
 * 필요한 env (.env.local):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SCHOOL_API_KEY
 *
 * schools 테이블은 source_id 에 UNIQUE 제약이 있어야 한다.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type Gubun = "elem_list" | "midd_list" | "high_list" | "univ_list";

const SCHOOL_TYPE_BY_GUBUN: Record<Gubun, "elementary" | "middle" | "high" | "university"> = {
  elem_list: "elementary",
  midd_list: "middle",
  high_list: "high",
  univ_list: "university",
};

const SOURCE_NAME = "career.go.kr";

const API_URL = "https://www.career.go.kr/cnet/openapi/getOpenApi";
const PER_PAGE = 200;
const UPSERT_CHUNK_SIZE = 500;

type CareerSchoolRow = {
  seq?: string | number;
  schoolName?: string;
  schoolType?: string;
  schoolGubun?: string;
  region?: string;
  adres?: string;
  estType?: string;
  link?: string;
  campusName?: string;
  totalCount?: string | number;
};

type SchoolUpsertRow = {
  source: string;
  source_id: string;
  school_name: string;
  school_type: "elementary" | "middle" | "high" | "university";
  region: string | null;
  address: string | null;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function pickString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function fetchPage(
  apiKey: string,
  gubun: Gubun,
  page: number,
): Promise<{ rows: CareerSchoolRow[]; totalCount: number }> {
  const params = new URLSearchParams({
    apiKey,
    svcType: "api",
    svcCode: "SCHOOL",
    contentType: "json",
    gubun,
    thisPage: String(page),
    perPage: String(PER_PAGE),
  });

  const url = `${API_URL}?${params.toString()}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `career.go.kr fetch failed (${gubun}, page ${page}): ${response.status} ${response.statusText}`,
    );
  }

  const json = (await response.json()) as {
    dataSearch?: { content?: CareerSchoolRow[] };
  };

  const rows = json.dataSearch?.content ?? [];
  const totalCount = rows[0]?.totalCount != null ? Number(rows[0].totalCount) : rows.length;

  return { rows, totalCount: Number.isFinite(totalCount) ? totalCount : rows.length };
}

async function fetchAllForGubun(apiKey: string, gubun: Gubun): Promise<CareerSchoolRow[]> {
  const first = await fetchPage(apiKey, gubun, 1);
  const all: CareerSchoolRow[] = [...first.rows];
  const totalPages = Math.max(1, Math.ceil(first.totalCount / PER_PAGE));

  console.log(`  [${gubun}] totalCount=${first.totalCount}, pages=${totalPages}`);

  for (let page = 2; page <= totalPages; page++) {
    const { rows } = await fetchPage(apiKey, gubun, page);
    if (rows.length === 0) break;
    all.push(...rows);
    if (page % 10 === 0) {
      console.log(`  [${gubun}] fetched page ${page}/${totalPages} (${all.length} rows)`);
    }
  }

  return all;
}

function normalize(row: CareerSchoolRow, gubun: Gubun): SchoolUpsertRow | null {
  const rawSeq = row.seq != null ? String(row.seq).trim() : "";
  const schoolName = pickString(row.schoolName);
  if (!rawSeq || !schoolName) return null;

  const schoolType = SCHOOL_TYPE_BY_GUBUN[gubun];
  // career.go.kr seq 는 gubun 별로 따로 매겨지므로 (elem seq=684 vs univ seq=684)
  // 전 학교 유형에 걸친 unique key 가 되도록 타입 prefix 를 붙인다.
  const sourceId = `${schoolType}:${rawSeq}`;

  return {
    source: SOURCE_NAME,
    source_id: sourceId,
    school_name: schoolName,
    school_type: schoolType,
    region: pickString(row.region),
    address: pickString(row.adres),
  };
}

function dedupeBySourceId(rows: SchoolUpsertRow[]): SchoolUpsertRow[] {
  const map = new Map<string, SchoolUpsertRow>();
  for (const row of rows) {
    map.set(row.source_id, row);
  }
  return Array.from(map.values());
}

async function upsertChunked(
  supabase: SupabaseClient,
  rows: SchoolUpsertRow[],
): Promise<number> {
  let upserted = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
    const { error } = await supabase
      .from("schools")
      .upsert(chunk as never, { onConflict: "source,source_id" });

    if (error) {
      throw new Error(`Supabase upsert failed at chunk ${i / UPSERT_CHUNK_SIZE}: ${error.message}`);
    }
    upserted += chunk.length;
    console.log(`  upserted ${upserted}/${rows.length}`);
  }
  return upserted;
}

async function insertChunked(
  supabase: SupabaseClient,
  rows: SchoolUpsertRow[],
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
    const { error } = await supabase
      .from("schools")
      .insert(chunk as never);

    if (error) {
      throw new Error(`Supabase insert failed at chunk ${i / UPSERT_CHUNK_SIZE}: ${error.message}`);
    }
    inserted += chunk.length;
    console.log(`  inserted ${inserted}/${rows.length}`);
  }
  return inserted;
}

async function syncSource(
  supabase: SupabaseClient,
  source: string,
  rows: SchoolUpsertRow[],
): Promise<number> {
  // 우선 (source, source_id) UNIQUE 제약이 있다고 가정하고 upsert 시도.
  // 제약이 없으면 (예: 초기 부트스트랩) 같은 source 의 기존 row 를 모두 지우고
  // 새로 insert 하는 방식으로 fallback — 마찬가지로 idempotent.
  try {
    return await upsertChunked(supabase, rows);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const constraintMissing =
      message.includes("no unique or exclusion constraint") ||
      message.includes("ON CONFLICT");
    if (!constraintMissing) throw error;

    console.warn(
      "\n  ⚠ (source, source_id) UNIQUE 제약이 없어 upsert 실패. " +
        "delete-by-source → insert 로 fallback 합니다.",
    );
    console.warn(
      "    영구적인 idempotency 를 원하면 SQL Editor 에서 다음 마이그레이션을 적용하세요:",
    );
    console.warn(
      "    db/migrations/2026-05-12_schools_source_unique.sql",
    );

    const { error: deleteError } = await supabase
      .from("schools")
      .delete()
      .eq("source", source);
    if (deleteError) {
      throw new Error(`Failed to clear existing ${source} rows: ${deleteError.message}`);
    }

    return await insertChunked(supabase, rows);
  }
}

async function main() {
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const schoolApiKey = requireEnv("SCHOOL_API_KEY");

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const gubuns: Gubun[] = ["elem_list", "midd_list", "high_list", "univ_list"];

  const byType: Record<string, number> = {};
  const allRows: SchoolUpsertRow[] = [];

  for (const gubun of gubuns) {
    console.log(`\nFetching ${gubun}...`);
    const raw = await fetchAllForGubun(schoolApiKey, gubun);

    const normalized: SchoolUpsertRow[] = [];
    for (const row of raw) {
      const mapped = normalize(row, gubun);
      if (mapped) normalized.push(mapped);
    }

    const type = SCHOOL_TYPE_BY_GUBUN[gubun];
    byType[type] = normalized.length;
    allRows.push(...normalized);
    console.log(`  [${gubun}] normalized ${normalized.length} rows (skipped ${raw.length - normalized.length})`);
  }

  const deduped = dedupeBySourceId(allRows);
  console.log(
    `\nDeduplicated by source_id: ${allRows.length} → ${deduped.length} (${allRows.length - deduped.length} dropped)`,
  );

  console.log("\nUpserting into public.schools...");
  const upserted = await syncSource(supabase, SOURCE_NAME, deduped);

  console.log("\n=== Sync complete ===");
  for (const type of Object.keys(byType)) {
    console.log(`  ${type.padEnd(11)}: ${byType[type]}`);
  }
  console.log(`  ${"deduped".padEnd(11)}: ${deduped.length}`);
  console.log(`  ${"upserted".padEnd(11)}: ${upserted}`);
}

main().catch((error) => {
  console.error("\n[sync-schools] FAILED:", error);
  process.exit(1);
});
