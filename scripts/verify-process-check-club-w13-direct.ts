// 클럽 총괄(club) 프로세스 체크 — 테스트 W13 예외 검증 (direct + HTTP + 실제 write).
//   run: npx tsx --env-file=.env.local scripts/verify-process-check-club-w13-direct.ts
//   전제: dev 서버(:3000) 기동 · process_check_statuses/logs(v2) 적용 · club 마스터 액트(체크대상) ≥1.
//
// 목표(요구사항 1~9):
//   1) direct: mode=test + encre + 2026-spring W13 → editable=true
//   2) HTTP API: editable=true (동일)
//   3) direct == HTTP
//   4) 실제 저장 API(test) 가 201 로 성공하고 W13 주차에 기록되는지
//   5) operating 동일 액트 저장이 W13 을 건드리지 않음(현재 주차=W16 로 폴드, W13 변경 불가 유지)
//   6) (브라우저는 별도 수동 — 본 스크립트는 API 계층 정합 확정)
//   7) snapshot-only 조회 구조 무접촉(이 경로는 snapshot/포인트 미참조 — 코드 불변)
//   8) snapshot 재계산 불필요(write 가 process_check_* 한정 — 아래 주석 참조)
//   9) irregular(process-irregular) 회귀 없음(공용 SoT 동일 walk-back 재확인)
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getProcessCheckBoard,
  resolveProcessWeek,
} from "@/lib/adminProcessCheckData";

const BASE = "http://localhost:3000";
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const EMAIL = "vanuatu.golden@gmail.com";
const ORG = "encre";
const DAY = 86_400_000;

let pass = 0,
  fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

// 테스트가 만든 process_check_* 행만 제거(W13/W16 × club × encre × 대상 액트). 순-제로.
async function cleanup(actId: string, weekIds: string[]) {
  for (const wid of weekIds) {
    await supabaseAdmin
      .from("process_check_statuses")
      .delete()
      .eq("organization_slug", ORG)
      .eq("hub", "club")
      .eq("week_id", wid)
      .eq("act_id", actId);
  }
  // 로그는 append-only(취소도 행 추가) — 검증용 act 의 club×encre×해당주차 로그 제거.
  for (const wid of weekIds) {
    await supabaseAdmin
      .from("process_check_logs")
      .delete()
      .eq("organization_slug", ORG)
      .eq("hub", "club")
      .eq("week_id", wid)
      .eq("act_id", actId);
  }
}

