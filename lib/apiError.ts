// 어드민 전역 API 오류 → 사용자 문구 변환 SoT.
//
// 배경: 서버는 4xx 에서 사용자가 스스로 고칠 수 있는 구체적 문구를 이미 반환한다
//   (예: "line_code 는 영문/숫자/하이픈(-)만 허용합니다 (공백·특수문자 불가). 예: IFBS-NN0007").
//   그러나 화면 catch 는 대부분 그 문구를 버리고 "잠시 후 다시 시도해주세요" 로 덮어써서
//   사용자가 원인을 알 수 없었다. 이 모듈이 "무엇을 보여줄지"의 단일 판단 지점이다.
//
// 원칙:
//   1) 4xx(400/403/404/409/412/422/428 등) = 업무 검증 → 서버 문구를 안전 필터 통과 시 그대로 노출.
//   2) 401 = 세션 만료 고정 문구 · 429 = 과요청 고정 문구 (서버 원문 무시).
//   3) 5xx = 서버 원문 절대 노출 금지(안전 문구만). 원문은 console.error 로만 남긴다.
//   4) 네트워크/취소 = 연결 실패 문구.
//   5) 어떤 경우에도 SQL·stack·파일 경로·env·HTML 오류 페이지·[object Object]·빈 문자열은 노출 금지.
//
// 일반 모드 / mode=test / actAsTestUserId / demoUserId 는 모두 같은 파서·같은 DTO 를 쓴다.
// 모드별 분기 문구를 만들지 말 것.
//
// 사용(권장 3형태):
//   // A. 이미 파싱된 payload 가 있을 때
//   if (!res.ok || !json.success) throw new ApiRequestError({ status: res.status, payload: json });
//   ...
//   catch (err) { console.error(err); t.apiError("create", err); }
//
//   // B. 응답만 있을 때(본문 미소비)
//   if (!res.ok) throw await readApiError(res);
//
//   // C. toast 없이 인라인 배너로 표시할 때
//   setBanner({ kind: "error", message: getApiErrorMessage(err, "저장에 실패했습니다") });

import { API_FIELD_LABELS, INTERNAL_ONLY_FIELDS, fieldLabel } from "@/lib/apiFieldLabels";

// ──────────────────────────────────────────────────────────────
// 공통 오류 DTO — 기존 API 계약을 깨지 않는 "읽기 전용 합집합".
//   실측(2026-07-22): app/api/**/route.ts 853곳이 { success:false, error:string },
//   25곳이 { error: ... }, 3곳이 { success:false, error:{ message, code } }.
//   서버 응답을 바꾸지 않고 이 타입으로 "읽기만" 한다.
// ──────────────────────────────────────────────────────────────

export type ApiErrorPayload = {
  success?: boolean;
  error?: string | { message?: string; code?: string } | null;
  message?: string | null;
  details?: string | null;
  reason?: string | null;
  code?: string | null;
};

export type ApiErrorSource = "server" | "status" | "network" | "client" | "fallback";

export type ApiErrorInfo = {
  /** HTTP status. null = 응답 자체가 없었다(네트워크/취소/CORS). */
  status: number | null;
  /** 서버가 준 error code (있을 때만). */
  code: string | null;
  /** 안전 필터를 통과한 서버 문구. 노출 금지 판정이면 null. */
  serverMessage: string | null;
  /** 화면에 그대로 표시해도 되는 최종 문구. */
  message: string;
  /** 최종 문구의 출처 — 테스트/로그용. */
  source: ApiErrorSource;
};

// ──────────────────────────────────────────────────────────────
// status 별 고정 문구
// ──────────────────────────────────────────────────────────────

export const API_ERROR_NETWORK = "서버에 연결할 수 없습니다. 네트워크 상태를 확인해주세요.";
export const API_ERROR_UNAUTHORIZED = "로그인이 만료되었습니다. 다시 로그인해주세요.";
export const API_ERROR_FORBIDDEN = "이 작업을 수행할 권한이 없습니다.";
export const API_ERROR_NOT_FOUND = "요청한 데이터를 찾을 수 없습니다.";
export const API_ERROR_TOO_MANY = "요청이 너무 많습니다. 잠시 후 다시 시도해주세요.";
export const API_ERROR_SERVER = "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
export const API_ERROR_GENERIC = "처리하지 못했습니다. 잠시 후 다시 시도해주세요.";

