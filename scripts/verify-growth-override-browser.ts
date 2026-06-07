/**
 * growth_status 자동/오버라이드 분리 — 어드민 Cluster3 화면 브라우저 검증 (read-only).
 *   1) T조하은(override=paused, auto=active): 3셀(최종/자동/오버라이드) + ⚠ 경고 노출
 *   2) T윤도현(override=graduated, auto=official_rest): 경고 미노출(예외) + graduated 표시
 *   3) T안건우(legacy graduating): 최종=성장 중, 오버라이드="-"
 * 사전조건: admin dev :3000.
 * Usage: npx tsx --env-file=.env.local scripts/verify-growth-override-browser.ts
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

type Case = {
  label: string;
  slug: string;
  url: string;
  expectFinal: string;
  expectAuto: string | null; // null = 검사 생략
  expectOverride: string; // 셀 텍스트 ("-" 포함)
  expectWarn: boolean;
};

async function main() {
  const browser = await chromium.launch({ channel: "chromium" });

  const CASES: Case[] = [
    {
      label: "T조하은(override=paused)",
      slug: "cho",
      url: `${adminBase}/admin/crews/oranke/cc05522b-7a71-48fb-a291-3aaaefdf4865/cluster3`,
      expectFinal: "성장 유보",
      expectAuto: "성장 중",
      expectOverride: "paused",
      expectWarn: true,
    },
    {
      label: "T윤도현(override=graduated, auto=official_rest)",
      slug: "yoon",
      url: `${adminBase}/admin/crews/encre/bf3b4305-751a-49e3-88ad-95a20e5c4dad/cluster3`,
      expectFinal: "성장 완료(졸업)",
      expectAuto: null, // 주차 경계에 따라 official_rest/active 변동 가능 — 경고 미노출만 확정 검사
      expectOverride: "graduated",
      expectWarn: false,
    },
    {
      label: "T안건우(legacy graduating)",
      slug: "ahn",
      url: `${adminBase}/admin/crews/oranke/ff6adaf8-8993-4b5b-b5ea-a4fa1036cdee/cluster3`,
      expectFinal: "성장 중",
      expectAuto: "성장 중",
      expectOverride: "-",
      expectWarn: false,
    },
  ];

  for (const c of CASES) {
    const cookies = await makeAdminCookies();
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1400 } });
    await ctx.addCookies(cookies.map((k) => ({ ...k, domain: "localhost", path: "/" })));
    const page = await ctx.newPage();
    await page.goto(c.url, { waitUntil: "domcontentloaded", timeout: 90000 });

    let body = "";
    let final: string | null = null;
    let auto: string | null = null;
    let override: string | null = null;
    for (let i = 0; i < 40; i++) {
      try {
        body = await page.evaluate(() => document.body.innerText);
        const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
        const at = (label: string) => {
          const idx = lines.findIndex((l) => l === label);
          return idx >= 0 ? (lines[idx + 1] ?? null) : null;
        };
        final = at("상태(최종)");
        auto = at("자동 계산");
        override = at("오버라이드");
        if (final && auto && override) break;
      } catch {
        // 내비게이션 중 — 재시도
      }
      await page.waitForTimeout(1500);
    }
    const warnShown = body.includes("수동 오버라이드(");
    console.log(`[${c.label}] 최종=${final} / 자동=${auto} / 오버라이드=${override} / 경고=${warnShown}`);
    check(`${c.label}: 상태(최종)="${c.expectFinal}"`, final === c.expectFinal, `실제=${final}`);
    if (c.expectAuto !== null) {
      check(`${c.label}: 자동 계산="${c.expectAuto}"`, auto === c.expectAuto, `실제=${auto}`);
    }
    check(`${c.label}: 오버라이드="${c.expectOverride}"`, override === c.expectOverride, `실제=${override}`);
    check(`${c.label}: 경고 ${c.expectWarn ? "노출" : "미노출"}`, warnShown === c.expectWarn, "");
    await page.screenshot({ path: `claudedocs/browser-growth-override-${c.slug}.png`, fullPage: false });
    await page.close();
    await ctx.close();
  }

  await browser.close();
  console.log(`\n결과: ${failures === 0 ? "전부 통과" : `실패 ${failures}건`}`);
  process.exit(failures ? 1 : 0);
}
void main();
