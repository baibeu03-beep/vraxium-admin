/**
 * /admin HOME 진입 버튼 그리드 검증.
 *   1) HOME 에 8개 버튼 (데스크톱 2행 4열 = grid-cols-4)
 *   2) HOME 사이드바 메뉴 잠금 유지
 *   3) 통합 검수 시스템 클릭 → /admin/members + 사이드바 정상 (전체 메뉴 노출)
 *   4) 엥크레 클릭 → /admin/crews/encre + 사이드바 정상 + 멤버 관리 메뉴 Encre 만
 *      (전체 멤버/Oranke/Phalanx 숨김)
 *   5) 스쿼드 클릭 → 이동 없음 + "프로세스가 DB화 되지 않았습니다." 토스트
 *   사전조건: admin dev :3000.
 *   npx tsx scripts/verify-admin-home-launch-grid.ts
 * READ-ONLY. 스크린샷은 claudedocs/.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { chromium } from "@playwright/test";
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
        void captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  const { error } = await server.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
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
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    await ctx.addCookies(
      cookies.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })),
    );
    const page = await ctx.newPage();

    const gotoHome = async () => {
      await page.goto(`${adminBase}/admin`, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2500);
    };

    // 1) 8개 버튼 + 2행 4열
    {
      console.log("\n[1] HOME 진입 버튼 그리드");
      await gotoHome();
      const grid = await page.evaluate(() => {
        const section = document.querySelector('section[aria-label="시스템 진입"]');
        const cells = [...(section?.querySelectorAll("a, button") ?? [])].map((el) => ({
          tag: el.tagName,
          text: el.textContent?.trim(),
          href: el.getAttribute("href"),
        }));
        const gridEl = section?.querySelector(".grid");
        const cols = gridEl
          ? getComputedStyle(gridEl).gridTemplateColumns.split(" ").length
          : 0;
        return { cells, cols };
      });
      check("버튼 8개", grid.cells.length === 8, `${grid.cells.length}개`);
      check("데스크톱 4열(=2행 4열)", grid.cols === 4, `${grid.cols}열`);
      const expect: Array<[string, string | null]> = [
        ["통합 검수 시스템", "/admin/members"],
        ["엥크레", "/admin/crews/encre"],
        ["오랑캐", "/admin/crews/oranke"],
        ["팔랑크스", "/admin/crews/phalanx"],
        ["스쿼드", null],
        ["디오니소스", null],
        ["A-Q", null],
        ["코쿤탁", null],
      ];
      for (const [label, href] of expect) {
        const cell = grid.cells.find((c) => c.text === label);
        check(
          `"${label}" → ${href ?? "(이동 없음)"}`,
          !!cell && (cell.href ?? null) === href,
          JSON.stringify(cell ?? null),
        );
      }
      await page.screenshot({ path: "claudedocs/home-launch-grid.png", fullPage: true });
    }

    // 2) HOME 사이드바 잠금 유지
    {
      console.log("\n[2] HOME 사이드바 잠금 유지");
      const locked = await page.evaluate(() => {
        const aside = document.querySelector("aside");
        const links = [...(aside?.querySelectorAll("nav a") ?? [])];
        const buttons = [...(aside?.querySelectorAll("nav button") ?? [])];
        return (
          links.every((a) => getComputedStyle(a).pointerEvents === "none") &&
          buttons.every((b) => (b as HTMLButtonElement).disabled)
        );
      });
      check("nav 링크/버튼 전부 잠김", locked);
    }

    // 3) 통합 검수 시스템 → /admin/members, 전체 메뉴 정상
    {
      console.log("\n[3] 통합 검수 시스템 클릭");
      await page.locator('section[aria-label="시스템 진입"] a', { hasText: "통합 검수 시스템" }).click();
      await page.waitForTimeout(3000);
      check("이동: /admin/members", page.url().endsWith("/admin/members"), page.url());
      const nav = await page.evaluate(() => {
        const aside = document.querySelector("aside");
        const links = [...(aside?.querySelectorAll("nav a") ?? [])];
        const btn = aside?.querySelector("nav button") as HTMLButtonElement | null;
        const texts = links.map((a) => a.textContent?.trim());
        return {
          unlocked:
            links.every((a) => getComputedStyle(a).pointerEvents !== "none") &&
            btn?.disabled === false,
          texts,
        };
      });
      check("사이드바 정상 동작(잠금 해제)", nav.unlocked);
      check(
        "멤버 관리 전체 메뉴 노출(전체 멤버+Encre+Oranke+Phalanx)",
        ["전체 멤버", "Encre", "Oranke", "Phalanx"].every((t) => nav.texts.includes(t)),
        JSON.stringify(nav.texts),
      );
    }

    // 4) 엥크레 → /admin/crews/encre, 멤버 관리 메뉴 Encre 만
    {
      console.log("\n[4] 엥크레 클릭 (조직 모드)");
      await gotoHome();
      await page.locator('section[aria-label="시스템 진입"] a', { hasText: "엥크레" }).click();
      await page.waitForTimeout(3000);
      check("이동: /admin/crews/encre", page.url().endsWith("/admin/crews/encre"), page.url());
      const nav = await page.evaluate(() => {
        const aside = document.querySelector("aside");
        const links = [...(aside?.querySelectorAll("nav a") ?? [])];
        const btn = aside?.querySelector("nav button") as HTMLButtonElement | null;
        const texts = links.map((a) => a.textContent?.trim());
        return {
          unlocked:
            links.every((a) => getComputedStyle(a).pointerEvents !== "none") &&
            btn?.disabled === false,
          texts,
        };
      });
      check("사이드바 정상 동작(잠금 해제)", nav.unlocked);
      check("Encre 링크 노출", nav.texts.includes("Encre"), JSON.stringify(nav.texts));
      check(
        "전체 멤버/Oranke/Phalanx 숨김",
        ["전체 멤버", "Oranke", "Phalanx"].every((t) => !nav.texts.includes(t)),
        JSON.stringify(nav.texts),
      );
      await page.screenshot({ path: "claudedocs/home-launch-encre-mode.png" });
      // 오랑캐/팔랑크스도 동일 패턴 — URL 만 빠르게 확인
      for (const [label, slug] of [
        ["오랑캐", "oranke"],
        ["팔랑크스", "phalanx"],
      ] as const) {
        await gotoHome();
        await page.locator('section[aria-label="시스템 진입"] a', { hasText: label }).click();
        await page.waitForTimeout(2500);
        const hidden = await page.evaluate(
          (other) => {
            const texts = [...document.querySelectorAll("aside nav a")].map((a) =>
              a.textContent?.trim(),
            );
            return other.every((t: string) => !texts.includes(t)) === true;
          },
          ["전체 멤버", ...["Encre", "Oranke", "Phalanx"].filter(
            (t) => t.toLowerCase() !== slug,
          )],
        );
        check(`"${label}" → /admin/crews/${slug} + 타 조직 숨김`,
          page.url().endsWith(`/admin/crews/${slug}`) && hidden, page.url());
      }
    }

    // 5) 스쿼드 클릭 → 이동 없음 + 토스트
    {
      console.log("\n[5] 미구축 버튼(스쿼드) 클릭");
      await gotoHome();
      const before = page.url();
      await page.locator('section[aria-label="시스템 진입"] button', { hasText: "스쿼드" }).click();
      await page.waitForTimeout(800);
      const toast = await page.evaluate(
        () => document.querySelector('[role="status"]')?.textContent?.trim() ?? "",
      );
      check("이동 없음", page.url() === before, page.url());
      check(
        '토스트 "프로세스가 DB화 되지 않았습니다."',
        toast === "프로세스가 DB화 되지 않았습니다.",
        `"${toast}"`,
      );
      await page.screenshot({ path: "claudedocs/home-launch-toast.png" });
    }

    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(`\n${failures === 0 ? "✓ 전체 통과" : `✗ 실패 ${failures}건`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