/**
 * 서버 문구를 사용자에게 보여줘도 되는 status 인가.
 *   · 2xx = `{ success:false }` 업무 실패 봉투(HTTP 는 성공) → 서버 문구가 곧 업무 사유다.
 *   · 4xx = 사용자가 고칠 수 있는 검증/상태 오류 → 서버 문구 우선. (401/429 제외)
 *   · 5xx = 내부 오류 → 원문 금지.
 */
export function allowsServerMessage(status: number | null): boolean {
  if (status == null) return false; // 네트워크 계층 — 서버 문구 자체가 없다.
  if (status === 401 || status === 429) return false; // 고정 정책 문구 우선.
  if (status >= 500) return false; // 내부 오류 원문 노출 금지.
  if (status >= 200 && status < 300) return true; // success:false 업무 실패.
  return status >= 400 && status < 500;
}

/** 서버 문구가 없거나 노출 불가일 때 쓰는 status 기반 문구. */
export function statusFallbackMessage(status: number | null): string {
  if (status == null) return API_ERROR_NETWORK;
  if (status === 401) return API_ERROR_UNAUTHORIZED;
  if (status === 403) return API_ERROR_FORBIDDEN;
  if (status === 404) return API_ERROR_NOT_FOUND;
  if (status === 429) return API_ERROR_TOO_MANY;
  if (status >= 500) return API_ERROR_SERVER;
  return API_ERROR_GENERIC;
}

// ──────────────────────────────────────────────────────────────
// 안전 필터 — 사용자에게 절대 노출하면 안 되는 문자열 판별
// ──────────────────────────────────────────────────────────────

// 사용자 문구로 쓰기엔 너무 긴 원문(스택/덤프)은 잘라내지 않고 통째로 버린다.
const MAX_USER_MESSAGE_LENGTH = 300;

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// 하나라도 걸리면 노출 금지.
const UNSAFE_PATTERNS: readonly RegExp[] = [
  // HTML 오류 페이지 / 마크업
  /<!doctype\s+html/i,
  /<\/?(html|head|body|pre|script|title)\b/i,
  // stack trace
  /\n\s*at\s+\S/,
  /\bat\s+(Object|Module|Function|async|Array)\.\S/,
  /\.(js|ts|tsx|mjs|cjs):\d+:\d+/,
  /webpack-internal|node_modules[\\/]/i,
  // SQL / Postgres / PostgREST 내부
  /\b(select|insert\s+into|update|delete\s+from|alter\s+table|create\s+table|drop\s+table)\b[\s\S]*\b(from|into|set|where|values)\b/i,
  /\brelation\s+"[^"]+"/i,
  /\bcolumn\s+"[^"]+"\s+(of|does|is)/i,
  /duplicate key value violates|violates (foreign key|not-null|check) constraint/i,
  /\bPGRST\d{2,}\b/,
  /\b(22P02|23502|23503|23505|23514|42501|42703|42P01|40001|57014)\b/,
  /\bpg_\w+|\bpostgres(ql)?\b/i,
  /supabase|service[_\s-]?role|anon key/i,
  // 파일 시스템 경로 / 실행 환경
  /[A-Za-z]:\\[\\\w.\- ]+/,
  /(^|\s)\/(var|usr|home|tmp|opt|etc)\//,
  /\/var\/task\b/,
  // 환경변수
  /\bprocess\.env\b/,
  /\b[A-Z][A-Z0-9]*_(KEY|SECRET|TOKEN|URL|PASSWORD|DSN)\b/,
  // 개발자 예외 원문
  /\b(TypeError|ReferenceError|SyntaxError|RangeError|AggregateError)\b/,
  /\bfetch failed\b|\bECONNREFUSED\b|\bENOTFOUND\b|\bETIMEDOUT\b/,
];

