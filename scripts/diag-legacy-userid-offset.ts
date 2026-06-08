/**
 * hrdb/olympus legacyUserIdOffset 정책 확정 — read-only 분석 (write 0).
 *
 *   npx tsx --env-file=.env.local scripts/diag-legacy-userid-offset.ts
 *
 *   1) 3개 source_system users.UserId min/max/count
 *   2) Vraxium users.legacy_user_id 점유 분포 (밴드별)
 *   3) synthetic 범위(≥100,000,000) 충돌 여부
 *   4) offset 후보(hrdb +10,000,000 · olympus +20,000,000) 적용 시 충돌 시뮬레이션
 *   5) 밴드 역추적 가능성 (offset 밴드 ↔ source_system 단사 여부)
 *
 * 주의: legacy_user_id 숫자만으로 동일인 판단 금지 — 충돌 = "네임스페이스 점유" 의미일 뿐,
 *   동일인 매칭은 이름+생년월일+연락처 3중 키 (FALSE_BRIDGE_NOTE, lib/pmsMigration.ts).
 */
import { writeFileSync, readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";

// MYSQL_PASSWORD 특수문자 — dotenv/--env-file 파싱이 깨뜨리므로 원문 직독 (기존 audit 패턴).
const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();

const OUT = "claudedocs/legacy-userid-offset-analysis-20260607.json";
const SOURCES = ["oranke", "hrdb", "olympus"] as const;
const SYNTHETIC_MIN = 100_000_000; // users.legacy_user_id synthetic default 범위 (2026-05-11~)
const CANDIDATE_OFFSETS: Record<string, number> = { oranke: 0, hrdb: 10_000_000, olympus: 20_000_000 };

const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);

async function main() {
  // ── 1) 소스별 UserId 범위 ──
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"),
    port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"),
    password: envGet("MYSQL_PASSWORD"),
    dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const sourceRanges: Record<string, { min: number; max: number; count: number }> = {};
  for (const src of SOURCES) {
    const [[row]] = (await conn.query(
      `SELECT MIN(UserId) AS mn, MAX(UserId) AS mx, COUNT(*) AS n FROM ${src}.users`,
    )) as [Array<{ mn: number; mx: number; n: number }>, unknown];
    sourceRanges[src] = { min: Number(row.mn), max: Number(row.mx), count: Number(row.n) };
  }
  await conn.end();

  // ── 2) Vraxium legacy_user_id 점유 (전수 — 페이지네이션) ──
  const occupied: number[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("users")
      .select("legacy_user_id")
      .not("legacy_user_id", "is", null)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { legacy_user_id: number }[]) occupied.push(r.legacy_user_id);
    if ((data ?? []).length < 1000) break;
  }
  occupied.sort((a, b) => a - b);
  const band = (lo: number, hi: number) => occupied.filter((v) => v >= lo && v < hi);
  const bands = {
    total: occupied.length,
    "0~10M (oranke 밴드)": band(0, 10_000_000).length,
    "10M~20M (hrdb 후보 밴드)": band(10_000_000, 20_000_000).length,
    "20M~30M (olympus 후보 밴드)": band(20_000_000, 30_000_000).length,
    "30M~100M (미지정 완충)": band(30_000_000, SYNTHETIC_MIN).length,
    "≥100M (synthetic)": occupied.filter((v) => v >= SYNTHETIC_MIN).length,
    "0~10M 상세(전수)": band(0, 10_000_000),
  };

  // ── 3·4) offset 시뮬레이션: 충돌(=네임스페이스 점유 겹침) + synthetic 침범 + 밴드 단사 ──
  const occupiedSet = new Set(occupied);
  const simulation: Record<string, Record<string, unknown>> = {};
  const bandsUsed: Array<{ src: string; lo: number; hi: number }> = [];
  for (const src of SOURCES) {
    const off = CANDIDATE_OFFSETS[src];
    const { min, max, count } = sourceRanges[src];
    const lo = off + min;
    const hi = off + max;
    // 기존 점유와 겹치는 값 (oranke 0-밴드의 기존 false-bridge 오염 포함 — 동일인 의미 아님)
    const collisions = occupied.filter((v) => v >= lo && v <= hi);
    simulation[src] = {
      offset: off,
      mappedRange: `[${lo.toLocaleString()}, ${hi.toLocaleString()}]`,
      mappedCount: count,
      syntheticBreach: hi >= SYNTHETIC_MIN,
      bandCapacity: 10_000_000,
      bandHeadroom: 10_000_000 - max,
      existingOccupiedInRange: collisions.length,
      existingOccupiedValues: collisions.slice(0, 50),
    };
    bandsUsed.push({ src, lo: off, hi: off + 10_000_000 });
  }
  // 밴드 단사(역추적): 후보 밴드 간 겹침 0 + 각 소스 max < 밴드 폭
  const bandOverlap = bandsUsed.some((a, i) =>
    bandsUsed.some((b, j) => i < j && a.lo < b.hi && b.lo < a.hi),
  );
  const reverseTraceable =
    !bandOverlap && SOURCES.every((s) => sourceRanges[s].max < 10_000_000);

  // ── ORANKE 1092 영향: offset 0 유지 → legacy_user_id=1092 그대로 ──
  const oranke1092 = {
    plannedLegacyId: 1092,
    occupiedAlready: occupiedSet.has(1092),
    note: "oranke offset 0 불변 — §12 dry-run·B8 산출물과 호환 유지",
  };

  const report = {
    generatedAt: "2026-06-07 legacyUserIdOffset 분석 (read-only)",
    syntheticMin: SYNTHETIC_MIN,
    sourceRanges,
    vraxiumOccupiedBands: bands,
    candidateOffsets: CANDIDATE_OFFSETS,
    simulation,
    bandOverlap,
    reverseTraceable,
    oranke1092,
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, vraxiumOccupiedBands: { ...bands, "0~10M 상세(전수)": `${bands["0~10M 상세(전수)"].length}건 (JSON 참조)` } }, null, 2));
  console.log("→", OUT);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
