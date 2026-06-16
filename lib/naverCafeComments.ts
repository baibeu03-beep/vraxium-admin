// 네이버 카페 게시글 댓글 수집 — 닉네임 목록 추출 전용 (Phase 1).
//
// 구조 (기존 Python Selenium 프로젝트의 이식):
//   1. Playwright persistent profile(.naver-profile/)로 네이버 로그인 세션 유지
//   2. 게시글 페이지 진입 → cafe_main iframe(레거시) 또는 본문(f-e 신형) 내부 댓글 영역 접근
//   3. 댓글 페이지네이션 순회
//   4. (nickname, content, date) 기준 dedupe → 닉네임 목록 추출
//
// 제약:
//   - 로컬(관리자 PC) 실행 전용. Vercel 등 서버리스 배포 환경에서는 호출부에서 차단한다.
//   - 포인트/패널티/회원 매칭/snapshot 어디에도 관여하지 않는 순수 read-only 수집기.
//   - 계정 정보는 NAVER_ID / NAVER_PASSWORD 환경변수로만 읽으며 어떤 로그에도 남기지 않는다.

import path from "node:path";
import type { BrowserContext, Frame, Page } from "playwright-core";

export type CafeCommentEntry = {
  nickname: string;
  content: string;
  date: string;
};

export type CafeCommentsData = {
  articleUrl: string;
  totalComments: number;
  uniqueNicknames: number;
  nicknames: string[];
  /** 닉네임별 댓글 수 (검증용 — 합계 = totalComments) */
  nicknameCounts: Array<{ nickname: string; count: number }>;
};

export type CafeCommentsResult =
  | { ok: true; data: CafeCommentsData }
  | { ok: false; error: CafeCommentsErrorCode; message: string };

export type CafeCommentsErrorCode =
  | "invalid_url"
  | "login_required"
  | "article_not_accessible"
  | "crawl_failed";

const PROFILE_DIR = path.join(process.cwd(), ".naver-profile");
const NAV_TIMEOUT_MS = 30_000;
const COMMENT_AREA_TIMEOUT_MS = 20_000;
const MAX_COMMENT_PAGES = 200;

/** 동시 수집 방지 — persistent profile은 단일 프로세스만 사용 가능. */
let crawlChain: Promise<unknown> = Promise.resolve();

/** 카페 게시글 URL 검증 + 데스크톱 표준 URL로 정규화. 비카페 URL이면 null. */
export function normalizeCafeArticleUrl(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  const host = u.hostname.toLowerCase();
  if (host === "cafe.naver.com") {
    return u.toString();
  }
  if (host === "m.cafe.naver.com") {
    // 모바일 신형: /ca-fe/web/cafes/{cafe}/articles/{id} → 데스크톱 f-e 경로로 치환
    const m = u.pathname.match(/^\/ca-fe\/web\/(cafes\/[^/]+\/articles\/\d+)/);
    if (m) return `https://cafe.naver.com/f-e/${m[1]}${u.search}`;
    // 모바일 레거시: /{club}/{articleid}
    return `https://cafe.naver.com${u.pathname}${u.search}`;
  }
  return null;
}

async function hasNaverSession(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies("https://naver.com");
  return cookies.some((c) => c.name === "NID_AUT");
}

/**
 * 네이버 로그인 best-effort. persistent profile에 세션이 있으면 그대로 사용,
 * 없으면 NAVER_ID/NAVER_PASSWORD로 폼 로그인 시도.
 * 캡차/기기확인 등으로 자동 로그인이 막혀도 즉시 실패하지 않는다 —
 * 공개 카페는 비로그인 열람이 가능하므로 게시글 접근을 계속 시도하고,
 * 멤버 전용 접근 실패 시에만 로그인 안내를 반환한다
 * (수동 시드: scripts/naver-session-seed.mjs).
 */
