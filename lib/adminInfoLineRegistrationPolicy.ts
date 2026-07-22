// 실무 정보(info) 라인 등록 정책 — **서버 SoT**.
//
// 제품 계약(2026-07-22): 실무 정보 활동유형은 고정 9종이며, info 등록은 그 9종에 정식 라인명/코드/
//   조직/포인트/활성 상태를 연결하는 원장이다. 신규 활동유형은 만들지 않는다.
//   → 따라서 info 등록에는 **활동유형 선택이 필수**이고, **활동유형×조직당 활성 등록은 1개**다.
//
// UI 차단만으로 끝내지 않는다 — POST/PATCH 가 이 모듈을 통과해야만 저장된다(HTTP 직접 호출 차단).
//
// 부분 성공 금지: 종전에는 registration 을 먼저 만든 뒤 포인트 config 만 실패시켰다(등록은 됐는데
//   포인트는 안 된 반쪽 상태). 이제 검증을 **생성 전에** 수행해 422/409 로 요청 전체를 거절한다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  INFO_ACTIVITY_TYPE_IDS,
  isInfoActivityTypeId,
} from "@/lib/adminInfoLineCatalog";
import {
  INFO_ACTIVITY_TYPE_DUPLICATE_MESSAGE,
  INFO_ACTIVITY_TYPE_REQUIRED_MESSAGE,
  INFO_ALL_REGISTERED_MESSAGE,
} from "@/lib/adminInfoLineRegistrationMessages";

// 공개 오류 코드 — 클라이언트가 문구가 아니라 코드로 분기할 수 있게 노출한다.
export const INFO_ACTIVITY_TYPE_REQUIRED = "INFO_ACTIVITY_TYPE_REQUIRED";
export const INFO_ACTIVITY_TYPE_ALREADY_REGISTERED =
  "INFO_ACTIVITY_TYPE_ALREADY_REGISTERED";
// 그 조직 범위의 9종이 이미 전부 등록됨 = 어떤 활동유형을 골라도 신규 등록이 불가능한 상태.
//   개별 활동유형 중복(ALREADY_REGISTERED)보다 먼저 판정한다 — 사용자에게 필요한 답이 다르다
//   ("다른 걸 고르세요"가 아니라 "더 추가할 수 없습니다").
export const INFO_ALL_ACTIVITY_TYPES_REGISTERED = "INFO_ALL_ACTIVITY_TYPES_REGISTERED";

// 사용자 노출 문구는 브라우저 안전 모듈이 SoT — 등록 폼 팝업과 API 응답이 같은 문자열을 쓴다.
//   (이 모듈은 supabaseAdmin 을 import 하므로 클라이언트가 직접 참조할 수 없다.)
export {
  INFO_ACTIVITY_TYPE_REQUIRED_MESSAGE,
  INFO_ACTIVITY_TYPE_DUPLICATE_MESSAGE,
  INFO_ALL_REGISTERED_TITLE,
  INFO_ALL_REGISTERED_BODY,
  INFO_ALL_REGISTERED_MESSAGE,
} from "@/lib/adminInfoLineRegistrationMessages";

export type InfoPolicyViolation = {
  status: 422 | 409;
  code: string;
  message: string;
};

/**
 * 활동유형 선택 검증. 미선택·9종 외 값이면 422.
 *   (9종 외 값 = "존재하지 않는 활동유형"이므로 '선택해야 합니다' 와 같은 코드로 묶는다 —
 *    클라이언트 입장에서 필요한 조치가 동일하다: 9종 중 하나를 고르라.)
 */
export function validateInfoActivityTypeSelection(
  pointActivityTypeId: string | null | undefined,
): InfoPolicyViolation | null {
  const value = typeof pointActivityTypeId === "string" ? pointActivityTypeId.trim() : "";
  if (!value || !isInfoActivityTypeId(value)) {
    return {
      status: 422,
      code: INFO_ACTIVITY_TYPE_REQUIRED,
      message: INFO_ACTIVITY_TYPE_REQUIRED_MESSAGE,
    };
  }
  return null;
}

/**
 * 활동유형 × 조직 중복 검증.
 *
 * 조직 범위 판정: **organization_slug 값이 같을 때만** 충돌로 본다.
 *   즉 common 등록과 encre 전용 등록은 공존한다(카탈로그가 조직 전용 > common 우선으로 표시).
 *   운영상 "공통 라인 위에 특정 클럽만 다른 라인명/코드를 쓰는" 케이스를 허용하기 위한 정책이며,
 *   요구사항의 `hub + point_activity_type_id + 적용 조직 → 활성 최대 1개` 를 그대로 구현한 것이다.
 *
 * @param excludeRegistrationId 수정(PATCH) 시 자기 자신 제외.
 */
export async function findConflictingInfoRegistration(opts: {
  pointActivityTypeId: string;
  organizationSlug: string | null;
  excludeRegistrationId?: string | null;
}): Promise<{ id: string; lineName: string | null; lineCode: string | null } | null> {
  const { pointActivityTypeId, organizationSlug, excludeRegistrationId } = opts;
  if (organizationSlug == null) return null; // org 미지정은 별도 규칙에서 차단(카탈로그 비노출).

  let query = supabaseAdmin
    .from("line_registrations")
    .select("id,line_name,line_code")
    .eq("hub", "info")
    .eq("is_active", true)
    .eq("organization_slug", organizationSlug)
    .eq("point_activity_type_id", pointActivityTypeId);
  if (excludeRegistrationId) query = query.neq("id", excludeRegistrationId);

  const { data, error } = await query.limit(1);
  if (error) {
    // 컬럼 미적용 등 조회 실패는 중복 검사를 건너뛴다(등록 자체를 막지 않는다 — 종전 동작 보존).
    console.warn("[infoLinePolicy] duplicate check unavailable:", error.message);
    return null;
  }
  const row = (data ?? [])[0] as
    | { id: string; line_name: string | null; line_code: string | null }
    | undefined;
  return row ? { id: row.id, lineName: row.line_name, lineCode: row.line_code } : null;
}

