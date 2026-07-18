import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getAdminCrewDtoByLegacyUserId } from "@/lib/adminCrewData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { loadActLogsByStartDate } from "@/lib/cluster4ActLogsData";
import { formatWeekFull } from "@/lib/adminCrewWeeklyResults";
import { isCrewWeekEditable } from "@/shared/growth.contracts";
import {
  buildCrewActSummary,
  resolveCrewActKind,
  resolveCrewActResult,
  type CrewActSummary,
  type CrewActSummaryRow,
} from "@/shared/crewActSummary";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

// ─────────────────────────────────────────────────────────────────────
// 회원별·주차별 상세 "액트 체크 내역" 탭의 서버 DTO/loader.
//   · 액트 목록 = 고객 Detail Log 와 동일 SoT(loadActLogsByStartDate = process_point_awards 원장).
//     관리자 탭은 includeCancelled=true 로 취소된 액트도 "취소됨" 으로 노출한다.
//   · 요약 = **크루 페이지와 동일한 공통 per-user 빌더**(shared/crewActSummary.buildCrewActSummary).
//     두 repo 가 같은 파일을 미러링해 쓰므로 산식이 갈라지지 않는다(관리자 전용 공식 금지).
//     ⚠ org × week 지표인 ActCheckApplicationSummary(액트 체크 신청율)와 혼동 금지 — 단위가 다르다
//       (신청율은 전 크루 동일값 / 이 요약은 크루마다 다름).
//   · **취소 액트**: 표에는 "취소됨" 으로 남기되 **요약 입력에서는 제외**한다. 크루 페이지가
//     includeCancelled=false 로 취소 행을 애초에 목록에서 빼기 때문 — 동일 수치를 맞추려면 요약도 제외해야
//     한다(포인트 합산도 recomputeWeeklyPoints 가 cancelled_at IS NULL 로 이미 제외). 신규 정책 아님.
//   · weekId 는 카드 식별자(합성일 수 있음). 재집계는 (iso_year,iso_week) 축이라 카드 startDate 로
//     실제 weeks 행을 되짚어 realWeekId 를 확보한다(합성 weekId 로 재집계 no-op 되는 것 방지).
// ─────────────────────────────────────────────────────────────────────

export type CrewWeekActRow = {
  awardId: string; // 안정 식별자(process_point_awards.id) — 취소 대상 지정용
  // 결과 = 크루 기준 판정(공통 resolveCrewActResult, 적립 포인트 파생). 원장 result 필드 아님.
  //   "체크 성공"(A/B 획득·무포인트 이행) | "체크 실패"(Point.C 미스) | "취소됨"(soft-cancel).
  resultLabel: string;
  resultTone: "success" | "fail" | "neutral"; // 배지 색(성공=초록·실패=빨강·취소=중립)
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
  // 요약(per-user) = 크루 페이지와 동일 빌더·동일 값. 취소 액트는 입력에서 제외(위 주석 참고).
  summary: CrewActSummary;
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

// 표 "종류" 컬럼 — 정규만 필수/선별 표기(기존 관리자 표 동작 유지). 변동은 "-".
//   ⚠ 판정 자체는 공통 resolveCrewActKind(크루 페이지와 동일 SoT) 재사용 — 자체 매핑 금지.
//   (크루 페이지 표는 변동을 전원/부분으로 표기하지만, 관리자 표의 이 컬럼은 기존대로 "-" 를 유지한다.
//    요약의 필수/선별은 정규 행만 세므로 이 표기 차이가 요약 수치에 영향을 주지 않는다.)
function requirementLabel(source: string, kind: string): string {
  if (source !== "regular") return "-";
  return resolveCrewActKind(source, kind).label;
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
    .map((l) => {
      // 결과 = 크루 기준 판정(취소가 아니면 적립 포인트에서 파생). 원장 result 필드(항상 "checked")를
      //   그대로 "체크 성공"으로 쓰던 것이 Point.C(미스) 행까지 성공으로 표기하던 버그였다.
      const crewResult = resolveCrewActResult({ pointA: l.pointA, pointB: l.pointB, pointC: l.pointC });
      const resultLabel = l.cancelled
        ? "취소됨"
        : crewResult === "fail"
          ? "체크 실패"
          : crewResult === "pending"
            ? "미판정"
            : "체크 성공";
      const resultTone: "success" | "fail" | "neutral" = l.cancelled
        ? "neutral"
        : crewResult === "fail"
          ? "fail"
          : crewResult === "pending"
            ? "neutral"
            : "success";
      return {
      awardId: l.awardId,
      resultLabel,
      resultTone,
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
      };
    });

  const weekLabel =
    formatWeekFull(ctx.card.seasonKey, ctx.card.weekNumber) ?? ctx.card.weekLabel ?? "-";

  // ── 요약(per-user) — 크루 페이지와 동일 빌더/동일 입력 ──────────────────────
  //   입력 = 크루 페이지가 보는 행과 동일 집합: 원장 actLogs 중 **취소 제외**(includeCancelled=false 등가).
  //   ⚠ 표(acts)는 취소 행을 포함하지만 요약은 제외한다 → 같은 user/week 에서 크루 페이지와 수치 일치.
  //   available* 는 DTO 에 원천이 없어 빌더가 earned 로 폴백한다(크루 페이지 현행과 동일 — 별도 이슈).
  const summaryRows: CrewActSummaryRow[] = logs
    .filter((l) => (l.source === "regular" || l.source === "irregular") && !l.cancelled)
    .map((l) => ({
      result: l.result === "checked" ? "checked" : "miss",
      source: l.source === "irregular" ? "irregular" : "regular",
      kindKey: resolveCrewActKind(l.source, l.kind).key,
      pointA: l.pointA,
      pointB: l.pointB,
      pointC: l.pointC,
    }));

  return {
    ok: true,
    data: {
      weekId: urlWeekId,
      weekLabel,
      editable: ctx.editable,
      summary: buildCrewActSummary(summaryRows),
      acts,
    },
  };
}
