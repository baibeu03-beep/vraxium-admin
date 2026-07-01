/**
 * A1 "체크 대기 항목 즉시 검수" — 결정적 검증(seed→검수→완료/실패→cleanup).
 *
 *   테스트 스코프 항목만 시드/처리/삭제한다(실유저·실데이터 무접촉). 해피패스 완료는 실제 크롤러
 *   응답에 의존하지 않도록, 라우트가 위임하는 runDueProcessCheckSweep 에 crawlAndMatch 를 주입해
 *   결정적으로 검증한다(= 동일 함수·동일 scope='qa'). 래퍼 집계(runProcessCheckNow)도 함께 확인.
 *
 *   검증 항목(사용자 6단계 대응):
 *     1) 실행 전 체크 대기(테스트 due) 수
 *     2) 검수 실행(=runDueProcessCheckSweep, scope='qa', onlyIds)
 *     3) 결과(succeeded/failed) — HTTP 응답과 동형(direct)
 *     4) 실행 후 '체크 완료' 수 증가(status='completed') + 대기 수 감소
 *     5) DB status='completed'(보드 GET 가 읽는 SoT)로 화면 반영 근거
 *     6) 실패 항목은 status='pending' 유지 + 사유(last_error) 기록
 *
 *   npx tsx --env-file=.env.local scripts/verify-qa-run-now-process-check.ts
 */
import { createClient } from "@supabase/supabase-js";
import { runDueProcessCheckSweep } from "@/lib/processCheckDueSweep";
import { runProcessCheckNow } from "@/lib/qaRunNow";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });

