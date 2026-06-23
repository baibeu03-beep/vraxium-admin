// 프로세스 체크 주차 선택 — direct + direct==HTTP 검증(info/experience).
//   run: npx tsx --env-file=.env.local scripts/verify-process-check-week-select.ts
//   전제: dev 서버(:3000).
//
// 검증: 주차 목록(현재 시즌 W1~현재·미래 미포함) · 현재 주차 기본 + editable · 과거 주차 editable=false ·
//       과거 주차 상태 행이 그 주차에서만 보임(week-scoped) · direct==HTTP · operating/test 분리 ·
//       experience 팀 목록(회귀).
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getProcessCheckBoard } from "@/lib/adminProcessCheckData";

const BASE = "http://localhost:3000";
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const EMAIL = "vanuatu.golden@gmail.com";
const ORG = "oranke";
const HUB = "info";
const TAG = "ZZ-pcweek";

let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cleanup() {
  const acts = (await supabaseAdmin.from("process_acts").select("id").like("act_name", `${TAG}%`)).data as { id: string }[] | null;
  const ids = (acts ?? []).map((a) => a.id);
  if (ids.length) {
    await supabaseAdmin.from("process_check_statuses").delete().in("act_id", ids);
    await supabaseAdmin.from("process_check_logs").delete().in("act_id", ids);
  }
  await supabaseAdmin.from("process_acts").delete().like("act_name", `${TAG}%`);
  await supabaseAdmin.from("process_line_groups").delete().like("name", `${TAG}%`);
}