// ── 개발 용어 차단 ──────────────────────────────────────────────
// 서버 검증 문구에는 내부 필드명(line_code)·영문 validator 문장이 섞여 있다. 사용자 화면에는
// 개발 용어를 내보내지 않는다: ① 알려진 필드명은 사용자 용어로 번역 ② 번역 못한 snake_case
// 식별자나 영문 validator 문장이 남으면 그 문구 자체를 폐기하고 화면 fallback 을 쓴다.

// 번역 대상 토큰 = 라벨 사전에 등록된 이름(snake_case·camelCase·단일 단어) + 임의의 snake_case 식별자.
//   사전에 없는 snake_case 가 남으면 그 문구는 사용자에게 보여주지 않는다.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const FIELD_TOKEN_RE = new RegExp(
  `\\b(?:${Object.keys(API_FIELD_LABELS)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|")}|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\\b`,
  "g",
);

// 개발자용 괄호 주석 — "팀(team_id)이 필요합니다" · "클럽(encre|oranke|phalanx)" 처럼
// 한글 라벨 뒤에 내부 이름/enum 을 덧붙인 형태. 사용자에게는 아무 정보가 없으므로 통째로 제거한다.
//   소문자 식별자만 대상이다 — "(IFBS-NN0007)" 같은 실제 코드 값은 사용자에게 필요하므로 남긴다.
//   한글이 섞인 괄호 "(공백·특수문자 불가)" 나 "하이픈(-)" 도 대상이 아니다.
const ANNOTATION_PAREN_RE =
  /\s*\([a-z][a-z0-9_]*(?:\s*\|\s*[a-z][a-z0-9_]*)*\)/g;

// 최종 게이트 — 번역·정리 후에도 소문자로 시작하는 영문 토큰이 남으면 개발 용어다
//   (org · info|experience 같은 enum · 미등록 camelCase). 사용자에게 보이지 않게 폐기한다.
//   대문자로 시작하는 값(IFBS-NN0007 · Point.A)은 실제 코드/라벨이므로 통과시킨다.
const LEFTOVER_DEV_TOKEN_RE = /(?:^|[^A-Za-z0-9_])[a-z][A-Za-z0-9_]+/;

// 게이트 예외 — "사용자가 입력한 값"을 그대로 되돌려주는 부분은 개발 용어가 아니다.
//   · 이메일 주소: "이미 등록된 이메일입니다: a.b@example.com"
//   · 따옴표로 감싼 값: "'wisdom'은(는) 선택할 수 없습니다" (사용자가 고른 값의 에코)
//   이 구간을 제외한 나머지에만 개발 토큰 검사를 적용한다.
const USER_VALUE_SPANS: readonly RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /'[^']*'/g,
  /"[^"]*"/g,
  /‘[^’]*’/g, // ‘…’
  /“[^”]*”/g, // “…”
];

function stripUserValues(text: string): string {
  let out = text;
  for (const re of USER_VALUE_SPANS) out = out.replace(re, " ");
  return out;
}

// 사용자 문구일 수 없는 영문 validator 관용구.
const DEV_ENGLISH_PATTERNS: readonly RegExp[] = [
  /\bis required\b/i,
  /\bmust be\b/i,
  /\bmust include\b/i,
  /\bis not (a|an|valid)\b/i,
  /\b(invalid|missing|unsupported|unexpected) [a-z_]+/i,
  /\bnot found\b/i,
  /\b(unauthorized|forbidden|bad request)\b/i,
  /\bfailed to [a-z]/i,
];

// 한글이 한 글자도 없으면 사용자용 문구가 아니다(어드민 UI 문구는 전부 한국어).
const HANGUL_RE = /[가-힣]/;

// 라벨 치환 뒤 조사 정리 — 띄어쓰기("라인 코드 는" → "라인 코드는")와
// 받침에 따른 조사 선택("소속 클럽를" → "소속 클럽을")을 함께 맞춘다.
const KOREAN_PARTICLE_RE =
  /\s*(은|는|이|가|을|를|와|과|으로|로)(?=[\s,.)!?]|$)/g;

