// 크루 액트 내역 요약(per-user) — 크루 페이지 · 관리자 주차 상세 액트 탭 **공통 SoT**.
// ─────────────────────────────────────────────────────────────────────
// ⚠ 이 파일은 두 repo 에 **미러링**된다(shared/cluster4.contracts.ts 와 동일 규약):
//     vraxium-admin/shared/crewActSummary.ts  ==  vraxium/shared/crewActSummary.ts
//   한쪽만 고치면 두 화면 수치가 갈라진다 — 반드시 같이 수정할 것.
//
// 단위 = **user × week**. "이 크루가 받은(적립된) 액트" 요약이다.
//   ⚠ org × week 지표인 `ActCheckApplicationSummary`(액트 체크 신청율)와 **의미가 다르다**. 섞지 말 것:
//     · 신청율  = 관리자가 그 액트에 "체크 신청"을 접수했는가 (org 단위 · 전 크루 동일값)
//     · 이 요약 = 그 크루가 실제로 이행/적립했는가 (user 단위 · 크루마다 다름)
//
// SoT = `Cluster4ActLogDto`(= process_point_awards 적립 원장) 파생 행. 표시 중인 행만 합산한다
//   — DOM 재추산·별도 조회·대상자 재판정 금지.
//
// 취소(soft-cancel) 정책(기존 크루 페이지 SoT 그대로 승계 — 신규 정의 아님):
//   · 크루 페이지: loadActLogsByStartDate 기본 includeCancelled=false → 취소 액트가 **목록에서 빠짐**
//     → 요약 입력에도 애초에 없음 = 전체/성공/실패/포인트 어디에도 미포함.
//   · 관리자 탭 : 표에는 "취소됨" 으로 노출하되(includeCancelled=true), **요약 입력에서는 제외**해
//     크루 페이지와 동일 수치를 유지한다(호출부가 cancelled 행을 걸러 넣는다).
//   · 포인트 합산(user_weekly_points)도 recomputeWeeklyPoints 가 cancelled_at IS NULL 로 제외.
//
// ⚠ 알려진 한계(이번 범위 아님 — 별도 이슈): 현재 원장 기반 actLogs 는 "적립된 액트"만 담아
//   result 가 항상 "checked" 다 → **fail 은 항상 0**, rate 는 항상 100%. 또 DTO 에 availableA/B/C 가
//   없어 available 이 earned 로 폴백된다(예: 43/43). 이 산식은 크루 페이지 현행과의 **동등성**이
//   기준이므로 여기서 임의 재설계하지 않는다.
// ─────────────────────────────────────────────────────────────────────

/** 1차 범위는 "checked" 고정. "miss"(미수행 행)는 후속 Phase 대비 enum 만 유지. */
export type CrewActResult = "checked" | "miss";
export type CrewActSource = "regular" | "irregular";
/** 종류 배지 키 — 정규: 필수/선별 · 변동: 전원/부분 · 미상: unknown. */
export type CrewActKindKey = "required" | "selective" | "all" | "partial" | "unknown";

/** 요약이 소비하는 액트 1행(표시 중인 행). 두 화면이 이 형태로 정규화해 넣는다. */
export type CrewActSummaryRow = {
  result: CrewActResult;
  source: CrewActSource;
  kindKey: CrewActKindKey;
  /** Po.A(별/투구…) 적립값 */
  pointA: number;
  /** Po.B(방패/인절미…) 적립값 */
  pointB: number;
  /** Po.C(번개/화살…) 패널티 magnitude(≥0) — 표시는 음수/빨강, 합산은 magnitude. */
  pointC: number;
  /** (선택) 획득 가능했던 최대치 — 업스트림이 주면 사용, 없으면 획득값으로 폴백(획득=가능). */
  availableA?: number;
  availableB?: number;
  availableC?: number;
};

export type CrewActPointPair = { earned: number; available: number };

export type CrewActSummary = {
  /** 체크 가능 = 표시 중인 행 수. 불변식: total === success + fail */
  total: number;
  success: number;
  fail: number;
  /** 정규 행 중 종류=필수 */
  required: number;
  /** 정규 행 중 종류=선별 */
  selective: number;
  /** 활동 완료율 = round(success/total*100), total 0 → 0 */
  rate: number;
  regularActCount: number;
  variableActCount: number;
  points: { pointA: CrewActPointPair; pointB: CrewActPointPair; pointC: CrewActPointPair };
};

/**
 * 종류(label + 배지 key) 판정 — 두 화면 공통 단일 SoT.
 *   정규: required|basic → 필수 · selection|optional → 선별  (basic/optional = 레거시 enum)
 *   변동: all → 전원 · partial → 부분
 *   그 외/미상 → "-"(unknown)
 */
export function resolveCrewActKind(
  source: string,
  kind: string | null | undefined,
): { label: string; key: CrewActKindKey } {
  const k = String(kind ?? "").toLowerCase();
  if (source === "irregular") {
    if (k === "all") return { label: "전원", key: "all" };
    if (k === "partial") return { label: "부분", key: "partial" };
    return { label: "-", key: "unknown" };
  }
  if (k === "required" || k === "basic") return { label: "필수", key: "required" };
  if (k === "selection" || k === "optional") return { label: "선별", key: "selective" };
  return { label: "-", key: "unknown" };
}

export function emptyCrewActSummary(): CrewActSummary {
  return {
    total: 0,
    success: 0,
    fail: 0,
    required: 0,
    selective: 0,
    rate: 0,
    regularActCount: 0,
    variableActCount: 0,
    points: {
      pointA: { earned: 0, available: 0 },
      pointB: { earned: 0, available: 0 },
      pointC: { earned: 0, available: 0 },
    },
  };
}

/**
 * 크루 액트 요약 — **표시 중인 행 단일 출처**로 파생(순수 함수).
 * 불변식: total === success + fail · total === 표시 행 수.
 * 포인트 C 는 표(부호 없는 magnitude 표기)와 동일하게 Math.abs 로 합산해 표↔요약 parity 를 지킨다.
 */
export function buildCrewActSummary(acts: readonly CrewActSummaryRow[]): CrewActSummary {
  const total = acts.length;
  const success = acts.filter((a) => a.result === "checked").length;
  const fail = total - success;
  const required = acts.filter((a) => a.source === "regular" && a.kindKey === "required").length;
  const selective = acts.filter((a) => a.source === "regular" && a.kindKey === "selective").length;
  const rate = total > 0 ? Math.round((success / total) * 100) : 0;
  const regularActCount = acts.filter((a) => a.source === "regular").length;
  const variableActCount = acts.filter((a) => a.source === "irregular").length;
  const sum = (pick: (a: CrewActSummaryRow) => number) =>
    acts.reduce((n, a) => n + (pick(a) || 0), 0);
  return {
    total,
    success,
    fail,
    required,
    selective,
    rate,
    regularActCount,
    variableActCount,
    points: {
      pointA: { earned: sum((a) => a.pointA), available: sum((a) => a.availableA ?? a.pointA) },
      pointB: { earned: sum((a) => a.pointB), available: sum((a) => a.availableB ?? a.pointB) },
      pointC: {
        earned: sum((a) => Math.abs(a.pointC)),
        available: sum((a) => Math.abs(a.availableC ?? a.pointC)),
      },
    },
  };
}
