// 변동 액트 — 주차 드롭다운 + 검수 시점 자동 완료 + 통계(전원/부분) + 과거 주차 가드 검증.
//   run: npx tsx --env-file=.env.local scripts/verify-irregular-week-autocomplete.ts
//   전제: dev 서버(:3000) + 2026-06-15_process_irregular_acts.sql 적용.
//
// 검증 항목:
//   - 주차 목록 = 현재 시즌 W1~현재주차(미래 주차 미노출) · 현재 주차만 editable.
//   - 검수 시점 경과 review_request = 보드/통계 '체크 완료'(조회 시점 파생) · DB status 는 pending 유지.
//   - 통계 전원(all)/부분(partial) 카운트 정확.
//   - 과거 주차 행 complete/delete = 409(조회 전용).
//   - direct == HTTP(현재/과거 주차 GET) · operating/test 분리.
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  getIrregularBoard,
  completeIrregularAct,
  deleteIrregularAct,
} from "@/lib/adminProcessIrregularData";

const BASE = "http://localhost:3000";
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const EMAIL = "vanuatu.golden@gmail.com";
const ORG = "oranke";
const TAG = "ZZ-irr-week";

let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cleanup() {
  const rows = (await supabaseAdmin.from("process_irregular_acts").select("id").like("act_name", `${TAG}%`)).data as { id: string }[] | null;
  if (rows?.length) await supabaseAdmin.from("process_check_review_recipients").delete().in("ref_id", rows.map((r) => r.id));
  await supabaseAdmin.from("process_irregular_acts").delete().like("act_name", `${TAG}%`);
}

// 행 직접 삽입(스케줄 과거 등 createX 검증을 우회해야 하는 시나리오용).
async function insertRow(input: {
  weekId: string;
  kind: "review_request" | "manual_grant";
  crew: "all" | "partial";
  status: "pending" | "completed";
  scheduledIso: string | null;
  adminName: string;
  suffix: string;
}): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("process_irregular_acts")
    .insert({
      organization_slug: ORG,
      week_id: input.weekId,
      kind: input.kind,
      act_name: `${TAG} ${input.suffix}`,
      applicant_admin_id: null,
      applicant_admin_name: input.adminName,
      target_user_id: null,
      target_user_name: null,
      scope_mode: "operating",
      duration_minutes: 10,
      reason: "검증",
      point_a: input.crew === "all" ? 3 : 2,
      point_b: input.crew === "all" ? 2 : 0,
      point_c: 0,
      crew_reaction: input.crew,
      review_link: input.kind === "review_request" ? "https://cafe.naver.com/irr/week" : null,
      scheduled_check_at: input.scheduledIso,
      status: input.status,
      completed_at: input.status === "completed" ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`insertRow: ${error.message}`);
  return (data as { id: string }).id;
}

