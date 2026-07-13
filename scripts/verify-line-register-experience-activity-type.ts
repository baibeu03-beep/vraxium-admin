/**
 * 검증: /admin/lines/register 「강화 시 포인트」
 *   (1) 실무 경험 허브에서 포인트 대상 활동유형(파생, line_type→config_key)이 표시되고
 *       재조회/수정 진입 시 동일 복원되는지 (HTTP + DOM)
 *   (2) 실무 정보 기존 활동유형 select 동작 무변경
 *   (3) 「강화 시 포인트」 제목이 Point.A/B 라벨보다 시각적으로 큰지
 *   (4) 서버 SoT(deriveLineConfigKey)와 클라 SoT(experienceActivityTypeForLineType) 동치
 *
 *   dev server 필요.
 *   npx tsx --env-file=.env.local scripts/verify-line-register-experience-activity-type.ts
 */
import { pathToFileURL } from "url";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  experienceActivityTypeForLineType,
  LINE_REGISTRATION_LINE_TYPES,
} from "@/lib/adminLineRegistrationsTypes";
import { deriveLineConfigKey } from "@/lib/adminLinePointConfigsData";

const BASE = "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;
let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

async function cookies_() {
  const { data: adm } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (adm?.[0] as any)?.email;
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const sv = createServerClient(u, a, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it.map(({ name, value }: any) => ({ name, value }))) } });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c: any) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

// ── Part 0: SoT 동치 (서버 deriveLineConfigKey == 클라 파생 헬퍼) ──
function assertSoTEquivalence() {
  for (const lt of LINE_REGISTRATION_LINE_TYPES.experience) {
    const clientKey = experienceActivityTypeForLineType(lt)?.configKey ?? null;
    const serverKey =
      deriveLineConfigKey({ hub: "experience", lineType: lt, lineCode: "X" })?.configKey ?? null;
    ck(`SoT 동치 experience line_type="${lt}" → config_key`, clientKey === serverKey && !!clientKey, { clientKey, serverKey });
  }
  // 평가 → research(견문) 매핑 명시 확인.
  ck('평가 → 견문(research)', experienceActivityTypeForLineType("평가")?.label === "견문" && experienceActivityTypeForLineType("평가")?.configKey === "research");
}

