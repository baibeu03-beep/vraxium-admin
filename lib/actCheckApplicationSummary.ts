// 액트 체크 신청율 — 집계 단일 SoT(순수 함수·브라우저 안전).
// ─────────────────────────────────────────────────────────────────────
// ⚠ 이 지표는 "성공률/이행률/완료율"이 아니다. **가동된 액트 중 체크 신청이 접수된 비율**이다.
//   따라서 completed 만 세거나, matched 사용자 수를 세거나, 포인트 원장을 보면 안 된다.
//
// 정의(2026-07-17 확정):
//   전체(totalCount)   = 모든 정규 액트(가동 무관) + 그 주차의 모든 변동 액트
//   가동(activeCount)  = 가동된 정규 액트 + **모든 변동 액트**(변동은 생성=체크 요구 → 항상 가동)
//   체크(checkedCount) = 체크 신청된 가동 정규 액트 + 체크된 변동 액트
//   미체크(uncheckedCount) = 가동 − 체크
//   변동(variableCount)    = 그 주차의 변동 액트 수
//   신청율(applicationRate) = 체크 / 가동 × 100 (가동 0 → 0)
//
// 불변식: activeCount === checkedCount + uncheckedCount · checkedCount <= activeCount
//         totalCount === (정규 전체) + variableCount · activeCount >= variableCount
//
// 판정 SoT(호출부가 주입 — 여기서 새 규칙을 만들지 않는다):
//   · 정규 isActive  = weekOpenGate.isActOpenForWeek(+ config 없는 legacy 주차는 이력 보존)
//   · 정규 isApplied = process_check_statuses.status ∈ {pending, completed}  ("needed"=미신청)
//   · 변동 isChecked = effectiveIrregularStatus(kind,status,scheduled,now) === "completed"
//                      (manual_grant=생성 즉시 completed / review_request=pending 이면 미체크)
//   · origin='emergency_rest' 변동 행은 액트가 아니므로 호출부가 입력에서 제외한다.
//
// 중복 방지: 정규는 actId, 변동은 id 기준 dedupe(experience 는 팀/파트별 다중 상태행 → 액트 1건으로 접힘).
// ─────────────────────────────────────────────────────────────────────

export type ActCheckApplicationSummary = {
  totalCount: number;
  activeCount: number;
  checkedCount: number;
  uncheckedCount: number;
  variableCount: number;
  /** 0~100 정수(반올림) — 기존 관리자 지표 공통 포맷(lineOpenRate 등)과 동일. 원본 count 는 위 필드로 제공. */
  applicationRate: number;
};

/** 정규 액트 1건(액트 단위로 접힌 상태). */
export type ActCheckRegularInput = {
  actId: string;
  hub: string;
  isActive: boolean;
  isApplied: boolean;
};

/** 변동 액트 1건(emergency_rest 제외된 상태). */
export type ActCheckVariableInput = {
  id: string;
  isChecked: boolean;
};

export type ActCheckWeekInputs = {
  regular: ActCheckRegularInput[];
  variable: ActCheckVariableInput[];
};

export function emptyActCheckApplicationSummary(): ActCheckApplicationSummary {
  return {
    totalCount: 0,
    activeCount: 0,
    checkedCount: 0,
    uncheckedCount: 0,
    variableCount: 0,
    applicationRate: 0,
  };
}

function dedupeBy<T>(rows: readonly T[], key: (r: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/**
 * 액트 체크 신청 요약 — 목록/상세 공통 단일 빌더.
 *   호출부는 스코프(허브/팀)만 좁혀서 넣고, 산식은 절대 자체 구현하지 않는다.
 */
export function buildActCheckApplicationSummary(
  regular: readonly ActCheckRegularInput[],
  variable: readonly ActCheckVariableInput[],
): ActCheckApplicationSummary {
  const reg = dedupeBy(regular, (r) => r.actId);
  const vars = dedupeBy(variable, (v) => v.id);

  const activeRegular = reg.filter((r) => r.isActive);
  // 변동은 생성과 동시에 체크를 요구하는 액트 → 항상 가동(미가동 변동 상태는 존재하지 않는다).
  const activeCount = activeRegular.length + vars.length;
  const checkedCount =
    activeRegular.filter((r) => r.isApplied).length + vars.filter((v) => v.isChecked).length;

  return {
    totalCount: reg.length + vars.length,
    activeCount,
    checkedCount,
    uncheckedCount: activeCount - checkedCount,
    variableCount: vars.length,
    applicationRate: activeCount === 0 ? 0 : Math.round((checkedCount / activeCount) * 100),
  };
}
