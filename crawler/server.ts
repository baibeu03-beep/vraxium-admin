// 네이버 카페 댓글 크롤러 서비스 (C안 1차) — 닉네임 목록만 반환하는 HTTP 래퍼.
//
//   · 전용 환경(가정용/사무실 IP 상시 PC/미니PC)에서 tsx 로 구동:  npm run crawler  (tsx crawler/server.ts)
//   · 네이버 로그인 세션(.naver-profile/)을 가진 환경에서만 의미가 있다(로그인 전용 게시글 대응).
//   · 크루 DB·org·mode·user 에 일절 접근하지 않는다. 응답은 공개 닉네임 목록뿐.
//   · 매칭/스코프(org·mode·동명이인·test/operating)는 전적으로 Vercel admin 이 수행한다.
//   · 계정 정보·세션값은 어떤 응답/로그에도 남기지 않는다.
//
//   엔드포인트:
//     POST /crawl         { url } → { ok, data:{ articleUrl,totalComments,uniqueNicknames,nicknames,nicknameCounts } }
//     GET  /health        → { ok, up, lastCrawlAt, lastError }        (shallow · 브라우저 미기동 · uptime 핑용)
//     GET  /health?deep=1 → { ok, session:"valid"|"expired" }         (NID_AUT 확인 · 인증 필요)
//
//   인증: Authorization: Bearer <CAFE_CRAWLER_SECRET> (POST /crawl · deep health). 상수시간 비교.
//   env:  CAFE_CRAWLER_SECRET(필수) · CAFE_CRAWLER_PORT(기본 8787)
//
//   ※ buildServer({crawl,checkSession,secret}) 는 검증 스크립트가 가짜 구현을 주입하도록 export 한다
//     (네이버/Playwright 없이 계약 테스트 가능 — 기존 worker 의 주입 패턴과 동일 계열).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  collectCafeCommentNicknames,
  normalizeCafeArticleUrl,
  checkNaverSession,
  type CafeCommentsResult,
  type CafeCommentsErrorCode,
} from "../lib/naverCafeComments";

const PORT = Number(process.env.CAFE_CRAWLER_PORT ?? 8787);
const SECRET = process.env.CAFE_CRAWLER_SECRET?.trim() ?? "";
const MAX_BODY = 8 * 1024;

const ERROR_STATUS: Record<CafeCommentsErrorCode, number> = {
  invalid_url: 400,
  login_required: 409,
  article_not_accessible: 502,
  crawl_failed: 502,
  // 수집 진단 오류(2026-07-20) — 탐지 실패는 재시도 가능한 서버측 실패(502)로 응답(클라 재수집 유도).
  comment_container_not_found: 502,
  empty_state_not_confirmed: 502,
  layout_mismatch: 502,
  pagination_incomplete: 502,
};

// Bearer 토큰 상수시간 비교(길이 불일치는 즉시 false).
function bearerOk(req: IncomingMessage, secret: string): boolean {
  if (!secret) return false;
  const raw = req.headers["authorization"] ?? "";
  const header = Array.isArray(raw) ? raw[0] : raw;
  const m = /^Bearer\s+(.+)$/.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readJson(req: IncomingMessage): Promise<{ url?: unknown } | null> {
  return new Promise((resolve) => {
    let buf = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > MAX_BODY) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return resolve(null);
      try {
        resolve(JSON.parse(buf || "{}"));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

type BuildServerOptions = {
  crawl?: (url: string) => Promise<CafeCommentsResult>;
  checkSession?: () => Promise<boolean>;
  secret?: string;
};

export function buildServer({
  crawl = collectCafeCommentNicknames,
  checkSession = checkNaverSession,
  secret = SECRET,
}: BuildServerOptions = {}) {
  const state: { lastCrawlAt: string | null; lastError: string | null } = {
    lastCrawlAt: null,
    lastError: null,
  };

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      // ── GET /health ──
      if (req.method === "GET" && url.pathname === "/health") {
        if (url.searchParams.get("deep") !== "1") {
          return send(res, 200, {
            ok: true,
            up: true,
            lastCrawlAt: state.lastCrawlAt,
            lastError: state.lastError,
          });
        }
        if (!bearerOk(req, secret)) {
          return send(res, 401, { ok: false, error: "unauthorized", message: "인증이 필요합니다." });
        }
        let valid = false;
        try {
          valid = await checkSession();
        } catch {
          valid = false;
        }
        return send(res, 200, { ok: true, session: valid ? "valid" : "expired" });
      }

      // ── POST /crawl ──
      if (req.method === "POST" && url.pathname === "/crawl") {
        // 진단 로그 — Authorization "값"은 절대 출력하지 않고 존재/통과 여부만 남긴다.
        const hasAuth = Boolean(req.headers["authorization"]);
        const authPassed = bearerOk(req, secret);
        console.log(`[cafe-crawler] /crawl 수신 hasAuth=${hasAuth} authPassed=${authPassed}`);
        if (!authPassed) {
          return send(res, 401, { ok: false, error: "unauthorized", message: "인증이 필요합니다." });
        }
        const body = await readJson(req);
        const rawUrl = typeof body?.url === "string" ? body.url : "";
        const normalized = normalizeCafeArticleUrl(rawUrl);
        console.log(`[cafe-crawler] /crawl url=${rawUrl || "(none)"} normalized=${normalized ? "ok" : "null"}`);
        // 엣지 검증(SSRF/오픈프록시 차단): 카페 URL 이 아니면 브라우저를 띄우지 않는다.
        if (!rawUrl.trim() || !normalized) {
          return send(res, 400, {
            ok: false,
            error: "invalid_url",
            message: "네이버 카페 게시글 URL이 아닙니다.",
          });
        }

        const result = await crawl(rawUrl);
        state.lastCrawlAt = new Date().toISOString();
        console.log(
          `[cafe-crawler] /crawl 결과 ok=${result.ok}` +
            (result.ok
              ? ` nicknames=${result.data.uniqueNicknames}`
              : ` error=${result.error}`),
        );
        if (result.ok) {
          state.lastError = null;
          // 닉네임 목록만 — 크루/org/user/DB 필드 없음.
          return send(res, 200, { ok: true, data: result.data });
        }
        state.lastError = result.error;
        return send(res, ERROR_STATUS[result.error] ?? 502, {
          ok: false,
          error: result.error,
          message: result.message,
        });
      }

      return send(res, 404, { ok: false, error: "not_found", message: "지원하지 않는 경로입니다." });
    } catch {
      return send(res, 500, { ok: false, error: "crawl_failed", message: "서버 오류가 발생했습니다." });
    }
  });
}

// 직접 실행 시에만 리슨(검증 스크립트가 import 할 땐 미기동).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (!SECRET) {
    console.error("[cafe-crawler] CAFE_CRAWLER_SECRET 미설정 — 기동을 중단합니다.");
    process.exit(1);
  }
  buildServer().listen(PORT, () => {
    console.log(`[cafe-crawler] listening on :${PORT}`);
  });
}
