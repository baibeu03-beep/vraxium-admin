import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getAdminCrewDtoByLegacyUserId } from "@/lib/adminCrewData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { loadActLogsByStartDate } from "@/lib/cluster4ActLogsData";
import { formatWeekFull } from "@/lib/adminCrewWeeklyResults";
import { isCrewWeekEditable } from "@/shared/growth.contracts";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

// ─────────────────────────────────────────────────────────────────────
// 회원별·주차별 상세 "액트 체크 내역" 탭의 서버 DTO/loader.
//   · 액트 목록 = 고객 Detail Log 와 동일 SoT(loadActLogsByStartDate = process_point_awards 원장).
//     관리자 탭은 includeCancelled=true 로 취소된 액트도 "취소됨" 으로 노출한다.
//   · 요약 지표(활동 완료율/체크 성공·실패/획득·가능 포인트)는 고객 레포에 계산 공식이 있어
//     이 단계에선 보류(summary=null) — 임의 공식으로 고객 수치와 드리프트 내지 않는다.
//   · weekId 는 카드 식별자(합성일 수 있음). 재집계는 (iso_year,iso_week) 축이라 카드 startDate 로
//     실제 weeks 행을 되짚어 realWeekId 를 확보한다(합성 weekId 로 재집계 no-op 되는 것 방지).
// ─────────────────────────────────────────────────────────────────────

export type CrewWeekActRow = {
  awardId: string; // 안정 식별자(process_point_awards.id) — 취소 대상 지정용
  resultLabel: string; // "체크 성공" | "취소됨"(soft-cancel)
  actName: string;
  occurredAt: string | null;
  hubName: string | null;
  lineName: string | null;
  durationMinutes: number;
  pointA: number; // 별(A) — 원장 point_check
  pointB: number; // 방패(B) — 원장 point_advantage(per-act raw)
  pointC: number; // 번개(C) — 원장 point_penalty 크기(≥0)
  actKindLabel: "정규" | "변동"; // 구분 = source
  requirementLabel: string; // 종류 = 필수/선별/-(정규 act_type; 변동은 '-')
  cancelled: boolean;
  cancellable: boolean;
  cancelReason: string | null;
};

export type CrewWeekActDetailDto = {
  weekId: string; // URL 카드 weekId 그대로 echo
  weekLabel: string;
  editable: boolean; // isCrewWeekEditable(주차 성장 상태)
  // 요약 지표는 후속(고객 공식 확보 후). 현재는 null 로 명시(placeholder 노출).
  summary: null;
  acts: CrewWeekActRow[];
};

export type CrewWeekContext = {
  legacyUserId: string;
  userId: string; // 실제 user_profiles.user_id
  organizationSlug: string | null;
  card: Cluster4WeeklyCardDto;
  startDate: string;
  realWeekId: string | null; // weeks.id (재집계용) — startDate 로 되짚음
  editable: boolean;
};

export type CrewWeekContextResult =
  | { ok: true; ctx: CrewWeekContext }
  | { ok: false; reason: "member_not_found" | "week_not_found" };

// 크루 + 주차 컨텍스트 해석(액트 조회/취소 공통). weekId 소유 검증(카드 실재) + 재집계용 realWeekId.
export async function resolveCrewWeekContext(
  legacyUserId: string,
  urlWeekId: string,
): Promise<CrewWeekContextResult> {
  const crew = await getAdminCrewDtoByLegacyUserId(legacyUserId);
  if (!crew) return { ok: false, reason: "member_not_found" };

  const snap = await readWeeklyCardsSnapshot(crew.userId);
  const cards = snap.status === "hit" || snap.status === "stale" ? snap.cards : [];
  const card = cards.find((c) => c.weekId === urlWeekId);
  if (!card || !card.weekId) return { ok: false, reason: "week_not_found" };

  // 재집계용 실제 weeks.id — 카드 startDate 로 되짚음(합성 weekId 방지). 없으면 null(재집계 스킵 방지 위해 상위서 처리).
  let realWeekId: string | null = null;
  const wk = await supabaseAdmin
    .from("weeks")
    .select("id")
    .eq("start_date", card.startDate)
    .limit(1)
    .maybeSingle();
  if (!wk.error && wk.data) realWeekId = (wk.data as { id: string }).id;

  return {
    ok: true,
    ctx: {
      legacyUserId,
      userId: crew.userId,
      organizationSlug: crew.organizationSlug,
      card,
      startDate: card.startDate,
      realWeekId,
      editable: isCrewWeekEditable(card.userWeekStatus),
    },
  };
}

// 정규 act_type → 종류 라벨(필수/선별). 레거시(optional/basic)·변동은 "-".
function requirementLabel(source: string, kind: string): string {
  if (source !== "regular") return "-";
  if (kind === "required") return "필수";
  if (kind === "selection") return "선별";
  return "-";
}

export type CrewWeekActDetailResult =
  | { ok: true; data: CrewWeekActDetailDto }
  | { ok: false; reason: "member_not_found" | "week_not_found" };

// 액트 체크 내역 상세 DTO — ctx 기준 액트 목록(취소 포함) 조립.
export async function getCrewWeekActDetail(
  legacyUserId: string,
  urlWeekId: string,
): Promise<CrewWeekActDetailResult> {
  const resolved = await resolveCrewWeekContext(legacyUserId, urlWeekId);
  if (!resolved.ok) return resolved;
  const { ctx } = resolved;

  const byStart = await loadActLogsByStartDate(ctx.userId, { includeCancelled: true });
  const logs = byStart.get(ctx.startDate) ?? [];

  const acts: CrewWeekActRow[] = logs
    // 라인 개설 페이백(source='line') 누출 행 제외 — 액트 체크 목록은 정규/변동만.
    .filter((l) => l.source === "regular" || l.source === "irregular")
    .map((l) => ({
      awardId: l.awardId,
      resultLabel: l.cancelled ? "취소됨" : "체크 성공",
      actName: l.actName || "(액트)",
      occurredAt: l.occurredAt,
      hubName: l.hub,
      lineName: l.lineGroupName,
      durationMinutes: l.durationMinutes,
      pointA: l.pointA,
      pointB: l.pointB,
      pointC: l.pointC,
      actKindLabel: l.source === "regular" ? "정규" : "변동",
      requirementLabel: requirementLabel(l.source, l.kind),
      cancelled: l.cancelled,
      // 취소 가능 = 주차 수정 가능 + 미취소 + 안정 식별자 보유(마이그레이션 적용 후에만 awardId 유효).
      cancellable: ctx.editable && !l.cancelled && Boolean(l.awardId),
      cancelReason: l.cancelReason,
    }));

  const weekLabel =
    formatWeekFull(ctx.card.seasonKey, ctx.card.weekNumber) ?? ctx.card.weekLabel ?? "-";

  return {
    ok: true,
    data: {
      weekId: urlWeekId,
      weekLabel,
      editable: ctx.editable,
      summary: null,
      acts,
    },
  };
}