// 받침 유무에 따라 짝을 이루는 조사 — [받침 있음, 받침 없음].
const PARTICLE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["은", "는"],
  ["이", "가"],
  ["을", "를"],
  ["과", "와"],
  ["으로", "로"],
];

/** 한글 음절의 받침 유무. 한글이 아니면(영문·숫자) 판정하지 않는다(null). */
function hasFinalConsonant(char: string): boolean | null {
  const code = char.codePointAt(0);
  if (code === undefined) return null;
  if (code < 0xac00 || code > 0xd7a3) return null; // 완성형 한글 음절 밖.
  return (code - 0xac00) % 28 !== 0;
}

/** 앞 글자의 받침에 맞는 조사로 교정. 판정 불가면 원래 조사를 유지한다. */
function fixParticle(prevChar: string, particle: string): string {
  const batchim = hasFinalConsonant(prevChar);
  if (batchim === null) return particle;
  for (const [withFinal, withoutFinal] of PARTICLE_PAIRS) {
    if (particle === withFinal || particle === withoutFinal) {
      return batchim ? withFinal : withoutFinal;
    }
  }
  return particle;
}

/**
 * 서버 문구 안의 내부 필드명을 사용자 용어로 바꾼다.
 * 번역할 수 없는 내부 식별자가 남으면 null(= 이 문구는 사용자에게 보여주지 않는다).
 */
export function humanizeFieldNames(message: string): string | null {
  // 1) 개발자용 괄호 주석 제거 — "팀(team_id)이" → "팀이".
  const stripped = message.replace(ANNOTATION_PAREN_RE, "");
  const strippedChanged = stripped !== message;

  // 2) 내부 필드명 → 사용자 용어. 번역 못하는 식별자가 남으면 문구 자체를 폐기한다.
  let blocked = false;
  let substituted = false;
  const replaced = stripped.replace(FIELD_TOKEN_RE, (token) => {
    if (INTERNAL_ONLY_FIELDS.has(token)) {
      blocked = true;
      return token;
    }
    const label = fieldLabel(token);
    if (label) {
      substituted = true;
      return label;
    }
    blocked = true; // 사전에 없는 내부 식별자 — 사용자에게 노출 금지.
    return token;
  });
  if (blocked) return null;

  // 3) 치환으로 생긴 "라인 코드 는"(띄어쓰기) · "소속 클럽를"(받침 불일치) 조사만 교정한다.
  //    아무것도 바뀌지 않았으면 원문을 그대로 둔다 — 도메인이 직접 쓴 문구를 임의로 손대지 않는다.
  const fixed = substituted
    ? replaced.replace(KOREAN_PARTICLE_RE, (_match, particle: string, offset: number) => {
        const prevChar = replaced.slice(0, offset).replace(/\s+$/, "").slice(-1);
        return fixParticle(prevChar, particle);
      })
    : replaced;
  const out =
    strippedChanged || substituted
      ? fixed.replace(/\s{2,}/g, " ").replace(/\s+([,.)])/g, "$1").trim()
      : message;

  // 4) 남은 개발 토큰 최종 차단 — 치환 여부와 무관하게 항상 검사한다.
  //    (org · info|experience 같은 enum · 미등록 camelCase 는 여기서 걸린다.)
  //    사용자 입력 에코(이메일·따옴표 값)는 검사 대상에서 뺀다.
  return LEFTOVER_DEV_TOKEN_RE.test(stripUserValues(out)) ? null : out;
}

// 그 자체로는 정보가 없는 자리표시자 문구.
const EMPTY_EQUIVALENT = new Set([
  "[object object]",
  "undefined",
  "null",
  "error",
  "failed",
  "unknown",
  "internal server error",
  "internal error",
  "unexpected error",
  "bad request",
  "ok",
]);

