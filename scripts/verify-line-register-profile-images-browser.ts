/**
 * 브라우저 E2E 검증: /admin/lines/register 프로필 사진 이미지 매핑 (2026-06-07).
 *   npx tsx --env-file=.env.local scripts/verify-line-register-profile-images-browser.ts
 * 항목:
 *   A) 드롭다운 6개 옵션 각각 선택 → 원형 미리보기 src 매핑 일치 + 실제 로드(naturalWidth>0)
 *      + object-fit:cover + rounded-full/overflow-hidden (원 밖 비어짐 방지)
 *   B) 미선택('') 복귀 → placeholder 원 유지(이미지 없음)
 *   C) career 등록 → HTTP API 재조회 manager_profile_key 확인 → 목록 행 동일 이미지 표시
 *   D) 테스트 행 정리(삭제)
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  LINE_REGISTRATION_PROFILE_KEYS,
  LINE_REGISTRATION_PROFILE_IMAGE_MAP,
} from "../lib/adminLineRegistrationsTypes";

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
  const stamp = Date.now();
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const sbAdmin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // admin 세션 쿠키 (기존 스크립트 공통 패턴)
  const admin = createClient(supabaseUrl, serviceKey);
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

  const lineCode = `PRFB-${stamp}`;
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1380, height: 1000 } });
    await ctx.addCookies(
      captured.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })),
    );
    const page = await ctx.newPage();

    await page.goto(`${baseUrl}/admin/lines/register`, { waitUntil: "networkidle" });
    await page.getByLabel("소속 허브").selectOption("career");

    console.log("=== A) 6개 옵션 각각 선택 → 미리보기 이미지/스타일 검증 ===");
    for (const key of LINE_REGISTRATION_PROFILE_KEYS) {
      const expected = LINE_REGISTRATION_PROFILE_IMAGE_MAP[key];
      await page.getByLabel("프로필 사진").selectOption(key);
      const circle = page.getByTestId("profile-preview-circle");
      await circle.waitFor({ state: "visible", timeout: 5000 });
      const img = circle.locator("img");
      const info = await img.evaluate(async (el) => {
        const i = el as HTMLImageElement;
        // 원본 PNG 가 2MB+ 라 선택 직후엔 로딩 중일 수 있음 — decode 완료까지 대기.
        try {
          await i.decode();
        } catch {
          /* onerror — loaded=false 로 판정 */
        }
        const cs = getComputedStyle(i);
        const wrap = i.parentElement!;
        const wcs = getComputedStyle(wrap);
        const ir = i.getBoundingClientRect(); // transform(scale) 반영된 사각형
        const wrb = wrap.getBoundingClientRect();
        // 이미지가 채워야 하는 영역 = 래퍼 content box (1px 테두리 안쪽).
        const wr = {
          left: wrb.left + parseFloat(wcs.borderLeftWidth),
          top: wrb.top + parseFloat(wcs.borderTopWidth),
          right: wrb.right - parseFloat(wcs.borderRightWidth),
          bottom: wrb.bottom - parseFloat(wcs.borderBottomWidth),
          width: wrb.width,
        };
        return {
          src: i.getAttribute("src"),
          loaded: i.complete && i.naturalWidth > 0,
          objectFit: cs.objectFit,
          objectPosition: cs.objectPosition,
          transform: cs.transform,
          overflow: wcs.overflow,
          radius: wcs.borderRadius,
          wrapW: wr.width,
          // 확대된 이미지가 원형 영역을 사방으로 모두 덮는지 (빈 틈 없음)
          covers:
            ir.left <= wr.left + 0.5 &&
            ir.top <= wr.top + 0.5 &&
            ir.right >= wr.right - 0.5 &&
            ir.bottom >= wr.bottom - 0.5,
        };
      });
      check(`[${key}] src=${expected.src}`, info.src === expected.src, String(info.src));
      check(`[${key}] 실제 이미지 로드(naturalWidth>0)`, info.loaded);
      check(`[${key}] object-fit:cover`, info.objectFit === "cover", info.objectFit);
      check(
        `[${key}] object-position=${expected.objectPosition}`,
        info.objectPosition === expected.objectPosition.replace("center", "50%"),
        info.objectPosition,
      );
      // computed transform 은 matrix(z, 0, 0, z, tx, ty) 형태 — scale 값 일치 확인.
      const scaleMatch = /^matrix\(([\d.]+),/.exec(info.transform);
      check(
        `[${key}] zoom(scale ${expected.zoom}) 적용`,
        Boolean(scaleMatch) && Math.abs(parseFloat(scaleMatch![1]) - expected.zoom) < 0.01,
        info.transform,
      );
      check(
        `[${key}] 원형 클리핑(overflow-hidden + rounded-full)`,
        info.overflow === "hidden" && parseFloat(info.radius) >= info.wrapW / 2 - 1,
        `overflow=${info.overflow} radius=${info.radius}`,
      );
      check(`[${key}] 확대 후에도 원형 영역 빈틈 없이 커버`, info.covers);
    }
    await page.screenshot({
      path: "claudedocs/browser-line-register-profile-preview.png",
      fullPage: true,
    });

    console.log("\n=== B) 미선택 복귀 → placeholder 원 유지 ===");
    await page.getByLabel("프로필 사진").selectOption("");
    check(
      "placeholder 원 표시",
      await page.getByTestId("profile-placeholder-circle").isVisible(),
    );
    check(
      "미리보기 이미지 없음",
      (await page.getByTestId("profile-preview-circle").count()) === 0,
    );
    check(
      "'프로필 미리보기' 라벨 복귀",
      await page.getByText("프로필 미리보기", { exact: true }).isVisible(),
    );

    console.log("\n=== C) 등록 → API 재조회 → 목록 동일 이미지 ===");
    await page.getByPlaceholder("예) 마케팅 전략 라인").fill(`프로필 이미지 라인 ${stamp}`);
    await page.getByPlaceholder("예) WCBS-NL0001").fill(lineCode);
    await page.getByPlaceholder("메인 타이틀을 입력하세요").fill("프로필 검증 타이틀");
    await page.getByLabel("프로필 사진").selectOption("미즈 마블");
    check(
      "등록 직전 미리보기 = /Ms Marvel.png",
      (await page
        .getByTestId("profile-preview-circle")
        .locator("img")
        .getAttribute("src")) === LINE_REGISTRATION_PROFILE_IMAGE_MAP["미즈 마블"].src,
    );
    await page.getByRole("button", { name: "등록", exact: true }).click();
    await page.waitForSelector("text=라인이 등록되었습니다", { timeout: 15000 });
    check("등록 성공 안내 노출", true);

    // HTTP API 재조회 — 같은 admin 세션 쿠키로 GET (manager_profile_key 확인).
    const apiJson = await page.evaluate(async () => {
      const res = await fetch("/api/admin/lines/registrations?limit=20", {
        cache: "no-store",
      });
      return res.json();
    });
    const apiRow = apiJson?.data?.rows?.find(
      (r: { lineCode: string }) => r.lineCode === lineCode,
    );
    check("API 응답에 등록건 존재", Boolean(apiRow));
    check(
      "API managerProfileKey='미즈 마블'",
      apiRow?.managerProfileKey === "미즈 마블",
      JSON.stringify(apiRow?.managerProfileKey),
    );

    // 목록 새로고침 → 저장값 기반 동일 이미지 렌더 (기존 등록 데이터 표시 경로와 동일).
    await page.getByRole("button", { name: "새로고침" }).click();
    const rowAvatar = page.getByTestId(`row-profile-${lineCode}`);
    await rowAvatar.waitFor({ state: "visible", timeout: 10000 });
    const rowInfo = await rowAvatar.locator("img").evaluate((el) => {
      const i = el as HTMLImageElement;
      return {
        src: i.getAttribute("src"),
        loaded: i.complete && i.naturalWidth > 0,
        objectFit: getComputedStyle(i).objectFit,
      };
    });
    check("목록 행 이미지 src=/Ms Marvel.png", rowInfo.src === "/Ms Marvel.png", String(rowInfo.src));
    check("목록 행 이미지 실제 로드", rowInfo.loaded);
    check("목록 행 object-fit:cover", rowInfo.objectFit === "cover", rowInfo.objectFit);
    await page.screenshot({
      path: "claudedocs/browser-line-register-profile-list.png",
      fullPage: true,
    });

    await ctx.close();
  } finally {
    await browser.close();
    // D) 테스트 행 정리
    const { error: delErr } = await sbAdmin
      .from("line_registrations")
      .delete()
      .eq("line_code", lineCode);
    check("테스트 등록건 삭제(정리)", !delErr, delErr?.message);
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
