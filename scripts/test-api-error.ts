/**
 * 어드민 전역 API 오류 파서(lib/apiError) 단위 테스트 — 순수 로직(서버·DB 불필요).
 *   npx tsx scripts/test-api-error.ts
 *
 * 계약:
 *   · 4xx 업무 검증 문구는 그대로 노출 (사용자가 스스로 고칠 수 있는 원인)
 *   · 401/429/5xx/네트워크는 고정 정책 문구 — 서버 원문 노출 금지
 *   · SQL·stack·경로·env·HTML·[object Object]·빈 문자열은 어떤 status 에서도 노출 금지
 *   · 일반 모드/테스트 모드는 같은 파서를 쓰므로 payload 가 같으면 문구도 같다
 */
import {
  API_ERROR_FORBIDDEN,
  API_ERROR_GENERIC,
  API_ERROR_NETWORK,
  API_ERROR_NOT_FOUND,
  API_ERROR_SERVER,
  API_ERROR_TOO_MANY,
  API_ERROR_UNAUTHORIZED,
  ApiRequestError,
  allowsServerMessage,
  getApiErrorMessage,
  humanizeFieldNames,
  pickServerMessage,
  resolveApiError,
  sanitizeServerMessage,
  toApiErrorInfo,
} from "@/lib/apiError";
import { fieldLabel } from "@/lib/apiFieldLabels";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failed++;
  console.log(
    `${ok ? "✅" : "❌"} ${name}${!ok && detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`,
  );
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, { actual, expected });
}

// 재현 케이스 — /admin/lines/register 가 실제로 받는 400 문구(내부 필드명 제거 후).
const LINE_CODE_MSG = "라인 코드는 영문, 숫자, 하이픈(-)만 사용할 수 있습니다. 예: IFBS-NN0007";

// ── 1. 서버 문구 추출 우선순위 ────────────────────────────────
{
  eq("우선순위 1: message", pickServerMessage({ message: "가문구", error: "나문구" }), "가문구");
  eq("우선순위 2: error(string)", pickServerMessage({ error: "나문구", details: "다문구" }), "나문구");
  eq(
    "우선순위 3: error.message(객체)",
    pickServerMessage({ error: { message: "라문구", code: "x" }, details: "다문구" }),
    "라문구",
  );
  eq("우선순위 4: details", pickServerMessage({ details: "다문구", reason: "마문구" }), "다문구");
  eq("우선순위 5: reason", pickServerMessage({ reason: "마문구" }), "마문구");
  eq("1글자 문구는 정보 없음으로 폐기", pickServerMessage({ error: "가" }), null);
  eq("후보 없음 → null", pickServerMessage({ success: false }), null);
  eq("payload 아님 → null", pickServerMessage("문자열"), null);
  eq(
    "앞 후보가 불안전하면 다음 후보로",
    pickServerMessage({ message: "   ", error: LINE_CODE_MSG }),
    LINE_CODE_MSG,
  );
}

