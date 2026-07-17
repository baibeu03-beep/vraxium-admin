// Cluster4 라인 강화 상태(enhancementStatus) 수동 override — read-time overlay.
//
// 정책(중요):
//   - 이 모듈은 조회 시점(loadWeeklyCards 반환 직전)에만 적용된다. snapshot 에는 절대 굽지 않는다.
//   - computeCluster4Enhancement / snapshot 생성 로직은 무수정. override 는 "계산 결과 위에서만" 적용.
//   - override 행이 없거나 매칭되는 라인이 없으면 입력 cards 를 그대로(동일 참조) 반환한다
//     → 기존 응답과 100% 동일(회귀 0).
//   - 배지만 바꾸지 않는다: override 적용 후 그 카드의 강화율(라인 numerator/denominator/rate,
//     카드 weeklyGrowthRate/growthNumerator/growthDenominator, experienceRate)을 기존
//     breakdownFromLines + attachLineBreakdown 로직을 그대로 재사용해 재파생한다
//     → 라인 배지와 카드 수치가 항상 일치.
//   - 일반 모드 / mode=test(demoUserId) 는 loadWeeklyCards 단일 지점을 공유하므로 자동으로 동일
//     데코레이터·동일 DTO 를 탄다(override 키는 user_id 라 mode 와 무관).

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { roundGrowthRate } from "@/lib/lineAvailability";
import {
  attachLineBreakdown,
  breakdownFromLines,
  emptyBreakdown,
} from "@/lib/cluster4WeeklyCardsData";
import type {
  Cluster4EnhancementStatus,
  Cluster4LineDetailDto,
  Cluster4WeeklyCardDto,
} from "@/shared/cluster4.contracts";

const TABLE = "cluster4_line_enhancement_overrides";

// 강화 상태 override 기록(find-then-write) — enhancement-overrides POST 라우트와 동일 규칙.
//   info/competency 처럼 "표시 override" 가 결과 레버인 허브의 강화 결과 변경에 사용한다.
//   part_type 은 long form('information'|'experience'|'competency'|'career'). identity = target > id > code.
//   COALESCE 유니크 인덱스라 upsert onConflict 대신 find-then-write. 읽기 overlay 라 snapshot 무효화 불필요.
export async function setEnhancementOverrideStatus(params: {
  userId: string;
  weekId: string;
  partType: string;
  lineTargetId: string | null;
  lineId: string | null;
  lineCode: string | null;
  overrideStatus: Cluster4EnhancementStatus;
  adminUserId: string | null;
  note?: string | null;
}): Promise<{ changed: boolean }> {
  const { userId, weekId, partType, lineTargetId, lineId, lineCode, overrideStatus, adminUserId, note } =
    params;
  let findQ = supabaseAdmin
    .from(TABLE)
    .select("id,override_status")
    .eq("user_id", userId)
    .eq("week_id", weekId)
    .eq("part_type", partType);
  findQ = lineTargetId ? findQ.eq("line_target_id", lineTargetId) : findQ.is("line_target_id", null);
  findQ = lineId ? findQ.eq("line_id", lineId) : findQ.is("line_id", null);
  findQ = lineCode ? findQ.eq("line_code", lineCode) : findQ.is("line_code", null);
  findQ = findQ.is("line_ordinal", null);
  const { data: existing, error: findErr } = await findQ.maybeSingle();
  if (findErr) throw findErr;
  const row = existing as { id: string; override_status: string } | null;
  const nowIso = new Date().toISOString();
  if (row) {
    if (row.override_status === overrideStatus) return { changed: false };
    const { error } = await supabaseAdmin
      .from(TABLE)
      .update({
        override_status: overrideStatus,
        note: note ?? null,
        source: "admin_manual",
        created_by: adminUserId,
        updated_at: nowIso,
      })
      .eq("id", row.id);
    if (error) throw error;
    return { changed: true };
  }
  const { error } = await supabaseAdmin.from(TABLE).insert({
    user_id: userId,
    week_id: weekId,
    part_type: partType,
    line_target_id: lineTargetId,
    line_id: lineId,
    line_code: lineCode,
    line_ordinal: null,
    override_status: overrideStatus,
    source: "admin_manual",
    note: note ?? null,
    created_by: adminUserId,
  });
  if (error) throw error;
  return { changed: true };
}

