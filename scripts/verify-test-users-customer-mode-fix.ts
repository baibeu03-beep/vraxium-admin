/**
 * verify-test-users-customer-mode-fix.ts  (READ-ONLY — write 0, snapshot 무접촉)
 *
 * 검증 목표(사용자 체크리스트):
 *   3. 두 진입경로의 실제 HTTP API 응답 비교
 *   4. direct summer-sim 결과 == HTTP ?demoUserId=X&mode=test 응답 일치
 *   + 수정 효과 입증: before(no-mode, snapshot) != after(mode=test, summer-sim)
 *
 *   경로 모델:
 *     · "크루 페이지로 보기"(수정 후) → 고객앱 URL ?admin=true&demoUserId=X&mode=test
 *         → 고객 프록시 fetch /api/cluster4/weekly-cards?userId=X&demoUserId=X&mode=test
 *     · "Vercel 직접 접속 + demoUserId + mode=test" → 동일 쿼리
 *     ⇒ 두 경로는 수정 후 쿼리 동치 → 동일 응답이어야 함.
 *
 *   비교 대상 HTTP:
 *     ADMIN(3000)  /api/cluster4/weekly-cards?demoUserId=X&mode=test           (E, 백엔드 SoT)
 *     FRONT(3001)  /api/cluster4/weekly-cards?userId=X&demoUserId=X&mode=test  (고객 프록시=실제 경로)
 *     FRONT(3001)  /api/cluster4/weekly-cards?userId=X&demoUserId=X            (수정 전 경로 — 대조)
 *   direct: getCluster4WeeklyCardsForProfileUser(uid, {effectiveFromOverride})  (C)
 *
 * 실행: npx tsx --env-file=.env.local scripts/verify-test-users-customer-mode-fix.ts [userId]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { TEST_SUMMER_SIM_EFFECTIVE_FROM } from "@/lib/lineAvailability";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const ADMIN = "http://localhost:3000";
const FRONT = "http://localhost:3001";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";

let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

// 표시 핵심 필드만 추린 안정 지문(주차별).
function fp(cards: Cluster4WeeklyCardDto[]): string {
  return JSON.stringify(
    [...cards]
      .sort((a, b) => (b.weekNumber ?? 0) - (a.weekNumber ?? 0))
      .map((c) => ({
        w: c.weekNumber,
        sk: (c as Record<string, unknown>).seasonKey ?? null,
        st: (c as Record<string, unknown>).statusLabel ?? (c as Record<string, unknown>).resultStatus ?? null,
        team: c.teamName ?? null,
        part: c.partName ?? null,
        pts: c.points ?? null,
        inj: (c as Record<string, unknown>).cumulativeInjeolmi ?? null,
        g: `${(c as Record<string, unknown>).growthNumerator ?? "?"}/${(c as Record<string, unknown>).growthDenominator ?? "?"}`,
        lines: (Array.isArray(c.lines) ? c.lines : []).map((l) => ({
          pt: l.partType,
          code: (l as Record<string, unknown>).lineCode ?? null,
          n: (l as Record<string, unknown>).numerator ?? null,
          d: (l as Record<string, unknown>).denominator ?? null,
          es: (l as Record<string, unknown>).enhancementStatus ?? null,
        })),
      })),
  );
}

async function getCards(base: string, qs: string): Promise<{ status: number; cards: Cluster4WeeklyCardDto[] }> {
  const res = await fetch(`${base}/api/cluster4/weekly-cards${qs}`, {
    headers: { "x-internal-api-key": INTERNAL_KEY },
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, cards: (j?.data ?? []) as Cluster4WeeklyCardDto[] };
}

async function pickUser(explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  const markers = ((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: { user_id: string }) => x.user_id);
  const { data } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,card_count")
    .in("user_id", markers.slice(0, 500))
    .order("card_count", { ascending: false })
    .limit(1);
  return data?.[0]?.user_id ?? markers[0] ?? null;
}

async function main() {
  const uid = await pickUser(process.argv[2]);
  if (!uid) { console.log("테스트 유저 없음"); process.exit(2); }
  const prof = (await sb.from("user_profiles").select("display_name,organization_slug").eq("user_id", uid).maybeSingle()).data;
  console.log(`\n대상: ${prof?.display_name ?? "?"} (${prof?.organization_slug ?? "?"})  uid=${uid}\n`);

  // C: direct summer-sim
  const C = await getCluster4WeeklyCardsForProfileUser(uid, { effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM });
  // E: admin HTTP mode=test
  const E = await getCards(ADMIN, `?demoUserId=${uid}&mode=test`);
  // FA: front proxy, 수정 후 "크루 페이지로 보기" 경로 (userId+demoUserId+mode=test)
  const FA = await getCards(FRONT, `?userId=${uid}&demoUserId=${uid}&mode=test`);
  // FV: front proxy, "Vercel 직접 접속 + demoUserId + mode=test" (동치)
  const FV = await getCards(FRONT, `?demoUserId=${uid}&mode=test`);
  // FB: front proxy, 수정 전 경로 (no mode) — 대조
  const FB = await getCards(FRONT, `?userId=${uid}&demoUserId=${uid}`);

  console.log(`HTTP status: E(admin)=${E.status} FA(front+mode)=${FA.status} FV(front direct+mode)=${FV.status} FB(front no-mode)=${FB.status}\n`);

  const fpC = fp(C), fpE = fp(E.cards), fpFA = fp(FA.cards), fpFV = fp(FV.cards), fpFB = fp(FB.cards);

  console.log(`카드 수: C=${C.length} E=${E.cards.length} FA=${FA.cards.length} FV=${FV.cards.length} FB=${FB.cards.length}\n`);

  ck("[4] direct summer-sim(C) == admin HTTP ?demoUserId&mode=test (E)", fpC === fpE);
  ck("[3] '크루 페이지로 보기'(수정후 FA) == 'Vercel 직접+mode=test'(FV)", fpFA === fpFV);
  ck("[3] 고객 프록시 mode=test(FA) == 백엔드 summer-sim(C)", fpFA === fpC,
     fpFA === fpC ? "" : "프록시 enrich 가 값 변형(테스트 유저 비파괴 기대)");
  ck("[수정효과] 수정전 no-mode(FB) != 수정후 mode=test(FA) — 실제로 뷰가 바뀜", fpFB !== fpFA,
     fpFB !== fpFA ? "divergence 가 mode 였음을 입증" : "차이 없음(예상과 다름)");

  // 차이 주차 수(수정 전후)
  const before = JSON.parse(fpFB) as Array<{ w: number }>;
  const after = JSON.parse(fpFA) as Array<{ w: number }>;
  let diffWeeks = 0;
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    if (JSON.stringify(before[i]) !== JSON.stringify(after[i])) diffWeeks++;
  }
  console.log(`\n  수정 전(no-mode) → 후(mode=test) 변경 주차 수: ${diffWeeks}/${after.length}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
