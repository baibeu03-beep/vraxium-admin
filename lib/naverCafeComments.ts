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
import {
  classifyCafeCrawlOutcome,
  type CafeCrawlSignals,
  type CafeLayoutKind,
} from "./cafeCrawlOutcome";

export type { CafeLayoutKind } from "./cafeCrawlOutcome";

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
  // ── 수집 진단(2026-07-20) — "정상 빈 게시물" vs "댓글 영역 탐지 실패" 구분 근거(선택·후방호환) ──
  //   commentContainerFound : 댓글 컨테이너(후보 selector 중 하나) 발견 여부.
  //   emptyStateConfirmed   : "댓글 0개" 명시 빈 상태 DOM 확인 여부(컨테이너 없는 레이아웃의 정상 빈 판정).
  //   postBodyFound         : 게시물 본문 영역 발견 여부.
  //   paginationCompleted   : 댓글 페이지네이션/더보기 순회 완료 여부.
  //   layoutKind            : 진단용 레이아웃 추정(사용자 미노출).
  commentContainerFound?: boolean;
  emptyStateConfirmed?: boolean;
  postBodyFound?: boolean;
  paginationCompleted?: boolean;
  layoutKind?: CafeLayoutKind;
};

export type CafeCommentsResult =
  | { ok: true; data: CafeCommentsData }
  | { ok: false; error: CafeCommentsErrorCode; message: string };

export type CafeCommentsErrorCode =
  | "invalid_url"
  | "login_required"
  | "article_not_accessible"
  | "crawl_failed"
  // ── 수집 진단 오류(2026-07-20) — 댓글 영역 탐지 실패를 "정상 빈(success+0)"과 구분하기 위한 코드 ──
  //   comment_container_not_found : 본문은 열렸으나 댓글 컨테이너 후보를 하나도 못 찾음.
  //   empty_state_not_confirmed   : 컨테이너 아이템 0인데 빈 상태도 확정 못함(아이템 selector 불일치 의심).
  //   layout_mismatch             : 컨테이너·빈상태 모두 미발견(새 레이아웃 가능성) — retryable.
  //   pagination_incomplete       : 댓글 순회가 끝나지 않음(부분 수집을 완료로 처리 금지).
  //   ⚠ 사용자 문구는 전부 공통 "일시 오류"로 매핑(내부 코드·selector·DOM 미노출). 저장·진단용.
  | "comment_container_not_found"
  | "empty_state_not_confirmed"
  | "layout_mismatch"
  | "pagination_incomplete";

const PROFILE_DIR = path.join(process.cwd(), ".naver-profile");
const NAV_TIMEOUT_MS = 30_000;
const COMMENT_AREA_TIMEOUT_MS = 20_000;
// 댓글 lazy-load 대비 — 컨테이너 shell(ul.comment_list)은 떴는데 <li> 가 아직 안 채워진 순간에 세면 0이 된다.
//   컨테이너가 있으면 첫 아이템이 렌더될 때까지 이 시간까지 기다린다(정말 빈 글이면 타임아웃 후 진행 → success(0)).
const COMMENT_ITEM_WAIT_MS = 8_000;
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

// ── 댓글 영역 탐지 후보 selector(구조화 · 요구 §2) ────────────────────────────────
//   한 레이아웃 하드코딩 대신 "후보 배열 + 명시 탐지 결과"를 쓴다. 배열에 추가하면 판정/추출이
//   자동으로 그 레이아웃을 포함한다(판정 로직 변경 불필요).
//   ✅ 검증됨: 레거시 데스크톱 컨테이너 `ul.comment_list`(현행 동작 그대로).
//   ⚠ 미검증 확장 지점: f-e(신형) 컨테이너·빈 상태 DOM selector 는 **라이브 네이버 DOM 확인이 필요**하다.
//     추정 selector 를 넣지 않는다(빈 배열 유지) — 확인 후 값을 채우면 된다. 확인 전까지 f-e/신레이아웃
//     게시물은 layout_mismatch(일시 오류·retryable)로 정직하게 처리된다(과거의 잘못된 success+0 대신).
export const CAFE_DETECT_CONFIG: {
  container: string[];
  body: string[];
  emptyState: string[];
  feHint: string[];
} = {
  container: [COMMENT_LIST_SELECTOR], // [검증] 레거시. [미검증 추가지점] f-e 댓글 컨테이너 selector
  body: [".article_container", ".ArticleContentBox", COMMENT_LIST_SELECTOR], // 본문 발견(ARTICLE_READY 와 정합)
  emptyState: [], // [미검증] "댓글 0개" 명시 빈 상태 DOM selector — 라이브 확인 후 채운다(추정 금지)
  feHint: [], // [미검증] f-e 레이아웃 힌트 selector(진단용·비차단)
};

