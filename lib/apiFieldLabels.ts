// 내부 필드명 → 사용자 표시 용어 SoT (browser-safe · 서버/클라 공용).
//
// 원칙: **API 는 개발자 용어를 써도 되지만, 사용자 화면에는 개발 용어가 나가지 않는다.**
//   · 서버 검증 문구를 새로 쓸 때는 fieldLabel() 로 라벨을 만들어 쓴다.
//   · 그래도 새어 나오는 옛 문구는 lib/apiError 의 안전 필터가 이 표로 번역하고,
//     번역되지 않는 내부 식별자가 남으면 그 문구 자체를 폐기(화면 fallback)한다.
//
// 표기 규칙: 화면 라벨과 **같은 단어**를 쓴다(폼 라벨 ↔ 오류 문구 용어 불일치 금지).
//   예) 등록 폼 라벨이 "소속 클럽"이면 오류 문구도 "소속 클럽"이어야 한다.

export const API_FIELD_LABELS: Readonly<Record<string, string>> = {
  // ── 라인 등록/수정 ──
  line_code: "라인 코드",
  lineCode: "라인 코드",
  line_name: "라인명",
  lineName: "라인명",
  line_type: "라인 종류",
  lineType: "라인 종류",
  hub: "소속 허브",
  organization_slug: "소속 클럽",
  organizationSlug: "소속 클럽",
  organization: "소속 클럽",
  main_title: "메인 타이틀",
  mainTitle: "메인 타이틀",
  main_title_mode: "메인 타이틀 표시 방식",
  mainTitleMode: "메인 타이틀 표시 방식",
  unit_link: "유닛 링크",
  unitLink: "유닛 링크",
  estimated_duration_minutes: "소요 시간",
  estimatedDurationMinutes: "소요 시간",
  duration_minutes: "소요 시간",
  durationMinutes: "소요 시간",
  is_active: "사용 여부",
  isActive: "사용 여부",

  // ── 활동 유형 · 포인트 ──
  activity_type: "활동 유형",
  activity_type_id: "활동 유형",
  activityTypeId: "활동 유형",
  point_activity_type_id: "포인트 대상 활동 유형",
  pointActivityTypeId: "포인트 대상 활동 유형",
  point_a: "Point.A",
  point_b: "Point.B",
  point_c: "Point.C",

  // ── 실무 경력 전용 ──
  partner_company: "제휴/연계사",
  company_logo_url: "기업 로고",
  manager_name: "담당자명",
  manager_position: "직급",
  manager_job: "직무",
  manager_profile_key: "프로필 사진",

  // ── 주차 · 시즌 · 팀 ──
  week: "주차",
  week_id: "주차",
  weekId: "주차",
  week_start_date: "주차 시작일",
  week_end_date: "주차 종료일",
  season_key: "시즌",
  seasonKey: "시즌",
  half_key: "반기",
  halfKey: "반기",
  team_id: "팀",
  team_half_id: "팀",
  teamHalfId: "팀",
  team_name: "팀명",
  part_name: "파트",
  partName: "파트",
  part_type: "파트 구분",
  check_threshold: "체크 인정 기준",

  // ── 크루 · 사용자 ──
  crew_code: "크루 코드",
  crewCode: "크루 코드",
  user_id: "사용자",
  target_user_ids: "대상자",
  leader_crew_code: "팀장 크루 코드",

  // ── 체크 · 검수 ──
  act_name: "액트명",
  act_id: "액트",
  act: "액트",

  // ── 단일 단어형 파라미터 ── (문구에 그대로 등장하는 쿼리/바디 키)
  part: "파트",
  team: "팀",
  club: "클럽",
  season: "시즌",
  half: "반기",
  status: "상태",
  scope: "적용 범위",
  note: "메모",
  reason: "사유",
  review_link: "검수 링크",
  scheduled_check_at: "검수 예정 시각",
  output_link_1: "산출물 링크",
  output_description: "산출물 설명",
};

// 사용자에게 존재 자체를 알릴 필요가 없는 내부 식별자 — 문구에 남아 있으면 그 문구를 폐기한다.
//   (라벨을 붙여 번역해도 "개설 연결 정보가 …" 같은 말이 사용자에게 아무 도움이 안 되는 값들)
export const INTERNAL_ONLY_FIELDS: ReadonlySet<string> = new Set([
  "bridged_master_id",
  "bridgedMasterId",
  "competency_line_master_id",
  "experience_line_master_id",
  "info_line_master_id",
  "master_id",
  "masterId",
  "snapshot_id",
  "config_key",
  "configKey",
  "scope_mode",
  "actor_admin_id",
  "created_by",
  "check_status_id",
  "checkStatusId",
]);

/** 내부 필드명 → 사용자 표시 용어. 매핑이 없으면 null(= 사용자에게 보여줄 이름이 없다). */
export function fieldLabel(name: string): string | null {
  return API_FIELD_LABELS[name] ?? null;
}

// ── 조사 선택 ────────────────────────────────────────────────
// 오류 문구를 라벨로 조립할 때 "라인명을(를)" 같은 병기 표기를 쓰지 않기 위한 최소 헬퍼.
// 완성형 한글 음절의 받침 유무로 조사를 고른다(한글이 아니면 뒤 형태를 그대로 쓴다).

const JOSA_PAIRS = {
  "은/는": ["은", "는"],
  "이/가": ["이", "가"],
  "을/를": ["을", "를"],
  "와/과": ["과", "와"],
  "으로/로": ["으로", "로"],
} as const;

export type JosaPair = keyof typeof JOSA_PAIRS;

/** 완성형 한글 음절의 받침 유무. 한글이 아니면 null. */
export function hasBatchim(char: string): boolean | null {
  const code = char.codePointAt(0);
  if (code === undefined || code < 0xac00 || code > 0xd7a3) return null;
  return (code - 0xac00) % 28 !== 0;
}

/** `withJosa("라인명", "을/를")` → `"라인명을"` · `withJosa("라인 코드", "을/를")` → `"라인 코드를"`. */
export function withJosa(word: string, pair: JosaPair): string {
  const [withFinal, withoutFinal] = JOSA_PAIRS[pair];
  const batchim = hasBatchim(word.slice(-1));
  return `${word}${batchim === false || batchim === null ? withoutFinal : withFinal}`;
}

/**
 * 서버 검증 문구를 쓸 때 쓰는 헬퍼 — 라벨이 있으면 라벨, 없으면 필드명 그대로.
 * 새 문구는 반드시 라벨이 있는 필드에 대해서만 사용자에게 노출할 것.
 */
export function fieldLabelOrRaw(name: string): string {
  return API_FIELD_LABELS[name] ?? name;
}
