/**
 * 검증: 프로세스 체크 worker scope_mode 정합 + 검수 크루 0명 표시 + reviewerDebug.
 *
 *   A. 실데이터(read-only): encre/experience 테스트 행이 보드(test)에 pending+not_started 로 반영, direct==HTTP.
 *   B. 수정 증명(시드·net-zero, hub=info): 보드 mode=test 신청 → scope_mode='test' 저장(버그 수정 핵심),
 *      worker runOnce(스텁 크롤) 0매칭 → status='completed' · checked_crew_count=0(= "체크 완료(0명)"),
 *      reviewerDebug.resolutionStatus = no_comments / comments_found_no_match 분리, direct==HTTP.
 *   C. operating 무영향: operating 신청 → scope_mode='operating' · operating 보드 정상.
 *
 *   전제: dev 서버(localhost:3000) + v2/worker 마이그 적용.
 *   실행: npx tsx --env-file=.env.local scripts/verify-experience-reviewer-scope-fix.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getProcessCheckBoard, resolveProcessWeek } from "@/lib/adminProcessCheckData";
// @ts-expect-error — .mjs worker (런타임 import, 타입 선언 없음)
import { runOnce } from "./process-check-worker.mjs";

const BASE = "http://localhost:3000";
const EMAIL = "vanuatu.golden@gmail.com";
const ORG = "encre";
const TAG = "ZZ-pchk-scopefix";
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};
const findAct = (board: any, actId: string, partLabel?: string) =>
  (board.acts ?? []).find((a: any) => a.actId === actId && (partLabel ? a.partLabel === partLabel : true)) ?? null;

async function adminCookie() {
  const sb = createClient(URL, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await brow.auth.verifyOtp({
    email: EMAIL, token: (link as any).properties.email_otp, type: "magiclink",
  });
  const cap: any[] = [];
  const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) } });
  await srv.auth.setSession({
    access_token: (v as any).session.access_token,
    refresh_token: (v as any).session.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  const cookie = await adminCookie();
  const api = async (path: string, init: any = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) },
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  // ═══ A. 실데이터(read-only) — encre/experience 테스트 행 ═══
  console.log("── A. 실데이터(read-only): encre/experience 테스트 행 ──");
  const wTest = await resolveProcessWeek("test", "process-experience");
  const { data: realRows } = await supabaseAdmin
    .from("process_check_statuses")
    .select("id,act_id,team_id,status,scope_mode,week_id,attempt_count,last_attempt_at,last_error,checked_crew_count")
    .eq("organization_slug", ORG).eq("hub", "experience").eq("week_id", wTest!.weekId!);
  const real = (realRows ?? [])[0] as any;
  if (!real) {
    ck("실 experience 테스트 행 존재", false, "행 없음 — A 스킵");
  } else {
    ck("[DB] scope_mode='test' 로 정정됨", real.scope_mode === "test", `scope_mode=${real.scope_mode}`);
    ck("[DB] status=pending · attempt=0 · last_error=null",
      real.status === "pending" && (real.attempt_count ?? 0) === 0 && !real.last_error,
      `status=${real.status} attempt=${real.attempt_count} err=${real.last_error}`);

    const dBoard = await getProcessCheckBoard("experience", ORG, real.team_id, "test", "team_all", null);
    const dAct = findAct(dBoard, real.act_id);
    ck("[direct] 보드(test)에 해당 액트 노출 + status=pending", !!dAct && dAct.status === "pending", dAct?.status);
    ck("[direct] reviewerDebug.resolutionStatus = not_started",
      dAct?.reviewerDebug?.resolutionStatus === "not_started", dAct?.reviewerDebug?.resolutionStatus);

    const hBoard = await api(`/api/admin/processes/check?hub=experience&org=${ORG}&team=${real.team_id}&scope=team_all&mode=test`);
    const hAct = findAct(hBoard.json.data, real.act_id);
    ck("[HTTP] 200 + 해당 액트 status=pending", hBoard.status === 200 && hAct?.status === "pending", `status=${hBoard.status}`);
    ck("[direct==HTTP] status·resolutionStatus 일치",
      dAct?.status === hAct?.status && dAct?.reviewerDebug?.resolutionStatus === hAct?.reviewerDebug?.resolutionStatus,
      `${dAct?.reviewerDebug?.resolutionStatus} vs ${hAct?.reviewerDebug?.resolutionStatus}`);
  }

  // ═══ B/C. 시드(hub=info, net-zero) ═══
  console.log("── B/C. 시드(hub=info, net-zero): scope_mode 저장 + worker 0명 완료 ──");
  await cleanup();
  const wInfoTest = await resolveProcessWeek("test", "process-info");
  const wInfoOp = await resolveProcessWeek("operating", "process-info");

  const { data: grp } = await supabaseAdmin.from("process_line_groups")
    .insert({ hub: "info", name: `${TAG} 라인급`, sort_order: 9999, is_active: true })
    .select("id").single();
  const groupId = (grp as any).id;
  const mkAct = async (name: string) => {
    const { data } = await supabaseAdmin.from("process_acts").insert({
      line_group_id: groupId, hub: "info", act_name: `${TAG} ${name}`, duration_minutes: 10,
      occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00",
      point_check: 1, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check",
      act_type: "required", is_active: true,
    }).select("id").single();
    return (data as any).id as string;
  };
  const actNoMatch = await mkAct("무매칭");
  const actReview = await mkAct("미매칭댓글");
  const actOp = await mkAct("운영");
  ck("시드 — 라인급 + 액트3", !!groupId && !!actNoMatch && !!actReview && !!actOp);

  const futureIso = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const reqTest = async (actId: string) =>
    api("/api/admin/processes/check", {
      method: "POST",
      body: JSON.stringify({ hub: "info", organization: ORG, act_id: actId, action: "request",
        review_link: "https://cafe.naver.com/x/1", scheduled_check_at: futureIso, mode: "test" }),
    });

  // (B1) 핵심 — mode=test 신청이 scope_mode='test' 로 저장되는가.
  const r1 = await reqTest(actNoMatch);
  ck("[HTTP] test 신청 201", r1.status === 201, `status=${r1.status} ${r1.json.error ?? ""}`);
  const rowOf = async (actId: string) => (await supabaseAdmin.from("process_check_statuses")
    .select("id,scope_mode,status,checked_crew_count,last_error,week_id")
    .eq("organization_slug", ORG).eq("hub", "info").eq("act_id", actId).maybeSingle()).data as any;
  const row1 = await rowOf(actNoMatch);
  ck("[수정 핵심] test 신청 → scope_mode='test' 저장", row1?.scope_mode === "test", `scope_mode=${row1?.scope_mode}`);
  ck("[수정 핵심] test 신청 → 테스트 주차(W13)에 저장", row1?.week_id === wInfoTest!.weekId, `week_id=${row1?.week_id}`);

  await reqTest(actReview);

  // (B2) worker 0매칭 → 완료(0명). 검수 시점 과거로 당긴 뒤 runOnce(스텁).
  await supabaseAdmin.from("process_check_statuses")
    .update({ scheduled_check_at: new Date(Date.now() - 3_600_000).toISOString() })
    .in("act_id", [actNoMatch, actReview]);

  const stub = (matched: any[], review: any[]) => async () => ({ matched, review });
  // actNoMatch: 댓글 0 → no_comments. actReview: 미매칭 댓글 1 → comments_found_no_match.
  const res1 = await runOnce({ sb: supabaseAdmin, now: Date.now(), onlyIds: [row1.id],
    crawlAndMatch: stub([], []), accrue: null, log: () => {} });
  const rowReview = await rowOf(actReview);
  const res2 = await runOnce({ sb: supabaseAdmin, now: Date.now(), onlyIds: [rowReview.id],
    crawlAndMatch: stub([], [{ nickname: "15기 어딘가대 홍길동", reason: "구형: 이름 후보 0명" }]), accrue: null, log: () => {} });
  ck("[worker] runOnce 처리(succeeded)", res1.succeeded === 1 && res2.succeeded === 1, `r1=${JSON.stringify(res1)} r2=${JSON.stringify(res2)}`);

  const row1c = await rowOf(actNoMatch);
  ck("[전이] 0매칭 → status='completed' · checked_crew_count=0 (= 체크 완료(0명))",
    row1c?.status === "completed" && row1c?.checked_crew_count === 0 && !row1c?.last_error,
    `status=${row1c?.status} cc=${row1c?.checked_crew_count} err=${row1c?.last_error}`);

  // (B3) 보드 reviewerDebug 분리 — direct + HTTP.
  const dInfo = await getProcessCheckBoard("info", ORG, null, "test", null, null);
  const dNo = findAct(dInfo, actNoMatch);
  const dRev = findAct(dInfo, actReview);
  ck("[direct] no_comments (0댓글/0매칭) 완료", dNo?.status === "completed" && dNo?.reviewerDebug?.resolutionStatus === "no_comments",
    `${dNo?.status}/${dNo?.reviewerDebug?.resolutionStatus}`);
  ck("[direct] comments_found_no_match (미매칭댓글1/매칭0)",
    dRev?.reviewerDebug?.resolutionStatus === "comments_found_no_match" && dRev?.reviewerDebug?.matchedCrewCount === 0
      && dRev?.reviewerDebug?.unmatchedCommentAuthors?.length === 1,
    `${dRev?.reviewerDebug?.resolutionStatus} matched=${dRev?.reviewerDebug?.matchedCrewCount} unmatched=${dRev?.reviewerDebug?.unmatchedCommentAuthors?.length}`);

  const hInfo = await api(`/api/admin/processes/check?hub=info&org=${ORG}&mode=test`);
  const hNo = findAct(hInfo.json.data, actNoMatch);
  const hRev = findAct(hInfo.json.data, actReview);
  ck("[direct==HTTP] no_comments 액트 일치",
    dNo?.status === hNo?.status && dNo?.reviewerDebug?.resolutionStatus === hNo?.reviewerDebug?.resolutionStatus
      && dNo?.checkedCrewCount === hNo?.checkedCrewCount,
    `cc d=${dNo?.checkedCrewCount} h=${hNo?.checkedCrewCount}`);
  ck("[direct==HTTP] comments_found_no_match 액트 일치",
    dRev?.reviewerDebug?.resolutionStatus === hRev?.reviewerDebug?.resolutionStatus
      && dRev?.reviewerDebug?.unmatchedCommentAuthors?.length === hRev?.reviewerDebug?.unmatchedCommentAuthors?.length,
    `${hRev?.reviewerDebug?.resolutionStatus}`);

  // ═══ C. operating 무영향 ═══
  console.log("── C. operating 경로 무영향 ──");
  const rOp = await api("/api/admin/processes/check", {
    method: "POST",
    body: JSON.stringify({ hub: "info", organization: ORG, act_id: actOp, action: "request",
      review_link: "https://cafe.naver.com/x/2", scheduled_check_at: futureIso }), // mode 미부착 = operating
  });
  ck("[HTTP] operating 신청 201", rOp.status === 201, `status=${rOp.status}`);
  const rowOp = await rowOf(actOp);
  ck("[operating] scope_mode='operating' · 운영 주차 저장",
    rowOp?.scope_mode === "operating" && rowOp?.week_id === wInfoOp!.weekId,
    `scope_mode=${rowOp?.scope_mode} week=${rowOp?.week_id}`);
  const dOpBoard = await getProcessCheckBoard("info", ORG, null, "operating", null, null);
  const dOpAct = findAct(dOpBoard, actOp);
  ck("[operating 보드] 신청 액트 pending + reviewerDebug=not_started",
    dOpAct?.status === "pending" && dOpAct?.reviewerDebug?.resolutionStatus === "not_started", dOpAct?.status);

  await cleanup();
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

async function cleanup() {
  const g = (await supabaseAdmin.from("process_line_groups").select("id").eq("hub", "info").like("name", `${TAG}%`)).data ?? [];
  const ids = (g as any[]).map((x) => x.id);
  if (!ids.length) return;
  const acts = (await supabaseAdmin.from("process_acts").select("id").in("line_group_id", ids)).data ?? [];
  const actIds = (acts as any[]).map((x) => x.id);
  if (actIds.length) {
    const sts = (await supabaseAdmin.from("process_check_statuses").select("id").in("act_id", actIds)).data ?? [];
    const stIds = (sts as any[]).map((x) => x.id);
    if (stIds.length) await supabaseAdmin.from("process_check_review_recipients").delete().eq("source", "regular").in("ref_id", stIds);
    await supabaseAdmin.from("process_check_logs").delete().in("act_id", actIds);
    await supabaseAdmin.from("process_check_statuses").delete().in("act_id", actIds);
    await supabaseAdmin.from("process_acts").delete().in("id", actIds);
  }
  await supabaseAdmin.from("process_line_groups").delete().in("id", ids);
}

main().catch((e) => { console.error(e); process.exit(1); });
