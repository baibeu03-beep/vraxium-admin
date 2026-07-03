// Action Control 레지스트리 — 운영/QA 공용 "수동 실행(⚡ 즉시 실행 / ↩ 실행 취소)" 정책의 단일 SoT.
//
//   핵심 원칙(요구사항):
//     1) 자동 실행(스케줄러)과 수동 실행은 "동일한 Action Service"를 호출한다. 여기서는
//        어떤 서비스를 공유하는지만 기록하고, 실제 호출은 각 라우트/컴포넌트가 그 서비스를 쓴다.
//     2) display-only / QA 전용 로직 / 운영·QA 이중 구현을 만들지 않는다.
//     3) ↩ 실행 취소 = 단순 삭제가 아니라 "직전 단계 복원(step-back)". 복원 후 관련 snapshot 재계산.
//     4) 모든 Action이 취소 가능한 것은 아니므로, Action별 "직전 단계 복원 가능 여부"를 여기서 분류한다.
//     5) 복원 불가/위험한 Action은 ↩ 버튼을 비활성화하고 사유(reason)를 표시한다.
//
//   이 파일은 서버/클라이언트 공용(순수 데이터·타입). server-only import 금지.

/** 직전 단계 복원 가능 분류. */
export type ActionRollbackClass =
  /** 직전 단계로 안전하게 복원 가능(양방향 서비스 존재). ↩ 활성화. */
  | "reversible"
  /** 조건부/부분 복원(시간 게이트·데이터 소실 경고·이전값 보강 필요). ↩ 활성화 + 주의. */
  | "partial"
  /** 복원 불가/위험(비가역 정책·이전값 미보존). ↩ 비활성화 + 사유 표시. */
  | "irreversible"
  /** 되돌림 대상 아님(파생 캐시 재계산 등). ↩ 미노출. */
  | "not-applicable";

/** 자동 실행 트리거 종류. */
export type ActionAutoTrigger =
  | { kind: "cron"; detail: string } // GitHub Actions / 외부 스케줄러
  | { kind: "internal-endpoint"; detail: string } // x-internal-api-key sweep
  | { kind: "lazy-on-read"; detail: string } // 조회 시 지연 재계산
  | { kind: "external-poller"; detail: string } // 로컬 PC 워커
  | { kind: "event"; detail: string } // 다른 서비스 write 시 파생
  | null;

export type ActionControlEntry = {
  /** 안정적 식별자(로그/레지스트리 조회 키). */
  id: string;
  /** 한국어 라벨(버튼/헤더 표기의 근간). "⚡ {label} 즉시 실행" 형태로 조합. */
  label: string;
  /** 소속 어드민 페이지 route. */
  page: string;
  /** 자동 실행 트리거(없으면 null = 수동 전용). 자동 실행은 절대 변경/제거하지 않는다. */
  autoTrigger: ActionAutoTrigger;
  /** 자동/수동이 공유하는 Action Service(파일 경로 + 함수). */
  service: string;
  /** ⚡ 즉시 실행 지원 여부. */
  instant: boolean;
  /** ↩ 실행 취소(직전 단계 복원) 정의. */
  rollback: {
    class: ActionRollbackClass;
    /** 직전 단계 설명("오픈 확인 전", "개설 전", "검수 전" 등). class!=reversible/partial 이면 null. */
    targetStep: string | null;
    /** 복원 연산 요약(이전 상태 복원 방법). */
    method: string | null;
    /** 복원 후 snapshot 재계산이 필요한가(요구사항: 직전 단계 복원 뒤 반드시 재계산). */
    requiresSnapshotRecompute: boolean;
    /** 복원 불가/부분일 때 사용자에게 보여줄 사유(비활성 tooltip / 주의 문구). */
    reason: string | null;
  };
};

// ─── 레지스트리 ───────────────────────────────────────────────────────────
// 조사표(직전 단계 복원 조사)를 코드화한 것. 새 Action 추가 시 여기 한 곳만 갱신.