export type Cluster4LineEnhancementOverrideRow = {
  id: string;
  user_id: string;
  week_id: string;
  part_type: string;
  line_target_id: string | null;
  line_id: string | null;
  line_code: string | null;
  // placeholder(식별키 전무) 라인용 최후 폴백 키 — 카드 lines 배열 내 인덱스.
  line_ordinal: number | null;
  override_status: Cluster4EnhancementStatus;
  source: string;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

const SELECT_COLUMNS =
  "id,user_id,week_id,part_type,line_target_id,line_id,line_code,line_ordinal,override_status,source,note,created_by,created_at,updated_at";

// 한 사용자의 모든 라인 강화 override 를 로드한다(카드 조회당 1 SELECT).
// 테이블 미존재(마이그레이션 미적용) 등 실패 시 "override 없음"으로 취급해 조용히 [] 반환한다
// (조회 경로가 override 때문에 깨지지 않도록 — fail-open 은 여기선 "기존 자동값 유지"라 안전).
export async function loadEnhancementOverridesForUser(
  userId: string,
): Promise<Cluster4LineEnhancementOverrideRow[]> {
  if (!userId) return [];
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select(SELECT_COLUMNS)
    .eq("user_id", userId);
  if (error) {
    console.warn(
      "[cluster4/enh-override] load failed → treat as no override",
      { userId, message: error.message },
    );
    return [];
  }
  return (data ?? []) as Cluster4LineEnhancementOverrideRow[];
}

// override 행이 특정 카드 라인과 매칭되는지. 식별 우선순위: line_target_id > line_id > line_code > line_ordinal.
//   - 주차(week_id)와 part_type 이 먼저 일치해야 한다.
//   - target 기반 override 는 반드시 같은 line_target_id 를 가진 라인에만 적용(미배정 라인엔 안 붙음).
//   - identity 전무 placeholder 라인은 line_ordinal(카드 lines 배열 인덱스)로 매칭한다.
function overrideMatchesLine(
  row: Cluster4LineEnhancementOverrideRow,
  line: Cluster4LineDetailDto,
  lineIndex: number,
  cardWeekId: string | null,
): boolean {
  if (!cardWeekId || row.week_id !== cardWeekId) return false;
  if (row.part_type !== line.partType) return false;
  if (row.line_target_id != null) {
    return line.lineTargetId != null && line.lineTargetId === row.line_target_id;
  }
  if (row.line_id != null) {
    return line.lineId != null && line.lineId === row.line_id;
  }
  if (row.line_code != null) {
    return line.lineCode != null && line.lineCode === row.line_code;
  }
  if (row.line_ordinal != null) {
    return lineIndex === row.line_ordinal;
  }
  return false;
}

// read-time overlay: override 를 적용하고, 바뀐 카드만 강화율을 재파생해 반환한다.
//   override 없음 / 매칭 라인 없음 / 값 동일(no-op) → 입력 cards 를 동일 참조로 반환(100% 동일).
// preloadedRows: 호출부가 이미 시작해 둔 loadEnhancementOverridesForUser(userId) 결과 promise.
//   I/O 시작 시점만 앞당기기 위한 것 — 넘기지 않으면 기존과 100% 동일하게 여기서 조회한다.
//   ⚠ 반드시 "같은 userId 의 같은 조회" 결과여야 한다(호출부 책임). 적용 로직·순서·단축 판정 불변.
export async function applyEnhancementOverridesToCards(
  userId: string,
  cards: Cluster4WeeklyCardDto[],
  preloadedRows?: Promise<Cluster4LineEnhancementOverrideRow[]>,
): Promise<Cluster4WeeklyCardDto[]> {
  if (!userId || !Array.isArray(cards) || cards.length === 0) return cards;

  const rows = await (preloadedRows ?? loadEnhancementOverridesForUser(userId));
  if (rows.length === 0) return cards;

  let anyCardChanged = false;
  const next = cards.map((card) => {
    const cardWeekId = card.weekId ?? null;
    if (!cardWeekId || !Array.isArray(card.lines) || card.lines.length === 0) {
      return card;
    }
    // 이 카드 주차에 해당하는 override 만 후보로 좁힌다(빠른 필터).
    const candidates = rows.filter((r) => r.week_id === cardWeekId);
    if (candidates.length === 0) return card;

    let lineChanged = false;
    const overriddenLines: Cluster4LineDetailDto[] = card.lines.map((line, idx) => {
      const match = candidates.find((r) => overrideMatchesLine(r, line, idx, cardWeekId));
      if (!match) return line;
      if (line.enhancementStatus === match.override_status) return line; // no-op
      lineChanged = true;
      return { ...line, enhancementStatus: match.override_status };
    });
    if (!lineChanged) return card;
    anyCardChanged = true;

    // ── 강화율 재파생 (cluster4WeeklyCardsData.ts buildWeeklyCard 1272-1354 와 동일 산식) ──
    //   기존 함수(breakdownFromLines/attachLineBreakdown/roundGrowthRate)를 그대로 재사용한다.
    //   → 라인 배지(enhancementStatus) 와 카드/라인 강화율 수치가 항상 일치한다.
    const rest = card.isRestWeek;
    const breakdown = rest ? emptyBreakdown() : breakdownFromLines(overriddenLines);
    const completedLines =
      breakdown.info.completed +
      breakdown.ability.completed +
      breakdown.experience.completed +
      breakdown.career.completed;
    const availableLines =
      breakdown.info.available +
      breakdown.ability.available +
      breakdown.experience.available +
      breakdown.career.available;
    const linesWithBreakdown = attachLineBreakdown(overriddenLines, breakdown, rest);

    return {
      ...card,
      lines: linesWithBreakdown,
      weeklyGrowthRate: roundGrowthRate(completedLines, availableLines),
      growthNumerator: completedLines,
      growthDenominator: availableLines,
      experienceRate: {
        count: breakdown.experience.completed,
        total: breakdown.experience.available,
        rate: roundGrowthRate(
          breakdown.experience.completed,
          breakdown.experience.available,
        ),
      },
    };
  });

  return anyCardChanged ? next : cards;
}
