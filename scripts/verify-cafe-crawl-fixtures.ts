/**
 * 오프라인 fixture 검증 — 실제 selector 탐지 + 판정을 최소 HTML fixture 로 검증(네이버/네트워크 없음).
 *   playwright setContent 로 로컬 Chromium 에 fixture 를 로드하고, 운영과 "동일한" 함수를 구동한다:
 *     · collectCafeContainerSignals (lib/naverCafeComments) — 후보 배열 기반 컨테이너/본문/빈상태/레이아웃 신호
 *     · extractCommentsOnPage        (lib/naverCafeComments) — 실제 아이템 추출(BEST 제외·닉네임 게이트)
 *     · classifyCafeCrawlOutcome     (lib/cafeCrawlOutcome)   — §4 판정 규칙
 *   → 판정 로직을 테스트용으로 복제하지 않는다(운영 parser 그대로).
 *
 *   요구 Chromium: npx playwright-core install chromium (미설치면 스킵·exit 0).
 *   npx tsx scripts/verify-cafe-crawl-fixtures.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import {
  CAFE_DETECT_CONFIG,
  collectCafeContainerSignals,
  extractCommentsOnPage,
} from "@/lib/naverCafeComments";
import { classifyCafeCrawlOutcome, type CafeCrawlSignals } from "@/lib/cafeCrawlOutcome";

let failed = 0;
function ck(name: string, ok: boolean, detail?: unknown) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}
const fixture = (name: string) => readFileSync(path.join(process.cwd(), "scripts/fixtures/cafe", name), "utf8");

async function main() {
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    console.log(`⚠ Chromium 미설치 — fixture 테스트 스킵(순수 단위는 verify-cafe-crawl-outcome-unit 이 커버). ${e instanceof Error ? e.message.split("\n")[0] : ""}`);
    process.exit(0);
  }

  // 운영 crawlArticleComments 와 동일한 신호→판정 파이프라인(로그인/접근은 fixture 로 항상 통과 가정).
  async function evaluateFixture(
    html: string,
    config: typeof CAFE_DETECT_CONFIG,
  ): Promise<{ signals: CafeCrawlSignals; verdict: ReturnType<typeof classifyCafeCrawlOutcome> }> {
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: "domcontentloaded" });
      const sig = await page.evaluate(collectCafeContainerSignals, config);
      const count = sig.commentContainerFound ? (await extractCommentsOnPage(page.mainFrame())).length : 0;
      const signals: CafeCrawlSignals = {
        postBodyFound: sig.postBodyFound,
        commentContainerFound: sig.commentContainerFound,
        commentItemCount: count,
        emptyStateConfirmed: sig.emptyStateConfirmed,
        paginationCompleted: true,
        loginRequired: false,
        accessDenied: false,
        layoutKind: sig.layoutKind,
      };
      return { signals, verdict: classifyCafeCrawlOutcome(signals) };
    } finally {
      await page.close();
    }
  }

  try {
    // 1) 레거시 · 댓글 2개(BEST 미리보기 제외) → success + totalComments=2
    {
      const { signals, verdict } = await evaluateFixture(fixture("legacy-with-comments.html"), CAFE_DETECT_CONFIG);
      ck("[레거시·댓글2] 컨테이너 발견·아이템2(BEST 제외)", signals.commentContainerFound && signals.commentItemCount === 2, signals);
      ck("[레거시·댓글2] success + totalComments=2", verdict.kind === "success" && verdict.kind === "success" && verdict.totalComments === 2, verdict);
      ck("[레거시·댓글2] layoutKind=legacy", signals.layoutKind === "legacy");
    }

    // 2) 레거시 · 빈 컨테이너 → success + 0 (정상 빈 게시물)
    {
      const { signals, verdict } = await evaluateFixture(fixture("legacy-empty.html"), CAFE_DETECT_CONFIG);
      ck("[레거시·빈] 컨테이너 발견·아이템0", signals.commentContainerFound && signals.commentItemCount === 0);
      ck("[레거시·빈] success + 0 (정상 빈)", verdict.kind === "success" && verdict.kind === "success" && verdict.totalComments === 0, verdict);
    }

    // 3) 컨테이너 미발견(신형 f-e/mismatch · 실댓글 존재) → layout_mismatch (핵심: success+0 금지)
    {
      const { signals, verdict } = await evaluateFixture(fixture("container-not-found.html"), CAFE_DETECT_CONFIG);
      ck("[탐지실패] 본문 발견·컨테이너 미발견", signals.postBodyFound && !signals.commentContainerFound, signals);
      ck("[탐지실패] layout_mismatch (success+0 아님!)", verdict.kind === "error" && verdict.kind === "error" && verdict.errorCode === "layout_mismatch", verdict);
    }

    // 4) 컨테이너 미발견 + 빈 상태 DOM 확인(테스트 config 주입) → success + 0 (메커니즘 증명)
    {
      const cfg = { ...CAFE_DETECT_CONFIG, emptyState: [".CommentEmptyStateTest"] };
      const { signals, verdict } = await evaluateFixture(fixture("empty-state-confirmed.html"), cfg);
      ck("[빈상태확인] 컨테이너X·빈상태O", !signals.commentContainerFound && signals.emptyStateConfirmed, signals);
      ck("[빈상태확인] success + 0", verdict.kind === "success" && verdict.kind === "success" && verdict.totalComments === 0, verdict);
    }

    // 5) 대조 확인 — 같은 '탐지실패' fixture 라도 f-e 컨테이너 selector 를 후보에 추가하면 success 로 전환된다
    //    (즉 layout_mismatch 는 "selector 미등록" 신호이지 영구 오류가 아님 — 라이브 확인 후 배열에 추가하면 해소).
    {
      const cfg = { ...CAFE_DETECT_CONFIG, container: [...CAFE_DETECT_CONFIG.container, ".CommentContainerFE"] };
      const { signals } = await evaluateFixture(fixture("container-not-found.html"), cfg);
      // 아이템 카운트는 f-e 전용 추출기가 없어 0이지만(레거시 li 추출기 사용), 컨테이너 자체는 발견됨을 보인다.
      ck("[대조] 후보에 f-e 컨테이너 추가 시 commentContainerFound=true", signals.commentContainerFound, signals);
    }
  } finally {
    await browser.close();
  }

  console.log(`\n결과: ${failed === 0 ? "ALL PASS" : failed + " FAIL"}`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
