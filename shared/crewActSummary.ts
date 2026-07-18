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
// ⚠ 크루 기준 성공/실패는 **적립 포인트에서 파생**한다 — 원장 result 필드가 아니다(2026-07-18 수정).
//   적립 원장(process_point_awards)엔 "적립된 액트" 행만 담기고 그 행의 result 는 항상 "checked" 다.
//   그러나 적립 정책(processPointAccrual)상 한 크루는 한 액트에서 (A/B, C=0) '이행자' 또는 (0/0/C)
//   '비대상자' 중 **하나에만** 속한다(상호배타). 즉 Point.C(패널티) 적립 = 체크 대상이었으나 미이행:
//     · Point.C > 0                → 미스(fail)   · Point.A/B 획득·무포인트 이행 → 성공(success)
//   따라서 result 필드로 성공을 세면 미스(패널티 행)까지 성공으로 잡혀 rate 가 항상 100% 로 부풀었다
//   (실제 버그: 7행 전부 C>0 인데 "체크 성공 7·완료율 100%"). 판정은 resolveCrewActResult 로 파생한다.
//   available* 는 DTO 원천이 없어 earned 로 폴백된다(예: 20/20) — 별도 이슈, 여기서 재설계 금지.
// ─────────────────────────────────────────────────────────────────────

/**
 * 원장 적립 행 존재 마커(hasResultRecord) — "checked"=적립 행 있음. "miss" 는 enum 예약(미사용).
 * ⚠ 크루 성공/실패 판정에 쓰지 말 것 — 그건 `resolveCrewActResult`(적립 포인트 파생)로 한다.
 */
export type CrewActResult = "checked" | "miss";

/** 크루 기준 액트 판정 결과 — 표시 배지·요약 성공/실패 공통 SoT(hasResultRecord 와 분리). */
export type CrewActCheckResult = "success" | "fail" | "pending";
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
  /** 체크 가능 = 표시 중인 행 수. 불변식: total === success + fail + pending */
  total: number;
  /** 크루 체크 성공 = Point.A/B 획득(이행자) 또는 무포인트 이행 행 수 */
  success: number;
  /** 크루 체크 실패=미스 = Point.C(패널티) 적립 행 수 */
  fail: number;
  /** 미판정(원장 미적립) — 현 원장 원천에선 항상 0(후속 Phase 대비) */
  pending: number;
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
    pending: 0,
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
 * 크루 기준 액트 결과 판정 — 표시 배지와 요약 성공/실패가 **함께 쓰는 단일 함수**(공통 SoT).
 * ⚠ hasResultRecord(row.result "checked") 와 crewCheckResult 를 분리한다 —
 *   적립 원장 행이 존재한다는 사실만으로 성공이 아니다.
 *   · Point.C(패널티 magnitude) > 0 → 체크 대상이었으나 미이행 = "fail"(미스). **C 최우선**.
 *   · Point.A 또는 Point.B > 0        → 보상 획득(이행자)              = "success".
 *   · A/B/C 전부 0                    → 무포인트 이행자(원장 확정 행)   = "success".
 *   (판정 미완 액트는 원장에 적립되지 않아 이 원천에선 pending 미발생 — 타입만 유지.)
 * 적립 정책상 A/B 와 C 는 한 크루·한 액트에 동시 적립되지 않으므로(상호배타), 실데이터에서
 * "C 최우선"과 "A/B 우선"의 결과가 동일하다. 제품 정책("Point.C = 미스")에 맞춰 C 를 최우선한다.
 */
export function resolveCrewActResult(row: {
  pointA: number;
  pointB: number;
  pointC: number;
}): CrewActCheckResult {
  if (Math.abs(row.pointC ?? 0) > 0) return "fail";
  if ((row.pointA ?? 0) > 0 || (row.pointB ?? 0) > 0) return "success";
  return "success";
}

/**
 * 크루 액트 요약 — **표시 중인 행 단일 출처**로 파생(순수 함수).
 * 불변식: total === success + fail + pending · total === 표시 행 수.
 * 성공/실패는 크루 기준 판정(resolveCrewActResult, 적립 포인트 파생)으로 센다 — 원장 result 필드 아님.
 * 포인트 C 는 표(부호 없는 magnitude 표기)와 동일하게 Math.abs 로 합산해 표↔요약 parity 를 지킨다.
 */
export function buildCrewActSummary(acts: readonly CrewActSummaryRow[]): CrewActSummary {
  const total = acts.length;
  const outcomes = acts.map(resolveCrewActResult);
  const success = outcomes.filter((r) => r === "success").length;
  const pending = outcomes.filter((r) => r === "pending").length;
  const fail = total - success - pending;
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
    pending,
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
