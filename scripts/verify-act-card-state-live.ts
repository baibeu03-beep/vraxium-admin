/**
 * 액트 카드 5상태 실 HTTP/DB 통합 검증 (dev server 필요).
 *   임시 클럽 액트 5종 + 상태행을 시드해 inactive·pending·overdue·completed-on-time·completed-late 를
 *   각각 재현하고, 실제 lib(direct) + HTTP GET 응답에서 cardState/표시/원본 timestamp/실행자 구조를 확인한다.
 *   · operating == test 완전 동일(DTO 키 구조·상태 판정·필요/실제 시점·실행자)
 *   · direct == HTTP
 *   · snapshot 무영향
 *   시드 데이터는 검증 후 전부 정리(고정 UUID).
 *   npx tsx --env-file=.env.local scripts/verify-act-card-state-live.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { loadTeamPartsInfoActCheckManagement } from "@/lib/adminTeamPartsInfoActCheckData";
import { resolveActCardState } from "@/lib/actCardState";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

async function cookieHeader(): Promise<{ cookie: string; adminId: string }> {
  const { data: adm } = await supabaseAdmin.from("admin_users").select("id,email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as any)?.email;
  const adminId = (adm?.[0] as any)?.id;
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const sv = createServerClient(u, a, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it.map(({ name, value }: any) => ({ name, value }))) } });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return { cookie: cap.map((c) => `${c.name}=${c.value}`).join("; "), adminId };
}
async function snap() {
  const { count } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  const { data } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("updated_at").order("updated_at", { ascending: false }).limit(1);
  return { count: count ?? 0, latest: (data?.[0] as any)?.updated_at ?? null };
}
const iso = (deltaMs: number) => new Date(Date.now() + deltaMs).toISOString();

const ORG = "encre";
const LG1 = "0c1b0000-0000-4000-8000-000000000001"; // 클럽 전체 가이드(활성)
const LG2 = "0c1b0000-0000-4000-8000-000000000002"; // 행정 보안 검수(actCheck=false → 비가동)
// 고정 임시 액트 UUID(상태별 1종).
const ACTS = {
  inactive: "0c1a0000-0000-4000-8000-0000000000b1",
  pending: "0c1a0000-0000-4000-8000-0000000000b2",
  overdue: "0c1a0000-0000-4000-8000-0000000000b3",
  ontime: "0c1a0000-0000-4000-8000-0000000000b4",
  late: "0c1a0000-0000-4000-8000-0000000000b5",
} as const;
const ALL_IDS = Object.values(ACTS);

async function cleanup() {
  await supabaseAdmin.from("process_check_statuses").delete().in("act_id", ALL_IDS);
  await supabaseAdmin.from("process_acts").delete().in("id", ALL_IDS);
}

async function main() {
  try { const h = await fetch(`${BASE}/api/health`); check("dev server", h.ok); }
  catch { console.log("❌ dev server 미기동"); process.exit(2); }
  const { cookie, adminId } = await cookieHeader();
  const snapBefore = await snap();

  const { rows } = await loadSeasonWeeks();
  const week = rows.find((r) => !r.is_official_rest && r.week_start_date) ?? rows[0];
  const weekId = week.week_id;
  console.log(`   week=${week.week_label} id=${weekId.slice(0, 8)} org=${ORG}`);

  await cleanup(); // 멱등 사전 정리

  try {
    // ── 임시 액트 5종 시드 ──
    const baseAct = {
      hub: "club", duration_minutes: 5, occur_week: "N", occur_dow: 4, occur_time: "09:00",
      check_week: "N", check_dow: 4, check_time: "14:00", // 파생 필요 시점 = (목) 14:00
      point_check: 0, point_advantage: 0, point_penalty: 0,
      cafe: "none", check_target: "check", act_type: "basic", is_active: true,
    };
    const seedActs = [
      { id: ACTS.inactive, line_group_id: LG2, act_name: "[검증] inactive" },
      { id: ACTS.pending, line_group_id: LG1, act_name: "[검증] pending" },
      { id: ACTS.overdue, line_group_id: LG1, act_name: "[검증] overdue" },
      { id: ACTS.ontime, line_group_id: LG1, act_name: "[검증] on-time" },
      { id: ACTS.late, line_group_id: LG1, act_name: "[검증] late" },
    ].map((x) => ({ ...baseAct, ...x }));
    const { error: actErr } = await supabaseAdmin.from("process_acts").insert(seedActs);
    check("임시 액트 5종 시드", !actErr, actErr?.message);

    // ── 상태행 시드(필요/실제 시점을 명시) ──
    const stBase = { hub: "club", team_id: null, organization_slug: ORG, week_id: weekId, scope_mode: "operating", requested_by: adminId };
    const statuses = [
      // pending: 가동·미신청(status=needed)·필요 시점 미래 → now ≤ 필요 → 노랑
      { ...stBase, act_id: ACTS.pending, line_group_id: LG1, status: "needed", scheduled_check_at: iso(2 * 3600 * 1000), requested_at: null, completed_at: null },
      // overdue: 가동·미신청·필요 시점 과거 → now > 필요 → 빨강
      { ...stBase, act_id: ACTS.overdue, line_group_id: LG1, status: "needed", scheduled_check_at: iso(-2 * 3600 * 1000), requested_at: null, completed_at: null },
      // completed-on-time: 실제(완료) ≤ 필요 → 초록
      { ...stBase, act_id: ACTS.ontime, line_group_id: LG1, status: "completed", scheduled_check_at: iso(0), requested_at: iso(-3600 * 1000), completed_at: iso(-3600 * 1000) },
      // completed-late: 실제(완료) > 필요 → 파랑
      { ...stBase, act_id: ACTS.late, line_group_id: LG1, status: "completed", scheduled_check_at: iso(-2 * 3600 * 1000), requested_at: iso(0), completed_at: iso(0) },
      // inactive 는 상태행 없음(LG2 미가동 + 미신청)
    ];
    const { error: stErr } = await supabaseAdmin.from("process_check_statuses").insert(statuses);
    check("상태행 4종 시드", !stErr, stErr?.message);

    // ── 오픈 확인: club 게이트 ON, 단 LG2 만 actCheck=false(→ inactive 액트) ──
    const oc = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/open-confirm?club=${ORG}`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ config: { practicalInfo: {}, practicalExperience: {}, practicalCompetency: { checked: false }, actCheck: { info: {}, experience: {}, club: { [LG2]: false } } } }),
    });
    check("open-confirm 성공", oc.ok);

    // ── direct 조회(operating) ──
    const collect = (data: Awaited<ReturnType<typeof loadTeamPartsInfoActCheckManagement>>) => {
      const cards = data.clubOverall.lines.flatMap((l) => Object.values(l.regularActsByDay).flat());
      const byId = new Map(cards.map((c) => [c.actId, c]));
      return byId;
    };
    const dOp = await loadTeamPartsInfoActCheckManagement({ weekId, organization: ORG, mode: "operating" });
    const opById = collect(dOp);

    const expect: Record<string, string> = {
      [ACTS.inactive]: "inactive",
      [ACTS.pending]: "pending",
      [ACTS.overdue]: "overdue",
      [ACTS.ontime]: "completed-on-time",
      [ACTS.late]: "completed-late",
    };
    for (const [id, exp] of Object.entries(expect)) {
      const card = opById.get(id);
      check(`[${exp}] 카드 존재`, !!card, { id });
      if (!card) continue;
      check(`[${exp}] cardState 일치`, card.cardState === exp, { got: card.cardState });
      // 필요 시점 라벨은 모든 상태에서 표시(항상).
      check(`[${exp}] requiredLabel 항상 표시`, !!card.requiredLabel, { requiredLabel: card.requiredLabel });
      // 완료 상태만 실제 신청 시점/실행자.
      if (exp.startsWith("completed")) {
        check(`[${exp}] actualCheckedAt·actualLabel 존재`, !!card.actualCheckedAt && !!card.actualLabel, { actualCheckedAt: card.actualCheckedAt, actualLabel: card.actualLabel });
        check(`[${exp}] 실행자(requesterLabel) 존재`, !!card.requesterLabel, { requesterLabel: card.requesterLabel });
        // 서버 판정과 순수 함수 판정 일치(원본 timestamp 기준 재검산).
        const reReq = card.requiredCheckedAt ? Date.parse(card.requiredCheckedAt) : null;
        const reAct = card.actualCheckedAt ? Date.parse(card.actualCheckedAt) : null;
        const recomputed = resolveActCardState({ isActive: card.isActiveThisWeek, requiredCheckedAtMs: reReq, check: { actualCheckedAtMs: reAct }, nowMs: Date.now() });
        check(`[${exp}] 원본 timestamp 재검산 일치`, recomputed === exp, { recomputed });
      } else {
        check(`[${exp}] 미완료 → actualCheckedAt 없음`, card.actualCheckedAt === null);
      }
    }

    // ── operating == test 완전 동일(clubOverall) ──
    const dTest = await loadTeamPartsInfoActCheckManagement({ weekId, organization: ORG, mode: "test" });
    check("operating == test (clubOverall 전체)", JSON.stringify(dOp.clubOverall) === JSON.stringify(dTest.clubOverall));
    // 카드별 키 구조 동일.
    const tsById = collect(dTest);
    for (const id of ALL_IDS) {
      const oc2 = opById.get(id), tc = tsById.get(id);
      if (!oc2 || !tc) continue;
      check(`[${id.slice(-2)}] operating/test 키 구조 동일`, JSON.stringify(Object.keys(oc2).sort()) === JSON.stringify(Object.keys(tc).sort()));
    }

    // ── direct == HTTP (operating·test) ──
    for (const mode of ["operating", "test"] as const) {
      const direct = mode === "operating" ? dOp : dTest;
      const params = new URLSearchParams({ club: ORG });
      if (mode === "test") params.set("mode", "test");
      const res = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/act-check-management?${params}`, { headers: { cookie }, cache: "no-store" });
      const json: any = await res.json();
      check(`[${mode}] HTTP 200·success`, res.ok && json?.success === true, { status: res.status });
      // cardState 판정은 now 의존(pending/overdue 경계) → 시드 시점은 경계에서 2h 떨어뜨렸으므로 안정.
      check(`[${mode}] direct == HTTP`, JSON.stringify(direct) === JSON.stringify(json?.data));
    }
  } finally {
    await cleanup();
    await supabaseAdmin.from("cluster4_week_opening_configs").delete().eq("week_id", weekId).eq("organization_slug", ORG);
    console.log("   (시드/오픈설정 정리 완료)");
  }

  const snapAfter = await snap();
  check("snapshot 무변경(count)", snapBefore.count === snapAfter.count, { before: snapBefore.count, after: snapAfter.count });
  check("snapshot 무변경(latest)", snapBefore.latest === snapAfter.latest);

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); process.exit(1); });