// 브라우저 컨텍스트에서 실행(frame.evaluate) — 후보 배열로 컨테이너/본문/빈상태/레이아웃 신호를 수집한다.
//   ⚠ self-contained(외부 참조 금지 · selector 는 config 로만 전달) — 오프라인 fixture 테스트도 이 동일
//     함수를 page.evaluate 로 구동한다(운영 parser 와 동일 로직 · 판정 복제 없음). 정확한 댓글 "개수"는
//     여기서 세지 않고 extractCommentsOnPage 순회(중복 제거)가 담당한다.
export function collectCafeContainerSignals(config: {
  container: string[];
  body: string[];
  emptyState: string[];
  feHint: string[];
}): {
  postBodyFound: boolean;
  commentContainerFound: boolean;
  containerSelectorMatched: string | null;
  emptyStateConfirmed: boolean;
  layoutKind: CafeLayoutKind;
} {
  // ⚠ 이 함수는 frame.evaluate 로 브라우저에 "직렬화"돼 실행된다 — 중첩 named 함수/화살표를 두지 않는다
  //   (번들러 keepNames 가 __name 래퍼를 주입해 브라우저에서 Reference__name 오류를 낸다). 전부 인라인 루프.
  let containerSelectorMatched: string | null = null;
  for (const s of config.container) {
    try {
      if (document.querySelector(s)) {
        containerSelectorMatched = s;
        break;
      }
    } catch {
      // 잘못된 selector 는 무시(다음 후보 진행).
    }
  }
  const commentContainerFound = containerSelectorMatched !== null;

  let postBodyFound = commentContainerFound;
  if (!postBodyFound) {
    for (const s of config.body) {
      try {
        if (document.querySelector(s)) {
          postBodyFound = true;
          break;
        }
      } catch {
        // 무시.
      }
    }
  }

  let emptyStateConfirmed = false;
  for (const s of config.emptyState) {
    try {
      if (document.querySelector(s)) {
        emptyStateConfirmed = true;
        break;
      }
    } catch {
      // 무시.
    }
  }

  let feHintMatched = false;
  for (const s of config.feHint) {
    try {
      if (document.querySelector(s)) {
        feHintMatched = true;
        break;
      }
    } catch {
      // 무시.
    }
  }

  let layoutKind: CafeLayoutKind = "unknown";
  try {
    if (document.querySelector('iframe[name="cafe_main"]')) layoutKind = "legacy-iframe";
    else if (commentContainerFound) layoutKind = "legacy";
    else if (feHintMatched) layoutKind = "fe";
  } catch {
    // noop — 진단용이라 실패해도 판정에 영향 없음.
  }

  return {
    postBodyFound,
    commentContainerFound,
    containerSelectorMatched,
    emptyStateConfirmed,
    layoutKind,
  };
}