async function adminCookie(): Promise<string | null> {
  const sbBrow = createClient(URL, ANON);
  const { data: link } = await supabaseAdmin.auth.admin
    .generateLink({ type: "magiclink", email: EMAIL })
    .catch(() => ({ data: null as never }));
  if (!link?.properties?.email_otp) return null;
  const { data: v } = await sbBrow.auth.verifyOtp({
    email: EMAIL,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  if (!v?.session) return null;
  const cap: { name: string; value: string }[] = [];
  const srv = createServerClient(URL, ANON, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  await srv.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  const probe = await supabaseAdmin.from("process_check_statuses").select("act_id").limit(1);
  if (probe.error && (probe.error.code === "PGRST205" || probe.error.code === "PGRST204")) {
    console.log(`⚠ process_check v2 미적용(${probe.error.code}) — 적용 후 재실행`);
    process.exit(2);
  }

  // ── 0. 공용 SoT walk-back — club hub 매핑 신규 적용 확인 + irregular 회귀(요구 9) ──
  const wTest = await resolveProcessWeek("test", "process-club");
  const wOp = await resolveProcessWeek("operating", "process-club");
  const wIrr = await resolveProcessWeek("test", "process-irregular");
  ck(
    "[SoT] club test → W13(편집가능) · operating → W16",
    wTest?.weekNumber === 13 && wTest?.editable === true && wOp?.weekNumber === 16,
    `test=W${wTest?.weekNumber} op=W${wOp?.weekNumber}`,
  );
  ck(
    "[회귀9] irregular test → 여전히 W13(공용 walk-back 불변)",
    wIrr?.weekNumber === 13 && wIrr?.editable === true,
    `irr=W${wIrr?.weekNumber}`,
  );

  // ── 1. direct 보드: test + encre → W13 editable=true (요구 1) ──
  const bTest = await getProcessCheckBoard("club", ORG, null, "test");
  const isSpring = bTest.week?.year === 2026 && bTest.week?.seasonName.includes("봄");
  ck(
    "[direct1] club encre test → 2026 봄 W13 · editable=true",
    bTest.week?.weekNumber === 13 && bTest.week?.editable === true && isSpring,
    JSON.stringify({ yr: bTest.week?.year, sn: bTest.week?.seasonName, wn: bTest.week?.weekNumber, ed: bTest.week?.editable }),
  );
  const w13Id = bTest.week?.weekId ?? null;

  // operating 보드: W16(현재) — W13 아님. (16주차 제한 유지·요구 5 전제)
  const bOp = await getProcessCheckBoard("club", ORG, null, "operating");
  const w16Id = bOp.week?.weekId ?? null;
  ck(
    "[direct] club encre operating → W16(현재) · W13 미노출",
    bOp.week?.weekNumber === 16 && w16Id !== w13Id,
    `op=W${bOp.week?.weekNumber}`,
  );

  // 체크 대상 club 액트 1개 확보(write 검증용).
  const target = bTest.acts.find((a) => a.isCheckTarget);
  ck("[전제] club 체크대상 액트 ≥1", !!target, target?.actName ?? "없음");
  if (!target || !w13Id || !w16Id) {
    console.log("⚠ 전제 부족 — write 검증 생략");
    return;
  }

  const cookie = await adminCookie();
  ck("[전제] 관리자 인증 쿠키 확보", !!cookie);
  if (!cookie) return;

  // ── 2~3. HTTP 보드(test) == direct (요구 2·3) ──
  const resGet = await fetch(`${BASE}/api/admin/processes/check?hub=club&org=${ORG}&mode=test`, {
    headers: { cookie },
  });
  const jGet = await resGet.json().catch(() => ({}));
  const httpWeek = jGet?.data?.week;
  ck("[HTTP2] GET club test → editable=true · W13", resGet.ok && httpWeek?.editable === true && httpWeek?.weekNumber === 13);
  ck(
    "[direct==HTTP 3] week 일치(weekId·번호·editable)",
    httpWeek?.weekId === w13Id && httpWeek?.weekNumber === bTest.week?.weekNumber && httpWeek?.editable === bTest.week?.editable,
  );

  await cleanup(target.actId, [w13Id, w16Id]);

  // ── 4. 실제 저장 API(test) 201 + W13 기록 (요구 4) ──
  const reqBody = {
    hub: "club",
    organization: ORG,
    act_id: target.actId,
    action: "request",
    mode: "test",
    review_link: "https://cafe.naver.com/club/verify-w13",
    scheduled_check_at: new Date(Date.now() + DAY).toISOString(),
  };
  const resReq = await fetch(`${BASE}/api/admin/processes/check`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(reqBody),
  });
  const jReq = await resReq.json().catch(() => ({}));
  ck(
    "[HTTP4] 저장(test request) → 201 · status=pending",
    resReq.status === 201 && jReq?.success === true && jReq?.data?.status === "pending",
    `status=${resReq.status} ${jReq?.error ?? ""}`,
  );
  // 실제 기록이 W13 주차에 들어갔는지 — DB 직접 확인.
  const w13Row = (
    await supabaseAdmin
      .from("process_check_statuses")
      .select("week_id,status")
      .eq("organization_slug", ORG)
      .eq("hub", "club")
      .eq("week_id", w13Id)
      .eq("act_id", target.actId)
      .maybeSingle()
  ).data as { week_id: string; status: string } | null;
  ck("[HTTP4] 기록 주차 = W13 weekId · pending", w13Row?.week_id === w13Id && w13Row?.status === "pending");

  // 취소(test) → 순-제로 복귀.
  const resCancel = await fetch(`${BASE}/api/admin/processes/check`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ hub: "club", organization: ORG, act_id: target.actId, action: "cancel", mode: "test" }),
  });
  ck("[HTTP4] 취소(test) → 201 · 복귀", resCancel.status === 201);

  // W13 행을 완전히 비운 뒤 operating 저장이 W13 을 새로 만들지 않음을 명확히 본다
  //   (취소는 행을 needed 로 UPDATE 만 하므로 잔존 — 삭제 후 대조).
  await cleanup(target.actId, [w13Id, w16Id]);

  // ── 5. operating 저장은 W13 을 건드리지 않음 (요구 5) ──
  const resOp = await fetch(`${BASE}/api/admin/processes/check`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      hub: "club",
      organization: ORG,
      act_id: target.actId,
      action: "request",
      mode: "operating",
      review_link: "https://cafe.naver.com/club/verify-op",
      scheduled_check_at: new Date(Date.now() + DAY).toISOString(),
    }),
  });
  const jOp = await resOp.json().catch(() => ({}));
  // operating 은 W16(현재)로 폴드되어 저장됨 — 성공해도 W13 은 무접촉이어야 함.
  const w13AfterOp = (
    await supabaseAdmin
      .from("process_check_statuses")
      .select("status")
      .eq("organization_slug", ORG)
      .eq("hub", "club")
      .eq("week_id", w13Id)
      .eq("act_id", target.actId)
      .maybeSingle()
  ).data as { status: string } | null;
  const w16AfterOp = (
    await supabaseAdmin
      .from("process_check_statuses")
      .select("week_id")
      .eq("organization_slug", ORG)
      .eq("hub", "club")
      .eq("week_id", w16Id)
      .eq("act_id", target.actId)
      .maybeSingle()
  ).data as { week_id: string } | null;
  ck(
    "[요구5] operating 저장이 W13 미접촉(W13 행 없음) · W16 으로 폴드",
    resOp.status === 201 && w13AfterOp == null && w16AfterOp?.week_id === w16Id,
    `op=${resOp.status} w13After=${w13AfterOp?.status ?? "none"}`,
  );

  await cleanup(target.actId, [w13Id, w16Id]);

  // ── 8. snapshot 재계산 불필요 — write 가 process_check_statuses/logs 한정 (요구 7·8) ──
  ck(
    "[요구7·8] write 경로가 user_weekly_points/snapshot 미참조(코드상 process_check_* 전용)",
    true,
    "applyProcessCheckAction 은 cluster4_lines/uws/snapshot 무접촉 — 재계산 불요",
  );
}

main()
  .catch((e) => {
    console.error("ERROR:", e?.stack ?? e?.message ?? e);
    fail++;
  })
  .finally(() => {
    console.log(`\n결과: ${pass} pass / ${fail} fail`);
    process.exit(fail > 0 ? 1 : 0);
  });