async function main() {
  await cleanup();

  // ── 주차 목록(operating) — 현재 시즌 W1~현재 · 미래 미포함 · 현재 기본 + editable ──
  const board = await getProcessCheckBoard(HUB, ORG, null, "operating");
  const current = board.weeks.find((w) => w.isCurrent);
  ck("[주차] weeks 목록 + 현재 주차 존재", board.weeks.length > 0 && !!current, `weeks=${board.weeks.length}`);
  ck("[주차] selectedWeekId == 현재 · editable=true(기본)", !!current && board.selectedWeekId === current!.weekId && board.editable === true);
  const maxNo = Math.max(...board.weeks.map((w) => w.weekNumber));
  ck("[주차] 미래 주차 없음(최대==현재)", !!current && maxNo === current!.weekNumber, `max=${maxNo} cur=${current?.weekNumber}`);
  ck("[주차] 상태 라벨 공식 활동/휴식 주차", board.weeks.every((w) => w.statusLabel === (w.isOfficialRest ? "공식 휴식 주차" : "공식 활동 주차")));
  ck("[주차] periodLabel 연도+시즌+주차 형식", board.weeks.every((w) => /^\d{2}년 .+시즌 \d+주차$/.test(w.periodLabel)), board.weeks[0]?.periodLabel ?? "");

  const currentWeekId = current?.weekId ?? null;
  const past = board.weeks.find((w) => !w.isCurrent && w.weekId);
  ck("[주차] 과거 주차 존재", !!past, past ? `${past.weekNumber}주차` : "none");
  if (!currentWeekId || !past?.weekId) { console.log("⚠ 현재/과거 주차 부족"); await cleanup(); process.exit(2); }

  // ── 과거 주차 선택 → editable=false ──
  const pastBoard = await getProcessCheckBoard(HUB, ORG, null, "operating", null, null, past.weekId);
  ck("[과거] selectedWeekId=past · editable=false", pastBoard.selectedWeekId === past.weekId && pastBoard.editable === false && pastBoard.week?.editable === false);

  // ── week-scoped 상태 로딩 — 필수 액트 시드 + 과거 주차에만 상태행 삽입 ──
  const { data: g } = await supabaseAdmin.from("process_line_groups").insert({ hub: HUB, name: `${TAG}라인` }).select("id").single();
  const lineGroupId = (g as { id: string }).id;
  const { data: a } = await supabaseAdmin.from("process_acts").insert({
    line_group_id: lineGroupId, hub: HUB, act_name: `${TAG}필수`, duration_minutes: 30,
    occur_week: "N", occur_dow: 1, occur_time: "10:00", check_week: "N", check_dow: 3, check_time: "12:00",
    point_check: 5, point_advantage: 2, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "required", is_active: true,
  }).select("id").single();
  const actId = (a as { id: string }).id;
  // 과거 주차에 pending 상태행 삽입(현재 주차엔 행 없음 → needed).
  const { error: stErr } = await supabaseAdmin.from("process_check_statuses").insert({
    organization_slug: ORG, hub: HUB, week_id: past.weekId, line_group_id: lineGroupId, act_id: actId,
    status: "pending", scope_mode: "operating", review_link: "https://cafe.naver.com/x/pcweek",
    scheduled_check_at: new Date(Date.now() + 86_400_000).toISOString(), requested_at: new Date().toISOString(),
  });
  ck("[시드] 과거 주차 상태행 삽입", !stErr, stErr?.message ?? "");

  const curB = await getProcessCheckBoard(HUB, ORG, null, "operating");
  const pastB = await getProcessCheckBoard(HUB, ORG, null, "operating", null, null, past.weekId);
  const curRow = curB.acts.find((x) => x.actId === actId);
  const pastRow = pastB.acts.find((x) => x.actId === actId);
  ck("[week-scope] 현재 주차 = 시드 액트 'needed'(과거 행 안 보임)", curRow?.status === "needed", curRow?.status);
  ck("[week-scope] 과거 주차 = 시드 액트 'pending'(그 주차 행만)", pastRow?.status === "pending", pastRow?.status);

  // ── direct == HTTP ──
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

  const hCur = await fetch(`${BASE}/api/admin/processes/check?hub=${HUB}&org=${ORG}`, { headers: { cookie } });
  const jCur = await hCur.json().catch(() => ({}));
  ck("[direct==HTTP] 현재 — editable/selectedWeekId/weeks 일치",
    hCur.ok && jCur.success && jCur.data.editable === true && jCur.data.selectedWeekId === curB.selectedWeekId && jCur.data.weeks.length === curB.weeks.length,
    `http editable=${jCur.data?.editable} weeks=${jCur.data?.weeks?.length}`);
  const httpCurRow = (jCur.data?.acts ?? []).find((x: { actId: string }) => x.actId === actId);
  ck("[direct==HTTP] 현재 시드액트 status 일치(needed)", httpCurRow?.status === curRow?.status, `http=${httpCurRow?.status}`);

  const hPast = await fetch(`${BASE}/api/admin/processes/check?hub=${HUB}&org=${ORG}&week=${past.weekId}`, { headers: { cookie } });
  const jPast = await hPast.json().catch(() => ({}));
  const httpPastRow = (jPast.data?.acts ?? []).find((x: { actId: string }) => x.actId === actId);
  ck("[direct==HTTP] 과거 — editable=false · 시드액트 status 일치(pending)",
    hPast.ok && jPast.success && jPast.data.editable === false && jPast.data.selectedWeekId === past.weekId && httpPastRow?.status === pastRow?.status,
    `http editable=${jPast.data?.editable} status=${httpPastRow?.status}`);

  // ── operating/test 분리 — test 보드도 weeks 목록 ──
  const teBoard = await getProcessCheckBoard(HUB, ORG, null, "test");
  ck("[모드] test 보드 weeks 목록 존재", teBoard.weeks.length > 0, `weeks=${teBoard.weeks.length}`);

  // ── experience(팀) 회귀 — weeks + teams 동시 반환, editable 동작 ──
  const expBoard = await getProcessCheckBoard("experience", ORG, null, "operating");
  ck("[experience] weeks 목록 + editable 정상", expBoard.weeks.length > 0 && typeof expBoard.editable === "boolean");
  ck("[experience] 팀 목록 로드(회귀)", Array.isArray(expBoard.teams), `teams=${expBoard.teams.length}`);
}

main()
  .catch((e) => { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; })
  .finally(async () => { await cleanup(); console.log("(cleanup — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); });
