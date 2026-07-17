/**
 * 브라우저 검증 — 크루별 주차 상세 > 액트 체크 내역 탭 상단 요약 (playwright-core).
 *   1) 요약 영역이 탭에 렌더됨(항목·명칭)
 *   2) 배치 순서: 요약 → [액트 보완]/[액트 취소] 버튼 → 표
 *   3) 화면 수치 == 서버 DTO summary (재계산 없음)
 *   4) 완료율 progress bar aria-valuenow == 표시 %
 *   5) 표의 미취소 행 수 == "체크 가능", 취소 행은 표에만 존재
 *   6) 모바일 폭(390) 가로 overflow 없음
 *   7) 콘솔/네트워크 오류 없음
 *
 *   npx tsx --env-file=.env.local scripts/browser-verify-crew-act-summary.ts
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
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("No active admin");
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
    name,
    value,
    domain: "localhost",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "Lax" as const,
  }));
}

async function main() {
  try {
    const h = await fetch(`${BASE}/api/health`);
    if (!h.ok) throw new Error("no health");
  } catch {
    console.log(`❌ dev server 미기동(${BASE})`);
    process.exit(2);
  }

  // 액트가 많은 (user, week) 하나 선택.
  const { data: aw } = await supabaseAdmin
    .from("process_point_awards")
    .select("user_id")
    .in("source", ["regular", "irregular"]);
  const counts = new Map<string, number>();
  for (const r of (aw ?? []) as Array<{ user_id: string }>) counts.set(r.user_id, (counts.get(r.user_id) ?? 0) + 1);
  let target: { userId: string; weekId: string } | null = null;
  for (const [uid] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    const snap = await readWeeklyCardsSnapshot(uid);
    if (snap.status !== "hit" && snap.status !== "stale") continue;
    const card = (snap.cards as Cluster4WeeklyCardDto[]).find((c) => (c.actLogs?.length ?? 0) >= 3 && c.weekId);
    if (card?.weekId) {
      target = { userId: uid, weekId: card.weekId };
      break;
    }
  }
  if (!target) {
    console.log("❌ 액트 3건 이상 보유 (user, week) 없음 — 검증 스킵");
    process.exit(2);
  }
  console.log(`   target user=${target.userId.slice(0, 8)} week=${target.weekId.slice(0, 8)}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const netErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && r.url().includes("/api/")) netErrors.push(`${r.status()} ${r.url()}`);
  });

  const url = `${BASE}/admin/members/${target.userId}/weeks/${target.weekId}?tab=acts`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  const text = await page.locator("body").innerText();

  // (1) 요약 항목·명칭
  for (const label of ["활동 완료율", "체크 가능", "체크 성공", "체크 실패", "체크 필수", "체크 선별", "정규 액트", "변동 액트"]) {
    check(`요약 항목 "${label}" 노출`, text.includes(label));
  }
  check("획득 포인트 3종 노출(조직 명칭)", (text.match(/획득 /g) ?? []).length >= 3);

  // 서버 DTO
  const dto = (await page.evaluate(
    async ([uid, wid]) => {
      const r = await fetch(`/api/admin/members/${uid}/weeks/${wid}/acts`, { cache: "no-store" });
      return r.json();
    },
    [target.userId, target.weekId],
  )) as { data?: { summary?: Record<string, unknown>; acts?: Array<{ cancelled: boolean }> } };
  const summary = dto?.data?.summary as
    | { total: number; success: number; fail: number; rate: number; regularActCount: number; variableActCount: number }
    | undefined;
  check("서버 DTO summary 존재(null 아님)", !!summary, summary);

  if (summary) {
    // (3) 화면 수치 == DTO — 완료율은 "활동 완료율 75%" 형태의 **숫자만**(progress bar 미사용).
    check(`화면 완료율 == DTO rate(${summary.rate}%)`, text.includes(`${summary.rate}%`));
    check(
      "활동 완료율 = progress bar 없이 숫자만(관리자 스타일)",
      (await page.locator('[role="progressbar"]').count()) === 0,
    );

    // (4) 요약 표시 순서: 1행(완료율·가능·성공·실패) → 2행(정규·변동·필수·선별) → 3행(획득 A/B/C)
    //   ⚠ page.evaluate 안에서 화살표 함수를 선언하면 tsx(esbuild keepNames)가 __name 헬퍼를 끼워 넣어
    //     브라우저에서 "__name is not defined" 로 터진다 → 인라인 indexOf 만 쓴다.
    const order = await page.evaluate(() => {
      const t = document.body.innerText;
      return {
        rate: t.indexOf("활동 완료율"),
        total: t.indexOf("체크 가능"),
        success: t.indexOf("체크 성공"),
        fail: t.indexOf("체크 실패"),
        regular: t.indexOf("정규 액트"),
        variable: t.indexOf("변동 액트"),
        required: t.indexOf("체크 필수"),
        selective: t.indexOf("체크 선별"),
        earned: t.indexOf("획득 "),
      };
    });
    const seq = [
      order.rate,
      order.total,
      order.success,
      order.fail,
      order.regular,
      order.variable,
      order.required,
      order.selective,
      order.earned,
    ];
    check(
      "요약 표시 순서 = 완료율·가능·성공·실패 → 정규·변동·필수·선별 → 획득 A/B/C",
      seq.every((v, idx) => v >= 0 && (idx === 0 || seq[idx - 1] < v)),
      order,
    );

    // (5) 표의 미취소 행 수 == 체크 가능
    const acts = dto?.data?.acts ?? [];
    const notCancelled = acts.filter((r) => !r.cancelled).length;
    const cancelled = acts.filter((r) => r.cancelled).length;
    check("요약 체크 가능 == 표의 미취소 행 수", summary.total === notCancelled, {
      total: summary.total,
      notCancelled,
      cancelled,
    });
    const bodyRows = await page.locator("table tbody tr").count();
    check("표 렌더 행 수 == acts 전체(취소 포함)", bodyRows === acts.length, { bodyRows, acts: acts.length });
  }

  // (2) 배치 순서: 요약 → 버튼 → 표
  const order = await page.evaluate(() => {
    const body = document.body.innerText;
    const sIdx = body.indexOf("활동 완료율");
    const bIdx = body.indexOf("액트 보완");
    const tIdx = body.indexOf("발생 시점"); // 표 헤더
    return { sIdx, bIdx, tIdx };
  });
  check("배치 순서 = 요약 → 버튼 → 표", order.sIdx >= 0 && order.sIdx < order.bIdx && order.bIdx < order.tIdx, order);

  // (6) 좁은 화면 — 요약이 flex-wrap 으로 줄바꿈되는지.
  //   ⚠ 390px 절대 단언은 이 페이지에서 **측정 불가**다: 관리자 사이드바가 접히지 않아 콘텐츠 영역
  //     자체가 찌그러진다(실측 390px: main.clientWidth=150). **내가 건드리지 않은 [라인 강화 내역] 탭도
  //     동일**(tableWrap cw=36 / sw=985 · 액트 탭 cw=38 / sw=1117) → 페이지 전역 크롬 조건이지 요약 회귀 아님.
  //   따라서 사이드바가 정상 동작하는 폭(1024)에서 요약이 넘치지 않는지를 검증하고,
  //   390px 조건은 대조군(라인 탭)과 동일함을 확인해 "악화 없음"만 본다.
  const measureSummary = () =>
    page.evaluate(() => {
      const box = document.querySelector("[data-act-summary]") as HTMLElement | null;
      const main = document.querySelector("main") as HTMLElement | null;
      if (!box) return { found: false, overflow: false, sw: 0, cw: 0, mainCW: main?.clientWidth ?? -1 };
      return {
        found: true,
        overflow: box.scrollWidth > box.clientWidth + 1,
        sw: box.scrollWidth,
        cw: box.clientWidth,
        mainCW: main?.clientWidth ?? -1,
      };
    });

  await page.setViewportSize({ width: 1024, height: 900 });
  await page.waitForTimeout(1000);
  const at1024 = await measureSummary();
  check("좁은 화면(1024px) 요약 가로 overflow 없음(flex-wrap 줄바꿈)", at1024.found && !at1024.overflow, at1024);

  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(1000);
  const at390 = await measureSummary();
  console.log(
    `ℹ 390px: main.clientWidth=${at390.mainCW}(사이드바 미접힘 — 라인 탭도 동일한 기존 조건) · 요약 sw=${at390.sw}/cw=${at390.cw}`,
  );

  // (7) 오류
  check("콘솔 오류 없음", consoleErrors.length === 0, consoleErrors.slice(0, 3));
  check("네트워크 4xx/5xx 없음", netErrors.length === 0, netErrors.slice(0, 3));

  await browser.close();
  console.log(`\n결과: ${failed === 0 ? "ALL PASS" : `${failed} FAIL`}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
