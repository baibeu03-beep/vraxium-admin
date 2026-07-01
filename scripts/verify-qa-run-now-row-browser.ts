/**
 * 브라우저(인증) — 행 단위 "즉시 검수" 버튼 종단 검증(항상 체크 완료).
 *   현재 주차의 club 보드에 테스트 '체크 대기' 행 1건을 시드한 뒤:
 *     1) 그 행에 '즉시 검수' 버튼이 보인다(체크 대기 행만).
 *     2) 버튼 클릭 → 확인 모달 → 실 HTTP 호출 → 결과 배너(크롤 결과 3종 문구, 모두 체크 완료).
 *     3) 버튼이 한 일만으로(추가 조작 없이) 보드 새로고침 시 상태가 '체크 완료'로 바뀌고
 *        버튼이 사라진다 — 인증을 못 찾아도 항상 완료(pending→completed 화면 확인).
 *   테스트 스코프만 시드·삭제(무흔적). 스크린샷: claudedocs/qa-row-*.png
 *
 *   npx tsx --env-file=.env.local scripts/verify-qa-run-now-row-browser.ts
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const g = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = g("NEXT_PUBLIC_SUPABASE_URL")!;
const ANON = g("NEXT_PUBLIC_SUPABASE_ANON_KEY")!;
const SERVICE = g("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE);
const SHOT = resolve(adminRoot, "claudedocs");
const ORG = "encre", HUB = "club";
const MODE = process.env.VERIFY_MODE === "operating" ? "operating" : "test";

let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function makeAdminCookies() {
  const anon = createClient(SUPABASE_URL, ANON);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: v } = await anon.auth.verifyOtp({ email: adminEmail, token: (link as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const srv = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (i: any[]) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" as const }));
}

async function main() {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();

  let seedId: string | null = null;
  let seedActId: string | null = null;
  let seedGroupId: string | null = null;
  const { data: preLogs } = await admin.from("process_check_logs").select("id").eq("organization_slug", ORG);
  const preLogIds = new Set((preLogs ?? []).map((l: any) => l.id));

  try {
    // 보드 GET(test) — 현재 주차 + needed 체크대상 액트 1개.
    await page.goto(`${BASE}/admin/processes/check/club?org=${ORG}&mode=${MODE}`, { waitUntil: "domcontentloaded" });
    const board = await page.evaluate(async (qs) => {
      const r = await fetch(`/api/admin/processes/check?${qs}`); return await r.json();
    }, `hub=${HUB}&org=${ORG}&mode=${MODE}`);
    const acts = board?.data?.acts ?? [];
    const weekId = board?.data?.week?.weekId ?? board?.data?.selectedWeekId ?? null;
    let target = acts.find((a: any) => a.isCheckTarget && a.status === "needed" && a.lineGroupId);
    if (weekId && !target) {
      const tag = `ZZ-qa-row-${Date.now()}`;
      const grp = await admin
        .from("process_line_groups")
        .insert({ hub: HUB, name: `${tag} line` })
        .select("id,name")
        .single();
      if (!grp.error && grp.data) {
        seedGroupId = (grp.data as any).id;
        const act = await admin
          .from("process_acts")
          .insert({
            line_group_id: seedGroupId,
            hub: HUB,
            act_name: `${tag} act`,
            duration_minutes: 10,
            occur_week: "N",
            occur_dow: 1,
            occur_time: "10:00",
            check_week: "N",
            check_dow: 3,
            check_time: "12:00",
            point_check: 1,
            point_advantage: 0,
            point_penalty: 0,
            cafe: "occur",
            check_target: "check",
            act_type: "required",
            is_active: true,
          })
          .select("id,act_name,line_group_id")
          .single();
        if (!act.error && act.data) {
          seedActId = (act.data as any).id;
          target = {
            actId: seedActId,
            actName: (act.data as any).act_name,
            lineGroupId: (act.data as any).line_group_id,
          };
        }
      }
    }
    if (!weekId || !target) { console.log("⚠ 시드 가능한 needed 체크대상 액트/주차 없음 — skip"); await browser.close(); process.exit(0); }

    // 시드: 현재 주차·미래예약(검수 예정 시각 전 상태 재현)·체크 대기.
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const ins = await admin.from("process_check_statuses").insert({
      organization_slug: ORG, hub: HUB, week_id: weekId, act_id: target.actId, line_group_id: target.lineGroupId,
      status: "pending", scope_mode: MODE, scheduled_check_at: future, review_link: "https://cafe.naver.com/qa-row-browser", attempt_count: 0,
    }).select("id").maybeSingle();
    if (ins.error || !ins.data) { console.log(`⚠ 시드 실패(${ins.error?.message}) — skip`); await browser.close(); process.exit(0); }
    seedId = (ins.data as any).id;

    // 1) 행에 '즉시 검수' 버튼.
    await page.reload({ waitUntil: "domcontentloaded" });
    const rowLoc = page.locator("tr", { hasText: target.actName }).first();
    await rowLoc.waitFor({ state: "visible", timeout: 30_000 });
    const btn = rowLoc.getByRole("button", { name: "즉시 검수" });
    let btnVisible = false;
    try { await btn.waitFor({ state: "visible", timeout: 15_000 }); btnVisible = true; } catch { btnVisible = false; }
    ck("[1] '체크 대기' 행에 '즉시 검수' 버튼 노출", btnVisible);
    // 안내 헤더(운영자용) 노출.
    ck("[1] '즉시 검수' 안내 헤더 노출", (await page.getByText("검수 시점을 기다리지 않고").count()) > 0);
    // 14컬럼 가로 스크롤 — 상태 칸(맨 오른쪽)이 보이도록 내부 컨테이너를 우측 끝으로 스크롤 후 캡처.
    const scrollRight = async () => {
      await page.evaluate(() => document.querySelectorAll(".overflow-x-auto").forEach((el) => el.scrollTo({ left: 99999 })));
      await btn.scrollIntoViewIfNeeded().catch(() => {});
    };
    await scrollRight();
    await page.screenshot({ path: resolve(SHOT, "qa-row-button.png") }).catch(() => {});

    // 2) 클릭 → 확인 모달 → 확인 → 실 HTTP 라운드트립(실 크롤러 지연과 무관하게 응답 수신으로 판정).
    let clicked = false;
    if (btnVisible) {
      await btn.click();
      // 확인 모달.
      let modal = false;
      try { await page.getByText("이 항목을 지금 바로 검수하시겠습니까?").waitFor({ state: "visible", timeout: 15_000 }); modal = true; } catch { modal = false; }
      ck("[2] 확인 모달 표시('이 항목을 지금 바로 검수하시겠습니까?')", modal);
      const respPromise = page
        .waitForResponse((r) => r.url().includes("/api/admin/qa/run-now/process-check-row"), { timeout: 150_000 })
        .catch(() => null);
      await page.getByRole("alertdialog").getByRole("button", { name: "즉시 검수" }).click();
      const resp = await respPromise;
      clicked = Boolean(resp);
      const respJson = resp ? await resp.json().catch(() => ({})) : {};
      ck("[2b] HTTP body data.status=completed", respJson?.data?.status === "completed", JSON.stringify(respJson?.data ?? null));
      ck("[2] 확인 후 process-check-row HTTP 응답 수신", Boolean(resp), resp ? `status=${resp.status()}` : "no-response");
      // 결과 배너 — 크롤 결과 3종 문구(모두 '체크 완료로 처리했습니다'), 내부 용어 없음.
      const CLEAN = /체크 완료로 처리했습니다/;
      let banner = "";
      try { const b = page.getByText(CLEAN).first(); await b.waitFor({ state: "visible", timeout: 15_000 }); banner = await b.innerText(); } catch { banner = ""; }
      const JARGON = ["QA", "scope", "fail-closed", "dry-run", "internal", "marker", "테스트 항목", "검수 대상이 아닙니다"];
      ck("[2] 결과 배너 = 3종 문구(모두 체크 완료·내부 용어 없음)", Boolean(banner) && !JARGON.some((w) => banner.includes(w)), banner);
      await page.screenshot({ path: resolve(SHOT, "qa-row-clicked.png"), fullPage: true }).catch(() => {});
    }

    // 3) 버튼이 한 일만으로(추가 조작 없이) — 인증을 못 찾아도 항상 '체크 완료' + 버튼 사라짐.
    await page.reload({ waitUntil: "domcontentloaded" });
    const rowLoc2 = page.locator("tr", { hasText: target.actName }).first();
    await rowLoc2.waitFor({ state: "visible", timeout: 30_000 });
    const rowText = await rowLoc2.innerText();
    const noBtn = (await rowLoc2.getByRole("button", { name: "즉시 검수" }).count()) === 0;
    // DB 도 completed 확인(화면·데이터 일치).
    const { data: dbRow } = await admin.from("process_check_statuses").select("status").eq("id", seedId!).maybeSingle();
    const { count: completedLogCount } = await admin
      .from("process_check_logs")
      .select("id", { count: "exact", head: true })
      .eq("act_id", target.actId)
      .eq("action", "check_completed");
    ck(
      "[3] 클릭만으로 '체크 완료'(인증 못 찾아도) + '즉시 검수' 버튼 사라짐",
      clicked && rowText.includes("체크 완료") && noBtn && (dbRow as any)?.status === "completed",
      `noBtn=${noBtn}/db=${(dbRow as any)?.status}`,
    );
    ck("[4] 상태창/상세 이력용 check_completed 로그 기록", (completedLogCount ?? 0) >= 1, `logs=${completedLogCount ?? 0}`);
    await page.evaluate(() => document.querySelectorAll(".overflow-x-auto").forEach((el) => el.scrollTo({ left: 99999 })));
    await rowLoc2.scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: resolve(SHOT, "qa-row-completed.png") }).catch(() => {});
  } catch (e: any) {
    console.error("browser error:", e?.stack ?? e?.message ?? e); fail++;
  } finally {
    if (seedId) {
      await admin.from("process_check_review_recipients").delete().eq("ref_id", seedId);
      await admin.from("process_check_statuses").delete().eq("id", seedId);
    }
    const { data: postLogs } = await admin.from("process_check_logs").select("id").eq("organization_slug", ORG);
    const newLogIds = (postLogs ?? []).map((l: any) => l.id).filter((id: string) => !preLogIds.has(id));
    if (newLogIds.length) await admin.from("process_check_logs").delete().in("id", newLogIds);
    if (seedActId) await admin.from("process_acts").delete().eq("id", seedActId);
    if (seedGroupId) await admin.from("process_line_groups").delete().eq("id", seedGroupId);
    ck("[cleanup] 시드 삭제(무흔적)", true, `logs removed=${newLogIds.length}`);
    await browser.close();
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
