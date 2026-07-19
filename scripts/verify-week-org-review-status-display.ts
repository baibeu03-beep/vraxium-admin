// 검증(direct): 주차 검수 상태가 (week_id, org, scope) SoT 를 정확히 반영하는가.
//   전제: scope 컬럼 마이그레이션 + migrate --apply 완료.
//   [A] 카드 계산(getCluster4WeeklyCardsForProfileUser): 같은 org·같은 W2 라도
//         테스트 사용자 → success/fail(검수완료 scope), 운영 사용자 → aggregating(집계 중).
//         두 사용자의 W2 카드 DTO 키는 동일(분기 없는 동일 계산).
//   [B] 관리자 목록/상세(admin): QA_HIDE_REAL_USERS=true 이므로 test scope 표시.
//   route 는 loader 를 1:1 로 감싸므로 direct == HTTP.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { loadTeamPartsInfoWeeks } from "@/lib/adminTeamPartsInfoWeeksData";
import { loadWeekOrgResultStates } from "@/lib/weekOrgResultState";

const ORGS = ["phalanx", "oranke", "encre"] as const;
const W2_START = "2026-07-06";
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function pickUser(org: string, want: "test" | "operating", testIds: Set<string>): Promise<string | null> {
  const { data: uss } = await supabaseAdmin.from("user_season_statuses").select("user_id").eq("season_key", "2026-summer");
  const ids = [...new Set(((uss ?? []) as Array<{ user_id: string }>).map((r) => r.user_id))];
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await supabaseAdmin.from("user_profiles").select("user_id").in("user_id", ids.slice(i, i + 300)).eq("organization_slug", org);
    for (const p of (data ?? []) as Array<{ user_id: string }>) {
      const isTest = testIds.has(p.user_id);
      if (want === "test" ? isTest : !isTest) return p.user_id;
    }
  }
  return null;
}

function w2Card(cards: Array<Record<string, unknown>>) {
  return cards.find((c) => c.startDate === W2_START);
}

async function main() {
  const testIds = await fetchTestUserMarkerIds();

  // 기대 test-scope 상태(관리자 표시): DB 직접
  const { data: w2 } = await supabaseAdmin.from("weeks").select("id").eq("season_key", "2026-summer").eq("week_number", 2).maybeSingle();
  const weekId = (w2 as { id: string }).id;
  const expTest: Record<string, string> = {};
  for (const org of ORGS) {
    const m = await loadWeekOrgResultStates([weekId], org, "test");
    expTest[org] = m.get(weekId)?.status ?? "aggregating";
  }

  console.log("[A] 카드 계산 — 테스트 사용자 success/fail vs 운영 사용자 성장(집계 중) (same org/W2)");
  let sampleTestKeys: string | null = null;
  let sampleOperKeys: string | null = null;
  const allStatuses = new Set<string>();
  const collect = (cards: Array<Record<string, unknown>>) => { for (const c of cards) allStatuses.add(String(c.userWeekStatus)); };
  for (const org of ORGS) {
    const testUser = await pickUser(org, "test", testIds);
    const operUser = await pickUser(org, "operating", testIds);
    if (testUser) {
      const cards = (await getCluster4WeeklyCardsForProfileUser(testUser)) as unknown as Array<Record<string, unknown>>;
      collect(cards);
      const c = w2Card(cards);
      const st = c?.userWeekStatus as string | undefined;
      // test scope=published(phalanx)+uws → success/fail. 그 외(aggregating)는 고객 카드에서 'tallying'(성장 집계 중).
      //   ⚠ 고객 카드 상태 어휘에 'aggregating'/'reviewing' 없음 — 모두 기존 tallying 로 매핑.
      const wantResult = expTest[org] === "published";
      ck(`[${org}] test 사용자 W2=${st} (scope test=${expTest[org]})`,
        c != null && (wantResult ? (st === "success" || st === "fail") : st === "tallying"));
      if (c) sampleTestKeys = Object.keys(c).sort().join(",");
    }
    if (operUser) {
      const cards = (await getCluster4WeeklyCardsForProfileUser(operUser)) as unknown as Array<Record<string, unknown>>;
      collect(cards);
      const c = w2Card(cards);
      const st = c?.userWeekStatus as string | undefined;
      // 운영 미검수 → 고객 카드는 'tallying'(성장 집계 중)으로 유지(삭제 금지·'검수 중' 노출 금지).
      ck(`[${org}] 운영 사용자 W2=${st} (성장 집계 중=tallying, 카드 유지)`, c != null && st === "tallying");
      if (c) sampleOperKeys = Object.keys(c).sort().join(",");
    }
  }
  if (sampleTestKeys && sampleOperKeys)
    ck("test/operating W2 카드 DTO 키 동일(분기 없는 동일 DTO)", sampleTestKeys === sampleOperKeys);
  // 고객 카드 어휘에 내부 상태 노출 금지.
  ck("고객 카드에 'aggregating'/'reviewing' 상태 없음(기존 어휘만)",
    !allStatuses.has("aggregating") && !allStatuses.has("reviewing"), `statuses={${[...allStatuses].join(",")}}`);

  console.log("\n[B] 관리자 목록(admin) — QA=test scope 표시 (phalanx=검수완료, oranke/encre=집계중)");
  for (const org of ORGS) {
    const data = await loadTeamPartsInfoWeeks({ organization: org, page: 1, pageSize: 100 });
    const item = data.items.find((i) => i.weekId === weekId);
    ck(`[${org}] 관리자 W2 reviewStatus=${item?.reviewStatus} == test-scope=${expTest[org]}`, item?.reviewStatus === expTest[org]);
  }

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — 실패 ${fail}건`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