async function ensureLogin(
  context: BrowserContext,
  page: Page,
): Promise<{ loggedIn: boolean }> {
  if (await hasNaverSession(context)) return { loggedIn: true };

  const id = process.env.NAVER_ID?.trim();
  const password = process.env.NAVER_PASSWORD?.trim();
  if (!id || !password) return { loggedIn: false };

  try {
    await page.goto(
      "https://nid.naver.com/nidlogin.login?mode=form&url=https://cafe.naver.com",
      { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS },
    );
    // 키 입력 감지를 피하기 위해 fill(값 직접 주입) 사용 — 기존 프로젝트의 JS 주입 방식과 동일 계열.
    await page.fill("#id", id);
    await page.fill("#pw", password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => null),
      page.click("#log\\.login, button[type=submit]"),
    ]);
    // 기기 등록 확인 화면이 나오면 "등록안함"을 눌러 통과한다.
    const skipDevice = page.locator("#new\\.dontsave, a:has-text('등록안함')").first();
    if (await skipDevice.isVisible().catch(() => false)) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => null),
        skipDevice.click(),
      ]);
    }
  } catch {
    return { loggedIn: false };
  }

  return { loggedIn: await hasNaverSession(context) };
}

const LOGIN_GUIDE_MESSAGE =
  "네이버 로그인 세션이 없어 멤버 전용 게시글에 접근하지 못했을 수 있습니다. node scripts/naver-session-seed.mjs 를 실행해 창에서 1회 로그인한 뒤 다시 시도해주세요.";

/** 댓글 영역이 있는 frame을 찾는다 — 레거시는 cafe_main iframe, 신형(f-e)은 본문. */
async function resolveArticleFrame(page: Page): Promise<Frame> {
  const iframe = page.frame({ name: "cafe_main" });
  return iframe ?? page.mainFrame();
}

const COMMENT_LIST_SELECTOR = "ul.comment_list";
const ARTICLE_READY_SELECTOR = "ul.comment_list, .article_container, .ArticleContentBox";

// 댓글 페이지네이션은 .CommentBox 내부의 .ArticlePaginate (실측 2026-06).
// 주의: RelatedArticles/PopularArticles 에도 동일 클래스 pager 가 있어 반드시 CommentBox 로 스코프.
const COMMENT_PAGER_SELECTOR = ".CommentBox .ArticlePaginate";

/** 현재 표시 중인 댓글 페이지에서 (nickname, content, date) 목록 추출. */
async function extractCommentsOnPage(frame: Frame): Promise<CafeCommentEntry[]> {
  return frame.evaluate(() => {
    const items = Array.from(document.querySelectorAll("ul.comment_list > li"));
    const out: Array<{ nickname: string; content: string; date: string }> = [];
    for (const li of items) {
      // BEST(인기) 댓글 미리보기는 본 댓글과 중복 + 내용 축약 가능성 → 제외
      if (li.classList.contains("CommentBest")) continue;
      const nickEl = li.querySelector(".comment_nickname");
      const contentEl = li.querySelector(".text_comment, .comment_text_view");
      const dateEl = li.querySelector(".comment_info_date");
      const nickname = nickEl?.textContent?.trim() ?? "";
      if (!nickname) continue; // 삭제된 댓글 등 닉네임 없는 항목 제외
      out.push({
        nickname,
        content: contentEl?.textContent?.trim() ?? "",
        date: dateEl?.textContent?.trim() ?? "",
      });
    }
    return out;
  });
}

/** 댓글 페이지네이션 버튼 목록(페이지 번호 텍스트)과 현재 페이지를 읽는다. */
async function readPaginationState(frame: Frame): Promise<{ pages: number[]; current: number | null; hasNextChunk: boolean }> {
  return frame.evaluate((pagerSelector) => {
    const box = document.querySelector(pagerSelector);
    if (!box) return { pages: [], current: null, hasNextChunk: false };
    const pages: number[] = [];
    let current: number | null = null;
    for (const btn of Array.from(box.querySelectorAll("a, button"))) {
      const text = btn.textContent?.trim() ?? "";
      if (/^\d+$/.test(text)) {
        const n = Number(text);
        pages.push(n);
        const el = btn as HTMLElement;
        if (
          el.getAttribute("aria-current") === "page" ||
          el.getAttribute("aria-pressed") === "true" ||
          /\b(on|active|current|page_current)\b/.test(el.className)
        ) {
          current = n;
        }
      }
    }
    const next = box.querySelector("a.type_next:not([aria-disabled='true']), button.type_next:not([disabled]), [class*='next']:not([disabled])");
    return { pages, current, hasNextChunk: Boolean(next) };
  }, COMMENT_PAGER_SELECTOR);
}

