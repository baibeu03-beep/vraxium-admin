// 읽기 전용 심층 조사 — (2) IF99A-NR0007 실 출처 / (5) snapshot 전수 타org 오염.
// 사용법: npx tsx --env-file=.env.local scripts/investigate-deep-2-and-5.ts
import { createClient } from "@supabase/supabase-js";
import { parseLineCodeOrg, type LineOrgScope } from "../lib/cluster4LineOrg";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function log(label: string, v: unknown) {
  console.log(`\n=== ${label} ===`);
  console.dir(v, { depth: null, maxArrayLength: 80 });
}

// ── (2) "IF99A - NR0007" 실 출처: 코드/이름/타이틀 컬럼 전반 패턴 검색 ──
async function searchLiteral() {
  console.log("\n############ (2) IF99A - NR0007 실 출처 검색 ############");
  const patterns = ["%IF99%", "%NR0007%", "%99A%", "% - %"];
  // [table, columns]
  const targets: Array<[string, string[]]> = [
    ["cluster4_lines", ["line_code", "main_title"]],
    ["line_registrations", ["line_code", "line_name", "main_title"]],
    ["cluster4_experience_line_masters", ["line_code", "line_name", "main_title"]],
    ["cluster4_competency_line_masters", ["line_code", "line_name", "main_title"]],
    ["career_projects", ["line_code", "line_name"]],
    ["activity_types", ["name"]],
  ];
  for (const [table, cols] of targets) {
    for (const col of cols) {
      for (const pat of patterns) {
        const { data, error } = await supabase
          .from(table)
          .select(`${col}`)
          .ilike(col, pat)
          .limit(20);
        if (error) {
          if (!/does not exist|schema cache/.test(error.message))
            console.log(`  (skip ${table}.${col}: ${error.message})`);
          continue;
        }
        if (data && data.length) {
          log(`HIT ${table}.${col} ILIKE '${pat}' (${data.length})`, data);
        }
      }
    }
  }
  console.log("  (위에 HIT 출력이 없으면 해당 패턴은 어떤 코드/이름/타이틀 컬럼에도 없음)");
}

// ── (5) snapshot 전수 스캔: 저장 cards 의 타org 라인 탐지 ──
type CardLine = { lineCode?: string | null; partType?: string; mainTitle?: string | null; status?: string };
type Card = { weekId?: string; startDate?: string; lines?: CardLine[] };

async function scanSnapshots() {
  console.log("\n############ (5) snapshot 전수 타org 오염 스캔 ############");
  // owner org 맵.
  const orgByUser = new Map<string, string | null>();
  {
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("user_profiles")
        .select("user_id,organization_slug")
        .range(from, from + 999);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{ user_id: string; organization_slug: string | null }>;
      for (const r of rows) orgByUser.set(r.user_id, r.organization_slug);
      if (rows.length < 1000) break;
      from += 1000;
    }
  }
  console.log(`  user_profiles org 맵: ${orgByUser.size}명`);

  let scanned = 0;
  const polluted: Array<{
    userId: string;
    ownerOrg: string | null;
    lineCode: string | null;
    lineOrg: LineOrgScope;
    week?: string;
    title?: string | null;
    isStale: boolean;
    dtoVersion: number;
    computedAt: string;
  }> = [];

  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("cluster4_weekly_card_snapshots")
      .select("user_id,cards,is_stale,dto_version,computed_at")
      .order("user_id", { ascending: true })
      .range(from, from + 199);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{
      user_id: string;
      cards: unknown;
      is_stale: boolean;
      dto_version: number;
      computed_at: string;
    }>;
    for (const row of rows) {
      scanned += 1;
      const ownerOrg = orgByUser.get(row.user_id) ?? null;
      if (!ownerOrg) continue; // owner org 미상이면 필터 기준 없음(별도 집계)
      const cards = (Array.isArray(row.cards) ? row.cards : []) as Card[];
      for (const c of cards) {
        for (const ln of c.lines ?? []) {
          const org = parseLineCodeOrg(ln.lineCode);
          // 특정 타org(common/null 아님 + owner org 와 다름) = 오염.
          if (org && org !== "common" && org !== ownerOrg) {
            polluted.push({
              userId: row.user_id,
              ownerOrg,
              lineCode: ln.lineCode ?? null,
              lineOrg: org,
              week: c.startDate ?? c.weekId,
              title: ln.mainTitle,
              isStale: row.is_stale,
              dtoVersion: row.dto_version,
              computedAt: row.computed_at,
            });
          }
        }
      }
    }
    if (rows.length < 200) break;
    from += 200;
  }

  console.log(`  스캔한 snapshot 행: ${scanned}`);
  console.log(`  타org 오염 라인 인스턴스: ${polluted.length}`);
  if (polluted.length) {
    // userId 별 요약.
    const byUser = new Map<string, typeof polluted>();
    for (const p of polluted) {
      const arr = byUser.get(p.userId) ?? [];
      arr.push(p);
      byUser.set(p.userId, arr);
    }
    log(`오염 owner 수 ${byUser.size} — 샘플 최대 15건`, polluted.slice(0, 15));
    console.log("\n  오염 owner 별 (userId · ownerOrg · 라인수 · dtoVer · stale):");
    let n = 0;
    for (const [uid, arr] of byUser) {
      if (n++ >= 20) { console.log(`  ... 외 ${byUser.size - 20}명`); break; }
      const codes = Array.from(new Set(arr.map((a) => `${a.lineOrg}:${a.lineCode}`)));
      console.log(`  - ${uid} · ${arr[0].ownerOrg} · ${arr.length}건 · v${arr[0].dtoVersion} · stale=${arr[0].isStale} · ${codes.slice(0, 4).join(", ")}`);
    }
  } else {
    console.log("  ✓ 저장된 snapshot 전수에서 타org 토큰 라인 0 — 과거 오염 없음.");
  }
}

async function main() {
  await searchLiteral();
  await scanSnapshots();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
