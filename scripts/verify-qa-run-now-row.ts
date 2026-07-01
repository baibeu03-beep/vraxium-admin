/**
 * A1(행 단위) "자동 검수" — 결정적 검증.
 *   미래로 예약된(scheduled_check_at > now) 테스트 체크 대기 항목을 시드해:
 *     [A] 기존 자동 sweep(시각 게이트 유지)은 그 항목을 건드리지 않는다(운영 스케줄 불변).
 *     [B] ignoreSchedule 우회 + 주입 매칭 → 검수 예정 시각 전이라도 '체크 완료'(pending→completed).
 *     [C] 래퍼 runProcessCheckRowNow 검증: 이미 완료/실유저(운영)차단(422)/없음(404)/검수링크없음.
 *   테스트 스코프만 시드·처리·삭제(실데이터 무접촉). 무흔적 cleanup.
 *
 *   npx tsx --env-file=.env.local scripts/verify-qa-run-now-row.ts
 */
import { createClient } from "@supabase/supabase-js";
import {
  runDueProcessCheckSweep,
  findDueProcessCheckItems,
} from "@/lib/processCheckDueSweep";
import { runProcessCheckRowNow } from "@/lib/qaRunNow";

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
  const { data: tmpl } = await sb
    .from(STATUS)
    .select("act_id,line_group_id,organization_slug,hub")
    .eq("scope_mode", "test")
    .not("line_group_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (!tmpl) return console.log("⚠ 시드 템플릿 없음 — skip"), process.exit(0);
  const ORG = tmpl.organization_slug as string;
  const HUB = tmpl.hub as string;
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const ids = (markers ?? []).map((r) => r.user_id);
  const { data: profs } = await sb.from("user_profiles").select("user_id,organization_slug").in("user_id", ids).eq("organization_slug", ORG).limit(1);
  const crew = (profs ?? [])[0];
  if (!crew) return console.log(`⚠ ${ORG} 테스트 크루 없음 — skip`), process.exit(0);
  const { data: weekRows } = await sb.from("weeks").select("id").limit(3);
  const weeks = (weekRows ?? []).map((w) => w.id);
  if (weeks.length < 2) return console.log("⚠ week 부족 — skip"), process.exit(0);

  const future = new Date(Date.now() + 2 * 86_400_000).toISOString(); // 검수 예정 시각 = 미래
  const seed = (weekId: string, link: string | null) => ({
    organization_slug: ORG, hub: HUB, week_id: weekId, act_id: tmpl.act_id, line_group_id: tmpl.line_group_id,
    status: "pending", scope_mode: "test", scheduled_check_at: future, review_link: link, attempt_count: 0,
  });

  const { data: preLogs } = await sb.from(LOGS).select("id").eq("organization_slug", ORG);
  const preLogIds = new Set((preLogs ?? []).map((l) => l.id));

  let F: string | null = null, H: string | null = null;
  try {
    const ins = await sb.from(STATUS).insert([seed(weeks[0], "https://cafe.naver.com/qa-row-seed"), seed(weeks[1], null)]).select("id,week_id");
    if (ins.error) return console.log(`⚠ 시드 실패(${ins.error.message}) — skip`), process.exit(0);
    F = (ins.data ?? []).find((r) => r.week_id === weeks[0])?.id ?? null; // 미래예약·링크有
    H = (ins.data ?? []).find((r) => r.week_id === weeks[1])?.id ?? null; // 미래예약·링크無
    ck("[seed] 미래예약 테스트 대기 시드", Boolean(F && H), `F=${F} H=${H}`);

    // [A] 자동 스케줄 불변 — 시각 게이트 유지 sweep 은 미래 항목을 후보로 잡지 않는다.
    const dueNow = await findDueProcessCheckItems(new Date().toISOString());
    ck("[A] 기본 findDue 에 미래 항목 미포함", !dueNow.some((d) => d.id === F));
    const autoSweep = await runDueProcessCheckSweep({ scope: "qa", onlyIds: [F!], accrue: null });
    const { data: afterAuto } = await sb.from(STATUS).select("status,attempt_count").eq("id", F!).maybeSingle();
    ck("[A] 자동 sweep 미처리(status pending·attempt 0)", autoSweep.succeeded === 0 && afterAuto?.status === "pending" && (afterAuto?.attempt_count ?? 0) === 0);

    // [B] 우회 실행 — 검수 예정 시각 전이라도 즉시 검수 → 완료.
    const forced = await runDueProcessCheckSweep({
      scope: "qa", onlyIds: [F!], ignoreSchedule: true, ignoreRetryGate: true, accrue: null,
      crawlAndMatch: async () => ({ matched: [{ userId: crew.user_id, nickname: "qa-tester" }], review: [] }),
    });
    const { data: afterForce } = await sb.from(STATUS).select("status").eq("id", F!).maybeSingle();
    ck("[B] 우회 실행 → pending→completed(시각 전이라도)", forced.succeeded === 1 && afterForce?.status === "completed", `status=${afterForce?.status}`);

    // [C] 즉시 검수 = 크롤 결과와 무관하게 **항상 '체크 완료'**(테스트 행 한정).
    //     결과 code 3종(모두 완료 — 메시지 구분): confirmed | no_match | not_found.

    // [C1] 크롤 못 읽음(링크 없음/크롤러 미구성) 테스트 행 → 그래도 pending→completed(핵심 신동작).
    const noLink = await runProcessCheckRowNow({ statusId: H!, actor: "verify" });
    const { data: hAfter } = await sb.from(STATUS).select("status").eq("id", H!).maybeSingle();
    ck(
      "[C1] 인증 못 찾아도 체크 완료(pending→completed)",
      noLink.ok === true && hAfter?.status === "completed",
      `code=${noLink.code}/status=${hAfter?.status}`,
    );
    ck("[C1] code 는 3종 중 하나", ["confirmed", "no_match", "not_found"].includes(noLink.code), noLink.code);

    // [C2] 이미 완료된 행 재실행 → 멱등(ok=true·완료 유지).
    const already = await runProcessCheckRowNow({ statusId: F!, actor: "verify" });
    const { data: fAfter } = await sb.from(STATUS).select("status").eq("id", F!).maybeSingle();
    ck("[C2] 이미 완료 항목 재실행 → 멱등(완료 유지)", already.ok === true && fAfter?.status === "completed", `${already.code}/${fAfter?.status}`);

    // [C3] 운영(scope_mode!=='test') 행 안전 — 강제 완료 대상 아님(상태 불변·완료 안 됨).
    const { data: opRow } = await sb.from(STATUS).select("id,status").eq("scope_mode", "operating").eq("status", "pending").limit(1).maybeSingle();
    if (opRow) {
      const r = await runProcessCheckRowNow({ statusId: opRow.id, actor: "verify" });
      const { data: opAfter } = await sb.from(STATUS).select("status").eq("id", opRow.id).maybeSingle();
      ck("[C3] 운영 항목 → 처리 거부 + 상태 불변(완료 안 됨)", r.ok === false && r.code === "not_found" && opAfter?.status === "pending", `${r.code}/${opAfter?.status}`);
    } else {
      console.log("ℹ operating pending 행 없음 — 운영 안전 검증 skip");
    }

    // [C4] 없는 항목 → 처리 실패(not_found).
    const nf = await runProcessCheckRowNow({ statusId: "00000000-0000-0000-0000-000000000000", actor: "verify" });
    ck("[C4] 없는 항목 → not_found(실패)", nf.ok === false && nf.code === "not_found", nf.code);
  } finally {
    const seeded = [F, H].filter((x): x is string => Boolean(x));
    if (seeded.length) {
      await sb.from(RECIP).delete().in("ref_id", seeded);
      await sb.from(STATUS).delete().in("id", seeded);
    }
    const { data: postLogs } = await sb.from(LOGS).select("id").eq("organization_slug", ORG);
    const newLogIds = (postLogs ?? []).map((l) => l.id).filter((id) => !preLogIds.has(id));
    if (newLogIds.length) await sb.from(LOGS).delete().in("id", newLogIds);
    const { count: left } = await sb.from(STATUS).select("id", { count: "exact", head: true }).in("id", seeded.length ? seeded : ["00000000-0000-0000-0000-000000000000"]);
    ck("[cleanup] 시드 전수 삭제(무흔적)", (left ?? 0) === 0, `removed logs=${newLogIds.length}`);
  }

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