let pass = 0,
  fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`${ok ? "✅" : "❌"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

const STATUS = "process_check_statuses";
const RECIP = "process_check_review_recipients";
const LOGS = "process_check_logs";

async function main() {
  // 시드 좌표: 기존 test 행에서 유효 FK(act_id·week_id·line_group_id·org·hub)를 통째로 빌려오고,
  //   충돌 회피를 위해 week_id 만 다른 값 2개로 바꿔 둔다((org,hub,act,week) 조합이 기존과 달라짐).
  const { data: tmpl } = await sb
    .from(STATUS)
    .select("act_id,week_id,line_group_id,organization_slug,hub")
    .eq("scope_mode", "test")
    .not("act_id", "is", null)
    .not("line_group_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (!tmpl) {
    console.log("⚠ 시드 템플릿(test status 행) 없음 — 검증 skip");
    process.exit(0);
  }
  const ORG = tmpl.organization_slug as string;
  const HUB = tmpl.hub as string;
  // 테스트 크루(템플릿 org 소속) — 매칭 스텁/스코프 가드용.
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const ids = (markers ?? []).map((r) => r.user_id);
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id,organization_slug")
    .in("user_id", ids)
    .eq("organization_slug", ORG)
    .limit(1);
  const crew = (profs ?? [])[0];
  if (!crew) {
    console.log(`⚠ ${ORG} 테스트 크루 없음 — 검증 skip`);
    process.exit(0);
  }
  // 템플릿과 다른 week_id 2개(충돌 회피). weeks 에서 임의 2개.
  const { data: weekRows } = await sb
    .from("weeks")
    .select("id")
    .neq("id", tmpl.week_id)
    .limit(2);
  const freshWeeks = (weekRows ?? []).map((w) => w.id);
  if (freshWeeks.length < 2) {
    console.log("⚠ 여분 week 부족 — 검증 skip");
    process.exit(0);
  }
  const past = new Date(Date.now() - 86_400_000).toISOString();

  const seedRow = (weekId: string) => ({
    organization_slug: ORG,
    hub: HUB,
    week_id: weekId,
    act_id: tmpl.act_id,
    line_group_id: tmpl.line_group_id,
    status: "pending",
    scope_mode: "test",
    scheduled_check_at: past,
    review_link: "https://cafe.naver.com/qa-run-now-seed",
    attempt_count: 0,
  });

  // cleanup 기준 — 사전 로그 id 집합(self-clean).
  const { data: preLogs } = await sb.from(LOGS).select("id").eq("organization_slug", ORG);
  const preLogIds = new Set((preLogs ?? []).map((l) => l.id));

  let happyId: string | null = null;
  let failId: string | null = null;
  try {
    // 1) 실행 전 테스트 due 수(baseline).
    const before = await runProcessCheckNow({ dryRun: true, actor: "verify" });
    const baseDue = before.dueTest;
    ck("[1] 실행 전 테스트 due 집계 가능", Number.isFinite(baseDue), `dueTest=${baseDue}`);

    // 시드 2건(해피=freshWeeks[0] / 실패=freshWeeks[1]).
    const ins = await sb.from(STATUS).insert([seedRow(freshWeeks[0]), seedRow(freshWeeks[1])]).select("id,week_id");
    if (ins.error) {
      console.log(`⚠ 시드 insert 실패(${ins.error.message}) — 검증 skip(무변경)`);
      process.exit(0);
    }
    happyId = (ins.data ?? []).find((r) => r.week_id === freshWeeks[0])?.id ?? null;
    failId = (ins.data ?? []).find((r) => r.week_id === freshWeeks[1])?.id ?? null;
    ck("[seed] 테스트 대기 2건 시드", Boolean(happyId && failId), `happy=${happyId} fail=${failId}`);

    // 시드 후 due 가 +2.
    const afterSeed = await runProcessCheckNow({ dryRun: true, actor: "verify" });
    ck("[1] 시드 후 테스트 due +2", afterSeed.dueTest === baseDue + 2, `${baseDue}→${afterSeed.dueTest}`);

    // 2~3) 해피패스 검수 — 주입 crawlAndMatch(테스트 크루 매칭) → 완료.
    const okSweep = await runDueProcessCheckSweep({
      scope: "qa",
      onlyIds: [happyId!],
      accrue: null, // 포인트 적립 격리(검증 무관)
      crawlAndMatch: async () => ({
        matched: [{ userId: crew.user_id, nickname: "qa-tester" }],
        review: [],
      }),
    });
    ck("[2-3] 검수 실행 결과 succeeded=1·failed=0", okSweep.succeeded === 1 && okSweep.failed === 0, JSON.stringify({ s: okSweep.succeeded, f: okSweep.failed }));

    // 4-5) status='completed' 전환(보드 GET SoT).
    const { data: happyAfter } = await sb.from(STATUS).select("status,checked_crew_count").eq("id", happyId!).maybeSingle();
    ck("[4-5] 해피 항목 status='completed'", happyAfter?.status === "completed", `status=${happyAfter?.status}`);

    // 4) 완료 후 due 감소(해피 빠짐 → baseDue+1).
    const afterDone = await runProcessCheckNow({ dryRun: true, actor: "verify" });
    ck("[4] 완료 후 테스트 due 감소(+1만 남음)", afterDone.dueTest === baseDue + 1, `${afterSeed.dueTest}→${afterDone.dueTest}`);

    // 6) 실패 패스 — 주입 throw(크롤 실패) → status 유지 'pending' + last_error 기록.
    const badSweep = await runDueProcessCheckSweep({
      scope: "qa",
      onlyIds: [failId!],
      accrue: null,
      crawlAndMatch: async () => {
        throw new Error("crawl_failed(timeout): qa-seed");
      },
    });
    ck("[6] 실패 실행 결과 failed=1·succeeded=0", badSweep.failed === 1 && badSweep.succeeded === 0, JSON.stringify({ s: badSweep.succeeded, f: badSweep.failed }));
    const { data: failAfter } = await sb.from(STATUS).select("status,last_error").eq("id", failId!).maybeSingle();
    ck("[6] 실패 항목 status='pending' 유지 + 사유 기록", failAfter?.status === "pending" && Boolean(failAfter?.last_error), `status=${failAfter?.status} err=${(failAfter?.last_error ?? "").slice(0, 40)}`);

    // 래퍼 dry-run 집계 형태(완료 0·실패 0·대기=due).
    const dry = await runProcessCheckNow({ dryRun: true, actor: "verify" });
    ck("[래퍼] dry-run completedCount=0·stillPending=dueTest·failures=[]", dry.completedCount === 0 && dry.stillPendingCount === dry.dueTest && dry.failures.length === 0, `pending=${dry.stillPendingCount}/${dry.dueTest}`);
  } finally {
    // ── cleanup(전수): 시드 status·recipients·신규 logs 삭제 → 무흔적. ──
    const seededIds = [happyId, failId].filter((x): x is string => Boolean(x));
    if (seededIds.length) {
      await sb.from(RECIP).delete().in("ref_id", seededIds);
      await sb.from(STATUS).delete().in("id", seededIds);
    }
    const { data: postLogs } = await sb.from(LOGS).select("id").eq("organization_slug", ORG);
    const newLogIds = (postLogs ?? []).map((l) => l.id).filter((id) => !preLogIds.has(id));
    if (newLogIds.length) await sb.from(LOGS).delete().in("id", newLogIds);
    // 검증: 시드 흔적 제거됨.
    const { count: left } = await sb.from(STATUS).select("id", { count: "exact", head: true }).in("id", seededIds.length ? seededIds : ["00000000-0000-0000-0000-000000000000"]);
    ck("[cleanup] 시드 status 전수 삭제(무흔적)", (left ?? 0) === 0, `removed logs=${newLogIds.length}`);
  }

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
