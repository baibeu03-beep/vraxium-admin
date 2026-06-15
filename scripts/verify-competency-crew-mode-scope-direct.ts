/**
 * READ-ONLY 검증(direct): 실무 역량(practical-competency) 라인 개설의 org + mode 스코프.
 *   npx tsx --env-file=.env.local scripts/verify-competency-crew-mode-scope-direct.ts
 *
 * 검증 경로(4 API + 집계):
 *   1) 크루 검색/자동매칭 = cafe-line-crew loadScopedCrews(org+mode) — 누설/겹침 0.
 *   2) 활동 크루 집계/결과 = getCompetencyApplicationSummary/getCompetencyLineResults(org,week,mode)
 *      → test 모드에 실사용자 0, operating 모드에 테스트계정 0.
 *   3) 수동 추가 가드 = assertUserIdsInScope (operating+테스트 / test+실사용자 → 422).
 *   4) 라인 타깃 가드 = resolveUserScope 동일 축(assertApprovedApplicationsInScope 와 동일 판정).
 */
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { loadCrewRecords } from "@/lib/cluster4CafeLineMatch";
import { resolveUserScope, assertUserIdsInScope } from "@/lib/userScope";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import {
  getCompetencyApplicationSummary,
  getCompetencyLineResults,
} from "@/lib/adminCompetencyApplications";
import {
  describeWeekByStartMs,
  getOpenableWeekStartMs,
} from "@/lib/cluster4WeekPolicy";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ORGS = ["oranke", "encre", "phalanx"] as const;
let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string) => {
  console.log(`  ${cond ? "✓" : "✗"} ${label} ${cond ? "" : "❌"}`);
  cond ? pass++ : fail++;
};
const expectThrow = (label: string, fn: () => void) => {
  try {
    fn();
    ok(false, `${label} — 통과되면 안 됨`);
  } catch (e) {
    ok((e as { status?: number })?.status === 422, `${label} → 422`);
  }
};
const expectOk = (label: string, fn: () => void) => {
  try {
    fn();
    ok(true, `${label} → 통과`);
  } catch (e) {
    ok(false, `${label} — 막히면 안 됨: ${(e as Error).message}`);
  }
};

async function openableWeekId(): Promise<string | null> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const ms = getOpenableWeekStartMs(todayIso);
  const info = ms != null ? describeWeekByStartMs(ms) : null;
  if (!info) return null;
  const { data } = await sb
    .from("weeks")
    .select("id")
    .eq("iso_year", info.isoYear)
    .eq("iso_week", info.isoWeek)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function main() {
  const testIds = await fetchTestUserMarkerIds();
  console.log("test_user_markers 총:", testIds.size);
  const weekId = await openableWeekId();
  console.log("개설 대상 주차 weekId:", weekId);

  // HTTP 검증이 direct == HTTP 를 비교할 수 있도록 per-org 기대값 스냅샷 기록.
  const snapshot: Record<
    string,
    { operating: { activeCrews: number; userIds: string[] }; test: { activeCrews: number; userIds: string[] } }
  > = {};

  for (const org of ORGS) {
    console.log(`\n=== org='${org}' ===`);

    // 1) 크루 검색/자동매칭 모집단 — loadScopedCrews(org, mode) 와 동일 경로.
    const crews = await loadCrewRecords(org);
    const opScope = await resolveUserScope("operating", org);
    const tsScope = await resolveUserScope("test", org);
    const op = opScope.filter(crews, (c) => c.userId);
    const ts = tsScope.filter(crews, (c) => c.userId);
    ok(op.every((c) => !testIds.has(c.userId)), `[검색] operating(${op.length}) 테스트계정 0`);
    ok(ts.every((c) => testIds.has(c.userId)), `[검색] test(${ts.length}) 실사용자 0`);
    ok(
      op.every((c) => !ts.some((t) => t.userId === c.userId)),
      `[검색] operating∩test 겹침 0`,
    );

    // 2) 활동 크루 집계/결과 모드 분리.
    if (weekId) {
      const sumOp = await getCompetencyApplicationSummary(org, weekId, "operating");
      const sumTs = await getCompetencyApplicationSummary(org, weekId, "test");
      const resOp = await getCompetencyLineResults(org, weekId, "operating");
      const resTs = await getCompetencyLineResults(org, weekId, "test");
      ok(
        resOp.every((r) => !testIds.has(r.userId)),
        `[집계] operating 결과(${resOp.length}) 테스트계정 0`,
      );
      ok(
        resTs.every((r) => testIds.has(r.userId)),
        `[집계] test 결과(${resTs.length}) 실사용자 0`,
      );
      ok(
        sumOp.activeCrews === resOp.length && sumTs.activeCrews === resTs.length,
        `[집계] activeCrews=results 길이(op ${sumOp.activeCrews}/${resOp.length}, ts ${sumTs.activeCrews}/${resTs.length})`,
      );
      // 모드를 안 줬을 때(기본 operating)와 operating 명시가 동일해야(레거시 호환).
      const sumDefault = await getCompetencyApplicationSummary(org, weekId);
      ok(
        sumDefault.activeCrews === sumOp.activeCrews,
        `[집계] mode 기본값=operating (default ${sumDefault.activeCrews} == op ${sumOp.activeCrews})`,
      );
      snapshot[org] = {
        operating: { activeCrews: sumOp.activeCrews, userIds: resOp.map((r) => r.userId).sort() },
        test: { activeCrews: sumTs.activeCrews, userIds: resTs.map((r) => r.userId).sort() },
      };
    }
  }

  writeFileSync(
    "claudedocs/verify-competency-mode-scope-direct.json",
    JSON.stringify({ weekId, snapshot }, null, 2),
  );
  console.log("\n[direct 스냅샷 기록] claudedocs/verify-competency-mode-scope-direct.json");

  // 3·4) 수동 추가 / 라인 타깃 가드 판정(operating↔test 혼입 422).
  console.log(`\n=== 가드(수동추가·라인타깃) ===`);
  const testId = [...testIds][0];
  const { data } = await sb
    .from("user_profiles")
    .select("user_id")
    .eq("organization_slug", "oranke");
  const realId = (data ?? [])
    .map((r: { user_id: string }) => r.user_id)
    .find((id: string) => !testIds.has(id));
  const op = await resolveUserScope("operating", "oranke");
  const ts = await resolveUserScope("test", "oranke");
  expectOk("operating + 실사용자", () => assertUserIdsInScope(op, [realId!]));
  expectThrow("operating + 테스트계정", () => assertUserIdsInScope(op, [testId]));
  expectOk("test + 테스트계정", () => assertUserIdsInScope(ts, [testId]));
  expectThrow("test + 실사용자", () => assertUserIdsInScope(ts, [realId!]));
  expectOk("0명(승인 대상 없음) → 양쪽 통과(op)", () => assertUserIdsInScope(op, []));
  expectOk("0명(승인 대상 없음) → 양쪽 통과(ts)", () => assertUserIdsInScope(ts, []));

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
