/**
 * graduating 자동 계산 — 어드민 Cluster3 화면 브라우저 검증 (read-only).
 *   1) T안건우(DB=graduating, a=17, oranke 900087): Process 카드 상태 ≠ "졸업 절차 중", = "성장 중"
 *   2) T윤도현(graduated, encre 900038): Process 카드 상태 = "성장 완료(졸업)" (override 불변)
 * 사전조건: admin dev :3000. 인증=magiclink OTP 쿠키(verify-sidebar-logout-browser.ts 패턴).
 * Usage: npx tsx --env-file=.env.local scripts/verify-graduating-auto-browser.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const adminBase = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function makeAdminCookies(): Promise<Array<{ name: string; value: string }>> {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (linkError || !linkData?.properties?.email_otp)
    throw new Error(linkError?.message ?? "generateLink failed");
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session)
    throw new Error(verifyError?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        void captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  const { error } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (error) throw new Error(error.message);
  return captured;
}

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const browser = await chromium.launch({ channel: "chromium" });

  const CASES: Array<[string, string, string, string[]]> = [
    // [라벨, URL, 기대 상태 표기, 금지 표기]
    // 테스터 legacy id 는 cluster3 번들 API 에서 uuid 캐스팅 오류를 내므로 UUID 로 접근
    // (resolveGrowthUserId 가 UUID/legacy 둘 다 허용 — 기존 동작).
    [
      "T안건우(DB=graduating, a=17)",
      `${adminBase}/admin/crews/oranke/ff6adaf8-8993-4b5b-b5ea-a4fa1036cdee/cluster3`,
      "성장 중",
      ["졸업 절차 중"],
    ],
    [
      "T윤도현(graduated)",
      `${adminBase}/admin/crews/encre/bf3b4305-751a-49e3-88ad-95a20e5c4dad/cluster3`,
      "성장 완료(졸업)",
      ["졸업 절차 중"],
    ],
  ];

  for (const [label, url, expect, banned] of CASES) {
    // 세션 토큰 회전으로 두 번째 페이지가 /login 으로 튕기는 문제 → 케이스별 신규 세션.
    const cookies = await makeAdminCookies();
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1400 } });
    await ctx.addCookies(
      cookies.map((c) => ({ ...c, domain: "localhost", path: "/" })),
    );
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    // Process 카드의 상태 셀: "상태" 라벨 바로 다음 줄이 성장 상태 10종 라벨 중 하나인 곳.
    const GROWTH_LABELS = [
      "성장 완료(졸업)", "성장 중단", "성장 유보", "졸업 절차 중", "시즌 휴식 중",
      "휴식(개인) 중", "휴식(공식) 중", "클럽 온보딩 중", "추가 성장 중", "성장 중",
    ];
    let body = "";
    let statusValue: string | null = null;
    let statusKey: string | null = null;
    for (let i = 0; i < 40; i++) {
      try {
        body = await page.evaluate(() => document.body.innerText);
        const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
        for (let j = 0; j < lines.length - 1; j++) {
          if (lines[j] === "상태" && GROWTH_LABELS.includes(lines[j + 1])) {
            statusValue = lines[j + 1];
            statusKey = lines[j + 2] ?? null;
            break;
          }
        }
        if (statusValue) break;
      } catch {
        // 리다이렉트/내비게이션 중 — 다음 폴링에서 재시도
      }
      await page.waitForTimeout(1500);
    }
    console.log(`[${label}] ${url} → 최종 URL: ${page.url()}`);
    console.log(`    상태 셀: ${statusValue ?? "(미발견)"} / key=${statusKey ?? "-"}`);
    check(`${label}: 상태="${expect}" 표시`, statusValue === expect, `실제=${statusValue} (${statusKey})`);
    for (const b of banned) {
      check(`${label}: "${b}" 미노출`, !body.includes(b), "");
    }
    const slug = label.includes("안건우") ? "ahn" : "yoon";
    await page.screenshot({
      path: `claudedocs/browser-graduating-auto-${slug}.png`,
      fullPage: false,
    });
    await page.close();
    await ctx.close();
  }

  await browser.close();
  console.log(`\n결과: ${failures === 0 ? "전부 통과" : `실패 ${failures}건`}`);
  process.exit(failures ? 1 : 0);
}

void main();