// ── 2. 안전 필터 ──────────────────────────────────────────────
{
  eq("빈 문자열", sanitizeServerMessage("   "), null);
  eq("[object Object]", sanitizeServerMessage("[object Object]"), null);
  eq("undefined 문자열", sanitizeServerMessage("undefined"), null);
  eq("HTML 오류 페이지", sanitizeServerMessage("<!DOCTYPE html><html><body>502</body></html>"), null);
  eq("HTML 태그 시작", sanitizeServerMessage("<pre>Internal Server Error</pre>"), null);
  eq(
    "stack trace",
    sanitizeServerMessage("TypeError: x is not a function\n    at Object.foo (/app/x.js:1:2)"),
    null,
  );
  eq(
    "SQL 문",
    sanitizeServerMessage('select "id" from cluster4_lines where org = $1'),
    null,
  );
  eq(
    "Postgres 제약 위반 원문",
    sanitizeServerMessage(
      'duplicate key value violates unique constraint "line_registrations_line_code_key"',
    ),
    null,
  );
  eq(
    "relation 원문",
    sanitizeServerMessage('relation "public.cluster4_lines" does not exist'),
    null,
  );
  eq("PostgREST 코드", sanitizeServerMessage("PGRST116: no rows returned"), null);
  eq("Postgres SQLSTATE", sanitizeServerMessage("23505: unique violation"), null);
  eq("supabase 언급", sanitizeServerMessage("supabase client error"), null);
  eq("service role 언급", sanitizeServerMessage("service_role key is missing"), null);
  eq("윈도우 파일 경로", sanitizeServerMessage("ENOENT C:\\Users\\app\\lib\\x.ts"), null);
  eq("리눅스 배포 경로", sanitizeServerMessage("cannot read /var/task/lib/x.js"), null);
  eq("환경변수 이름", sanitizeServerMessage("SUPABASE_SERVICE_ROLE_KEY is not set"), null);
  eq("process.env", sanitizeServerMessage("process.env.FOO is undefined"), null);
  eq("fetch failed", sanitizeServerMessage("fetch failed"), null);
  eq("300자 초과 원문", sanitizeServerMessage("가".repeat(301)), null);
  eq("정상 업무 문구는 통과", sanitizeServerMessage(LINE_CODE_MSG), LINE_CODE_MSG);
  eq("영문 validator 문장은 폐기", sanitizeServerMessage("line_name is required"), null);
  eq(
    "내부 UUID 제거 후 통과",
    sanitizeServerMessage("대상 주차(3f6d2b1a-1c2d-4e5f-8a9b-0c1d2e3f4a5b)를 찾을 수 없습니다"),
    "대상 주차()를 찾을 수 없습니다",
  );
  eq(
    "UUID 뿐인 문구는 폐기",
    sanitizeServerMessage("3f6d2b1a-1c2d-4e5f-8a9b-0c1d2e3f4a5b"),
    null,
  );
  eq("문자열 아님", sanitizeServerMessage({ message: "x" }), null);
}

