/**
 * 브라우저 DOM 검증 — 어드민 회원 주차 상세 "액트 체크 내역"·"라인 강화 내역" 정렬(playwright-core).
 *   1) 액트 기본 진입: 발생 시점 컬럼이 오름차순(비감소)
 *   2) 헤더 클릭 3단계: 없음(none) → 오름차순(ascending) → 내림차순(descending) → 없음(기본 복귀)
 *   3) 정렬 헤더가 <button> + aria-sort(접근성) 로 구현
 *   4) 라인 탭: 허브 그룹 4개(정보→경험→역량→경력) 순서 + 정렬 헤더 aria-sort 존재
 *   5) 콘솔/네트워크 오류 없음
 *
 *   선행: npm run dev (:3000)
 *   npx tsx --env-file=.env.local scripts/browser-verify-detail-log-sort.ts
 */
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
function check(n: string, ok: boolean, d?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${n}${!ok && d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
}

async function makeAdminCookies() {
  const { data: admins } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("No active admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await anon.auth.verifyOtp({
    email,
    token: (link as { properties: { email_otp: string } }).properties.email_otp,
    type: "magiclink",
  });
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  const sess = (v as { session: { access_token: string; refresh_token: string } }).session;
  await server.auth.setSession({ access_token: sess.access_token, refresh_token: sess.refresh_token });
  return captured.map(({ name, value }) => ({
    name, value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" as const,
  }));
}

// 발생 시점 표시 문자열("2026.07.15 15:22") → 비교 가능한 정렬키(자릿수만 추출). "-" 는 최댓값(최하단).
function timeKey(text: string): string {
  const t = (text || "").trim();
  if (!t || t === "-") return "￿"; // 최하단
  return t.replace(/[^0-9]/g, "");
}

async function pickUserWeek(): Promise<{ userId: string; weekId: string } | null> {
  const { data: aw } = await supabaseAdmin
    .from("process_point_awards")
    .select("user_id")
    .in("source", ["regular", "irregular"]);
  const counts = new Map<string, number>();
  for (const r of (aw ?? []) as { user_id: string }[]) counts.set(r.user_id, (counts.get(r.user_id) ?? 0) + 1);
  const busiest = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id).slice(0, 12);
  for (const uid of busiest) {
    const snap = await readWeeklyCardsSnapshot(uid);
    if (snap.status !== "hit" && snap.status !== "stale") continue;
    const card = (snap.cards as Cluster4WeeklyCardDto[]).find((c) => c.weekId && (c.actLogs?.length ?? 0) >= 2);
    if (card?.weekId) return { userId: uid, weekId: card.weekId };
  }
  return null;
}