/**
 * 사용자에게 노출해도 되는 문구인지 판정한다.
 * 통과하면 정제된 문자열, 아니면 null.
 *   · 빈 문자열 / [object Object] / 스택 / SQL / 경로 / env / HTML 은 전부 null.
 *   · 내부 UUID 는 제거하고, 남은 문구가 의미를 유지할 때만 통과시킨다.
 *   · 내부 필드명(line_code 등)은 사용자 용어로 번역하고, 번역 못하면 문구를 폐기한다.
 *   · 영문 validator 문장("… is required")·한글이 없는 문구는 개발자용이므로 폐기한다.
 */
export function sanitizeServerMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_USER_MESSAGE_LENGTH) return null;
  if (EMPTY_EQUIVALENT.has(trimmed.toLowerCase())) return null;
  if (trimmed.startsWith("<")) return null;
  for (const re of UNSAFE_PATTERNS) {
    // /g 플래그가 없는 패턴만 쓰므로 lastIndex 상태 오염 없음.
    if (re.test(trimmed)) return null;
  }
  // 내부 UUID 제거 — 지우고 남은 문구가 너무 짧으면(사실상 UUID 뿐이면) 버린다.
  const withoutUuid = trimmed.replace(UUID_RE, "").replace(/\s{2,}/g, " ").trim();
  const cleaned = withoutUuid.replace(/^[\s(:\-–—,]+|[\s(:\-–—,]+$/g, "").trim();
  if (cleaned.length < 2) return null;

  // ── 개발 용어 게이트 ──
  if (!HANGUL_RE.test(cleaned)) return null; // 영문 전용 = 개발자 메시지.
  for (const re of DEV_ENGLISH_PATTERNS) {
    if (re.test(cleaned)) return null;
  }
  return humanizeFieldNames(cleaned);
}

// ──────────────────────────────────────────────────────────────
// payload → 서버 문구 추출 (우선순위 §3)
//   1) message  2) error(string)  3) error.message  4) details  5) reason
// ──────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** payload 에서 후보 문구를 우선순위대로 꺼내 첫 번째 "안전한" 값을 돌려준다. */
export function pickServerMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const candidates: unknown[] = [
    payload.message,
    typeof payload.error === "string" ? payload.error : undefined,
    isRecord(payload.error) ? payload.error.message : undefined,
    payload.details,
    payload.reason,
  ];
  for (const c of candidates) {
    const safe = sanitizeServerMessage(c);
    if (safe) return safe;
  }
  return null;
}