/**
 * 현재 댓글 목록의 시그니처 — 페이지 전환 감지용.
 * 주의: 페이저의 aria-current 는 클릭 즉시(목록 렌더 전) 바뀌므로 페이지 번호 대기만으로는
 * 이전 페이지를 중복 추출(→ dedupe 로 수백 건 누락)할 수 있다. 반드시 목록 내용 변경을 기다린다.
 */
async function readListSignature(frame: Frame): Promise<string> {
  return frame.evaluate(() => {
    const items = document.querySelectorAll("ul.comment_list > li");
    const first = items[0]?.textContent?.trim().slice(0, 80) ?? "";
    const last = items[items.length - 1]?.textContent?.trim().slice(0, 80) ?? "";
    return `${items.length}|${first}|${last}`;
  });
}

/** 클릭 후 댓글 목록 비동기 갱신 대기 — 목록 시그니처가 클릭 전과 달라질 때까지. */
async function waitForCommentPage(frame: Frame, prevSignature: string): Promise<void> {
  await frame
    .waitForFunction(
      (prev) => {
        const items = document.querySelectorAll("ul.comment_list > li");
        const first = items[0]?.textContent?.trim().slice(0, 80) ?? "";
        const last = items[items.length - 1]?.textContent?.trim().slice(0, 80) ?? "";
        return `${items.length}|${first}|${last}` !== prev;
      },
      prevSignature,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  await frame.waitForTimeout(400); // 목록 렌더 안정화 여유
}

/** 페이지 번호 버튼 클릭 후 목록 갱신 대기. */
async function gotoCommentPage(frame: Frame, pageNo: number): Promise<boolean> {
  const prevSignature = await readListSignature(frame);
  const clicked = await frame.evaluate(
    ({ pagerSelector, n }) => {
      const box = document.querySelector(pagerSelector);
      if (!box) return false;
      for (const btn of Array.from(box.querySelectorAll("a, button"))) {
        if (btn.textContent?.trim() === String(n)) {
          (btn as HTMLElement).click();
          return true;
        }
      }
      return false;
    },
    { pagerSelector: COMMENT_PAGER_SELECTOR, n: pageNo },
  );
  if (!clicked) return false;
  await waitForCommentPage(frame, prevSignature);
  return true;
}

/** "다음" 청크 버튼 클릭 (11~20 페이지 등). */
async function gotoNextChunk(frame: Frame): Promise<boolean> {
  const prevSignature = await readListSignature(frame);
  const clicked = await frame.evaluate((pagerSelector) => {
    const box = document.querySelector(pagerSelector);
    const next = box?.querySelector("a.type_next:not([aria-disabled='true']), button.type_next:not([disabled]), [class*='next']:not([disabled])");
    if (!next) return false;
    (next as HTMLElement).click();
    return true;
  }, COMMENT_PAGER_SELECTOR);
  if (!clicked) return false;
  await waitForCommentPage(frame, prevSignature);
  return true;
}

function dedupeKey(c: CafeCommentEntry): string {
  return `${c.nickname}\u0000${c.content}\u0000${c.date}`;
}

async function crawlArticleComments(url: string): Promise<CafeCommentsResult> {
  // playwright-core는 devDependency — 번들 밖 동적 로드 (Next server-external 기본 목록 포함).
  // 브라우저 바이너리는 로컬 ms-playwright 레지스트리 사용 (npx playwright-core install chromium).
  const { chromium } = await import("playwright-core");

  // 기본(headless shell) 기동이 환경에 따라 즉시 종료되는 경우가 있어 full Chromium 채널로 폴백.
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      viewport: { width: 1280, height: 900 },
    });
  } catch {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      channel: "chromium",
      viewport: { width: 1280, height: 900 },
    });
  }
  try {
    const page = context.pages()[0] ?? (await context.newPage());

    const { loggedIn } = await ensureLogin(context, page);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    } catch {
      return { ok: false, error: "article_not_accessible", message: "게시글 페이지 로드에 실패했습니다." };
    }

    // 레거시 URL은 cafe_main iframe 로드까지 잠시 대기
    await page.waitForTimeout(1500);
    const frame = await resolveArticleFrame(page);

    try {
      await frame.waitForSelector(ARTICLE_READY_SELECTOR, { timeout: COMMENT_AREA_TIMEOUT_MS });
    } catch {
      return {
        ok: false,
        error: loggedIn ? "article_not_accessible" : "login_required",
        message: loggedIn
          ? "게시글 본문/댓글 영역을 찾지 못했습니다. (멤버 전용 게시판 권한 또는 잘못된 URL 가능성)"
          : LOGIN_GUIDE_MESSAGE,
      };
    }

    const hasCommentList = await frame.locator(COMMENT_LIST_SELECTOR).count();
    const seen = new Map<string, CafeCommentEntry>();

    if (hasCommentList > 0) {
      // 1페이지 수집
      for (const c of await extractCommentsOnPage(frame)) seen.set(dedupeKey(c), c);

      // 페이지네이션 순회 (보이는 번호 → 다음 청크 반복)
      let guard = 0;
      const visited = new Set<number>([1]);
      while (guard < MAX_COMMENT_PAGES) {
        const state = await readPaginationState(frame);
        const remaining = state.pages.filter((p) => !visited.has(p)).sort((a, b) => a - b);
        if (remaining.length === 0) {
          if (!state.hasNextChunk) break;
          const moved = await gotoNextChunk(frame);
          if (!moved) break;
          guard++;
          continue;
        }
        const target = remaining[0];
        const moved = await gotoCommentPage(frame, target);
        if (!moved) break;
        visited.add(target);
        for (const c of await extractCommentsOnPage(frame)) seen.set(dedupeKey(c), c);
        guard++;
      }
    }

    const comments = Array.from(seen.values());
    const counts = new Map<string, number>();
    for (const c of comments) counts.set(c.nickname, (counts.get(c.nickname) ?? 0) + 1);
    const nicknames = Array.from(counts.keys());

    return {
      ok: true,
      data: {
        articleUrl: url,
        totalComments: comments.length,
        uniqueNicknames: nicknames.length,
        nicknames,
        nicknameCounts: nicknames.map((n) => ({ nickname: n, count: counts.get(n) ?? 0 })),
      },
    };
  } catch {
    return { ok: false, error: "crawl_failed", message: "댓글 수집 중 오류가 발생했습니다." };
  } finally {
    await context.close().catch(() => undefined);
  }
}