async function main() {
  try {
    const h = await fetch(`${BASE}/api/health`);
    if (!h.ok) throw new Error("no health");
  } catch {
    console.log(`❌ dev server 미기동(${BASE}). npm run dev 후 재실행.`);
    process.exit(2);
  }

  const target = await pickUserWeek();
  if (!target) {
    console.log("❌ 액트 2건 이상 보유 사용자/주차를 찾지 못했습니다.");
    process.exit(2);
  }
  console.log(`▶ 대상 ${target.userId.slice(0, 8)} / week ${target.weekId}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  await page.goto(`${BASE}/admin/members/${target.userId}/weeks/${target.weekId}`, { waitUntil: "networkidle" });

  // ── 액트 탭(기본) ──
  const occHeader = page.getByRole("button", { name: /발생 시점 기준 정렬/ }).first();
  await occHeader.waitFor({ state: "visible", timeout: 15000 });

  // 정렬 헤더 = 버튼 + th[aria-sort] (접근성)
  const occTh = page.locator('th:has(button[aria-label*="발생 시점 기준 정렬"])').first();
  check("액트 '발생 시점' 헤더가 button + aria-sort 로 구현", (await occTh.getAttribute("aria-sort")) === "none");

  // 발생 시점 컬럼 값을 브라우저 DOM 에서 읽는다("발생 시점" 헤더를 가진 table 의 해당 열).
  const readOccCol = async (): Promise<string[]> =>
    page.evaluate(() => {
      const th = [...document.querySelectorAll("th")].find((e) => e.textContent?.includes("발생 시점"));
      const table = th?.closest("table");
      if (!th || !table) return [];
      const idx = [...th.parentElement!.children].indexOf(th);
      return [...table.querySelectorAll("tbody tr")].map(
        (tr) => (tr.children[idx]?.textContent ?? "").trim(),
      );
    });

  const isNonDecreasing = (arr: string[]) => {
    const keys = arr.map(timeKey);
    for (let i = 1; i < keys.length; i++) if (keys[i - 1] > keys[i]) return false;
    return true;
  };

  const defaultCol = await readOccCol();
  check("액트 기본 진입: 발생 시점 오름차순(비감소)", defaultCol.length >= 2 && isNonDecreasing(defaultCol), defaultCol.slice(0, 6));

  // 3단계 클릭: none → asc → desc → none
  await occHeader.click();
  await page.waitForTimeout(150);
  check("클릭1: aria-sort=ascending", (await occTh.getAttribute("aria-sort")) === "ascending");
  const ascCol = await readOccCol();
  check("클릭1: 오름차순 정렬 반영", isNonDecreasing(ascCol));

  await occHeader.click();
  await page.waitForTimeout(150);
  check("클릭2: aria-sort=descending", (await occTh.getAttribute("aria-sort")) === "descending");
  const descCol = await readOccCol();
  check("클릭2: 내림차순 정렬 반영(asc 의 역순)", JSON.stringify(descCol) === JSON.stringify([...ascCol].reverse()));

  await occHeader.click();
  await page.waitForTimeout(150);
  check("클릭3: aria-sort=none(기본 복귀)", (await occTh.getAttribute("aria-sort")) === "none");
  const resetCol = await readOccCol();
  check("클릭3: 기본 정렬로 복귀", JSON.stringify(resetCol) === JSON.stringify(defaultCol));

  // 키보드 접근성 — 헤더 버튼 포커스 후 Enter 로 정렬 토글.
  await occHeader.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  check("키보드 Enter 로 정렬 가능(asc)", (await occTh.getAttribute("aria-sort")) === "ascending");

  // ── 라인 탭 ── (탭 = 일반 button, role=tab 아님)
  const linesResp = page.waitForResponse((r) => r.url().includes("/lines") && r.status() === 200, { timeout: 15000 }).catch(() => null);
  await page.getByRole("button", { name: "라인 강화 내역" }).first().click();
  await linesResp;
  await page.waitForTimeout(800);
  // 허브 그룹 헤더 순서(정보 → 경험 → 역량 → 경력) — 표시 순서=공식 허브 순서.
  const hubOrder = await page.evaluate(() => {
    const labels = ["실무 정보", "실무 경험", "실무 역량", "실무 경력"];
    const seen: string[] = [];
    for (const el of [...document.querySelectorAll("section")]) {
      const txt = el.textContent ?? "";
      for (const l of labels) if (txt.includes(l) && !seen.includes(l)) seen.push(l);
    }
    return seen;
  });
  check("라인 허브 그룹 표시 순서 = 공식 허브 순서", JSON.stringify(hubOrder) === JSON.stringify(["실무 정보", "실무 경험", "실무 역량", "실무 경력"]), hubOrder);
  // 라인 표에 정렬 헤더(aria-sort) 존재.
  const lineSortableCount = await page.locator('th[aria-sort] button[aria-label*="기준 정렬"]').count();
  check("라인 표 정렬 헤더(aria-sort + button) 존재", lineSortableCount > 0, { count: lineSortableCount });

  check("콘솔 오류 없음", consoleErrors.length === 0, consoleErrors.slice(0, 3));

  await browser.close();
  console.log(`\n═══ 결과: ${failed === 0 ? "PASS" : `FAIL ${failed}`} ═══`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