// 수집 진단 오류 코드 → 검수자 안전 문구(내부 코드·selector·DOM 미노출). 탐지 실패류는 전부 공통 "일시 오류".
function crawlDiagnosticMessage(code: CafeCommentsErrorCode): string {
  switch (code) {
    case "login_required":
      return LOGIN_GUIDE_MESSAGE;
    case "article_not_accessible":
      return "게시글에 접근하지 못했습니다. URL과 게시판 권한을 확인해주세요.";
    case "comment_container_not_found":
    case "empty_state_not_confirmed":
    case "layout_mismatch":
    case "pagination_incomplete":
    case "crawl_failed":
    default:
      return "댓글 정보를 일시적으로 가져오지 못했습니다. 다시 시도해주세요.";
  }
}

/** 현재 표시 중인 댓글 페이지에서 (nickname, content, date) 목록 추출. (오프라인 fixture 테스트도 재사용) */
export async function extractCommentsOnPage(frame: Frame): Promise<CafeCommentEntry[]> {
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

    // 댓글 lazy-load 레이스 방지 — 컨테이너 후보가 뜨면 첫 아이템이 렌더될 때까지 짧게 기다린다.
    //   (댓글이 있는 글을 "컨테이너 shell 만 뜬 순간"에 세어 0으로 저장하는 것을 막는다. 실제 문제 사례
    //    encreclub/41450: 로컬은 81, 그런데 shell 만 잡히는 타이밍이면 0이 됨.) 정말 빈 글이면 타임아웃→진행.
    const itemWaitSelector = CAFE_DETECT_CONFIG.container.map((c) => `${c} > li`).join(", ");
    if (itemWaitSelector) {
      await frame.waitForSelector(itemWaitSelector, { timeout: COMMENT_ITEM_WAIT_MS }).catch(() => null);
    }

    // 판정 신호 수집(후보 배열 기반) — 컨테이너/본문/빈상태/레이아웃. 아이템 개수는 아래 순회가 센다.
    const sig = await frame.evaluate(collectCafeContainerSignals, CAFE_DETECT_CONFIG);
    const seen = new Map<string, CafeCommentEntry>();
    let paginationCompleted = true;

    if (sig.commentContainerFound) {
      // 컨테이너 발견 → 기존 추출/순회(검증된 레거시 로직) 그대로.
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
      // guard 소진(= MAX 도달)으로 while 을 빠져나온 경우만 미완료. 정상 break(더 볼 페이지 없음/정지)는 완료.
      paginationCompleted = guard < MAX_COMMENT_PAGES;
    }

    const comments = Array.from(seen.values());
    const counts = new Map<string, number>();
    for (const c of comments) counts.set(c.nickname, (counts.get(c.nickname) ?? 0) + 1);
    const nicknames = Array.from(counts.keys());

    // ── 결과 판정(요구 §4) — "정상 빈 게시물"과 "댓글 영역 탐지 실패"를 신호로 구분한다. ──
    //   loginRequired/accessDenied 는 위 ready 게이트에서 이미 반환되므로 여기선 false(본문 정상 열림).
    const signals: CafeCrawlSignals = {
      postBodyFound: sig.postBodyFound,
      commentContainerFound: sig.commentContainerFound,
      commentItemCount: comments.length,
      emptyStateConfirmed: sig.emptyStateConfirmed,
      paginationCompleted,
      loginRequired: false,
      accessDenied: false,
      layoutKind: sig.layoutKind,
    };
    const verdict = classifyCafeCrawlOutcome(signals);
    if (verdict.kind === "error") {
      // 탐지 실패(컨테이너/빈상태 미발견 등) → success+0 대신 오류(코드는 진단용·문구는 공통 "일시 오류").
      return { ok: false, error: verdict.errorCode, message: crawlDiagnosticMessage(verdict.errorCode) };
    }

    return {
      ok: true,
      data: {
        articleUrl: url,
        totalComments: verdict.totalComments,
        uniqueNicknames: nicknames.length,
        nicknames,
        nicknameCounts: nicknames.map((n) => ({ nickname: n, count: counts.get(n) ?? 0 })),
        commentContainerFound: sig.commentContainerFound,
        emptyStateConfirmed: sig.emptyStateConfirmed,
        postBodyFound: sig.postBodyFound,
        paginationCompleted,
        layoutKind: sig.layoutKind,
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