export const ACTION_CONTROL_REGISTRY = {
  // ✅ 오픈 확인 — 미확인 ↔ 오픈 확인 완료. 멱등 upsert, 포인트/스냅샷 무접촉.
  weekOpenConfirm: {
    id: "weekOpenConfirm",
    label: "오픈 확인",
    page: "/admin/team-parts/info/weeks/[weekId]",
    autoTrigger: null,
    service: "lib/adminTeamPartsInfoWeekDetailData.ts › saveWeekOpenConfirm",
    instant: true,
    rollback: {
      class: "reversible",
      targetStep: "오픈 확인 전",
      method: "open_confirmed=false 로 upsert (config 값은 보존)",
      requiresSnapshotRecompute: false,
      reason: null,
    },
  },

  // ✅ 주차 개설 검수(라인 개설 검토) — 검수 전 ↔ 검수 완료.
  weekLineReview: {
    id: "weekLineReview",
    label: "주차 검수",
    page: "/admin/team-parts/info/weeks/[weekId]",
    autoTrigger: null,
    service: "lib/adminTeamPartsInfoWeekDetailData.ts › (review 저장)",
    instant: true,
    rollback: {
      class: "reversible",
      targetStep: "검수 전",
      method: "검수 플래그 해제(재저장)",
      requiresSnapshotRecompute: false,
      reason: null,
    },
  },

  // ✅ Process Check 상태 — needed ↔ 신청(pending). 적립 전 상태 머신.
  processCheckState: {
    id: "processCheckState",
    label: "검수 신청",
    page: "/admin/processes/check",
    autoTrigger: null,
    service: "lib/adminProcessCheckData.ts › applyProcessCheckAction",
    instant: true,
    rollback: {
      class: "reversible",
      targetStep: "신청 전(needed)",
      method: 'applyProcessCheckAction("cancel") 로 상태 복귀',
      requiresSnapshotRecompute: false,
      reason: null,
    },
  },

  // ✅ Process Check 완료+적립 — pending → completed(+포인트). revokeForAct 로 회수.
  processCheckComplete: {
    id: "processCheckComplete",
    label: "Process Check",
    page: "/admin/processes/check/info",
    autoTrigger: {
      kind: "cron",
      detail: "GitHub Actions */10 → run-due-checks + 로컬 워커",
    },
    service: "lib/processCheckDueSweep.ts › runDueProcessCheckSweep · lib/processPointAccrual.ts › accrueForCompletedAct",
    instant: true,
    rollback: {
      class: "reversible",
      targetStep: "체크 완료 전(pending)",
      method: "revokeForAct(원장 삭제·재합산→0) + status pending 복귀 + recipients 삭제",
      requiresSnapshotRecompute: true,
      reason: null,
    },
  },

  // ⚠️ 비정규 수동부여 — 부재 → completed(생성+포인트). 시간 게이트 존재.
  processIrregularGrant: {
    id: "processIrregularGrant",
    label: "비정규 수동부여",
    page: "/admin/processes/check/irregular",
    autoTrigger: null,
    service: "lib/adminProcessIrregularData.ts › createManualGrant · deleteIrregularAct",
    instant: true,
    rollback: {
      class: "partial",
      targetStep: "부여 전(부재)",
      method: "deleteIrregularAct → revokeForAct + 행 삭제",
      requiresSnapshotRecompute: true,
      reason: "예약 검수 시각(scheduled_check_at)이 지나 자동 완료된 건은 취소할 수 없습니다.",
    },
  },

  // ✅ 역량 라인 개설 — 개설 전 ↔ 개설 완료. is_active 토글 + prior_outputs 복원(진짜 복원).
  competencyLineOpen: {
    id: "competencyLineOpen",
    label: "역량 라인칸 개설",
    page: "/admin/line-opening/practical-competency",
    autoTrigger: null,
    service: "lib/adminCompetencyLineOpening.ts › openCompetencyHub · cancelCompetencyHub",
    instant: true,
    rollback: {
      class: "reversible",
      targetStep: "개설 전",
      method: "cancelCompetencyHub: is_active=false + prior_outputs 로 산출 복원",
      requiresSnapshotRecompute: true,
      reason: null,
    },
  },

  // ⚠️ 경험 팀총괄 개설 — 개설 전 ↔ 개설 완료. 개설 후 입력한 평가데이터는 소실.
  experienceTeamOpen: {
    id: "experienceTeamOpen",
    label: "경험 팀총괄 개설",
    page: "/admin/line-opening/practical-experience",
    autoTrigger: null,
    service: "lib/adminExperienceTeamOverall.ts › openTeamOverall · cancelTeamOverall",
    instant: true,
    rollback: {
      class: "partial",
      targetStep: "개설 전",
      method: "cancelTeamOverall: rollbackLines(evals→targets→lines 삭제) + status 복귀",
      requiresSnapshotRecompute: true,
      reason: "개설 이후 입력한 평가/산출 데이터는 복원 시 함께 제거됩니다(= 개설 전 상태).",
    },
  },

  // ✅ 정보 라인 개설 — 개설 전 ↔ 개설 완료. 개설 전엔 라인 부재 = 삭제가 복원.
  infoLineOpen: {
    id: "infoLineOpen",
    label: "정보 라인칸 개설",
    page: "/admin/line-opening/practical-info",
    autoTrigger: null,
    service: "app/api/admin/cluster4/info-lines/route.ts › POST/DELETE · deleteCluster4Line",
    instant: true,
    rollback: {
      class: "reversible",
      targetStep: "개설 전",
      method: "deleteCluster4Line(라인 행 + targets 제거)",
      requiresSnapshotRecompute: true,
      reason: null,
    },
  },

  // ✅ 주차 검수(리뷰) — 공표 → 검수 완료. result_reviewed_at 라벨 신호(개인 카드 무영향).
  weekResultReview: {
    id: "weekResultReview",
    label: "주차 검수 완료",
    page: "/admin/week-recognitions",
    autoTrigger: {
      kind: "cron",
      detail: "GitHub Actions → run-due-week-actions(2단계 fallback)",
    },
    service: "lib/adminWeekRecognitionsData.ts › markWeekResultReviewed",
    instant: true,
    rollback: {
      class: "reversible",
      targetStep: "검수 전(공표만 된 상태)",
      method: "result_reviewed_at=null (개인 카드 DTO 무영향 → 개인 재계산 불필요, 집계 라벨만 복귀)",
      requiresSnapshotRecompute: false,
      reason: null,
    },
  },

  // 주차 검수 = 집계 확정(성장 성공/실패 확정 + 고객 앱 반영). ↩ = 확정 직전(집계 중) 복원.
  weekResultPublish: {
    id: "weekResultPublish",
    label: "주차 검수",
    page: "/admin/team-parts/info/weeks/[weekId]",
    autoTrigger: {
      kind: "cron",
      detail: "GitHub Actions → run-due-week-actions",
    },
    service: "lib/adminTeamPartsInfoWeekDetailData.ts › markTeamPartsWeekReviewed · revertTeamPartsWeekReview(→revertWeeklyCardFinalization)",
    instant: true,
    rollback: {
      class: "reversible",
      targetStep: "집계 확정 전(집계 중·미공표)",
      method: "result_published_at=NULL + result_reviewed_at=NULL + 코호트 snapshot 재계산 → 카드 tallying 복귀",
      requiresSnapshotRecompute: true,
      // 전 크루·고객 앱 영향 최종 역연산 — 호출부에서 강한 확인 모달 필수.
      reason: "전 크루·고객 앱에 반영되는 최종 확정입니다. 되돌리면 성장 성공/실패 표시가 ‘집계 중’으로 복원됩니다.",
    },
  },

  // ❌ 주차 인정 개별 수정 — 이전 status 미보존.
  weekRecognitionEdit: {
    id: "weekRecognitionEdit",
    label: "주차 인정 개별 수정",
    page: "/admin/week-recognitions",
    autoTrigger: null,
    service: "lib/adminWeekRecognitionsData.ts › updateWeekRecognition",
    instant: true,
    rollback: {
      class: "irreversible",
      targetStep: null,
      method: null,
      requiresSnapshotRecompute: true,
      reason: "이전 인정 상태값을 보존하지 않아 직전 단계로 복원할 수 없습니다.",
    },
  },

  // ❌ PMS 동기화 — 추가 전용, 인버스 없음.
  pmsSync: {
    id: "pmsSync",
    label: "PMS 포인트로그 동기화",
    page: "/admin/pms/sync-pointlogs",
    autoTrigger: { kind: "cron", detail: "env gate 크론" },
    service: "lib/pmsPointlogsSync.ts › syncPmsPointlogsIncremental",
    instant: true,
    rollback: {
      class: "irreversible",
      targetStep: null,
      method: null,
      requiresSnapshotRecompute: false,
      reason: "증분 추가 전용 동기화로 되돌림(인버스) 연산이 없습니다.",
    },
  },

  // N/A 스냅샷 재계산 — 파생 캐시. 되돌림 대상 아님.
  snapshotRecompute: {
    id: "snapshotRecompute",
    label: "스냅샷 재계산",
    page: "/admin/operation-health-check",
    autoTrigger: {
      kind: "lazy-on-read",
      detail: "weekly-cards 조회 시 boundary/is_stale/miss 지연 재계산",
    },
    service: "lib/cluster4WeeklyCardsSnapshot.ts › recomputeStaleOrDueSnapshots / recomputeWeeklyCardsSnapshotsForUsers",
    instant: true,
    rollback: {
      class: "not-applicable",
      targetStep: null,
      method: null,
      requiresSnapshotRecompute: false,
      reason: "파생 캐시 재계산은 SoT에서 순수 재유도되므로 되돌림 대상이 아닙니다.",
    },
  },
} as const satisfies Record<string, ActionControlEntry>;

export type ActionControlId = keyof typeof ACTION_CONTROL_REGISTRY;

export function getActionControl(id: ActionControlId): ActionControlEntry {
  return ACTION_CONTROL_REGISTRY[id];
}

/** ↩ 실행 취소 버튼을 활성화해야 하는가(reversible/partial). */
export function canRollback(id: ActionControlId): boolean {
  const c = ACTION_CONTROL_REGISTRY[id].rollback.class;
  return c === "reversible" || c === "partial";
}

/** ↩ 버튼을 아예 숨겨야 하는가(not-applicable). irreversible 은 "비활성+사유"로 노출. */
export function hideRollback(id: ActionControlId): boolean {
  return ACTION_CONTROL_REGISTRY[id].rollback.class === "not-applicable";
}