// ── 2b. 개발 용어 차단 (내부 필드명 → 사용자 용어) ────────────
{
  // 사전에 있는 필드명은 화면 라벨로 번역하고, 한국어 조사 앞 공백을 정리한다.
  eq(
    "line_code → 라인 코드 (조사 붙임)",
    humanizeFieldNames("line_code 는 형식이 올바르지 않습니다"),
    "라인 코드는 형식이 올바르지 않습니다",
  );
  eq(
    "organization_slug → 소속 클럽 (받침 있음 → '을')",
    humanizeFieldNames("organization_slug 를 선택해주세요"),
    "소속 클럽을 선택해주세요",
  );
  eq(
    "estimated_duration_minutes → 소요 시간",
    humanizeFieldNames("estimated_duration_minutes 값이 잘못되었습니다"),
    "소요 시간 값이 잘못되었습니다",
  );
  eq(
    "여러 필드 동시 번역 + 조사 각각 교정",
    humanizeFieldNames("line_code 와 organization_slug 를 확인해주세요"),
    "라인 코드와 소속 클럽을 확인해주세요",
  );
  eq(
    "받침 없는 라벨 → '는'",
    humanizeFieldNames("line_code 은 필수입니다"),
    "라인 코드는 필수입니다",
  );
  eq(
    "받침 있는 라벨 → '이'",
    humanizeFieldNames("estimated_duration_minutes 가 비어 있습니다"),
    "소요 시간이 비어 있습니다",
  );
  eq(
    "영문 라벨(Point.A) 뒤 — 조사는 붙이되 형태는 바꾸지 않음",
    humanizeFieldNames("point_a 를 확인해주세요"),
    "Point.A를 확인해주세요",
  );
  // 사전에 없는 내부 식별자는 번역 불가 → 문구 자체를 폐기(화면 fallback 으로 넘어간다).
  eq("미등록 내부 식별자는 폐기", humanizeFieldNames("foo_bar_id 가 잘못되었습니다"), null);
  eq(
    "내부 전용 식별자(bridged_master_id)는 폐기",
    humanizeFieldNames("bridged_master_id 를 찾을 수 없습니다"),
    null,
  );
  eq(
    "competency_line_master_id 는 폐기",
    humanizeFieldNames("competency_line_master_id 불일치"),
    null,
  );
  eq("필드명이 없으면 원문 유지", humanizeFieldNames("이미 등록된 라인 코드입니다."), "이미 등록된 라인 코드입니다.");

  // sanitize 전체 경로 — 개발 용어가 남으면 사용자에게 절대 나가지 않는다.
  eq("snake_case 가 남는 문구는 표시 금지", sanitizeServerMessage("snapshot_id 가 없습니다"), null);
  eq("영문 전용 문구는 표시 금지", sanitizeServerMessage("line registration not found"), null);
  eq("must be 문장은 표시 금지", sanitizeServerMessage("소속 클럽 must be one of encre|oranke"), null);
  eq("Unauthorized 는 표시 금지", sanitizeServerMessage("Admin authentication required."), null);
  eq(
    "번역 가능한 필드명은 번역해서 표시",
    sanitizeServerMessage("line_code 형식을 확인해주세요"),
    "라인 코드 형식을 확인해주세요",
  );
  eq("정상 한국어 업무 문구는 그대로", sanitizeServerMessage(LINE_CODE_MSG), LINE_CODE_MSG);

  // 개발자용 괄호 주석 제거 — "팀(team_id)이" → "팀이".
  eq(
    "괄호 안 내부 필드명 제거",
    humanizeFieldNames("팀(team_id)이 필요합니다"),
    "팀이 필요합니다",
  );
  eq(
    "괄호 안 enum 제거",
    humanizeFieldNames("소속 클럽(encre|oranke|phalanx)을 선택해주세요"),
    "소속 클럽을 선택해주세요",
  );
  eq(
    "라벨 중복 괄호도 제거",
    humanizeFieldNames("액트명(act_name)은 필수입니다"),
    "액트명은 필수입니다",
  );
  // 실제 코드 값(대문자)은 사용자에게 필요하므로 괄호째 보존한다.
  eq(
    "코드 값 괄호는 보존",
    humanizeFieldNames("이미 등록된 라인 코드입니다 (IFBS-NN0007)."),
    "이미 등록된 라인 코드입니다 (IFBS-NN0007).",
  );
  eq(
    "하이픈 안내 괄호는 보존",
    humanizeFieldNames("영문, 숫자, 하이픈(-)만 사용할 수 있습니다"),
    "영문, 숫자, 하이픈(-)만 사용할 수 있습니다",
  );

  // 최종 게이트 — 번역 후에도 소문자 영문 토큰이 남으면 폐기.
  eq(
    "파이프 enum 이 남으면 폐기",
    sanitizeServerMessage("소속 허브는 info|experience|competency 중 하나여야 합니다"),
    null,
  );
  eq("미등록 단어(org)가 남으면 폐기", sanitizeServerMessage("org 을 확인해주세요"), null);
  eq("미등록 camelCase 가 남으면 폐기", sanitizeServerMessage("weekLabel 이 없습니다"), null);
  eq(
    "대문자 코드 값은 통과",
    sanitizeServerMessage("이미 등록된 라인 코드입니다 (IFBS-NN0007)."),
    "이미 등록된 라인 코드입니다 (IFBS-NN0007).",
  );
  eq(
    "Point.A 표기는 통과",
    sanitizeServerMessage("Point.A/B 를 저장하려면 활동 유형을 먼저 선택하세요."),
    "Point.A/B 를 저장하려면 활동 유형을 먼저 선택하세요.",
  );

  // 사용자 입력 에코는 개발 토큰 검사에서 제외한다(이메일 · 따옴표 값).
  eq(
    "이메일 에코는 통과",
    sanitizeServerMessage("이미 운영 계정으로 등록된 이메일입니다: a.b@example.com"),
    "이미 운영 계정으로 등록된 이메일입니다: a.b@example.com",
  );
  eq(
    "따옴표 안 사용자 값은 통과",
    sanitizeServerMessage("'wisdom'은(는) 실무 정보 허브에서 선택할 수 없는 라인 종류입니다."),
    "'wisdom'은(는) 실무 정보 허브에서 선택할 수 없는 라인 종류입니다.",
  );
  eq(
    "따옴표 밖 개발 토큰은 여전히 차단",
    sanitizeServerMessage("'wisdom'은(는) hub 목록에 없습니다 info|experience"),
    null,
  );

  // 라벨 사전 — 요구된 용어 매핑이 실제로 걸려 있는지.
  eq("라벨: line_code", fieldLabel("line_code"), "라인 코드");
  eq("라벨: organization_slug", fieldLabel("organization_slug"), "소속 클럽");
  eq("라벨: hub", fieldLabel("hub"), "소속 허브");
  eq("라벨: line_type", fieldLabel("line_type"), "라인 종류");
  eq("라벨: activity_type", fieldLabel("activity_type"), "활동 유형");
  eq("라벨: activity_type_id", fieldLabel("activity_type_id"), "활동 유형");
  eq("라벨: duration_minutes", fieldLabel("duration_minutes"), "소요 시간");
  eq("라벨: estimated_duration_minutes", fieldLabel("estimated_duration_minutes"), "소요 시간");
  eq("라벨 없음: bridged_master_id", fieldLabel("bridged_master_id"), null);
  eq("라벨 없음: competency_line_master_id", fieldLabel("competency_line_master_id"), null);
}