/** payload 에서 서버 error code 를 꺼낸다(있을 때만). */
export function pickServerCode(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const raw = isRecord(payload.error) ? payload.error.code : payload.code;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

// ──────────────────────────────────────────────────────────────
// 핵심 변환기
// ──────────────────────────────────────────────────────────────

export type ResolveApiErrorInput = {
  /** HTTP status. 응답이 없었으면 null. */
  status?: number | null;
  /** 파싱된 응답 본문(있으면). */
  payload?: unknown;
  /** catch 로 잡힌 원본 오류(있으면). */
  cause?: unknown;
  /** 화면별 최종 fallback 문구. 없으면 status 기반 문구를 쓴다. */
  fallback?: string;
};

/**
 * status + payload + client error → 사용자 문구.
 * 우선순위: 서버 message/error/details/reason → (4xx 만) → status 고정 문구 →
 *           클라이언트 Error.message(안전한 경우) → 화면 fallback.
 */
export function resolveApiError(input: ResolveApiErrorInput): ApiErrorInfo {
  const status = input.status ?? null;
  const code = pickServerCode(input.payload);
  const serverMessage = pickServerMessage(input.payload);

  // 1) 서버가 고칠 수 있는 4xx 업무 문구를 줬으면 그대로.
  if (serverMessage && allowsServerMessage(status)) {
    return { status, code, serverMessage, message: serverMessage, source: "server" };
  }

  // 2) status 정책 문구 — 401/429/5xx 는 여기서 고정, 403/404 는 서버 문구가 없을 때만.
  //    status 가 특정 문구를 갖지 않는 구간(2xx·기타 4xx)에서는 화면 fallback 이 더 구체적이다.
  if (status != null) {
    const byStatus = statusFallbackMessage(status);
    const useFallback = byStatus === API_ERROR_GENERIC && Boolean(input.fallback);
    return {
      status,
      code,
      serverMessage,
      message: useFallback ? (input.fallback as string) : byStatus,
      source: useFallback ? "fallback" : "status",
    };
  }

  // 3) 응답 자체가 없었던 경우 — 네트워크인지 클라이언트 로직 오류인지 구분.
  if (isNetworkError(input.cause)) {
    return { status: null, code, serverMessage, message: API_ERROR_NETWORK, source: "network" };
  }

  // 4) 클라이언트가 던진 도메인 문구(예: "Point.A/B 를 저장하려면 …")는 안전하면 노출.
  const clientMessage =
    input.cause instanceof Error ? sanitizeServerMessage(input.cause.message) : null;
  if (clientMessage) {
    return { status: null, code, serverMessage, message: clientMessage, source: "client" };
  }

  // 5) 화면별 fallback.
  return {
    status: null,
    code,
    serverMessage,
    message: input.fallback ?? API_ERROR_GENERIC,
    source: "fallback",
  };
}

/** fetch 계층 실패(네트워크/취소/CORS) 판별. */
export function isNetworkError(cause: unknown): boolean {
  if (cause instanceof ApiRequestError) return cause.status == null;
  if (typeof DOMException !== "undefined" && cause instanceof DOMException) {
    return cause.name === "AbortError" || cause.name === "TimeoutError";
  }
  if (!(cause instanceof Error)) return false;
  if (cause.name === "AbortError" || cause.name === "TimeoutError") return true;
  // 브라우저 fetch 실패는 TypeError("Failed to fetch" / "NetworkError when …"),
  // Node(undici)는 TypeError("fetch failed") + cause 에 ECONNREFUSED 등.
  return (
    cause.name === "TypeError" &&
    /failed to fetch|fetch failed|networkerror|network request failed|load failed/i.test(
      cause.message,
    )
  );
}

// ──────────────────────────────────────────────────────────────
// 오류 객체 — throw/catch 사이에서 status·payload 를 잃지 않는다.
// ──────────────────────────────────────────────────────────────

export class ApiRequestError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  /** 안전 필터를 통과한 서버 문구(없으면 null). */
  readonly serverMessage: string | null;
  /** 화면에 표시해도 되는 최종 문구. */
  readonly userMessage: string;
  /** userMessage 의 출처. */
  readonly source: ApiErrorSource;
  /** 서버 원본 payload — console.error 전용. toast 로 보내지 말 것. */
  readonly payload: unknown;

  constructor(input: ResolveApiErrorInput & { url?: string }) {
    const info = resolveApiError(input);
    // Error.message 는 개발자용(원문 우선) — 사용자 문구는 userMessage 를 쓴다.
    const devMessage =
      pickRawDevMessage(input.payload) ??
      (input.cause instanceof Error ? input.cause.message : null) ??
      info.message;
    super(input.url ? `${devMessage} [${input.status ?? "network"} ${input.url}]` : devMessage);
    this.name = "ApiRequestError";
    this.status = info.status;
    this.code = info.code;
    this.serverMessage = info.serverMessage;
    this.userMessage = info.message;
    this.source = info.source;
    this.payload = input.payload;
    if (input.cause !== undefined) this.cause = input.cause;
  }

  toInfo(fallback?: string): ApiErrorInfo {
    // throw 지점에서 fallback 을 못 준 경우에만 catch 지점의 fallback 을 적용한다.
    const useFallback = this.userMessage === API_ERROR_GENERIC && Boolean(fallback);
    return {
      status: this.status,
      code: this.code,
      serverMessage: this.serverMessage,
      message: useFallback ? (fallback as string) : this.userMessage,
      source: useFallback ? "fallback" : this.source,
    };
  }
}

