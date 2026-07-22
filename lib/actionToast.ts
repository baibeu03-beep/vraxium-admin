"use client";

// 사용자 액션 단위 공통 결과 문구 매퍼(전역 SoT) — 기존 toast 시스템(components/ui/toast) 위에 얹는다.
//
// 원칙:
//   · 사용자의 액션 직후 발생하는 "일시적 결과"(성공/실패)만 하단 toast 로 표시한다.
//   · 페이지마다 임의 문자열을 toast 에 직접 넣지 않는다 — action key 로 문구를 고른다.
//   · UUID·DB ID·내부 코드·SQL/stack·후보 선택 과정·제외 상세 등 개발자용 정보는
//     toast 에 절대 노출하지 않는다(필요 시 호출부 console 로만).
//   · 지속성 상태 안내·폼 필드 validation 은 이 매퍼로 보내지 말고 인라인 UI 로 유지한다.
//   · 서버 원문은 "직접" 넣지 않는다. 다만 4xx 업무 검증 문구(사용자가 스스로 고칠 수 있는 원인)는
//     lib/apiError 의 안전 필터를 통과한 값에 한해 t.apiError() 로 노출한다 —
//     5xx·401·429·네트워크는 그 안에서 고정 정책 문구로 바뀌므로 내부 원문이 새지 않는다.
//
// 사용:
//   const t = useActionToast();
//   t.success("save");                     // "저장이 완료되었습니다."
//   t.error("open", { status: res.status });// 403→권한 / 409→이미 처리 / 그 외→일반 재시도 안내
//   t.error("submit", { message: DOMAIN_PRECONDITION_MSG }); // 도메인 지정 문구(서버 원문 아님)
//   t.apiError("create", err);             // catch 에서 서버 4xx 원인 그대로 안내(안전 필터 적용)

import { useToast } from "@/components/ui/toast";
import { toApiErrorInfo } from "@/lib/apiError";

export type ActionResult =
  | "save"
  | "create"
  | "update"
  | "delete"
  | "submit"
  | "approve"
  | "reject"
  | "review"
  | "reset"
  | "open"
  | "cancel"
  | "copy";

const SUCCESS_MESSAGE: Record<ActionResult, string> = {
  save: "저장이 완료되었습니다.",
  create: "생성이 완료되었습니다.",
  update: "수정이 완료되었습니다.",
  delete: "삭제가 완료되었습니다.",
  submit: "신청이 완료되었습니다.",
  approve: "승인이 완료되었습니다.",
  reject: "반려가 완료되었습니다.",
  review: "검수가 완료되었습니다.",
  reset: "초기화가 완료되었습니다.",
  open: "개설이 완료되었습니다.",
  cancel: "취소가 완료되었습니다.",
  copy: "복사가 완료되었습니다.",
};

// 구조화된 오류 종류 — HTTP status / 서버 error code 로만 매핑한다(서버 원문 문자열 검색 금지).
export type ActionErrorKind =
  | "permission" // 403 — 권한 없음
  | "precondition" // 412/422/428 — 선행 절차 미완료
  | "conflict" // 409 — 이미 처리됨
  | "notFound" // 404 — 대상 없음
  | "network" // 네트워크/타임아웃
  | "unknown"; // 그 외 예기치 않은 서버 오류

const ERROR_MESSAGE: Record<ActionErrorKind, string> = {
  permission: "이 작업을 수행할 권한이 없습니다.",
  precondition: "아직 필요한 절차가 완료되지 않았습니다.",
  conflict: "이미 처리가 완료된 상태입니다.",
  notFound: "대상을 찾을 수 없습니다.",
  network: "처리하지 못했습니다. 잠시 후 다시 시도해주세요.",
  unknown: "처리하지 못했습니다. 잠시 후 다시 시도해주세요.",
};

// HTTP status → 구조화 오류 종류.
export function errorKindFromStatus(status?: number | null): ActionErrorKind {
  if (status === 403) return "permission";
  if (status === 404) return "notFound";
  if (status === 409) return "conflict";
  if (status === 412 || status === 422 || status === 428) return "precondition";
  if (status == null || status === 0) return "network";
  return "unknown";
}

export function actionSuccessMessage(action: ActionResult): string {
  return SUCCESS_MESSAGE[action];
}
export function actionErrorMessage(kind: ActionErrorKind): string {
  return ERROR_MESSAGE[kind];
}

// 오류 입력 — status(권장) 또는 명시 kind, 그리고 도메인 지정 문구(override).
//   ⚠ override 는 반드시 도메인이 직접 작성한 사용자용 상수여야 한다. 서버 원본 message(res error)를
//     그대로 넘기지 말 것(원문·상세 노출 금지 원칙).
export type ActionErrorInput =
  | ActionErrorKind
  | { status?: number | null; kind?: ActionErrorKind; message?: string };

/**
 * 액션 결과 toast 훅 — 전역 toast SoT(useToast) 위에서 공통 문구를 선택해 표시한다.
 *   success(action, override?)  ·  error(action, err?)  ·  raw(kind, message) (도메인 특수 케이스)
 */
export function useActionToast() {
  const { toast } = useToast();
  return {
    // action 기반 성공 문구. override 는 도메인 지정 사용자 문구(서버 원문 금지).
    success(action: ActionResult, override?: string) {
      toast("success", override ?? actionSuccessMessage(action));
    },
    // 구조화된 오류 → 사용자 문구. (개발자 상세는 호출부 console 로.)
    error(_action: ActionResult, err?: ActionErrorInput) {
      let kind: ActionErrorKind = "unknown";
      let override: string | undefined;
      if (typeof err === "string") {
        kind = err;
      } else if (err) {
        if (err.kind) kind = err.kind;
        else if (err.status != null) kind = errorKindFromStatus(err.status);
        override = err.message; // 도메인 지정 문구만.
      }
      toast("error", override ?? actionErrorMessage(kind));
    },
    /**
     * catch 로 잡은 API 오류 → 사용자 문구. 전역 SoT(lib/apiError)가 노출 여부를 판정한다.
     *   · 4xx 업무 검증(서버가 구체적 원인을 준 경우) → 그 문구 그대로.
     *   · 401/429/5xx/네트워크 → 고정 정책 문구(서버 원문 노출 없음).
     *   · fallback 은 status 로도 문구가 특정되지 않을 때만 쓰인다.
     * 개발자 상세(stack·원본 payload)는 호출부에서 console.error(err) 로 따로 남길 것.
     */
    apiError(_action: ActionResult, err: unknown, fallback?: string) {
      toast("error", toApiErrorInfo(err, fallback).message);
    },
    // 매퍼로 표현 불가한 도메인 특수 문구/경고 전용(문구는 도메인 상수여야 함).
    raw: toast,
  };
}