async function main() {
  assertSoTEquivalence();

  const cookies = await cookies_();
  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 2000 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.on("dialog", async (d: any) => { await d.dismiss(); });

  const resp = await page.goto(`${BASE}/admin/lines/register`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(2000);
  ck("/admin/lines/register 200", resp?.status() === 200, { status: resp?.status() });

  // ── Part 1: 실무 경험 → 활동유형 파생 표시 ──
  await page.selectOption('select[aria-label="소속 허브"]', "experience");
  await page.waitForTimeout(300);
  ck("experience: 활동유형 표시 노출", !!(await page.$("[data-point-activity-type]")));
  // 실무 경험은 편집형 select 가 아니라 파생 표시(옵션 없음).
  ck("experience: 활동유형은 select 아님(파생 표시)", (await page.$$("[data-point-activity-type] option")).length === 0);

  for (const [lineType, expectKey, expectLabel] of [
    ["도출", "derive", "도출"],
    ["분석", "analysis", "분석"],
    ["평가", "research", "견문"],
    ["관리", "management", "관리"],
    ["확장", "expansion", "확장"],
  ] as const) {
    await page.selectOption('select[aria-label="라인 종류"]', lineType);
    await page.waitForTimeout(120);
    const key = await page.$eval("[data-point-activity-type]", (el: any) => el.getAttribute("data-experience-config-key"));
    const text = (await page.$eval("[data-point-activity-type]", (el: any) => el.textContent))?.trim();
    ck(`experience line_type="${lineType}" → "${expectLabel} (${expectKey})"`, key === expectKey && text === `${expectLabel} (${expectKey})`, { key, text });
  }

  // ── Part 2: 실무 정보 기존 동작 무변경(편집형 select + activity_types.id 옵션) ──
  await page.selectOption('select[aria-label="소속 허브"]', "info");
  await page.waitForTimeout(300);
  const infoIsSelect = await page.$eval("[data-point-activity-type]", (el: any) => el.tagName.toLowerCase());
  ck("info: 활동유형은 편집형 select 유지", infoIsSelect === "select");
  const atOpts = await page.$$eval("[data-point-activity-type] option", (els: any[]) => els.map((e) => e.value));
  ck("info: 활동유형 = activity_types.id(wisdom/essay/etc_a)", atOpts.includes("wisdom") && atOpts.includes("essay") && atOpts.includes("etc_a"), { atOpts });

  // ── Part 3: career 에는 활동유형 표시 없음 ──
  await page.selectOption('select[aria-label="소속 허브"]', "career");
  await page.waitForTimeout(300);
  ck("career: 활동유형 항목 없음", !(await page.$("[data-point-activity-type]")));

  // ── Part 4: 제목 크기 > Point.A/B 라벨 크기 ──
  await page.selectOption('select[aria-label="소속 허브"]', "experience");
  await page.waitForTimeout(200);
  const titleFs = await page.evaluate(() => {
    const h3 = Array.from(document.querySelectorAll("h3")).find((e) => e.textContent?.trim() === "강화 시 포인트");
    return h3 ? parseFloat(getComputedStyle(h3).fontSize) : null;
  });
  const pointLabelFs = await page.evaluate(() => {
    const lbl = Array.from(document.querySelectorAll("label")).find((e) => e.textContent?.trim().startsWith("Point.A"));
    return lbl ? parseFloat(getComputedStyle(lbl).fontSize) : null;
  });
  ck("제목 '강화 시 포인트' > Point.A 라벨 크기", !!titleFs && !!pointLabelFs && titleFs > pointLabelFs, { titleFs, pointLabelFs });

  await page.screenshot({ path: "claudedocs/qa-line-register-exp-activity-type.png", fullPage: false });

  // ── Part 5: HTTP 등록 DTO 포함 + 재조회 복원 (points 미설정 → 공유 config 무접촉) ──
  const lineCode = `EXVERIFY-NR${String(process.pid).slice(-4).padStart(4, "0")}`;
  const orgsToTry = ["phalanx", "encre", "oranke", null] as const;
  let createdId: string | null = null;
  let usedOrg: string | null = null;
  for (const org of orgsToTry) {
    const r = await page.request.post(`${BASE}/api/admin/lines/registrations`, {
      data: {
        line_name: "검증-경험-활동유형",
        hub: "experience",
        line_type: "평가", // → research(견문)
        line_code: lineCode,
        main_title_mode: "fixed",
        main_title: "검증 타이틀",
        organization_slug: org,
        // point_a/point_b 미설정 → 서버가 config upsert 스킵(공유 SoT 무접촉).
      },
      headers: { "Content-Type": "application/json" },
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok() && j?.success) {
      createdId = j.data.id;
      usedOrg = org;
      ck("POST experience DTO 등록 성공(line_type 포함)", j.data.lineType === "평가" && j.data.hub === "experience", { lineType: j.data.lineType, org });
      // points 미설정 → pointConfig 미저장(공유 config 무접촉).
      ck("points 미설정 → 공유 config 무접촉(pointConfig.saved!=true)", j.pointConfig?.saved !== true, { pointConfig: j.pointConfig });
      break;
    }
  }
  ck("등록 API 접근 성공(허용 org)", !!createdId, { usedOrg });

  if (createdId) {
    // 재조회(수정 진입 프리필 원천) — line_type 복원 → 파생 활동유형 동일.
    const g = await page.request.get(`${BASE}/api/admin/lines/registrations/${createdId}`);
    const gj = await g.json().catch(() => ({}));
    const restoredType = gj?.data?.lineType;
    ck("재조회 시 line_type 복원", restoredType === "평가", { restoredType });
    ck("복원값 → 파생 활동유형 동일(견문/research)", experienceActivityTypeForLineType(restoredType ?? "")?.configKey === "research");
    ck("experience DTO.pointActivityTypeId=null(별도 저장 없음)", gj?.data?.pointActivityTypeId === null, { v: gj?.data?.pointActivityTypeId });

    // 정리 — 생성한 검증 라인 삭제(line_registrations 만, bridge/snapshot 무관).
    const { error: delErr } = await supabaseAdmin.from("line_registrations").delete().eq("id", createdId);
    ck("검증 라인 정리(delete) 성공", !delErr, delErr?.message);
  }

  await browser.close();
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