// ── 3. status 별 노출 정책 ────────────────────────────────────
{
  check("2xx(success:false) 서버 문구 허용", allowsServerMessage(200));
  check("400 허용", allowsServerMessage(400));
  check("403 허용", allowsServerMessage(403));
  check("404 허용", allowsServerMessage(404));
  check("409 허용", allowsServerMessage(409));
  check("422 허용", allowsServerMessage(422));
  check("401 금지", !allowsServerMessage(401));
  check("429 금지", !allowsServerMessage(429));
  check("500 금지", !allowsServerMessage(500));
  check("502 금지", !allowsServerMessage(502));
  check("네트워크(null) 금지", !allowsServerMessage(null));
}

// ── 4. resolveApiError — 요구 §4 status 정책 ──────────────────
{
  const r400 = resolveApiError({ status: 400, payload: { success: false, error: LINE_CODE_MSG } });
  eq("400: 서버 문구 그대로", r400.message, LINE_CODE_MSG);
  eq("400: source=server", r400.source, "server");

  eq(
    "409 중복: 서버 문구 그대로",
    resolveApiError({ status: 409, payload: { success: false, error: "이미 등록된 라인 코드입니다." } })
      .message,
    "이미 등록된 라인 코드입니다.",
  );
  eq(
    "422 확정됨: 서버 문구 그대로",
    resolveApiError({
      status: 422,
      payload: { success: false, error: "현재 주차는 이미 확정되어 수정할 수 없습니다." },
    }).message,
    "현재 주차는 이미 확정되어 수정할 수 없습니다.",
  );
  eq(
    "401: 서버 원문 무시하고 세션 만료 안내",
    resolveApiError({ status: 401, payload: { success: false, error: "Session idle timeout." } })
      .message,
    API_ERROR_UNAUTHORIZED,
  );
  eq(
    "403: 서버 구체 문구 우선",
    resolveApiError({
      status: 403,
      payload: { success: false, error: "이 클럽에 라인을 등록할 권한이 없습니다." },
    }).message,
    "이 클럽에 라인을 등록할 권한이 없습니다.",
  );
  eq(
    "403: 문구 없으면 권한 fallback",
    resolveApiError({ status: 403, payload: { success: false } }).message,
    API_ERROR_FORBIDDEN,
  );
  eq(
    "404: 서버 업무 문구 우선",
    resolveApiError({ status: 404, payload: { error: "해당 라인이 존재하지 않습니다." } }).message,
    "해당 라인이 존재하지 않습니다.",
  );
  eq(
    "404: 문구 없으면 찾을 수 없음",
    resolveApiError({ status: 404, payload: {} }).message,
    API_ERROR_NOT_FOUND,
  );
  eq(
    "429: 고정 문구",
    resolveApiError({ status: 429, payload: { error: "rate limited: 120 req/min" } }).message,
    API_ERROR_TOO_MANY,
  );
  eq(
    "500: Supabase 원문 차단",
    resolveApiError({
      status: 500,
      payload: {
        success: false,
        error: 'insert into "line_registrations" failed: duplicate key value violates unique constraint',
      },
    }).message,
    API_ERROR_SERVER,
  );
  eq(
    "500: 안전해 보이는 문구도 노출 금지",
    resolveApiError({ status: 500, payload: { error: "라인 저장 중 문제가 발생했습니다" } }).message,
    API_ERROR_SERVER,
  );
  eq(
    "503: 서버 안내",
    resolveApiError({ status: 503, payload: {} }).message,
    API_ERROR_SERVER,
  );
  eq(
    "JSON 아닌 응답(HTML) → 안전 fallback",
    resolveApiError({
      status: 502,
      payload: { details: "<!DOCTYPE html><html><body>Bad Gateway</body></html>" },
    }).message,
    API_ERROR_SERVER,
  );
  eq(
    "400 인데 본문이 HTML → 화면 fallback",
    resolveApiError({
      status: 400,
      payload: { details: "<!DOCTYPE html><html>nope</html>" },
      fallback: "저장에 실패했습니다",
    }).message,
    "저장에 실패했습니다",
  );
  eq(
    "네트워크 실패",
    resolveApiError({ status: null, cause: new TypeError("Failed to fetch") }).message,
    API_ERROR_NETWORK,
  );
  eq(
    "요청 취소(AbortError)",
    resolveApiError({
      status: null,
      cause: Object.assign(new Error("aborted"), { name: "AbortError" }),
    }).message,
    API_ERROR_NETWORK,
  );
  eq(
    "클라이언트 도메인 문구는 노출",
    resolveApiError({
      status: null,
      cause: new Error("Point.A/B 를 저장하려면 포인트 대상 활동유형을 먼저 선택하세요."),
    }).message,
    "Point.A/B 를 저장하려면 포인트 대상 활동유형을 먼저 선택하세요.",
  );
  eq(
    "정보 없음 → 화면 fallback",
    resolveApiError({ status: null, cause: null, fallback: "저장에 실패했습니다" }).message,
    "저장에 실패했습니다",
  );
  eq(
    "정보/fallback 모두 없음 → 일반 문구",
    resolveApiError({ status: null }).message,
    API_ERROR_GENERIC,
  );
  eq(
    "2xx success:false → 업무 문구 노출",
    resolveApiError({ status: 200, payload: { success: false, error: "대상자가 없습니다." } }).message,
    "대상자가 없습니다.",
  );
}

