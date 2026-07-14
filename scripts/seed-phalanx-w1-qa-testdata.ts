/**
 * QA 검수 테스트 데이터 시드 — phalanx / 2026-summer 여름 시즌 1주차 (mode=test 30명).
 * ─────────────────────────────────────────────────────────────────────────────
 * 목적: "검수 완료(uws 생성) → snapshot 재계산 → /cluster-4·/weekly-ranking 반영 → 실행 취소 원복"
 *   전체 흐름을 테스트하기 위한 **입력 데이터만** 구성한다.
 *
 * ⚠ user_week_statuses(uws) 는 이 스크립트가 만들지 않는다. "검수 완료 버튼"(=markTeamPartsWeekReviewed)
 *   이 계산·생성한다. 본 시드는 그 계산이 결정적으로 나오도록 입력(라인/대상자/평가/포인트/휴식)만 채운다.
 *
 * 기존 서버 함수/SoT 재사용:
 *   - 포인트: process_irregular_acts + process_check_review_recipients(matched) → accrueForCompletedIrregular
 *             (원장 process_point_awards upsert → recomputeWeeklyPoints → user_weekly_points). user_weekly_points 직접 조작 안 함.
 *   - 실무 경험 판정 입력: cluster4_experience_line_masters(slot 1/2/3) + cluster4_lines(experience,week_id)
 *             + cluster4_line_targets(user) + cluster4_experience_line_evaluations(rating).
 *             → 검수 완료 시 fetchExperienceRequiredSlotStatusByWeek 가 그대로 읽어 pass/fail 산정(신규 공식 없음).
 *   - 개인 휴식: crew_personal_rest_periods(주차 overlap) → finalize 가 personal_rest 판정.
 *   - (선택) 검수/실행취소: markTeamPartsWeekReviewed / revertTeamPartsWeekReview (실제 버튼과 동일 서버 함수).
 *
 * 테스트 구성(정확히 30명, user_id asc 결정적 배정):
 *   1) 성장 성공        10명  — 포인트 ≥ 기준 · 필수 슬롯 3종 통과
 *   2) 포인트 부족 실패   6명  — 슬롯 통과 · 포인트 < 기준(checkGate fail)
 *   3) 실무 경험 부족 실패 6명  — 포인트 ≥ 기준 · 슬롯1 평가 낮음(fail)
 *   4) 복합 실패         4명  — 포인트 < 기준 + 슬롯1 fail
 *   5) 개인 휴식         2명  — crew_personal_rest_periods(W1 overlap) → personal_rest
 *   6) 경계값           2명  — 포인트 == 기준(정확히) · 슬롯 통과 → 성공
 *
 * 안전장치:
 *   - 기본 dry-run(쓰기 없음). --apply 에서만 DB write.
 *   - 대상 전원 test_user_markers ∧ org=phalanx 검증(fail-closed). 실유저 혼입 시 즉시 중단.
 *   - 멱등: 자연키(line_code/team_name/act_name/(line,user)/(source_rest_id)) select-or-create + 원장 upsert.
 *   - --rollback: 매니페스트(claudedocs/qa-seed-phalanx-w1-manifest.json)에 기록한 id만 정확히 제거·원복.
 *     · 포인트는 revokeForAct('irregular', actId) 로 원장 삭제 + recompute(무손실 원복).
 *     · growth_status / user_season_statuses.status 는 캡처한 원본으로 복원.
 *   - 운영(실유저) 데이터 무접촉: 모든 쓰기는 테스트 마커 유저 대상만.
 *
 * 사용:
 *   미리보기:  npx tsx --env-file=.env.local scripts/seed-phalanx-w1-qa-testdata.ts
 *   적용:      ... seed-phalanx-w1-qa-testdata.ts --apply
 *   검증:      ... seed-phalanx-w1-qa-testdata.ts --verify   (예상 verdict · 실제 uws · 집계 상태 표)
 *   검수완료:  ... seed-phalanx-w1-qa-testdata.ts --finalize  (⚠ QA 코호트 전체 대상 — 아래 주의 참조)
 *   실행취소:  ... seed-phalanx-w1-qa-testdata.ts --revert
 *   롤백:      ... seed-phalanx-w1-qa-testdata.ts --rollback
 *
 * ⚠ --finalize 주의: 검수 완료(finalize)의 코호트는 season_key='2026-summer' 참여자 **전체(전 org 테스트 유저)**
 *   이다(loadFinalizeCohort 는 org 필터 없음 — 전역 공표라 정상 설계). 즉 phalanx 30명 외 다른 org 테스트 유저도
 *   같은 주차 uws 가 만들어진다(실무 경험 데이터 없으면 fail). 이는 실제 버튼 동작과 동일하며 --revert 로 전량 원복된다.
 *   phalanx 30명 검증은 --verify 가 그 30명만 집중 리포트한다.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";
import { fetchExperienceRequiredSlotStatusByWeek } from "@/lib/lineAvailability";
import { accrueForCompletedIrregular, revokeForAct } from "@/lib/processPointAccrual";
import {
  markTeamPartsWeekReviewed,
  revertTeamPartsWeekReview,
} from "@/lib/adminTeamPartsInfoWeekDetailData";

// ── 설정 ──────────────────────────────────────────────────────────────────────
const ORG = "phalanx";
const SEASON_KEY = "2026-summer";
const SEED_TAG = "QA-SEED-PHALANX-W1";
const DEFAULT_THRESHOLD = 30; // lib/cluster4Enhancement.DEFAULT_WEEK_CHECK_THRESHOLD
const PASS_RATING = 6; // rating > 3 → 슬롯 통과
const FAIL_RATING = 2; // rating <= 3 → 슬롯 fail
const REST_SOURCE_SYSTEM = "qa-seed-phalanx-w1"; // crew_personal_rest_periods.source_system
const REST_SOURCE_ID_BASE = 990_000; // source_rest_id 합성 베이스(운영 값과 충돌 회피)
const MANIFEST_PATH = path.resolve(
  process.cwd(),
  "claudedocs",
  "qa-seed-phalanx-w1-manifest.json",
);

// 슬롯 정의(필수 3종) — cluster4_experience_line_masters CHECK 쌍과 동일.
const SLOTS = [
  { slot: 1, category: "derivation", code: `${SEED_TAG}-DER`, name: `[${SEED_TAG}] 도출` },
  { slot: 2, category: "analysis", code: `${SEED_TAG}-ANA`, name: `[${SEED_TAG}] 분석` },
  { slot: 3, category: "evaluation", code: `${SEED_TAG}-EVA`, name: `[${SEED_TAG}] 평가` },
] as const;

type Group = "success" | "pointsFail" | "expFail" | "complexFail" | "personalRest" | "boundary";
const GROUP_PLAN: { group: Group; count: number; expected: "success" | "fail" | "personal_rest" }[] = [
  { group: "success", count: 10, expected: "success" },
  { group: "pointsFail", count: 6, expected: "fail" },
  { group: "expFail", count: 6, expected: "fail" },
  { group: "complexFail", count: 4, expected: "fail" },
  { group: "personalRest", count: 2, expected: "personal_rest" },
  { group: "boundary", count: 2, expected: "success" },
];
const TOTAL = GROUP_PLAN.reduce((s, g) => s + g.count, 0); // 30

// ── 타입 ──────────────────────────────────────────────────────────────────────
type WeekRow = {
  id: string;
  start_date: string;
  end_date: string | null;
  season_key: string | null;
  iso_year: number | null;
  iso_week: number | null;
  is_official_rest: boolean | null;
  check_threshold: number | null;
  result_published_at: string | null;
  result_reviewed_at: string | null;
};

type UserPlan = {
  userId: string;
  displayName: string;
  group: Group;
  expected: "success" | "fail" | "personal_rest";
  slotRatings: number[] | null; // null = 슬롯 데이터 없음(휴식)
  pointsTarget: number;
};

type Manifest = {
  version: 1;
  seedTag: string;
  createdAt: string;
  weekId: string;
  weekStart: string;
  seasonKey: string;
  threshold: number;
  teamId: string | null;
  teamCreated: boolean;
  masters: { id: string; slot: number; created: boolean }[];
  lines: { id: string; slot: number; created: boolean }[];
  targetIds: string[];
  evaluationIds: string[];
  irregularActIds: string[];
  recipientIds: string[];
  restPeriodIds: string[];
  userPlan: UserPlan[];
  originals: {
    growthByUser: Record<string, string | null>;
    ussStatusByUser: Record<string, string | null>;
  };
};

// ── 공통 헬퍼 ────────────────────────────────────────────────────────────────
function decomposePoints(target: number): number[] {
  // point_a CHECK 0~20 → 20 단위로 분해.
  const chunks: number[] = [];
  let rem = target;
  while (rem > 20) {
    chunks.push(20);
    rem -= 20;
  }
  if (rem > 0) chunks.push(rem);
  return chunks;
}

async function resolveWeek(): Promise<WeekRow> {
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select(
      "id,start_date,end_date,season_key,iso_year,iso_week,is_official_rest,check_threshold,result_published_at,result_reviewed_at",
    )
    .eq("season_key", SEASON_KEY)
    .order("start_date", { ascending: true })
    .limit(1);
  if (error) throw new Error(`weeks 조회 실패: ${error.message}`);
  const w = ((data ?? [])[0] as WeekRow | undefined) ?? null;
  if (!w) throw new Error(`${SEASON_KEY} 주차를 찾을 수 없습니다.`);
  if (w.is_official_rest) throw new Error(`W1(${w.id})이 공식 휴식 주차입니다 — 중단.`);
  if (w.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM) {
    throw new Error(`W1(${w.start_date})이 레거시 경계(${CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM}) 이전 — uws 대상 아님.`);
  }
  return w;
}

// 검수 완료가 쓰는 것과 동일 우선순위: qa_weeks_state → org_week_thresholds → weeks.check_threshold → 30.
async function resolveThreshold(week: WeekRow): Promise<number> {
  let threshold =
    week.check_threshold != null && week.check_threshold >= 0 ? week.check_threshold : DEFAULT_THRESHOLD;
  const { data: owt } = await supabaseAdmin
    .from("org_week_thresholds")
    .select("check_threshold")
    .eq("organization_slug", ORG)
    .eq("week_id", week.id)
    .maybeSingle();
  if (owt && (owt as { check_threshold: number }).check_threshold >= 0) {
    threshold = (owt as { check_threshold: number }).check_threshold;
  }
  const { data: qws } = await supabaseAdmin
    .from("qa_weeks_state")
    .select("check_threshold")
    .eq("week_id", week.id)
    .maybeSingle();
  const qv = (qws as { check_threshold: number | null } | null)?.check_threshold;
  if (qv != null && qv >= 0) threshold = qv;
  return threshold;
}

async function loadPhalanxTestUsers(): Promise<{ userId: string; displayName: string }[]> {
  const markers = await fetchTestUserMarkerIds();
  const ids = [...markers];
  if (ids.length === 0) throw new Error("test_user_markers 비어있음.");
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,organization_slug")
    .in("user_id", ids);
  if (error) throw new Error(`user_profiles 조회 실패: ${error.message}`);
  const rows = ((data ?? []) as { user_id: string; display_name: string | null; organization_slug: string | null }[])
    .filter((p) => p.organization_slug === ORG)
    .map((p) => ({ userId: p.user_id, displayName: p.display_name ?? p.user_id.slice(0, 8) }))
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  // fail-closed: 대상 전원이 test marker 여야 한다(위 in-markers 로 이미 보장, 이중 방어).
  const markerSet = markers;
  const leak = rows.filter((r) => !markerSet.has(r.userId));
  if (leak.length) throw new Error(`비-테스트 유저 혼입 감지(${leak.length}) — 중단.`);
  return rows;
}

function buildUserPlans(users: { userId: string; displayName: string }[], threshold: number): UserPlan[] {
  const PASS_POINTS = threshold + 5;
  const FAIL_POINTS = Math.max(0, threshold - 10);
  const plans: UserPlan[] = [];
  let i = 0;
  for (const g of GROUP_PLAN) {
    for (let n = 0; n < g.count; n++) {
      const u = users[i++];
      let slotRatings: number[] | null;
      let pointsTarget: number;
      switch (g.group) {
        case "success":
          slotRatings = [PASS_RATING, PASS_RATING, PASS_RATING];
          pointsTarget = PASS_POINTS;
          break;
        case "boundary":
          slotRatings = [PASS_RATING, PASS_RATING, PASS_RATING];
          pointsTarget = threshold; // 정확히 기준값
          break;
        case "pointsFail":
          slotRatings = [PASS_RATING, PASS_RATING, PASS_RATING];
          pointsTarget = FAIL_POINTS;
          break;
        case "expFail":
          slotRatings = [FAIL_RATING, PASS_RATING, PASS_RATING]; // 슬롯1 fail
          pointsTarget = PASS_POINTS;
          break;
        case "complexFail":
          slotRatings = [FAIL_RATING, PASS_RATING, PASS_RATING];
          pointsTarget = FAIL_POINTS;
          break;
        case "personalRest":
          slotRatings = null; // 휴식 short-circuit — 슬롯 데이터 불필요
          pointsTarget = 0;
          break;
      }
      plans.push({
        userId: u.userId,
        displayName: u.displayName,
        group: g.group,
        expected: g.expected,
        slotRatings,
        pointsTarget,
      });
    }
  }
  return plans;
}

async function firstAdminId(): Promise<string | null> {
  const { data } = await supabaseAdmin.from("admin_users").select("id").limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

function summarize(plans: UserPlan[], threshold: number) {
  const byExpected: Record<string, number> = {};
  for (const p of plans) byExpected[p.expected] = (byExpected[p.expected] || 0) + 1;
  console.log(`\n총 대상자: ${plans.length}`);
  console.log(`포인트 기준값(threshold): ${threshold}`);
  console.log(`성공 예상: ${byExpected.success ?? 0} · 실패 예상: ${byExpected.fail ?? 0} · 개인 휴식 예상: ${byExpected.personal_rest ?? 0}`);
  console.log("\n[사용자별 계획]");
  for (const p of plans) {
    const slots = p.slotRatings ? `slots=[${p.slotRatings.join(",")}]` : "slots=(휴식)";
    console.log(`  ${p.displayName.padEnd(8)} ${p.group.padEnd(12)} → ${p.expected.padEnd(13)} pts=${String(p.pointsTarget).padStart(2)} ${slots}  ${p.userId}`);
  }
}

// ── APPLY ─────────────────────────────────────────────────────────────────────
async function apply(week: WeekRow, threshold: number, plans: UserPlan[]) {
  const adminId = await firstAdminId();
  const nowIso = new Date().toISOString();
  const opensAt = `${week.start_date}T00:00:00Z`;
  const closesAt = `${week.end_date ?? week.start_date}T23:59:59Z`; // 과거 마감 → deadlinePassed(pending 아님)

  const manifest: Manifest = {
    version: 1,
    seedTag: SEED_TAG,
    createdAt: nowIso,
    weekId: week.id,
    weekStart: week.start_date,
    seasonKey: SEASON_KEY,
    threshold,
    teamId: null,
    teamCreated: false,
    masters: [],
    lines: [],
    targetIds: [],
    evaluationIds: [],
    irregularActIds: [],
    recipientIds: [],
    restPeriodIds: [],
    userPlan: plans,
    originals: { growthByUser: {}, ussStatusByUser: {} },
  };

  // ── 0) 원본 캡처(growth_status / uss status) ──────────────────────────────
  const userIds = plans.map((p) => p.userId);
  const { data: profRows } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,growth_status")
    .in("user_id", userIds);
  for (const r of (profRows ?? []) as { user_id: string; growth_status: string | null }[]) {
    manifest.originals.growthByUser[r.user_id] = r.growth_status;
  }
  const { data: ussRows } = await supabaseAdmin
    .from("user_season_statuses")
    .select("user_id,status")
    .eq("season_key", SEASON_KEY)
    .in("user_id", userIds);
  const ussByUser = new Map<string, string>();
  for (const r of (ussRows ?? []) as { user_id: string; status: string }[]) {
    manifest.originals.ussStatusByUser[r.user_id] = r.status;
    ussByUser.set(r.user_id, r.status);
  }

  // ── 1) 코호트 포함 보장: growth_status='active' (paused/graduated → 코호트/휴식 오판 방지, 원복 가능) ─
  //    비휴식 그룹의 uss='rest' 는 seasonRest short-circuit 을 피하려 'active' 로 조정(원복 가능).
  for (const p of plans) {
    const curGrowth = manifest.originals.growthByUser[p.userId] ?? null;
    if (curGrowth !== "active") {
      const { error } = await supabaseAdmin
        .from("user_profiles")
        .update({ growth_status: "active" })
        .eq("user_id", p.userId);
      if (error) throw new Error(`growth_status 설정 실패(${p.userId}): ${error.message}`);
    }
    if (p.group !== "personalRest") {
      if (ussByUser.get(p.userId) === "rest") {
        const { error } = await supabaseAdmin
          .from("user_season_statuses")
          .update({ status: "active" })
          .eq("season_key", SEASON_KEY)
          .eq("user_id", p.userId);
        if (error) throw new Error(`uss status 조정 실패(${p.userId}): ${error.message}`);
      }
    }
  }

  // ── 2) 팀(select-or-create) ────────────────────────────────────────────────
  const teamName = `${SEED_TAG} 팀`;
  {
    const { data: exist } = await supabaseAdmin
      .from("cluster4_teams")
      .select("id")
      .eq("team_name", teamName)
      .maybeSingle();
    if (exist) {
      manifest.teamId = (exist as { id: string }).id;
    } else {
      const { data, error } = await supabaseAdmin
        .from("cluster4_teams")
        .insert({ team_name: teamName, is_active: true })
        .select("id")
        .single();
      if (error || !data) throw new Error(`팀 생성 실패: ${error?.message}`);
      manifest.teamId = (data as { id: string }).id;
      manifest.teamCreated = true;
    }
  }

  // ── 3) 마스터 3종(slot 1/2/3, select-or-create by line_code) ────────────────
  const masterBySlot = new Map<number, string>();
  for (const s of SLOTS) {
    const { data: exist } = await supabaseAdmin
      .from("cluster4_experience_line_masters")
      .select("id")
      .eq("line_code", s.code)
      .maybeSingle();
    if (exist) {
      const id = (exist as { id: string }).id;
      masterBySlot.set(s.slot, id);
      manifest.masters.push({ id, slot: s.slot, created: false });
    } else {
      const { data, error } = await supabaseAdmin
        .from("cluster4_experience_line_masters")
        .insert({
          line_code: s.code,
          line_name: s.name,
          experience_category: s.category,
          experience_slot_order: s.slot,
          team_id: manifest.teamId,
          organization_slug: ORG,
          is_active: true,
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(`마스터 생성 실패(slot ${s.slot}): ${error?.message}`);
      const id = (data as { id: string }).id;
      masterBySlot.set(s.slot, id);
      manifest.masters.push({ id, slot: s.slot, created: true });
    }
  }

  // ── 4) 라인 3종(slot별 1개, select-or-create by (week_id, experience_line_master_id, is_qa_test)) ─
  const lineBySlot = new Map<number, string>();
  for (const s of SLOTS) {
    const masterId = masterBySlot.get(s.slot)!;
    const { data: exist } = await supabaseAdmin
      .from("cluster4_lines")
      .select("id")
      .eq("week_id", week.id)
      .eq("part_type", "experience")
      .eq("experience_line_master_id", masterId)
      .eq("is_qa_test", true)
      .maybeSingle();
    if (exist) {
      const id = (exist as { id: string }).id;
      lineBySlot.set(s.slot, id);
      manifest.lines.push({ id, slot: s.slot, created: false });
    } else {
      const { data, error } = await supabaseAdmin
        .from("cluster4_lines")
        .insert({
          part_type: "experience",
          main_title: `[${SEED_TAG}] ${s.name}`,
          line_code: `${s.code}-LINE`,
          experience_line_master_id: masterId,
          team_id: manifest.teamId,
          week_id: week.id,
          submission_opens_at: opensAt,
          submission_closes_at: closesAt,
          is_active: true,
          is_qa_test: true,
          created_by: adminId,
          updated_by: adminId,
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(`라인 생성 실패(slot ${s.slot}): ${error?.message}`);
      const id = (data as { id: string }).id;
      lineBySlot.set(s.slot, id);
      manifest.lines.push({ id, slot: s.slot, created: true });
    }
  }

  // ── 5) 대상자 + 평가 (비휴식 그룹) ─────────────────────────────────────────
  for (const p of plans) {
    if (!p.slotRatings) continue; // 휴식 그룹 skip
    for (let idx = 0; idx < SLOTS.length; idx++) {
      const s = SLOTS[idx];
      const lineId = lineBySlot.get(s.slot)!;
      // 대상자 select-or-create (unique: line_id, week_id, target_user_id WHERE target_mode='user')
      let targetId: string;
      const { data: exTgt } = await supabaseAdmin
        .from("cluster4_line_targets")
        .select("id")
        .eq("line_id", lineId)
        .eq("week_id", week.id)
        .eq("target_user_id", p.userId)
        .eq("target_mode", "user")
        .maybeSingle();
      if (exTgt) {
        targetId = (exTgt as { id: string }).id;
      } else {
        const { data, error } = await supabaseAdmin
          .from("cluster4_line_targets")
          .insert({
            line_id: lineId,
            week_id: week.id,
            target_mode: "user",
            target_user_id: p.userId,
            target_rule: {},
            created_by: adminId,
            updated_by: adminId,
          })
          .select("id")
          .single();
        if (error || !data) throw new Error(`대상자 생성 실패(${p.userId}, slot ${s.slot}): ${error?.message}`);
        targetId = (data as { id: string }).id;
      }
      if (!manifest.targetIds.includes(targetId)) manifest.targetIds.push(targetId);

      // 평가 upsert (unique: line_target_id, user_id)
      const rating = p.slotRatings[idx];
      const { data: evalRow, error: evalErr } = await supabaseAdmin
        .from("cluster4_experience_line_evaluations")
        .upsert(
          {
            line_target_id: targetId,
            user_id: p.userId,
            rating,
            evaluated_by: adminId,
            evaluated_at: nowIso,
          },
          { onConflict: "line_target_id,user_id" },
        )
        .select("id")
        .single();
      if (evalErr || !evalRow) throw new Error(`평가 생성 실패(${p.userId}, slot ${s.slot}): ${evalErr?.message}`);
      const evalId = (evalRow as { id: string }).id;
      if (!manifest.evaluationIds.includes(evalId)) manifest.evaluationIds.push(evalId);
    }
  }

  // ── 6) 포인트: irregular act + matched recipient → accrueForCompletedIrregular ─
  for (const p of plans) {
    if (p.pointsTarget <= 0) continue;
    const chunks = decomposePoints(p.pointsTarget);
    for (let c = 0; c < chunks.length; c++) {
      const actName = `${SEED_TAG} ${p.userId.slice(0, 8)} #${c + 1}`.slice(0, 60);
      // act select-or-create by (week_id, org, act_name, target_user_id)
      let actId: string;
      const { data: exAct } = await supabaseAdmin
        .from("process_irregular_acts")
        .select("id")
        .eq("week_id", week.id)
        .eq("organization_slug", ORG)
        .eq("act_name", actName)
        .eq("target_user_id", p.userId)
        .maybeSingle();
      if (exAct) {
        actId = (exAct as { id: string }).id;
      } else {
        const { data, error } = await supabaseAdmin
          .from("process_irregular_acts")
          .insert({
            organization_slug: ORG,
            week_id: week.id,
            kind: "manual_grant",
            act_name: actName,
            applicant_admin_id: adminId,
            applicant_admin_name: SEED_TAG,
            target_user_id: p.userId,
            target_user_name: p.displayName,
            point_a: chunks[c],
            point_b: 0,
            point_c: 0,
            crew_reaction: "partial",
            reason: `${SEED_TAG} 프로세스 체크 포인트 시드`,
            status: "completed",
            completed_at: nowIso,
            scope_mode: "test",
          })
          .select("id")
          .single();
        if (error || !data) throw new Error(`irregular act 생성 실패(${p.userId}): ${error?.message}`);
        actId = (data as { id: string }).id;
      }
      if (!manifest.irregularActIds.includes(actId)) manifest.irregularActIds.push(actId);

      // matched recipient: 멱등 = (source,ref_id) delete 후 insert.
      await supabaseAdmin
        .from("process_check_review_recipients")
        .delete()
        .eq("source", "irregular")
        .eq("ref_id", actId);
      const { data: rec, error: recErr } = await supabaseAdmin
        .from("process_check_review_recipients")
        .insert({
          source: "irregular",
          ref_id: actId,
          organization_slug: ORG,
          scope_mode: "test",
          user_id: p.userId,
          nickname: p.displayName,
          match_type: "matched",
          match_reason: SEED_TAG,
        })
        .select("id")
        .single();
      if (recErr || !rec) throw new Error(`recipient 생성 실패(${p.userId}): ${recErr?.message}`);
      const recId = (rec as { id: string }).id;
      if (!manifest.recipientIds.includes(recId)) manifest.recipientIds.push(recId);

      // 원장 적립 (process_point_awards upsert → recomputeWeeklyPoints → user_weekly_points)
      const res = await accrueForCompletedIrregular(actId);
      if ("skipped" in res && res.skipped) {
        console.warn(`  ⚠ 적립 skip(${p.userId}, ${actName}): ${res.reason}`);
      }
    }
  }

  // ── 7) 개인 휴식 그룹: crew_personal_rest_periods (W1 overlap) ───────────────
  {
    const restPlans = plans.filter((p) => p.group === "personalRest");
    for (let k = 0; k < restPlans.length; k++) {
      const p = restPlans[k];
      const sourceRestId = REST_SOURCE_ID_BASE + k;
      // select-or-create by (source_system, source_rest_id) [unique]
      const { data: exist } = await supabaseAdmin
        .from("crew_personal_rest_periods")
        .select("id")
        .eq("source_system", REST_SOURCE_SYSTEM)
        .eq("source_rest_id", sourceRestId)
        .maybeSingle();
      let restId: string;
      if (exist) {
        restId = (exist as { id: string }).id;
      } else {
        const { data, error } = await supabaseAdmin
          .from("crew_personal_rest_periods")
          .insert({
            user_id: p.userId,
            organization_slug: ORG,
            start_date: week.start_date,
            end_date: week.end_date ?? week.start_date,
            source_system: REST_SOURCE_SYSTEM,
            source_rest_id: sourceRestId,
          })
          .select("id")
          .single();
        if (error || !data) throw new Error(`휴식 기간 생성 실패(${p.userId}): ${error?.message}`);
        restId = (data as { id: string }).id;
      }
      if (!manifest.restPeriodIds.includes(restId)) manifest.restPeriodIds.push(restId);
    }
  }

  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`\n✅ 시드 적용 완료. 매니페스트: ${MANIFEST_PATH}`);
  console.log(
    `   팀=${manifest.teamCreated ? "생성" : "재사용"} · 마스터 ${manifest.masters.length} · 라인 ${manifest.lines.length} · 대상자 ${manifest.targetIds.length} · 평가 ${manifest.evaluationIds.length} · 변동액트 ${manifest.irregularActIds.length} · 휴식 ${manifest.restPeriodIds.length}`,
  );
}

// ── VERIFY ────────────────────────────────────────────────────────────────────
type StatusLike = "success" | "fail" | "personal_rest" | "pending" | "not_applicable" | "-";

async function predictVerdict(week: WeekRow, p: UserPlan): Promise<StatusLike> {
  // 검수 완료(computeUserVerdicts)와 동일 순서: 휴식 우선 → 경험 슬롯 verdict.
  const { data: uss } = await supabaseAdmin
    .from("user_season_statuses")
    .select("status")
    .eq("season_key", SEASON_KEY)
    .eq("user_id", p.userId)
    .maybeSingle();
  if ((uss as { status: string } | null)?.status === "rest") return "personal_rest";
  const { data: rest } = await supabaseAdmin
    .from("crew_personal_rest_periods")
    .select("id")
    .eq("user_id", p.userId)
    .lte("start_date", week.end_date ?? week.start_date)
    .gte("end_date", week.start_date)
    .limit(1);
  if ((rest ?? []).length > 0) return "personal_rest";
  const vmap = await fetchExperienceRequiredSlotStatusByWeek(p.userId, [week.id], Date.now(), {
    alwaysOpenWeekIds: new Set([week.id]),
    organizationSlug: ORG,
  });
  const v = vmap.get(week.id);
  if (!v || v.status === "not_applicable") return "not_applicable";
  if (v.status === "pending") return "pending";
  if (v.status === "pass") return "success";
  return "fail";
}

async function verify(week: WeekRow, threshold: number, plans: UserPlan[]) {
  const published = week.result_published_at != null;
  const reviewed = week.result_reviewed_at != null;
  console.log(`\n[주차 상태] W1(${week.start_date})  공표=${published ? "됨" : "미공표(집계 중)"}  검수=${reviewed ? "완료" : "미완료"}`);
  console.log(`[포인트 기준값] ${threshold}`);

  // 실제 uws 조회
  const userIds = plans.map((p) => p.userId);
  const { data: uwsRows } = await supabaseAdmin
    .from("user_week_statuses")
    .select("user_id,status")
    .eq("week_start_date", week.start_date)
    .in("user_id", userIds);
  const uwsByUser = new Map<string, string>();
  for (const r of (uwsRows ?? []) as { user_id: string; status: string }[]) uwsByUser.set(r.user_id, r.status);

  // 실제 포인트 조회
  const { data: pts } = await supabaseAdmin
    .from("user_weekly_points")
    .select("user_id,points")
    .eq("year", week.iso_year)
    .eq("week_number", week.iso_week)
    .in("user_id", userIds);
  const ptsByUser = new Map<string, number>();
  for (const r of (pts ?? []) as { user_id: string; points: number }[]) ptsByUser.set(r.user_id, r.points);

  console.log("\n사용자        그룹          기대          엔진예측       실제uws        pts  일치");
  let match = 0;
  for (const p of plans) {
    const predicted = await predictVerdict(week, p);
    const actual = (uwsByUser.get(p.userId) as StatusLike) ?? (published ? "-" : "(집계중)");
    const pt = ptsByUser.get(p.userId) ?? 0;
    // 집계 전(미공표): uws 없음이 정상. 공표 후: actual==expected 여야 함.
    const ok = published ? actual === p.expected : predicted === p.expected;
    if (ok) match++;
    console.log(
      `  ${p.displayName.padEnd(8)} ${p.group.padEnd(12)} ${p.expected.padEnd(13)} ${String(predicted).padEnd(13)} ${String(actual).padEnd(13)} ${String(pt).padStart(3)}  ${ok ? "✅" : "❌"}`,
    );
  }
  console.log(`\n일치: ${match}/${plans.length}  (${published ? "공표됨 → 실제 uws 기준" : "미공표 → 엔진 예측 기준(uws 없음이 정상=집계 중)"})`);
}

// ── FINALIZE / REVERT (실제 버튼 서버 함수 재사용) ─────────────────────────────
async function finalize(week: WeekRow) {
  const actor = await firstAdminId();
  console.log(`\n[검수 완료] markTeamPartsWeekReviewed(scope=qa) 실행 — ⚠ QA 코호트 전체 대상.`);
  const res = await markTeamPartsWeekReviewed(week.id, actor, { scope: "qa" });
  console.log(`✅ 결과: ${JSON.stringify(res, null, 2)}`);
}

async function revert(week: WeekRow) {
  const actor = await firstAdminId();
  console.log(`\n[실행 취소] revertTeamPartsWeekReview(scope=qa) 실행.`);
  const res = await revertTeamPartsWeekReview(week.id, "qa", actor);
  console.log(`✅ 결과: ${JSON.stringify(res, null, 2)}`);
}

// ── ROLLBACK (매니페스트 기반) ──────────────────────────────────────────────
async function rollback() {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8")) as Manifest;
  } catch {
    console.log(`❌ 매니페스트 없음(${MANIFEST_PATH}) — 롤백할 시드 기록이 없습니다.`);
    process.exit(2);
  }

  // uws 존재 시 경고(검수 완료가 실행된 상태 — 먼저 --revert 권장).
  const { count: uwsCount } = await supabaseAdmin
    .from("user_week_statuses")
    .select("id", { count: "exact", head: true })
    .eq("week_start_date", manifest.weekStart)
    .in("user_id", manifest.userPlan.map((p) => p.userId));
  if ((uwsCount ?? 0) > 0) {
    console.log(`⚠ 이 주차에 대상자 uws ${uwsCount}건 존재 — 먼저 --revert(실행 취소)로 uws 를 원복한 뒤 --rollback 을 권장합니다.`);
  }

  // 1) 포인트 회수: revokeForAct('irregular', actId) → 원장 삭제 + recompute.
  for (const actId of manifest.irregularActIds) {
    try {
      await revokeForAct("irregular", actId);
    } catch (e) {
      console.warn(`  ⚠ 적립 회수 실패(${actId}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // recipients + irregular acts 삭제
  if (manifest.recipientIds.length) {
    await supabaseAdmin.from("process_check_review_recipients").delete().in("id", manifest.recipientIds);
  }
  if (manifest.irregularActIds.length) {
    await supabaseAdmin.from("process_irregular_acts").delete().in("id", manifest.irregularActIds);
  }

  // 2) 평가 → 대상자 → 라인 → 마스터(생성분만) → 팀(생성분만)
  if (manifest.evaluationIds.length) {
    await supabaseAdmin.from("cluster4_experience_line_evaluations").delete().in("id", manifest.evaluationIds);
  }
  if (manifest.targetIds.length) {
    await supabaseAdmin.from("cluster4_line_targets").delete().in("id", manifest.targetIds);
  }
  const lineIds = manifest.lines.filter((l) => l.created).map((l) => l.id);
  if (lineIds.length) {
    await supabaseAdmin.from("cluster4_lines").delete().in("id", lineIds);
  }
  const masterIds = manifest.masters.filter((m) => m.created).map((m) => m.id);
  if (masterIds.length) {
    await supabaseAdmin.from("cluster4_experience_line_masters").delete().in("id", masterIds);
  }
  if (manifest.teamCreated && manifest.teamId) {
    await supabaseAdmin.from("cluster4_teams").delete().eq("id", manifest.teamId);
  }

  // 3) 개인 휴식 삭제
  if (manifest.restPeriodIds.length) {
    await supabaseAdmin.from("crew_personal_rest_periods").delete().in("id", manifest.restPeriodIds);
  }

  // 4) growth_status / uss status 원복
  for (const [uid, orig] of Object.entries(manifest.originals.growthByUser)) {
    await supabaseAdmin.from("user_profiles").update({ growth_status: orig }).eq("user_id", uid);
  }
  for (const [uid, orig] of Object.entries(manifest.originals.ussStatusByUser)) {
    if (orig == null) continue;
    await supabaseAdmin
      .from("user_season_statuses")
      .update({ status: orig })
      .eq("season_key", SEASON_KEY)
      .eq("user_id", uid);
  }

  await fs.rm(MANIFEST_PATH, { force: true });
  console.log(`✅ 롤백 완료 — 시드가 만든 데이터 제거·원복. 매니페스트 삭제.`);
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const has = (f: string) => argv.includes(f);

  if (has("--rollback")) {
    await rollback();
    process.exit(0);
  }

  const week = await resolveWeek();
  const threshold = await resolveThreshold(week);

  if (has("--finalize")) {
    await finalize(week);
    process.exit(0);
  }
  if (has("--revert")) {
    await revert(week);
    process.exit(0);
  }

  const users = await loadPhalanxTestUsers();
  if (users.length < TOTAL) {
    throw new Error(`phalanx 테스트 유저 ${users.length}명 < 필요 ${TOTAL}명 — 중단.`);
  }
  const selected = users.slice(0, TOTAL);
  const plans = buildUserPlans(selected, threshold);

  if (has("--verify")) {
    await verify(week, threshold, plans);
    process.exit(0);
  }

  console.log(`=== ${SEED_TAG} 시드 ${has("--apply") ? "(APPLY)" : "(DRY-RUN)"} ===`);
  console.log(`주차: ${SEASON_KEY} W1  id=${week.id}  ${week.start_date}~${week.end_date}  iso=${week.iso_year}/${week.iso_week}`);
  console.log(`phalanx 테스트 유저: ${users.length} (사용 ${selected.length})`);
  summarize(plans, threshold);

  if (!has("--apply")) {
    console.log("\n(미리보기 — 적용하려면 --apply · 검증은 --verify)");
    console.log("검수 완료 전에는 /cluster-4·/weekly-ranking 이 '집계 중'(uws 없음)이어야 정상입니다.");
    process.exit(0);
  }

  await apply(week, threshold, plans);
  console.log("\n다음 단계:");
  console.log("  1) --verify           → 예상 verdict/포인트 확인(공표 전=집계 중)");
  console.log("  2) 관리자 UI 검수 완료 버튼 또는 --finalize → uws 생성 + snapshot 재계산");
  console.log("  3) --verify           → success/fail/personal_rest 실제 uws 확인");
  console.log("  4) UI 실행 취소 또는 --revert → 집계 중으로 원복");
  console.log("  5) --rollback         → 시드 입력 데이터 제거");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
