// (2) 고객 하드코딩 폴백 재현 조건 + (5) direct==HTTP(operating/test)·타org 0 검증.
// 사용법: npx tsx --env-file=.env.local scripts/verify-deep-2-and-5.ts [userId]
import { createClient } from "@supabase/supabase-js";
import { parseLineCodeOrg } from "../lib/cluster4LineOrg";
import { getCluster4WeeklyCardsForProfileUser } from "../lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "../lib/cluster4WeeklyCardsSnapshot";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY!;

type Line = { lineCode?: string | null; partType?: string; mainTitle?: string | null; activityTypeId?: string | null; status?: string };
type Card = { weekId?: string; startDate?: string; lines?: Line[] };

// 고객앱 하드코딩 폴백 맵(vraxium Cluster4CardContent.tsx lineCodeMap) — 정보 activityType→코드.
const CUSTOMER_INFO_FALLBACK: Record<string, string> = {
  wisdom: "IF99A - NR0001", essay: "IF99A - NR0002", infodesk: "IF99A - NR0003",
  calendar: "IF99A - NR0004", session: "IF99A - NR0005", forum: "IF99A - NR0006",
  practical_lecture: "IF99A - NR0007", community: "IF99A - NR0008", etc_a: "IF99A - NR9999",
};

function lineSig(cards: Card[]): string[] {
  const out: string[] = [];
  for (const c of cards ?? []) for (const ln of c.lines ?? []) out.push(`${c.startDate ?? c.weekId}|${ln.partType}|${ln.lineCode ?? "∅"}`);
  return out.sort();
}
function crossOrg(cards: Card[], ownerOrg: string): string[] {
  const out: string[] = [];
  for (const c of cards ?? []) for (const ln of c.lines ?? []) {
    const o = parseLineCodeOrg(ln.lineCode);
    if (o && o !== "common" && o !== ownerOrg) out.push(`${ln.lineCode}(${o})`);
  }
  return out;
}

async function httpCards(u: string, mode?: string): Promise<Card[]> {
  const url = `${BASE}/api/cluster4/weekly-cards?demoUserId=${u}${mode === "test" ? "&mode=test" : ""}`;
  const r = await fetch(url, { headers: { "x-internal-api-key": KEY } });
  const j: any = await r.json();
  return Array.isArray(j?.data) ? j.data : (j?.data?.cards ?? j?.cards ?? []);
}

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function main() {
  // 검증 대상 — encre 실사용자 1명(인자로 override 가능).
  let userId = process.argv[2];
  let org = "";
  if (!userId) {
    const { data } = await supabase.from("user_profiles").select("user_id,organization_slug")
      .eq("organization_slug", "encre").not("display_name", "ilike", "T%").limit(1);
    userId = (data ?? [])[0]?.user_id;
    org = (data ?? [])[0]?.organization_slug ?? "";
  } else {
    const { data } = await supabase.from("user_profiles").select("organization_slug").eq("user_id", userId).maybeSingle();
    org = data?.organization_slug ?? "";
  }
  console.log(`대상 userId=${userId} org=${org}`);

  console.log("\n############ (5) direct == snapshot(HTTP/고객 제공원) · 타org 0 ############");
  // snapshot-only 구조: 고객앱 HTTP /api/cluster4/weekly-cards 는 readWeeklyCardsSnapshot 를 그대로 서빙.
  //   → direct(라이브 재생성) vs snapshot(저장=HTTP=브라우저 렌더원) 비교가 3자 일치의 권위 비교.
  const direct = (await getCluster4WeeklyCardsForProfileUser(userId)) as unknown as Card[];
  const snapRow: any = await readWeeklyCardsSnapshot(userId);
  const snap = (snapRow?.cards ?? []) as Card[];
  // (참고) demoUserId HTTP 는 로컬에서 ENABLE_DEMO_MODE 게이트로 비어있을 수 있음 — 진단만.
  const httpDemo = await httpCards(userId, "operating").catch(() => []);
  console.log(`  snapshot status=${snapRow?.status} dtoVer=${snapRow?.dtoVersion ?? "?"} · demoHTTP cards=${httpDemo.length}(게이트시 0)`);

  const sigD = lineSig(direct), sigS = lineSig(snap);
  check("direct == snapshot 라인셋 동일(현 snapshot 최신)", JSON.stringify(sigD) === JSON.stringify(sigS),
    `direct=${sigD.length} snapshot=${sigS.length}`);
  check("direct(라이브) 타org 라인 0", crossOrg(direct, org).length === 0, crossOrg(direct, org).slice(0, 5).join(", "));
  check("snapshot(저장=HTTP 서빙) 타org 라인 0", crossOrg(snap, org).length === 0, crossOrg(snap, org).slice(0, 5).join(", "));
  // snapshot 생성시점 vs 현재(direct 재계산): 라인셋 동일 → 생성시점 데이터도 비오염(과거 오염 없음).
  check("생성시점(snapshot) == 현재(direct) — 과거 오염 없음", JSON.stringify(sigD) === JSON.stringify(sigS));

  console.log("\n############ (2) 고객 하드코딩 폴백 재현 조건 ############");
  // 정보(information) 라인의 실제 백엔드 lineCode 분포 — 폴백은 매칭 lineCode 부재 시에만 발동.
  const infoLines = direct.flatMap((c) => (c.lines ?? []).filter((l) => l.partType === "information"));
  const withCode = infoLines.filter((l) => l.lineCode && l.lineCode.trim());
  const nullCode = infoLines.filter((l) => !l.lineCode || !l.lineCode.trim());
  console.log(`  정보 라인 ${infoLines.length}개 — lineCode 보유 ${withCode.length} / 부재(폴백대상) ${nullCode.length}`);
  console.log(`  실제 백엔드 정보 lineCode 표본: ${Array.from(new Set(withCode.map((l) => l.lineCode))).slice(0, 6).join(", ") || "(없음)"}`);
  console.log("  → 고객앱은 위 실제 코드를 우선 표시. 매칭 lineCode 부재 카드에서만");
  console.log(`     하드코딩 폴백(예: practical_lecture → ${CUSTOMER_INFO_FALLBACK.practical_lecture})이 노출됨.`);
  check("백엔드 정보 lineCode 는 'IF99A-NR' 하드코딩 형식이 아님(공백/99A placeholder 없음)",
    withCode.every((l) => !/IF99A|NR000|\s-\s/.test(l.lineCode ?? "")),
    `샘플=${withCode[0]?.lineCode ?? "∅"}`);

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
