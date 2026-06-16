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
  if (!base) {
    const { collectCafeCommentNicknames } = await import("./naverCafeComments");
    return collectCafeCommentNicknames(rawUrl);
  }

  const secret = process.env.CAFE_CRAWLER_SECRET?.trim();
  const timeoutMs = Number(process.env.CAFE_CRAWLER_TIMEOUT_MS ?? 120_000);
  const cfId = process.env.CF_ACCESS_CLIENT_ID?.trim();
  const cfSecret = process.env.CF_ACCESS_CLIENT_SECRET?.trim();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/crawl`, {
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

    const json = (await res.json().catch(() => null)) as
      | { ok?: boolean; data?: CafeCommentsData; error?: string; message?: string }
      | null;

    if (res.ok && json?.ok === true && json.data) {
      return { ok: true, data: json.data };
    }

    const code = mapErrorCode(json?.error);
    return { ok: false, error: code, message: reviewerMessage(code) };
  } catch {
    // 네트워크/타임아웃/abort — 민감값 없는 일반 메시지.
    return {
      ok: false,
      error: "crawl_failed",
      message: "댓글 수집 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.",
    };
  } finally {
    clearTimeout(timer);
  }
}
