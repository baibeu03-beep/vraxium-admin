/**
 * 카페 게시물 DOM "구조 근거" 수집 진단 — selector 확정을 위한 라이브 관찰(로컬 전용).
 *   .naver-profile(로그인 세션)로 게시물을 열고, 댓글 영역의 **구조(태그·클래스·개수)만** 덤프한다.
 *   ⚠ 개인정보 보호: 댓글 본문/닉네임/쿠키/전체 HTML 은 절대 출력하지 않는다(태그명·클래스명·개수만).
 *
 *   사용:
 *     세션 확인만:   npx tsx scripts/diag-cafe-dom.ts
 *     DOM 근거 수집: npx tsx scripts/diag-cafe-dom.ts "<문제 게시물 URL>"
 */
import path from "node:path";
import type { BrowserContext, Frame } from "playwright-core";
import { normalizeCafeArticleUrl } from "@/lib/naverCafeComments";

const PROFILE_DIR = path.join(process.cwd(), ".naver-profile");

// 댓글 컨테이너 후보(발견 시 구조 보고). 확정용 아님 — "무엇이 실제로 존재하는지" 관찰용.
const CONTAINER_CANDIDATES = [
  "ul.comment_list",
  ".comment_list",
  ".CommentBox",
  ".CommentList",
  "ul.CommentList",
  ".comment_area",
  "[class*='CommentList']",
  "[class*='comment_list']",
];
const ITEM_CANDIDATES = [
  "ul.comment_list > li",
  ".comment_list li",
  ".CommentItem",
  "[class*='CommentItem']",
  "li[class*='comment']",
  "[class*='comment_area'] li",
];

async function launch(): Promise<BrowserContext> {
  const { chromium } = await import("playwright-core");
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, { headless: true, viewport: { width: 1280, height: 900 } });
  } catch {
    return await chromium.launchPersistentContext(PROFILE_DIR, { headless: true, channel: "chromium", viewport: { width: 1280, height: 900 } });
  }
}

// 브라우저 컨텍스트에서 실행 — 구조만(텍스트 미포함). 후보 매칭 + "omment" 포함 클래스 상위 분포.
//   ⚠ frame.evaluate 직렬화 대상 — 중첩 named 함수/화살표 금지(esbuild __name 래퍼 방지). 전부 인라인.
function probe(cfg: { containers: string[]; items: string[] }) {
  const containers: Array<Record<string, unknown>> = [];
  for (const s of cfg.containers) {
    try {
      const nodes = document.querySelectorAll(s);
      const first = nodes[0] as Element | undefined;
      let firstClass = "";
      if (first) firstClass = (typeof first.className === "string" ? first.className : "").trim().slice(0, 120);
      containers.push({
        selector: s,
        count: nodes.length,
        firstTag: first ? first.tagName.toLowerCase() : "",
        firstClass,
        firstChildCount: first ? first.childElementCount : -1,
      });
    } catch {
      containers.push({ selector: s, error: "invalid" });
    }
  }

  const items: Array<Record<string, unknown>> = [];
  for (const s of cfg.items) {
    try {
      const nodes = document.querySelectorAll(s);
      const first = nodes[0] as Element | undefined;
      let firstClass = "";
      if (first) firstClass = (typeof first.className === "string" ? first.className : "").trim().slice(0, 120);
      items.push({
        selector: s,
        count: nodes.length,
        firstTag: first ? first.tagName.toLowerCase() : "",
        firstClass,
      });
    } catch {
      items.push({ selector: s, error: "invalid" });
    }
  }

  // "omment" 포함 클래스 분포(실제 댓글 구조 발견용) — 텍스트 미포함, 태그.클래스 상위만.
  const dist: Record<string, number> = {};
  try {
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const c = typeof el.className === "string" ? el.className.trim().slice(0, 120) : "";
      if (/omment/i.test(c)) {
        const key = `${el.tagName.toLowerCase()}.${c.replace(/\s+/g, ".")}`;
        dist[key] = (dist[key] ?? 0) + 1;
      }
    }
  } catch {
    // noop
  }
  const commentClassTop = Object.entries(dist).sort((a, b) => b[1] - a[1]).slice(0, 30);

  const iframeNames: string[] = [];
  for (const f of Array.from(document.querySelectorAll("iframe"))) {
    iframeNames.push(f.getAttribute("name") || f.getAttribute("id") || "(anon)");
  }
  const hasFeMarker = Boolean(document.querySelector("[class*='ArticleContent'], .se-main-container, [class*='CommentBox']"));
  const bodyClassSample = (typeof document.body?.className === "string" ? document.body.className : "").trim().slice(0, 120);

  return { containers, items, commentClassTop, iframeNames, hasFeMarker, bodyClassSample };
}

async function main() {
  const rawUrl = process.argv[2] ?? "";
  const context = await launch();
  try {
    // 세션 유효성(boolean 만) — NID_AUT 존재 여부.
    const cookies = await context.cookies("https://naver.com");
    const hasSession = cookies.some((c) => c.name === "NID_AUT");
    console.log(`[session] NID_AUT present = ${hasSession}`);
    if (!rawUrl) {
      console.log("URL 인자 없음 — 세션 확인만 수행했습니다. DOM 근거 수집: npx tsx scripts/diag-cafe-dom.ts \"<URL>\"");
      return;
    }
    const url = normalizeCafeArticleUrl(rawUrl);
    console.log(`[url] normalized = ${url ? "ok" : "null(비카페 URL)"}`);
    if (!url) return;

    const page = context.pages()[0] ?? (await context.newPage());
    let gotoOk = true;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch {
      gotoOk = false;
    }
    console.log(`[goto] ok = ${gotoOk} · finalUrlHost = ${(() => { try { return new URL(page.url()).host; } catch { return "?"; } })()}`);
    await page.waitForTimeout(2500); // iframe/f-e 지연 로딩 여유

    // 메인 프레임 + cafe_main iframe 각각 관찰(어느 쪽에 댓글이 있는지).
    const frames: Array<{ label: string; frame: Frame }> = [{ label: "main", frame: page.mainFrame() }];
    const iframe = page.frame({ name: "cafe_main" });
    if (iframe) frames.push({ label: "cafe_main(iframe)", frame: iframe });

    for (const { label, frame } of frames) {
      console.log(`\n===== FRAME: ${label} =====`);
      const ev = await frame.evaluate(probe, { containers: CONTAINER_CANDIDATES, items: ITEM_CANDIDATES });
      console.log("iframeNames:", JSON.stringify(ev.iframeNames));
      console.log("bodyClassSample:", ev.bodyClassSample, "| hasFeMarker:", ev.hasFeMarker);
      console.log("container candidates:");
      for (const c of ev.containers) console.log("  ", JSON.stringify(c));
      console.log("item candidates:");
      for (const c of ev.items) console.log("  ", JSON.stringify(c));
      console.log("comment-class distribution (tag.class : count, top30):");
      for (const [k, n] of ev.commentClassTop) console.log(`   ${n.toString().padStart(4)}  ${k}`);
    }
  } finally {
    await context.close().catch(() => undefined);
  }
}
main().catch((e) => { console.error("[diag] error:", e instanceof Error ? e.message : e); process.exit(1); });
