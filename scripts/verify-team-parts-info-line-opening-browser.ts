/**
 * 라인 개설 관리 탭(주차 전체 요약) 브라우저 검증 (dev server 필요).
 *   - [라인 개설 관리] 탭 클릭 → 요약 패널 렌더
 *   - 요약에 전체/오픈/개설/미개설/라인칸 개설율 표시
 *   - 브라우저 표시값 == HTTP DTO (동일 주차/클럽)
 *   npx tsx --env-file=.env.local scripts/verify-team-parts-info-line-opening-browser.ts
 */
import { pathToFileURL } from "url";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { saveWeekOpenConfirm, loadWeekOpeningConfig, EXPERIENCE_LINE_TYPES } from "@/lib/adminTeamPartsInfoWeekDetailData";
import { listTeams } from "@/lib/adminExperienceLineData";

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
  const { data: adm } = await supabaseAdmin.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as any)?.email;
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const sv = createServerClient(u, a, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it.map(({ name, value }: any) => ({ name, value }))) } });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c: any) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" }));
}

async function main() {
  const { rows } = await loadSeasonWeeks();
  const weekId = (rows.find((r) => !r.is_official_rest && r.week_start_date) ?? rows[0]).week_id;
  const cookieList = await cookies_();
  const cookieHeader = cookieList.map((c) => `${c.name}=${c.value}`).join("; ");
  console.log(`   week=${weekId.slice(0, 8)}`);

  // 기대값(HTTP DTO).
  const httpRes = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/line-opening-management?club=oranke`, { headers: { cookie: cookieHeader } });
  const httpJson: any = await httpRes.json();
  const sum = httpJson?.data?.summary;
  ck("HTTP DTO 로드", !!sum, sum);

  const pw: any = await import(pathToFileURL(resolve("../vraxium/node_modules/playwright/index.js")).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  const ctx = await (await chromium.launch()).newContext({ viewport: { width: 1600, height: 2000 } });
  await ctx.addCookies(cookieList);
  const page = await ctx.newPage();
  page.on("dialog", async (d: any) => { await d.dismiss(); });

  const resp = await page.goto(`${BASE}/admin/team-parts/info/weeks/${weekId}?club=oranke`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3500);
  ck("페이지 200", resp?.status() === 200);

  // [라인 개설 관리] 탭 클릭.
  await page.click('[data-tab="line"]');
  await page.waitForTimeout(2500);

  ck("라인 개설 요약 패널 렌더", !!(await page.$("[data-line-opening-panel]")));
  const panelText = await page.$eval("[data-line-opening-panel]", (e: any) => e.textContent);
  for (const label of ["전체", "오픈", "개설", "미개설", "라인칸 개설율"]) {
    ck(`요약 라벨 '${label}'`, panelText.includes(label));
  }
  // 브라우저 표시값 == HTTP DTO (숫자/율 포함).
  ck("브라우저 == HTTP totalLines", panelText.includes(String(sum.totalLines)), { totalLines: sum.totalLines });
  ck("브라우저 == HTTP 라인칸 개설율", panelText.includes(`${sum.lineOpenRate}%`), { rate: sum.lineOpenRate });

  // ── 허브 급 1: 실무 정보 섹션 ──
  ck("실무 정보 라인 개설 섹션 렌더", !!(await page.$('[data-hub-section="info-line-opening"]')));
  const infoText = await page.$eval('[data-hub-section="info-line-opening"]', (e: any) => e.textContent);
  ck("실무 정보 허브 요약 제목", /허브 급 1 : \[실무 정보\]/.test(infoText));
  for (const col of ["라인명", "운영진", "운영", "개설 시점", "개설 크루", "기입 크루", "진행 상태"]) {
    ck(`표 컬럼 '${col}'`, infoText.includes(col));
  }
  const lineRows = await page.$$('[data-info-open-line]');
  ck("실무 정보 라인 행 = 9", lineRows.length === 9, { rows: lineRows.length });
  // DTO 라인명이 표에 실제 표시.
  const info = httpJson.data.practicalInfo;
  ck("첫 라인명 표시", infoText.includes(info.lines[0].lineName), { name: info.lines[0].lineName });
  // 운영/미오픈 배지 존재(오픈 대상 여부 반영).
  ck("운영 배지(오픈/미오픈)", infoText.includes("오픈") || infoText.includes("미오픈"));
  // 모든 라인 행에 상태 속성(data-line-state) 부여 — 이 주차(오픈확인 전)는 전부 not_open.
  const states0 = await page.$$eval('[data-info-open-line]', (els: any[]) => els.map((e) => e.getAttribute("data-line-state")));
  ck("모든 라인 행 data-line-state 존재", states0.every((s: string | null) => !!s), states0);
  ck("오픈확인 전 = 전부 not_open", states0.every((s: string | null) => s === "not_open"), states0);
  // 개설 불가(not_required) 배지는 빨강/에러 아님 → 회색(zinc) 계열이어야.
  const notReqBadge = await page.$$eval('[data-info-open-line][data-line-state="not_open"] td:last-child span', (els: any[]) => els.map((e) => e.className));
  ck("개설 불가 배지 회색(빨강 아님)", notReqBadge.length > 0 && notReqBadge.every((c: string) => c.includes("zinc") && !c.includes("rose") && !c.includes("red")), { sample: notReqBadge[0] });
  // 행 전체를 회색으로 칠하지 않음(상태색은 라인명 칩에만) — tr 에 bg-zinc/emerald/amber 없음.
  const rowCls0 = await page.$$eval('[data-info-open-line]', (els: any[]) => els.map((e) => e.className));
  ck("행 전체 배경색 미적용(칩만)", rowCls0.every((c: string) => !/bg-(zinc|emerald|amber|orange|rose)/.test(c)), { sample: rowCls0[0] });
  // 미오픈 라인명 칩은 회색 빛바램.
  const notOpenChip = await page.$$eval('[data-info-open-line][data-line-state="not_open"] td:first-child span', (els: any[]) => els.map((e) => e.className));
  ck("미오픈 라인명 칩 회색", notOpenChip.length > 0 && notOpenChip.every((c: string) => c.includes("zinc")), { sample: notOpenChip[0] });

  // ── 허브 급 2: 실무 경험 섹션 ──
  ck("실무 경험 라인 개설 섹션 렌더", !!(await page.$('[data-hub-section="experience-line-opening"]')));
  const expText = await page.$eval('[data-hub-section="experience-line-opening"]', (e: any) => e.textContent);
  ck("실무 경험 허브 요약 제목", /허브 급 2 : \[실무 경험\]/.test(expText));
  const expTabs = await page.$$('[data-exp-team-tab]');
  ck("팀 탭 렌더(>=1)", expTabs.length >= 1, { tabs: expTabs.length });
  const expRows = await page.$$('[data-exp-open-line]');
  ck("선택 팀 라인 행 = 5", expRows.length === 5, { rows: expRows.length });
  const expDto = httpJson.data.practicalExperience;
  if (expDto.teams.length >= 1) {
    ck("팀 요약 제목([팀명] 팀 요약)", expText.includes(`[${expDto.teams[0].teamName}] 팀 요약`), { team: expDto.teams[0].teamName });
    ck("라인명 5종(도출~확장)", ["도출", "분석", "견문", "관리", "확장"].every((n) => expText.includes(n)));
  }
  // 팀 탭 전환 시 팀 요약 제목이 바뀐다.
  if (expTabs.length >= 2) {
    const before = await page.$eval('[data-hub-section="experience-line-opening"]', (e: any) => e.textContent);
    await expTabs[1].click();
    await page.waitForTimeout(400);
    const after = await page.$eval('[data-hub-section="experience-line-opening"]', (e: any) => e.textContent);
    ck("팀 탭 전환 시 팀 요약 변경", before !== after);
  }

  // ── 허브 급 3: 실무 역량 섹션 ──
  ck("실무 역량 라인 개설 섹션 렌더", !!(await page.$('[data-hub-section="competency-line-opening"]')));
  const compText = await page.$eval('[data-hub-section="competency-line-opening"]', (e: any) => e.textContent);
  ck("실무 역량 허브 요약 제목", /허브 급 3 : \[실무 역량\]/.test(compText));
  const compDto = httpJson.data.practicalCompetency;
  const compRows = await page.$$('[data-comp-open-line]');
  ck("실무 역량 등록 라인 전부 표시(하드코딩 아님)", compRows.length === compDto.lines.length && compRows.length > 0, { rows: compRows.length, dto: compDto.lines.length });
  // 이 주차(오픈확인 전) 역량은 전부 미개설 → not_open, "개설 필요" 배지 없음.
  const compStates0 = await page.$$eval('[data-comp-open-line]', (els: any[]) => els.map((e) => e.getAttribute("data-line-state")));
  ck("역량 미개설=not_open(개설 필요 없음)", compStates0.every((s: string | null) => s === "not_open"), { sample: compStates0.slice(0, 3) });
  ck("역량 표에 '개설 필요' 미표기", !compText.includes("개설 필요"));

  await page.screenshot({ path: "claudedocs/qa-team-parts-line-opening.png", fullPage: true });

  // ── 상태별 배경색 시나리오: 실제 개설 정보 라인이 있는 주차에 임시 전체 오픈확인 → 색상 확인 → 원복 ──
  //   (UI 표현 검증용. saveWeekOpenConfirm 은 snapshot 무접촉. 종료 시 config 원복.)
  const CREATED_WEEK = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc";
  const CREATED_ORG = "encre" as const;
  const existing = await supabaseAdmin.from("cluster4_week_opening_configs").select("*").eq("week_id", CREATED_WEEK).eq("organization_slug", CREATED_ORG).maybeSingle();
  try {
    const teams = await listTeams(CREATED_ORG, "operating");
    const { data: infoTypes } = await supabaseAdmin.from("activity_types").select("id").eq("cluster_id", "practical_info").eq("is_active", true);
    const practicalInfo: Record<string, boolean> = {};
    for (const t of (infoTypes ?? []) as { id: string }[]) practicalInfo[t.id] = true;
    const practicalExperience: Record<string, Record<string, boolean>> = {};
    for (const tm of teams) { practicalExperience[tm.id] = {}; for (const ty of EXPERIENCE_LINE_TYPES) practicalExperience[tm.id][ty] = true; }
    await saveWeekOpenConfirm({ weekId: CREATED_WEEK, organization: CREATED_ORG, config: { practicalInfo, practicalExperience, practicalCompetency: { checked: true } } });

    // 기대 상태(HTTP DTO 로 계산) — created(ontime/late) 라인이 실제로 존재해야 색상 시나리오 검증 의미.
    const g = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${CREATED_WEEK}/line-opening-management?club=${CREATED_ORG}`, { headers: { cookie: cookieHeader } });
    const gj: any = await g.json();
    const expectStates = gj.data.practicalInfo.lines.map((l: any) => {
      if (!l.isOpenThisWeek) return "not_open";
      const created = l.progressStatus === "crew_submitting" || l.progressStatus === "crew_submission_closed";
      if (!created) return "open_uncreated";
      return l.createdTimingStatus === "late" ? "created_late" : "created_ontime";
    });
    ck("시나리오 주차에 개설 완료 라인 존재", expectStates.some((s: string) => s.startsWith("created")), { expectStates });

    await page.goto(`${BASE}/admin/team-parts/info/weeks/${CREATED_WEEK}?club=${CREATED_ORG}`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(3500);
    await page.click('[data-tab="line"]');
    await page.waitForTimeout(2500);
    const domStates = await page.$$eval('[data-info-open-line]', (els: any[]) => els.map((e) => e.getAttribute("data-line-state")));
    ck("브라우저 라인 상태 == DTO 파생 상태", JSON.stringify(domStates) === JSON.stringify(expectStates), { domStates, expectStates });
    // 초록(개설 완료) 색은 라인명 칩에 적용 — created 행의 라인명 span 에 emerald.
    const createdChip = await page.$$eval('[data-info-open-line][data-line-state^="created"] td:first-child span', (els: any[]) => els.map((e) => e.className));
    ck("개설 완료 라인명 칩 초록", createdChip.length > 0 && createdChip.every((c: string) => c.includes("emerald")), { n: createdChip.length });
    // open_uncreated 라인명 칩은 경고(주황) 계열.
    const uncreatedChip = await page.$$eval('[data-info-open-line][data-line-state="open_uncreated"] td:first-child span', (els: any[]) => els.map((e) => e.className));
    ck("오픈·미개설 라인명 칩 주황(경고)", uncreatedChip.length > 0 && uncreatedChip.every((c: string) => c.includes("orange")), { n: uncreatedChip.length });
    // 개설 필요(required) 배지는 빨강/주황.
    const reqBadge = await page.$$eval('[data-info-open-line][data-line-state="open_uncreated"] td:last-child span', (els: any[]) => els.map((e) => e.className));
    ck("개설 필요 배지 주황/빨강", reqBadge.length > 0 && reqBadge.every((c: string) => c.includes("orange") || c.includes("rose") || c.includes("red")), { sample: reqBadge[0] });
    // 행 전체 배경색 미적용(칩만).
    const rowClsS = await page.$$eval('[data-info-open-line]', (els: any[]) => els.map((e) => e.className));
    ck("시나리오 행 전체 배경색 미적용", rowClsS.every((c: string) => !/bg-(zinc|emerald|amber|orange|rose)/.test(c)), { sample: rowClsS[0] });

    // ── 실무 경험(팀 기준 집계) DTO 검증 — 개설 크루/기입 크루가 팀 기준·관리 심화(≤10) ──
    const expData = gj.data.practicalExperience;
    ck("시나리오 실무 경험 팀 존재", expData.teams.length >= 1, { teams: expData.teams.length });
    const createdTeam = expData.teams.find((t: any) => t.summary.createdLines > 0) ?? null;
    ck("실무 경험 개설 완료 팀 존재", !!createdTeam, createdTeam?.teamName);
    if (createdTeam) {
      for (const l of createdTeam.lines) {
        const created = l.progressStatus === "crew_submitting" || l.progressStatus === "crew_submission_closed";
        if (created) {
          ck(`[exp ${createdTeam.teamName}/${l.lineName}] 개설<=가능(팀 기준)`, (l.createdCrewCount ?? 0) <= l.eligibleCrewCount, { c: l.createdCrewCount, e: l.eligibleCrewCount });
        }
        if (l.lineName === "관리") {
          ck(`[exp ${createdTeam.teamName}/관리] 심화 모수<=10`, l.eligibleCrewCount <= 10, { eligible: l.eligibleCrewCount });
        }
      }
      // 실무 경험 섹션의 선택 팀 라인 행 5개 렌더 + 개설 팀 탭 클릭 시 created 칩 초록.
      const expTabSel = `[data-exp-team-tab="${createdTeam.teamId}"]`;
      if (await page.$(expTabSel)) {
        await page.click(expTabSel);
        await page.waitForTimeout(400);
      }
      const expRowStates = await page.$$eval('[data-exp-open-line]', (els: any[]) => els.map((e) => e.getAttribute("data-line-state")));
      ck("실무 경험 선택 팀 라인 5행", expRowStates.length === 5, { rows: expRowStates.length });
      ck("실무 경험 개설 팀에 created 상태 존재", expRowStates.some((s: string | null) => (s ?? "").startsWith("created")), expRowStates);
    }

    await page.screenshot({ path: "claudedocs/qa-team-parts-line-opening-states.png", fullPage: true });
  } finally {
    // config 원복(원래 행 복원 / 없었으면 삭제).
    if (existing.data) {
      const r = existing.data as any;
      await supabaseAdmin.from("cluster4_week_opening_configs").update({ config: r.config, open_confirmed: r.open_confirmed, open_confirmed_at: r.open_confirmed_at, open_confirmed_by: r.open_confirmed_by }).eq("week_id", CREATED_WEEK).eq("organization_slug", CREATED_ORG);
    } else {
      await supabaseAdmin.from("cluster4_week_opening_configs").delete().eq("week_id", CREATED_WEEK).eq("organization_slug", CREATED_ORG);
    }
    console.log("   (시나리오 open-config 원복 완료)");
  }

  // ── 실무 역량 개설 완료 시각 확인(config 무관 — 역량 개설은 cluster4_lines 존재 기반) ──
  //   phalanx a2112b50 주차엔 개설 완료 역량 라인이 있어 초록 칩으로 표시된다.
  {
    const COMP_WEEK = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc";
    const cg = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${COMP_WEEK}/line-opening-management?club=phalanx`, { headers: { cookie: cookieHeader } });
    const cgj: any = await cg.json();
    const compCreated = cgj.data.practicalCompetency.lines.filter((l: any) => l.progressStatus === "crew_submitting" || l.progressStatus === "crew_submission_closed");
    ck("phalanx 역량 개설 완료 라인 존재(DTO)", compCreated.length > 0, { n: compCreated.length });
    if (compCreated.length > 0) {
      // 개설 완료 라인 = createdCrewCount>=1, eligible<=클럽 크루, required 아님.
      ck("역량 개설 라인 개설크루>=1·개설<=가능", compCreated.every((l: any) => (l.createdCrewCount ?? 0) >= 1 && (l.createdCrewCount ?? 0) <= l.eligibleCrewCount));
      await page.goto(`${BASE}/admin/team-parts/info/weeks/${COMP_WEEK}?club=phalanx`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForTimeout(3500);
      await page.click('[data-tab="line"]');
      await page.waitForTimeout(2500);
      const compCreatedChip = await page.$$eval('[data-comp-open-line][data-line-state^="created"] td:first-child span', (els: any[]) => els.map((e) => e.className));
      ck("역량 개설 완료 라인명 칩 초록", compCreatedChip.length > 0 && compCreatedChip.every((c: string) => c.includes("emerald")), { n: compCreatedChip.length });
      const compText2 = await page.$eval('[data-hub-section="competency-line-opening"]', (e: any) => e.textContent);
      ck("역량 개설 라인 '크루 기입 중/종료' 표기", /크루 기입 (중|종료)/.test(compText2));
      ck("역량 표에 '개설 필요' 미표기(개설 후에도)", !compText2.includes("개설 필요"));
      await page.screenshot({ path: "claudedocs/qa-team-parts-line-opening-competency.png", fullPage: true });
    }
  }

  await ctx.browser()?.close?.();
  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
