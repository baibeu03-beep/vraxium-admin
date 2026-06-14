/**
 * 브라우저 E2E: /admin/lines/info 적용 클럽 표시 정책 + 설명 문구 제거 (2026-06-14).
 *   npx tsx --env-file=.env.local scripts/verify-lines-info-club-display-browser.ts
 * READ-ONLY. 스크린샷: claudedocs/browser-lines-info-club-display.png
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

async function main() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(supabaseUrl, ensureEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const anon = createClient(supabaseUrl, anonKey);
  const { data: l, error: le } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (le || !l?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await anon.auth.verifyOtp({
    email: adminEmail,
    token: l.properties.email_otp,
    type: "magiclink",
  });
  if (ve || !v.session) throw new Error(ve?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  await server.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
    await ctx.addCookies(
      captured.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })),
    );
    const page = await ctx.newPage();

    await page.goto(`${baseUrl}/admin/lines/info`, { waitUntil: "networkidle" });
    await page.waitForSelector("text=등록된 라인", { timeout: 20000 });

    console.log("=== A) 설명 문구 제거 (요구사항 1) ===");
    check(
      "페이지 타이틀 '라인 정보' 유지",
      await page.getByRole("heading", { name: "라인 정보", exact: true }).isVisible(),
    );
    check(
      "상단 설명 문구 제거됨 (등록 대장 안내문 부재)",
      (await page.getByText("등록 대장(line_registrations)에 등록된 라인을 조회합니다", {
        exact: false,
      }).count()) === 0,
    );

    console.log("\n=== B) 적용 클럽 표시 — 허브×라인종류 단위 (요구사항 2~5) ===");
    // 필터 없이 전건을 가장 큰 페이지에서 보기 어려우므로, 허브 필터로 좁혀 행 단위 검증.
    // (hub, lineType, 적용 클럽 셀) 트리플을 페이지별로 수집한다.
    async function collectTriples() {
      return page.locator("tbody tr").evaluateAll((trs) =>
        trs.map((tr) => {
          const tds = tr.querySelectorAll("td");
          return {
            club: tds[1]?.textContent?.trim() ?? "",
            hub: tds[2]?.textContent?.trim() ?? "",
            lineType: tds[3]?.textContent?.trim() ?? "",
          };
        }),
      );
    }

    // info 전체 → 공통
    await page.getByLabel("허브 필터").selectOption("info");
    await page.waitForTimeout(300);
    let triples = await collectTriples();
    check(
      `실무 정보 전체(${triples.length}건) 적용 클럽 = "공통"`,
      triples.length > 0 && triples.every((t) => t.club === "공통"),
      `값: ${[...new Set(triples.map((t) => t.club))].join(", ")}`,
    );

    // competency 전체 → 공통
    await page.getByLabel("허브 필터").selectOption("competency");
    await page.waitForTimeout(300);
    triples = await collectTriples();
    check(
      `실무 역량 전체(${triples.length}건) 적용 클럽 = "공통"`,
      triples.length > 0 && triples.every((t) => t.club === "공통"),
      `값: ${[...new Set(triples.map((t) => t.club))].join(", ")}`,
    );

    // experience — 관리·확장 → 공통 (DB slug 가 org 여도), 그 외는 공통 강제 아님
    await page.getByLabel("허브 필터").selectOption("experience");
    await page.waitForTimeout(300);
    // 라인 종류 페이지네이션 없이 전건 확인 위해 라인종류 필터를 관리/확장으로 좁힘.
    await page.getByLabel("라인 종류 필터").selectOption("관리");
    await page.waitForTimeout(300);
    triples = await collectTriples();
    check(
      `실무 경험 '관리'(${triples.length}건) 적용 클럽 = "공통" (DB org 무관)`,
      triples.length > 0 && triples.every((t) => t.club === "공통"),
      `값: ${[...new Set(triples.map((t) => t.club))].join(", ")}`,
    );
    await page.getByLabel("라인 종류 필터").selectOption("확장");
    await page.waitForTimeout(300);
    triples = await collectTriples();
    check(
      `실무 경험 '확장'(${triples.length}건) 적용 클럽 = "공통" (DB org 무관)`,
      triples.length > 0 && triples.every((t) => t.club === "공통"),
      `값: ${[...new Set(triples.map((t) => t.club))].join(", ")}`,
    );

    // experience 도출 — 공통 강제 대상 아님 (common→공통, org→원문). 회귀 없는지 확인.
    await page.getByLabel("라인 종류 필터").selectOption("도출");
    await page.waitForTimeout(300);
    triples = await collectTriples();
    check(
      `실무 경험 '도출'(${triples.length}건) — 공통/encre/oranke/phalanx/'-' 중 하나 (강제 아님)`,
      triples.every((t) =>
        ["공통", "encre", "oranke", "phalanx", "-"].includes(t.club),
      ),
      `값: ${[...new Set(triples.map((t) => t.club))].join(", ")}`,
    );

    await page.getByLabel("허브 필터").selectOption("all");
    await page.getByLabel("라인 종류 필터").selectOption("all");
    await page.waitForTimeout(300);
    await page.screenshot({
      path: "claudedocs/browser-lines-info-club-display.png",
      fullPage: true,
    });
    console.log("\n스크린샷: claudedocs/browser-lines-info-club-display.png");

    await ctx.close();
  } finally {
    await browser.close();
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