/**
 * 그 조직 범위의 9종이 전부 활성 등록으로 점유됐는가(= 신규 등록 불가 상태).
 *   수정(PATCH)에서는 자기 자신을 제외해야 "이미 내가 쓰던 슬롯"이 만석으로 잡히지 않는다.
 */
export async function isInfoScopeFullyRegistered(
  organizationSlug: string | null,
  excludeRegistrationId?: string | null,
): Promise<boolean> {
  if (organizationSlug == null) return false;
  let query = supabaseAdmin
    .from("line_registrations")
    .select("point_activity_type_id")
    .eq("hub", "info")
    .eq("is_active", true)
    .eq("organization_slug", organizationSlug);
  if (excludeRegistrationId) query = query.neq("id", excludeRegistrationId);

  const { data, error } = await query;
  if (error) {
    // 조회 실패 시 "만석"으로 단정하지 않는다 — 개별 중복 검사가 뒤에서 다시 막는다.
    console.warn("[infoLinePolicy] scope saturation check unavailable:", error.message);
    return false;
  }
  const taken = new Set(
    ((data ?? []) as Array<{ point_activity_type_id: string | null }>)
      .map((r) => r.point_activity_type_id)
      .filter((id): id is string => Boolean(id)),
  );
  return INFO_ACTIVITY_TYPE_IDS.every((id) => taken.has(id));
}

/**
 * 생성/수정 공통 게이트 — 만석 검증 + 선택 검증 + 중복 검증을 한 번에.
 * 위반이 없으면 null. 호출부는 이 결과를 그대로 HTTP 응답으로 옮긴다.
 *
 * 판정 순서는 **클라이언트 UI 와 동일**해야 한다(만석 → 미선택 → 중복). 순서가 어긋나면
 * 우회 요청과 화면 안내가 서로 다른 이유를 말하게 된다.
 */
export async function assertInfoRegistrationPolicy(opts: {
  pointActivityTypeId: string | null | undefined;
  organizationSlug: string | null;
  excludeRegistrationId?: string | null;
}): Promise<InfoPolicyViolation | null> {
  // 신규 등록(수정 제외)에서만 "만석" 을 따진다 — 수정은 이미 있는 행을 고치는 동작이라
  //   만석이어도 계속 가능해야 한다(라인명/코드/포인트 수정 경로가 막히면 안 된다).
  if (!opts.excludeRegistrationId && (await isInfoScopeFullyRegistered(opts.organizationSlug))) {
    return {
      status: 409,
      code: INFO_ALL_ACTIVITY_TYPES_REGISTERED,
      message: INFO_ALL_REGISTERED_MESSAGE,
    };
  }

  const selection = validateInfoActivityTypeSelection(opts.pointActivityTypeId);
  if (selection) return selection;

  const conflict = await findConflictingInfoRegistration({
    pointActivityTypeId: (opts.pointActivityTypeId as string).trim(),
    organizationSlug: opts.organizationSlug,
    excludeRegistrationId: opts.excludeRegistrationId ?? null,
  });
  if (conflict) {
    return {
      status: 409,
      code: INFO_ACTIVITY_TYPE_ALREADY_REGISTERED,
      message: INFO_ACTIVITY_TYPE_DUPLICATE_MESSAGE,
    };
  }
  return null;
}

export type InfoRegistrationSlot = {
  activityTypeId: string;
  // 이 조직 범위에서 이미 활성 등록이 있는가(= 신규 등록 불가·수정 경로 안내 대상).
  registered: boolean;
  registrationId: string | null;
  registeredLineName: string | null;
  registeredLineCode: string | null;
};

/**
 * 등록 폼용 — 조직 범위별 9종 슬롯 점유 현황.
 *   organizationSlug 는 "등록하려는 그 조직"(common 포함). 충돌 판정과 **동일한 기준**으로
 *   계산해야 UI 차단과 서버 차단이 어긋나지 않는다.
 */
export async function listInfoRegistrationSlots(
  organizationSlug: string,
): Promise<InfoRegistrationSlot[]> {
  const { data, error } = await supabaseAdmin
    .from("line_registrations")
    .select("id,line_name,line_code,point_activity_type_id")
    .eq("hub", "info")
    .eq("is_active", true)
    .eq("organization_slug", organizationSlug);
  if (error) {
    console.warn("[infoLinePolicy] slot lookup unavailable:", error.message);
  }
  const byActivity = new Map<
    string,
    { id: string; line_name: string | null; line_code: string | null }
  >();
  for (const r of ((error ? [] : data) ?? []) as Array<{
    id: string;
    line_name: string | null;
    line_code: string | null;
    point_activity_type_id: string | null;
  }>) {
    if (r.point_activity_type_id && !byActivity.has(r.point_activity_type_id)) {
      byActivity.set(r.point_activity_type_id, r);
    }
  }
  return INFO_ACTIVITY_TYPE_IDS.map((id) => {
    const hit = byActivity.get(id) ?? null;
    return {
      activityTypeId: id,
      registered: Boolean(hit),
      registrationId: hit?.id ?? null,
      registeredLineName: hit?.line_name ?? null,
      registeredLineCode: hit?.line_code ?? null,
    };
  });
}