// 개발자 로그용 원문(필터 없음) — Error.message 에만 들어가고 사용자에게 표시되지 않는다.
function pickRawDevMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const raw =
    (typeof payload.error === "string" ? payload.error : undefined) ??
    (isRecord(payload.error) && typeof payload.error.message === "string"
      ? payload.error.message
      : undefined) ??
    (typeof payload.message === "string" ? payload.message : undefined) ??
    (typeof payload.details === "string" ? payload.details : undefined) ??
    (typeof payload.reason === "string" ? payload.reason : undefined);
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? trimmed.slice(0, 500) : null;
}

// ──────────────────────────────────────────────────────────────
// 화면에서 쓰는 진입점 3개
// ──────────────────────────────────────────────────────────────

/**
 * catch 로 잡은 값 → 사용자 문구 1줄. 인라인 배너/에러 텍스트에 그대로 넣어도 안전하다.
 *   catch (err) { console.error(err); setError(getApiErrorMessage(err, "저장에 실패했습니다")); }
 */
export function getApiErrorMessage(cause: unknown, fallback?: string): string {
  return toApiErrorInfo(cause, fallback).message;
}

/** catch 로 잡은 값 → ApiErrorInfo (status 별 분기가 필요할 때). */
export function toApiErrorInfo(cause: unknown, fallback?: string): ApiErrorInfo {
  if (cause instanceof ApiRequestError) return cause.toInfo(fallback);
  return resolveApiError({ status: null, cause, fallback });
}

/**
 * 응답 본문을 아직 읽지 않은 실패 응답 → ApiRequestError.
 *   if (!res.ok) throw await readApiError(res, "저장에 실패했습니다");
 * 본문이 JSON 이 아니면(HTML 오류 페이지 등) 서버 문구 없이 status 문구로 떨어진다.
 */
export async function readApiError(
  response: Response,
  fallback?: string,
): Promise<ApiRequestError> {
  let payload: unknown = null;
  try {
    const text = await response.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        // JSON 이 아니면(HTML 오류 페이지·프록시 텍스트) 사용자 문구로 쓰지 않는다.
        payload = { details: text.slice(0, 500) };
      }
    }
  } catch {
    payload = null;
  }
  return new ApiRequestError({ status: response.status, payload, fallback, url: response.url });
}

// ──────────────────────────────────────────────────────────────
// 서버(route handler) 쪽 안전망 — 같은 필터를 응답 생성 시점에도 건다.
// ──────────────────────────────────────────────────────────────

/**
 * route handler 의 catch 에서 클라이언트로 내보낼 error 문구를 고른다.
 *   · 4xx(우리 도메인 오류가 던진 업무 문구) → 안전 필터 통과 시 그대로.
 *   · 5xx / 401 / 429 → 항상 fallback. Postgres·PostgREST·stack 원문이 새지 않는다.
 * 원문은 호출부에서 console.error(error) 로 서버 로그에만 남길 것.
 *
 *   } catch (error) {
 *     const status = error instanceof LineRegistrationError ? error.status : 500;
 *     console.error("[lines/registrations POST]", error);
 *     return Response.json(
 *       { success: false, error: publicErrorMessage(error, status, "라인 등록에 실패했습니다") },
 *       { status },
 *     );
 *   }
 */
export function publicErrorMessage(error: unknown, status: number, fallback: string): string {
  if (!allowsServerMessage(status)) return fallback;
  const safe = error instanceof Error ? sanitizeServerMessage(error.message) : null;
  return safe ?? fallback;
}

/**
 * 이미 `await res.json()` 으로 payload 를 확보한 기존 idiom 용.
 *   const json = await res.json().catch(() => ({}));
 *   if (!res.ok || !json.success) throw apiErrorFrom(res, json, "저장에 실패했습니다");
 */
export function apiErrorFrom(
  response: Pick<Response, "status" | "url">,
  payload: unknown,
  fallback?: string,
): ApiRequestError {
  return new ApiRequestError({
    status: response.status,
    payload,
    fallback,
    url: response.url,
  });
}