// ── 5. ApiRequestError — throw/catch 왕복에서 유실 없음 ────────
{
  const err = new ApiRequestError({
    status: 400,
    payload: { success: false, error: LINE_CODE_MSG },
    fallback: "라인 등록에 실패했습니다.",
    url: "/api/admin/lines/registrations",
  });
  eq("ApiRequestError.status", err.status, 400);
  eq("ApiRequestError.userMessage = 서버 문구", err.userMessage, LINE_CODE_MSG);
  check("Error.message 는 개발자용(원문+status+url)", err.message.includes("/api/admin/lines/registrations"));
  eq("catch → getApiErrorMessage 로 동일 문구", getApiErrorMessage(err), LINE_CODE_MSG);
  eq("catch → toApiErrorInfo.status 보존", toApiErrorInfo(err).status, 400);

  const err500 = new ApiRequestError({
    status: 500,
    payload: { success: false, error: 'relation "cluster4_lines" does not exist' },
  });
  eq("500 catch → 안전 문구", getApiErrorMessage(err500, "저장에 실패했습니다"), API_ERROR_SERVER);
  check(
    "500 개발자 message 에는 원문 보존(console 용)",
    err500.message.includes("cluster4_lines"),
  );

  const errGeneric = new ApiRequestError({ status: 400, payload: {} });
  eq(
    "throw 지점 fallback 없으면 catch 지점 fallback 적용",
    getApiErrorMessage(errGeneric, "라인 등록에 실패했습니다."),
    "라인 등록에 실패했습니다.",
  );

  eq(
    "일반 Error 도 안전하면 노출",
    getApiErrorMessage(new Error("소속 클럽을 선택해주세요"), "실패"),
    "소속 클럽을 선택해주세요",
  );
  eq(
    "일반 Error 가 내부 원문이면 fallback",
    getApiErrorMessage(new Error("PGRST301 JWT expired"), "실패"),
    "실패",
  );
  eq("비-Error throw → fallback", getApiErrorMessage("문자열 throw", "실패"), "실패");
}

// ── 6. 일반 모드 · 테스트 모드 동등성 ─────────────────────────
{
  // 같은 API·같은 잘못된 요청이면 mode 와 무관하게 payload/DTO 가 같고, 따라서 문구도 같아야 한다.
  const payload = { success: false, error: LINE_CODE_MSG };
  const normal = resolveApiError({ status: 400, payload });
  const test = resolveApiError({ status: 400, payload: { ...payload } });
  eq("일반=테스트 문구 동일", normal.message, test.message);
  eq("일반=테스트 source 동일", normal.source, test.source);
  eq("일반=테스트 status 동일", normal.status, test.status);
}

console.log(`\n═══ 결과: PASS ${passed} · FAIL ${failed} ═══`);
process.exit(failed > 0 ? 1 : 0);
