// 카페 닉네임 수집 오케스트레이터 (C안 1차 — 외부 크롤러 서비스 호출).
//
//   · CAFE_CRAWLER_URL 설정 시(운영/Vercel): 외부 크롤러 서비스(POST /crawl)를 호출해 닉네임만 받는다.
//   · 미설정 시(로컬 개발): 기존 로컬 Playwright 경로(collectCafeCommentNicknames)로 폴백 — 보존.
//
//   반환 타입은 collectCafeCommentNicknames 와 동일(CafeCommentsResult) → 호출부(라우트) 무변경.
//   매칭/스코프(org·mode·동명이인·test/operating)는 라우트가 별도로 수행한다(여기는 닉네임만 취급).
//   크루 DB·snapshot·user_weekly_points 에 일절 접근하지 않는다(read-only 닉네임 파이프라인).
//
//   ⚠ A(Vercel 직접 fetch/parse)는 1차 미구현 — 공개 게시글 성공률 스파이크 후 플래그로 추가 예정.
//   env 는 호출 시점에 읽는다(런타임 주입·테스트 주입 호환).

import type {
  CafeCommentsResult,
  CafeCommentsData,
  CafeCommentsErrorCode,
} from "./naverCafeComments";

const KNOWN_CODES: ReadonlySet<string> = new Set([
  "invalid_url",
  "login_required",
  "article_not_accessible",
  "crawl_failed",
  // 수집 진단 오류(2026-07-20) — 탐지 실패를 "정상 빈"과 구분하는 코드. 미등록이면 crawl_failed 로 뭉개져
  //   진단 코드가 유실되므로 반드시 통과시킨다(사용자 문구는 아래에서 공통 "일시 오류"로 매핑).
  "comment_container_not_found",
  "empty_state_not_confirmed",
  "layout_mismatch",
  "pagination_incomplete",
]);

function mapErrorCode(raw: unknown): CafeCommentsErrorCode {
  return typeof raw === "string" && KNOWN_CODES.has(raw)
    ? (raw as CafeCommentsErrorCode)
    : "crawl_failed";
}

// 검수자 화면용 안전 메시지 — 내부 세부/세션/민감값을 노출하지 않는다.
function reviewerMessage(code: CafeCommentsErrorCode): string {
  switch (code) {
    case "invalid_url":
      return "네이버 카페 게시글 URL이 아닙니다. (cafe.naver.com / m.cafe.naver.com)";
    case "login_required":
      return "카페 댓글 자동 수집이 일시적으로 불가합니다(세션 점검 필요). 잠시 후 다시 시도하거나 운영자에게 알려주세요.";
    case "article_not_accessible":
      return "게시글에 접근하지 못했습니다. URL과 게시판 권한을 확인해주세요.";
    // 댓글 영역 탐지 실패류 — 내부 코드/selector/DOM 을 노출하지 않고 공통 "일시 오류" 문구로만 안내한다.
    case "comment_container_not_found":
    case "empty_state_not_confirmed":
    case "layout_mismatch":
    case "pagination_incomplete":
    case "crawl_failed":
    default:
      return "댓글 수집 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.";
  }
}

/**
 * 카페 게시글 URL → 댓글 작성자 닉네임 목록(CafeCommentsResult).
 * 운영(Vercel)은 외부 크롤러 서비스, 로컬은 기존 Playwright 경로.
 */
export async function fetchCafeNicknames(rawUrl: string): Promise<CafeCommentsResult> {
  const base = process.env.CAFE_CRAWLER_URL?.trim();

  // 로컬 개발 폴백 — 기존 로컬 크롤링 경로 유지(보존).
  // ⚠ 운영(Vercel)에서 이 분기를 타면 거의 항상 오설정이다: serverless 에는 브라우저/프로필이
  //   없어 collectCafeCommentNicknames 가 crawl_failed 로 끝나 라우트가 502 를 낸다.
  //   (CAFE_CRAWLER_URL 미설정/Production 스코프 누락/redeploy 미반영을 로그로 드러낸다.)
  if (!base) {
    console.error(
      "[cafe-crawler-client] CAFE_CRAWLER_URL 미설정 → 로컬 Playwright 폴백 사용. " +
        "Vercel 이라면 외부 크롤러 호출이 아니라 폴백을 타는 오설정입니다.",
    );
    const { collectCafeCommentNicknames } = await import("./naverCafeComments");
    return collectCafeCommentNicknames(rawUrl);
  }

  const secret = process.env.CAFE_CRAWLER_SECRET?.trim();
  const timeoutMs = Number(process.env.CAFE_CRAWLER_TIMEOUT_MS ?? 120_000);
  const cfId = process.env.CF_ACCESS_CLIENT_ID?.trim();
  const cfSecret = process.env.CF_ACCESS_CLIENT_SECRET?.trim();

  const endpoint = `${base.replace(/\/+$/, "")}/crawl`;
  // 진단 로그 — 시크릿 "값"은 절대 출력하지 않고 존재 여부만 남긴다.
  console.log(
    `[cafe-crawler-client] POST ${endpoint} hasSecret=${Boolean(secret)} ` +
      `cfAccess=${Boolean(cfId && cfSecret)} timeoutMs=${timeoutMs}`,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        ...(cfId && cfSecret
          ? { "CF-Access-Client-Id": cfId, "CF-Access-Client-Secret": cfSecret }
          : {}),
      },
      body: JSON.stringify({ url: rawUrl }),
      signal: controller.signal,
    });

    // 본문을 text 로 먼저 받아 그대로 로깅(파싱 실패 시에도 원문 확인 가능).
    const text = await res.text().catch(() => "");
    let json:
      | { ok?: boolean; data?: CafeCommentsData; error?: string; message?: string }
      | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    console.log(
      `[cafe-crawler-client] response status=${res.status} ok=${res.ok} ` +
        `error=${json?.error ?? "-"} bodyLen=${text.length} body=${text.slice(0, 300)}`,
    );

    if (res.ok && json?.ok === true && json.data) {
      return { ok: true, data: json.data };
    }

    const code = mapErrorCode(json?.error);
    return { ok: false, error: code, message: reviewerMessage(code) };
  } catch (err) {
    // 네트워크/타임아웃/abort(=크롤러 응답 "전" 실패) — 민감값 없는 일반 메시지.
    const name = err instanceof Error ? err.name : "unknown";
    const detail = err instanceof Error ? err.message : String(err);
    const aborted = controller.signal.aborted;
    console.error(
      `[cafe-crawler-client] fetch 실패(응답 전) endpoint=${endpoint} ` +
        `aborted=${aborted} name=${name} detail=${detail}`,
    );
    return {
      ok: false,
      error: "crawl_failed",
      message: aborted
        ? "댓글 수집 서버 응답이 지연되어 중단되었습니다. 잠시 후 다시 시도해주세요."
        : "댓글 수집 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.",
    };
  } finally {
    clearTimeout(timer);
  }
}