async function main() {
  const probe = await supabaseAdmin.from("process_irregular_acts").select("id").limit(1);
  if (probe.error) { console.log(`⚠ 마이그레이션 미적용(${probe.error.code}) — 적용 후 재실행`); process.exit(2); }

  await cleanup();

  // ── 1. 주차 목록(operating) — 현재 시즌 W1~현재주차 · 현재 주차만 editable ──
  const board = await getIrregularBoard(ORG, "operating");
  const current = board.weeks.find((w) => w.isCurrent);
  ck("[주차] weeks 목록 비어있지 않음 + 현재 주차 존재", board.weeks.length > 0 && !!current, `weeks=${board.weeks.length}`);
  ck("[주차] selectedWeekId == 현재 주차 weekId · editable=true(기본)", !!current && board.selectedWeekId === current!.weekId && board.editable === true);
  // 미래 주차 미노출 — 모든 옵션의 주차번호 <= 현재 주차번호.
  const maxNo = Math.max(...board.weeks.map((w) => w.weekNumber));
  ck("[주차] 미래 주차 없음(최대 주차번호 == 현재 주차)", !!current && maxNo === current!.weekNumber, `max=${maxNo} cur=${current?.weekNumber}`);
  // 휴식/활동 상태 라벨 형식.
  ck("[주차] 상태 라벨 = 공식 활동/휴식 주차", board.weeks.every((w) => w.statusLabel === (w.isOfficialRest ? "공식 휴식 주차" : "공식 활동 주차")));

  const currentWeekId = current?.weekId ?? null;
  const past = board.weeks.find((w) => !w.isCurrent && w.weekId);
  ck("[주차] 과거 주차(weekId 보유) 1개 이상 존재", !!past, past ? `${past.weekNumber}주차` : "none");
  if (!currentWeekId || !past?.weekId) { console.log("⚠ 현재/과거 주차 부족 — 시즌 초반일 수 있음"); await cleanup(); process.exit(2); }

  // ── 2. 검수 시점 자동 완료 — 과거 스케줄 pending review_request = 보드 '체크 완료'(DB 는 pending) ──
  const before = await getIrregularBoard(ORG, "operating");
  const autoId = await insertRow({
    weekId: currentWeekId, kind: "review_request", crew: "all", status: "pending",
    scheduledIso: new Date(Date.now() - 3600_000).toISOString(), adminName: "검증관리자", suffix: "자동완료(전원)",
  });
  const after = await getIrregularBoard(ORG, "operating");
  const autoRow = after.acts.find((a) => a.id === autoId);
  ck("[자동완료] 과거 검수시점 행 = 보드 status '완료' · autoCompleted=true · rawStatus=pending",
    !!autoRow && autoRow!.status === "completed" && autoRow!.autoCompleted === true && autoRow!.rawStatus === "pending");
  ck("[자동완료] 통계 완료 +1(파생 반영)", after.summary.completed === before.summary.completed + 1, `${before.summary.completed}→${after.summary.completed}`);
  const dbStatus = (await supabaseAdmin.from("process_irregular_acts").select("status").eq("id", autoId).single()).data as { status: string };
  ck("[자동완료] DB status 는 pending 유지(영구 write 없음)", dbStatus.status === "pending");

  // ── 3. 통계 전원/부분 — partial 행 추가 후 all/partial 카운트 ──
  await insertRow({ weekId: currentWeekId, kind: "manual_grant", crew: "partial", status: "completed", scheduledIso: new Date().toISOString(), adminName: "검증관리자", suffix: "수동(부분)" });
  const board3 = await getIrregularBoard(ORG, "operating");
  const allCnt = board3.acts.filter((a) => a.crewReaction === "all").length;
  const partCnt = board3.acts.filter((a) => a.crewReaction === "partial").length;
  ck("[통계] all/partial 카운트 = 실제 행 집계 일치", board3.summary.all === allCnt && board3.summary.partial === partCnt && allCnt >= 1 && partCnt >= 1, `all=${board3.summary.all} partial=${board3.summary.partial}`);
  ck("[통계] 전체 = 링크신청 + 수동부여", board3.summary.total === board3.summary.reviewRequest + board3.summary.manualGrant);

  // ── 4. 과거 주차 가드 — 과거 주차 행 complete/delete = 409 ──
  const pastId = await insertRow({ weekId: past.weekId, kind: "manual_grant", crew: "partial", status: "completed", scheduledIso: new Date().toISOString(), adminName: "검증관리자", suffix: "과거주차" });
  let comp409 = false, del409 = false;
  try { await completeIrregularAct(pastId, ORG, "operating"); } catch (e) { comp409 = (e as { status?: number })?.status === 409; }
  try { await deleteIrregularAct(pastId, ORG, "operating"); } catch (e) { del409 = (e as { status?: number })?.status === 409; }
  ck("[과거가드] 과거 주차 complete → 409", comp409);
  ck("[과거가드] 과거 주차 delete → 409", del409);
  // 가드로 삭제되지 않았는지 확인.
  const stillThere = (await supabaseAdmin.from("process_irregular_acts").select("id").eq("id", pastId).maybeSingle()).data;
  ck("[과거가드] 과거 주차 행 보존(write 0)", !!stillThere);

  // ── 5. direct == HTTP (현재/과거 주차 GET) ──
  const sbBrow = createClient(URL, ANON);
  const { data: link } = await supabaseAdmin.auth.admin.generateLink({ type: "magiclink", email: EMAIL }).catch(() => ({ data: null as never }));
  let cookie = "";
  if (link?.properties?.email_otp) {
    const { data: v } = await sbBrow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
    const cap: { name: string; value: string }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) } } as any);
    await srv.auth.setSession({ access_token: v!.session!.access_token, refresh_token: v!.session!.refresh_token });
    cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");
  }
  ck("[HTTP] 인증 쿠키 확보", !!cookie);

  // 현재 주차 GET — editable=true · selectedWeekId=current.
  const hCur = await fetch(`${BASE}/api/admin/processes/check/irregular?org=${ORG}`, { headers: { cookie } });
  const jCur = await hCur.json().catch(() => ({}));
  const dCur = await getIrregularBoard(ORG, "operating");
  ck("[direct==HTTP] 현재 주차 — editable/selectedWeekId/통계 일치",
    hCur.ok && jCur.success &&
    jCur.data.editable === dCur.editable && jCur.data.editable === true &&
    jCur.data.selectedWeekId === dCur.selectedWeekId &&
    jCur.data.summary.completed === dCur.summary.completed &&
    jCur.data.summary.all === dCur.summary.all &&
    jCur.data.weeks.length === dCur.weeks.length,
    `http editable=${jCur.data?.editable} weeks=${jCur.data?.weeks?.length}`);

  // 과거 주차 GET — editable=false · selectedWeekId=past.
  const hPast = await fetch(`${BASE}/api/admin/processes/check/irregular?org=${ORG}&week=${past.weekId}`, { headers: { cookie } });
  const jPast = await hPast.json().catch(() => ({}));
  const dPast = await getIrregularBoard(ORG, "operating", past.weekId);
  ck("[direct==HTTP] 과거 주차 — editable=false · selectedWeekId=past 일치",
    hPast.ok && jPast.success &&
    jPast.data.editable === false && dPast.editable === false &&
    jPast.data.selectedWeekId === past.weekId && dPast.selectedWeekId === past.weekId,
    `http editable=${jPast.data?.editable} sel=${jPast.data?.selectedWeekId}`);

  // ── 6. operating/test 분리 — test 보드도 weeks 목록 + operating 행 미노출 ──
  const teBoard = await getIrregularBoard(ORG, "test");
  ck("[모드] test 보드 weeks 목록 존재 + operating 자동완료행 미노출",
    teBoard.weeks.length > 0 && !teBoard.acts.some((a) => a.id === autoId));
}

main()
  .catch((e) => { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; })
  .finally(async () => { await cleanup(); console.log("(cleanup — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); });
