// 실무 정보(info) 라인 등록 정책 **문구 SoT** — 브라우저 안전(서버 전용 import 없음).
//
// 클라이언트 폼(LineRegistrationManager)과 서버 게이트(adminInfoLineRegistrationPolicy)가
// 같은 상수를 쓰게 하려고 분리했다. 정책 모듈은 supabaseAdmin 을 import 하므로 클라이언트 번들에
// 끌려들어오면 안 된다 — 그래서 문구만 여기 둔다.
//
// 문구 원칙(2026-07-22 운영 결정): "왜 등록이 안 되는지"만 말한다.
//   대안 안내("기존 라인을 수정하세요" 등)나 이동 CTA 는 이 팝업에 붙이지 않는다.

export const INFO_ALL_REGISTERED_TITLE = "실무 정보 라인 추가 불가";

export const INFO_ALL_REGISTERED_LINES = [
  "실무 정보 라인은 이미 9개 모두 등록되어 있습니다.",
  "새로운 실무 정보 라인은 추가할 수 없습니다.",
] as const;

// 팝업/배너 본문 — 렌더 측이 whitespace-pre-line 이라 개행이 그대로 두 줄로 보인다.
export const INFO_ALL_REGISTERED_BODY = INFO_ALL_REGISTERED_LINES.join("\n");

// API 오류 문자열은 한 줄로(줄바꿈 없이) 내보낸다.
export const INFO_ALL_REGISTERED_MESSAGE = INFO_ALL_REGISTERED_LINES.join(" ");

export const INFO_ACTIVITY_TYPE_REQUIRED_MESSAGE =
  "실무 정보 라인은 기존 9개 활동유형 중 하나를 선택해야 합니다.";

export const INFO_ACTIVITY_TYPE_DUPLICATE_MESSAGE =
  "선택한 활동유형에는 이미 정식 라인이 등록되어 있습니다. 기존 라인을 수정해주세요.";
