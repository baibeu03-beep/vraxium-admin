/**
 * 브라우저 DOM 검증 — 어드민 회원 주차 상세 > 액트 체크 내역, 7행 전부 Point.C 실제 사례.
 * ─────────────────────────────────────────────────────────────────────
 *   요구(실제 화면):
 *     체크 가능: 7 · 체크 성공: 0 · 체크 실패: 7
 *     행별 실패 배지: 7개 · 행별 성공 배지: 0개
 *     Point.C 값이 있는 행이 성공 배지로 표시되지 않음.
 *   값은 전부 렌더된 DOM 에서 읽는다(요약 metric 스팬 + 표 결과 셀 배지 텍스트).
 *
 *   선행: admin dev(:3000) 기동.
 *   npx tsx --env-file=.env.local scripts/browser-verify-crew-act-result.ts
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
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
}

async function makeAdminCookies() {
  const { data: admins } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("No active admin");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await anon.auth.verifyOtp({
    email, token: (link as { properties: { email_otp: string } }).properties.email_otp, type: "magiclink",
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

// 7행 전부 C>0 인 (user, week) 카드 하나 찾기(라이브 HTTP 검증과 동일 후보).
async function findRealCase(): Promise<{ userId: string; weekId: string; tag: string } | null> {
  const realUsers = [
    "35c987bf-015f-482c-b966-63fe55af0256",
    "6678e364-68ad-4aa1-a531-79f62c2c166a",
    "b303c17e-26ec-429c-804e-f0d25c3f9463",
  ];
  for (const uid of realUsers) {
    const snap = await readWeeklyCardsSnapshot(uid);
    if (snap.status !== "hit" && snap.status !== "stale") continue;
    const card = (snap.cards as Cluster4WeeklyCardDto[]).find((c) => {
      const logs = c.actLogs ?? [];
      return logs.length === 7 && logs.every((l) => Math.abs(l.pointC ?? 0) > 0) && !!c.weekId;
    });
    if (card?.weekId) return { userId: uid, weekId: card.weekId, tag: `${uid.slice(0, 8)}/${card.weekLabel ?? card.startDate}` };
  }
  return null;
}

async function main() {
  try {
    const h = await fetch(`${BASE}/api/health`);
    if (!h.ok) throw new Error("no health");
  } catch {
    console.log(`❌ dev server 미기동(${BASE})`);
    process.exit(2);
  }
  const target = await findRealCase();
  if (!target) {
    console.log("❌ 7행-전부-C 실제 사례 카드 없음 — snapshot 재생성 필요할 수 있음");
    process.exit(2);
  }
  console.log(`   target ${target.tag} (week=${target.weekId.slice(0, 8)})\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();

  await page.goto(`${BASE}/admin/members/${target.userId}/weeks/${target.weekId}?tab=acts`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(2500);

  // ── 요약 metric(DOM) — label→value 매핑 ─────────────────────────────────
  const metrics = await page.evaluate(() => {
    const out: Record<string, string> = {};
    document.querySelectorAll("[data-act-summary] span.inline-flex").forEach((el) => {
      const spans = el.querySelectorAll(":scope > span");
      if (spans.length >= 2) out[(spans[0].textContent || "").trim()] = (spans[1].textContent || "").trim();
    });
    return out;
  });
  check("DOM 체크 가능 == 7", metrics["체크 가능"] === "7", metrics["체크 가능"]);
  check("DOM 체크 성공 == 0", metrics["체크 성공"] === "0", metrics["체크 성공"]);
  check("DOM 체크 실패 == 7", metrics["체크 실패"] === "7", metrics["체크 실패"]);
  check("DOM 활동 완료율 == 0%", metrics["활동 완료율"] === "0%", metrics["활동 완료율"]);

  // ── 표 결과 셀 배지(DOM) — 각 행 2번째 td 텍스트 ────────────────────────
  const badges = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("table tbody tr")).map((r) => {
      const cells = r.querySelectorAll("td");
      return cells.length > 1 ? (cells[1].textContent || "").trim() : "";
    });
  });
  const failBadges = badges.filter((b) => b === "체크 실패").length;
  const successBadges = badges.filter((b) => b === "체크 성공").length;
  check("행별 실패 배지 7개", failBadges === 7, { failBadges, badges });
  check("행별 성공 배지 0개", successBadges === 0, { successBadges, badges });
  check("표 행 7개", badges.length === 7, badges.length);

  // ── Point.C 셀이 있는 행이 성공 배지가 아님 ─────────────────────────────
  const cViolation = await page.evaluate(() => {
    let bad = 0;
    document.querySelectorAll("table tbody tr").forEach((r) => {
      const cells = r.querySelectorAll("td");
      const result = cells.length > 1 ? (cells[1].textContent || "").trim() : "";
      // Point.C 열 = 10번째 td(체크박스0·결과1·액트명2·발생3·허브4·라인5·소요6·A7·B8·C9)
      const cText = cells.length > 9 ? (cells[9].textContent || "").trim() : "";
      const cNeg = cText.startsWith("-") && cText !== "-0"; // "-1","-12" 등 = C>0
      if (cNeg && result === "체크 성공") bad++;
    });
    return bad;
  });
  check("Point.C 보유 행이 성공 배지로 표시되지 않음", cViolation === 0, { cViolation });

  await browser.close();
  console.log(`\n결과: ${failed === 0 ? "ALL PASS" : `${failed} FAIL`}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