/** persistent profile 단일 사용 제약 — 모든 브라우저 작업(수집·세션확인)을 직렬화한다. */
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = crawlChain.then(fn, fn);
  crawlChain = run.catch(() => undefined);
  return run;
}

/**
 * 네이버 카페 게시글 URL에서 댓글 작성자 닉네임 목록을 수집한다. (direct function)
 * 동시 호출은 직렬화된다 — persistent profile 단일 사용 제약.
 */
export async function collectCafeCommentNicknames(rawUrl: string): Promise<CafeCommentsResult> {
  const url = normalizeCafeArticleUrl(rawUrl);
  if (!url) {
    return { ok: false, error: "invalid_url", message: "네이버 카페 게시글 URL이 아닙니다. (cafe.naver.com / m.cafe.naver.com)" };
  }
  return runExclusive(() => crawlArticleComments(url));
}

/**
 * 네이버 로그인 세션 유효성 확인 — 크롤러 서비스 deep health 전용.
 * persistent profile 에 NID_AUT 가 있으면 true(=valid). 수집과 동일하게 직렬화된다.
 * 계정 정보·세션값은 어떤 로그에도 남기지 않는다(반환은 boolean 만).
 */
export async function checkNaverSession(): Promise<boolean> {
  return runExclusive(async () => {
    const { chromium } = await import("playwright-core");
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true });
    } catch {
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: true,
        channel: "chromium",
      });
    }
    try {
      return await hasNaverSession(context);
    } finally {
      await context.close().catch(() => undefined);
    }
  });
}
