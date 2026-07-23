// 주차 결과(크루) 상세 — 검수 완료 상태의 **초기 로딩/버튼/공표 취소** 실브라우저 검증(dev :3000, owner 세션).
//
//   A. 검수 완료 + 공표 snapshot 있음  → 진입 즉시 값 표시 · 공표 취소 표시 · 공표 버튼 비활성
//   B. 검수 완료 + 새 예비 결과 있음   → 새 예비 결과 표시 · 재공표 활성 · 공표 취소 활성
//   C. 공표 취소 직후                  → 상태 집계 중 · 목록(다른 화면) 결과 비노출 · base 행 유지 · 결과 컬럼 "-"
//   D. legacy 검수 완료(snapshot 없음) → 완료 상태 유지 · 명시적 경고 · live 폴백 없음
//   + 일반 모드 / mode=test 가 같은 상태 전이·같은 DTO 를 쓰는지 대조.
//
//   ⚠ 이 스크립트는 검증 대상 주차를 실제로 공표/취소한다(QA_HIDE_REAL_USERS=true → scope=test).
//     종료 시 원래 상태(published · 활성 snapshot 없음)로 **되돌린다**.
//
//   실행: npm run verify:crew-week-publish-states
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const PATH = "/admin/team-parts/info/crew-week-results";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const OWNER_EMAIL = "vanuatu.golden@gmail.com";

// 대상 = 2026-summer W2 · encre. QA 스위치로 실효 scope 는 test 다(운영 코호트 행을 건드리지 않는다).
const ORG = "encre";
const SEASON_KEY = "2026-summer";
const WEEK_NUMBER = 2;

let fail = 0;
const ck = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function sessionCookies() {
  const sb = createClient(URL_, SERVICE);
  const brow = createClient(URL_, ANON);
  const { data: link, error } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email: OWNER_EMAIL,
  });
  if (error) throw new Error(`generateLink: ${error.message}`);
  const { data: v, error: e2 } = await brow.auth.verifyOtp({
    email: OWNER_EMAIL,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  if (e2) throw new Error(`verifyOtp: ${e2.message}`);
  const cap = [];
  const srv = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/" }));
}

// ── 화면에서 읽어낸 사실 ─────────────────────────────────────────────────────
async function readPanel(page) {
  await page.waitForSelector("[data-crew-week-publish]", { timeout: 20000 });
  // 로딩 문구가 사라질 때까지(=상세 GET 완료) 기다린다.
  await page
    .waitForFunction(
      () => !document.body.innerText.includes("불러오는 중…"),
      null,
      { timeout: 25000 },
    )
    .catch(() => {});
  return page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const step = [...document.querySelectorAll("[data-step]")].find(
      (n) => n.getAttribute("data-active") === "true",
    );
    const publish = q("[data-action-publish]");
    const unpublish = q("[data-action-unpublish]");
    const preview = q("[data-action-preview]");
    const summarySource = q("[data-summary-source]");
    const metrics = {};
    for (const n of document.querySelectorAll("[data-metric]")) {
      metrics[n.getAttribute("data-metric")] = n.textContent.trim();
    }
    const teamMetrics = {};
    for (const n of document.querySelectorAll("[data-team-metric]")) {
      teamMetrics[n.getAttribute("data-team-metric")] = n.textContent.trim();
    }
    const rows = [...document.querySelectorAll("[data-crew-row]")];
    const rankCells = rows.map((r) => r.querySelector("[data-col-rank]")?.textContent.trim() ?? "");
    const resultCells = rows.map(
      (r) => r.querySelector("[data-col-result]")?.textContent.trim() ?? "",
    );
    const cumWeeksByUser = {};
    for (const r of rows) {
      cumWeeksByUser[r.getAttribute("data-crew-row")] =
        r.querySelector("[data-col-cumweeks]")?.textContent.trim() ?? "";
    }
    const teamRowNames = [...document.querySelectorAll("[data-team-row]")].map((n) =>
      n.getAttribute("data-team-row"),
    );
    // 크루 표의 "소속 팀" 컬럼 집계 — 팀 표 totalCrew 와 대조할 값.
    const crewCountByTeam = {};
    for (const r of rows) {
      const t = r.querySelector("[data-col-team]")?.textContent.trim() ?? "";
      crewCountByTeam[t] = (crewCountByTeam[t] ?? 0) + 1;
    }
    const teamTotalByName = {};
    const teamPartsByName = {};
    for (const n of document.querySelectorAll("[data-team-row]")) {
      const name = n.getAttribute("data-team-row");
      teamTotalByName[name] = Number(n.getAttribute("data-team-total"));
      teamPartsByName[name] = Number(n.getAttribute("data-team-parts"));
    }
    // 크루 표에서 팀별 distinct 파트 — 팀 표 partCount 의 원천 대조용('-'/'미배정'/공백 제외).
    const crewPartsByTeam = {};
    for (const r of rows) {
      const t = r.querySelector("[data-col-team]")?.textContent.trim() ?? "";
      const p = r.querySelector("[data-col-part]")?.textContent.trim() ?? "";
      if (!p || p === "-" || p === "미배정") continue;
      (crewPartsByTeam[t] ??= []).push(p);
    }
    for (const k of Object.keys(crewPartsByTeam)) {
      crewPartsByTeam[k] = [...new Set(crewPartsByTeam[k])];
    }
    return {
      step: step?.getAttribute("data-step") ?? null,
      previewEnabled: !!preview && !preview.disabled,
      publishPresent: !!publish,
      publishEnabled: !!publish && !publish.disabled,
      publishLabel: publish?.textContent.trim() ?? null,
      publishKind: publish?.getAttribute("data-publish-kind") ?? null,
      unpublishPresent: !!unpublish,
      unpublishEnabled: !!unpublish && !unpublish.disabled,
      legacyBanner: q("[data-legacy-completed]")?.textContent.trim() ?? null,
      legacyKind: q("[data-legacy-completed]")?.getAttribute("data-legacy-kind") ?? null,
      summarySource: summarySource?.getAttribute("data-summary-source") ?? null,
      metrics,
      teamMetrics,
      rowCount: rows.length,
      rankCells,
      resultCells,
      cumWeeksByUser,
      teamRowNames,
      crewCountByTeam,
      teamTotalByName,
      teamPartsByName,
      crewPartsByTeam,
      baseNotice: q("[data-details-base]")?.textContent.trim() ?? null,
      teamTableRows: teamRowNames.length,
    };
  });
}

// 고객 앱 /weekly-ranking 의 "N주" 원천 = weekly-card snapshot 의 accumulatedApprovedWeeks.
//   front metricFromCard 가 그 값을 CrewRankShowcase.cumulativeSuccessWeeks 로 그대로 옮긴다.
async function expectedCumWeeksByUser(sb, userIds, weekId) {
  const out = new Map();
  for (let i = 0; i < userIds.length; i += 50) {
    const { data, error } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("user_id,cards")
      .in("user_id", userIds.slice(i, i + 50));
    if (error) throw new Error(`snapshot 조회 실패: ${error.message}`);
    for (const r of data ?? []) {
      const card = Array.isArray(r.cards) ? r.cards.find((c) => c.weekId === weekId) : null;
      if (!card) continue;
      const v = card.accumulatedApprovedWeeks;
      if (typeof v === "number" && Number.isFinite(v)) out.set(r.user_id, Math.max(0, v));
    }
  }
  return out;
}

const clickConfirm = async (page) => {
  await page.waitForSelector("[data-admin-dialog-confirm]", { timeout: 10000 });
  await page.click("[data-admin-dialog-confirm]");
};
// 알림 다이얼로그를 닫으면서 본문 문구를 그대로 돌려준다(문구 검증용 — 줄바꿈 보존).
const dismissAlert = async (page) => {
  await page.waitForSelector("[data-admin-dialog-confirm]", { timeout: 20000 });
  const text = await page.evaluate(() => {
    const dlg = document.querySelector("[data-admin-dialog]");
    const body = dlg?.querySelector("h2")?.nextElementSibling;
    return body ? body.textContent : null;
  });
  await page.click("[data-admin-dialog-confirm]");
  return text;
};

// 활성 finalize run 을 전부 철회한다(물리 삭제 없음 — 서비스와 동일하게 reverted_at 만 찍는다).
//   ⚠ 검증은 **알려진 시작 상태**에서 출발해야 한다. 이전 회차가 남긴 활성 snapshot 이 있으면
//     [D](legacy) 전제가 깨지고, 버튼 존재 여부로 대기하던 지점이 즉시 통과해 publish 와 경합한다.
async function revertActiveRuns(sb, weekId) {
  const { data, error } = await sb
    .from("cluster4_week_finalize_runs")
    .select("id,organization_slug")
    .eq("week_id", weekId)
    .eq("organization_slug", ORG)
    .is("reverted_at", null);
  if (error) throw new Error(`활성 run 조회 실패: ${error.message}`);
  if (!data?.length) return 0;
  const { error: e2 } = await sb
    .from("cluster4_week_finalize_runs")
    .update({ reverted_at: new Date().toISOString() })
    .in("id", data.map((r) => r.id));
  if (e2) throw new Error(`활성 run 철회 실패: ${e2.message}`);
  return data.length;
}

// 쓰기 동작은 **서버 응답을 기다린다**. 버튼 출현으로 판정하면 이미 떠 있던 버튼에 즉시 통과한다.
async function actAndAwaitPost(page, weekId, clickSelector) {
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(weekId) && r.request().method() === "POST",
      { timeout: 180000 },
    ),
    (async () => {
      await page.click(clickSelector);
      await clickConfirm(page);
    })(),
  ]);
  if (!res.ok()) throw new Error(`POST 실패 ${res.status()}: ${await res.text()}`);
  return res.json();
}

const EXPECTED_PREVIEW_ALERT =
  "누적된 데이터를 기준하여, 결과를 도출했습니다.\n다른 페이지에는 공표되지 않았으며, ‘확인’ 용입니다.";

async function main() {
  const sb = createClient(URL_, SERVICE);
  const { data: wk } = await sb
    .from("weeks")
    .select("id,start_date,end_date")
    .eq("season_key", SEASON_KEY)
    .eq("week_number", WEEK_NUMBER)
    .maybeSingle();
  if (!wk) throw new Error(`주차 없음: ${SEASON_KEY} W${WEEK_NUMBER}`);
  const weekId = wk.id;
  const detailUrl = `${BASE}${PATH}/${ORG}/${weekId}`;
  console.log(`대상: ${SEASON_KEY} W${WEEK_NUMBER} ${ORG} · weekId=${weekId}`);

  // 원래 상태 스냅샷(복원용).
  const { data: before } = await sb
    .from("cluster4_week_org_result_states")
    .select("week_id,organization_slug,scope,status")
    .eq("week_id", weekId)
    .eq("organization_slug", ORG);
  console.log(`원래 org 상태: ${JSON.stringify(before)}`);

  // [D] 전제(= legacy 검수 완료: published + 활성 snapshot 없음)를 만들어 놓고 시작한다.
  const reverted = await revertActiveRuns(sb, weekId);
  for (const row of before ?? []) {
    await sb
      .from("cluster4_week_org_result_states")
      .update({ status: "published" })
      .eq("week_id", weekId)
      .eq("organization_slug", row.organization_slug)
      .eq("scope", row.scope);
  }
  console.log(`시작 상태 정리: 활성 run ${reverted}건 철회 · org 상태 published 로 고정`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies(await sessionCookies());
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

  try {
    // ── D. legacy 검수 완료 + snapshot 없음 ─────────────────────────────────
    console.log("\n[D] legacy 검수 완료(공표 snapshot 없음)");
    await page.goto(detailUrl, { waitUntil: "networkidle" });
    let s = await readPanel(page);
    ck("완료 상태 유지(집계 중으로 격하되지 않음)", s.step === "completed", `step=${s.step}`);
    ck(
      "명시적 경고 표시",
      (s.legacyBanner ?? "").includes("공표 snapshot 이 없어 결과를 표시할 수 없습니다"),
      s.legacyBanner ? "표시됨" : "없음",
    );
    ck("legacy 종류 = 활성 run 없음", s.legacyKind === "no_run", `kind=${s.legacyKind}`);
    ck("공표 취소 숨김(되돌릴 활성 공표 없음)", !s.unpublishPresent);
    ck("공표 버튼 비활성(예비 없음)", s.publishPresent && !s.publishEnabled);
    ck("공표 버튼 문구 = 재공표", s.publishKind === "republish", s.publishLabel ?? "");
    ck("예비 검수 활성", s.previewEnabled);
    ck("종합 인덱스 출처 = legacy", s.summarySource === "legacy", `source=${s.summarySource}`);
    ck(
      "live 폴백 없음 — 종합 지표 전부 '-'",
      Object.values(s.metrics).every((v) => v === "-"),
      JSON.stringify(s.metrics),
    );
    ck("base 행은 표시됨", s.rowCount > 0, `${s.rowCount}행`);
    ck(
      "결과 컬럼 '-'(등수·성장 결과)",
      s.rankCells.every((v) => v === "-") && s.resultCells.every((v) => v === "-"),
      `등수 uniq=${[...new Set(s.rankCells)].join(",")} / 결과 uniq=${[...new Set(s.resultCells)].join(",")}`,
    );

    const baseRowCount = s.rowCount;

    // ── A 준비: 예비 → 재공표 ────────────────────────────────────────────────
    console.log("\n[A] 검수 완료 + 공표 snapshot 있음 (예비 → 재공표 후 재진입)");
    await page.click("[data-action-preview]");
    const alertText = await dismissAlert(page); // "예비 결과 도출" 알림
    ck(
      "예비 검수 팝업 문구 정확 일치(줄바꿈·‘확인’ 따옴표 포함)",
      alertText === EXPECTED_PREVIEW_ALERT,
      JSON.stringify(alertText),
    );
    await page.waitForSelector("[data-summary-source='preview']", { timeout: 20000 });
    await actAndAwaitPost(page, weekId, "[data-action-publish]");

    // 재진입(초기 로딩 동작 자체를 검증한다 — 예비 검수를 누르지 않는다).
    await page.goto(detailUrl, { waitUntil: "networkidle" });
    s = await readPanel(page);
    ck("진입 즉시 상태 = 검수 완료", s.step === "completed", `step=${s.step}`);
    ck("legacy 경고 사라짐", s.legacyBanner === null);
    ck("종합 인덱스 출처 = 공표 결과", s.summarySource === "published", `source=${s.summarySource}`);
    ck(
      "예비 검수 없이 상단 크루 종합 결과 표시",
      ["소속 크루", "시즌 휴식", "개인 휴식", "성장 도전", "성장 성공", "성장 실패"].every(
        (k) => s.metrics[k] != null && s.metrics[k] !== "-",
      ),
      JSON.stringify(s.metrics),
    );
    ck(
      "예비 검수 없이 성장 성공률/도전률 표시",
      s.metrics["성장 성공률"] !== "-" && s.metrics["성장 도전율"] !== "-",
      `${s.metrics["성장 성공률"]} / ${s.metrics["성장 도전율"]}`,
    );
    ck(
      "예비 검수 없이 상단 팀 종합 결과 표시",
      s.teamMetrics["팀 수"] != null && s.teamMetrics["팀 수"] !== "-",
      JSON.stringify(s.teamMetrics),
    );
    ck("예비 검수 없이 크루 활동 결과 표 채워짐", s.rowCount > 0, `${s.rowCount}행`);
    ck(
      "크루 표 결과 컬럼이 '-'가 아님",
      s.resultCells.some((v) => v !== "-"),
      `결과 uniq=${[...new Set(s.resultCells)].join(",")}`,
    );
    ck("공표 취소 버튼 표시", s.unpublishPresent && s.unpublishEnabled);
    ck("공표 버튼 비활성(새 예비 없음)", s.publishPresent && !s.publishEnabled);
    ck("공표 버튼 문구 = 재공표", s.publishKind === "republish", s.publishLabel ?? "");

    // ── 팀 활동 결과: '미배정' 가상 버킷 제외 ────────────────────────────────
    console.log("\n[팀] 미배정 가상 버킷 제외");
    await page.click("[data-tab='team']");
    const teamState = await readPanel(page);
    ck("예비 검수 없이 팀 활동 결과 표 채워짐", teamState.teamTableRows > 0, `${teamState.teamTableRows}행`);
    ck("팀 행 3개", teamState.teamTableRows === 3, teamState.teamRowNames.join(", "));
    ck(
      "미배정 행 없음",
      !teamState.teamRowNames.includes("미배정"),
      teamState.teamRowNames.join(", "),
    );
    ck("팀 수 = 3", teamState.teamMetrics["팀 수"] === "3", teamState.teamMetrics["팀 수"]);
    ck(
      "전적 = 0승 3패",
      teamState.teamMetrics["전적"] === "0승 3패",
      teamState.teamMetrics["전적"],
    );
    ck("패배 팀 수 = 3", teamState.teamMetrics["패배 팀 수"] === "3", teamState.teamMetrics["패배 팀 수"]);
    ck("승리 팀 수 = 0", teamState.teamMetrics["승리 팀 수"] === "0", teamState.teamMetrics["승리 팀 수"]);
    // 파트 수는 하드코딩하지 않는다 — 실제 팀 행 partCount 의 합과 같은지(구조)만 본다.
    //   ⚠ resolver 통일로 크루가 미배정 → 실제 팀으로 이동하면 그 팀의 distinct 파트가 늘 수 있다
    //     (실측: 사운드(T) 2→3, 합계 7→8). 값 고정 단언은 그 정정을 회귀로 오판한다.
    const partSum = teamState.teamRowNames.reduce(
      (a, n) => a + (teamState.teamPartsByName[n] ?? 0),
      0,
    );
    ck(
      "파트 수 = 실제 팀 partCount 합",
      teamState.teamMetrics["파트 수"] === String(partSum),
      `상단 ${teamState.teamMetrics["파트 수"]} vs 팀 행 합 ${partSum}`,
    );
    await page.click("[data-tab='crew']");
    const afterTeam = await readPanel(page);
    ck(
      "미배정 크루는 크루 활동 결과에 그대로 유지",
      afterTeam.rowCount === baseRowCount,
      `${afterTeam.rowCount} vs base ${baseRowCount}`,
    );
    ck(
      "크루 종합 '소속 크루' 도 미배정 포함 유지",
      afterTeam.metrics["소속 크루"] === `${baseRowCount}명`,
      afterTeam.metrics["소속 크루"],
    );

    // ── 소속 SoT: 크루 표 팀별 인원 == 팀 표 totalCrew ───────────────────────
    //   종전 버그: 팀 집계만 현재 user_memberships 를 읽어, 같은 크루가 크루 표=사운드(T) /
    //   팀 집계=미배정 으로 갈렸다. 이제 둘 다 week-effective resolver 산출값을 쓴다.
    console.log("\n[소속 SoT] 크루 표 ↔ 팀 표 인원 일치");
    const crewByTeam = afterTeam.crewCountByTeam;
    const teamTotal = teamState.teamTotalByName;
    const teamNames = Object.keys(teamTotal);
    const perTeamBad = teamNames.filter((n) => (crewByTeam[n] ?? 0) !== teamTotal[n]);
    ck(
      "팀별 인원 일치(크루 표 소속 팀 컬럼 vs 팀 표 소속 크루)",
      perTeamBad.length === 0,
      teamNames.map((n) => `${n}: 크루표 ${crewByTeam[n] ?? 0} / 팀표 ${teamTotal[n]}`).join(" · "),
    );
    ck(
      "사운드(T) 인원이 크루 표와 팀 표에서 동일",
      (crewByTeam["사운드(T)"] ?? 0) === (teamTotal["사운드(T)"] ?? -1),
      `크루표 ${crewByTeam["사운드(T)"] ?? 0} / 팀표 ${teamTotal["사운드(T)"] ?? "없음"}`,
    );
    ck(
      "크루 표에 '미배정' 소속 행 없음",
      !Object.keys(crewByTeam).includes("미배정") && !Object.keys(crewByTeam).includes("-"),
      Object.entries(crewByTeam).map(([k, v]) => `${k}=${v}`).join(", "),
    );
    const sumTeamTotal = teamNames.reduce((a, n) => a + teamTotal[n], 0);
    ck(
      "Σ 팀 totalCrew == 상단 소속 크루 수",
      `${sumTeamTotal}명` === afterTeam.metrics["소속 크루"],
      `${sumTeamTotal} vs ${afterTeam.metrics["소속 크루"]}`,
    );
    // 파트도 같은 SoT 인지 — 팀 표 partCount == 크루 표 소속 파트 컬럼의 distinct 수.
    const partBad = teamNames.filter(
      (n) => (afterTeam.crewPartsByTeam[n]?.length ?? 0) !== teamState.teamPartsByName[n],
    );
    ck(
      "팀별 파트 수 == 크루 표 distinct 파트 수",
      partBad.length === 0,
      teamNames
        .map((n) => `${n}: 크루표 ${(afterTeam.crewPartsByTeam[n] ?? []).join("/") || "없음"} (${afterTeam.crewPartsByTeam[n]?.length ?? 0}) vs 팀표 ${teamState.teamPartsByName[n]}`)
        .join(" · "),
    );

    // ── 실제 HTTP(브라우저 DOM 아님) — 같은 불변식을 API 응답 JSON 으로 확인 ──
    console.log("\n[HTTP] 예비 검수 API 응답에서 동일 불변식");
    const cookieHeader = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    for (const qsMode of ["", "?mode=test"]) {
      const url = `${BASE}/api/admin/team-parts/info/crew-week-results/${ORG}/${weekId}${qsMode ? `${qsMode}&` : "?"}action=preview`;
      const res = await fetch(url, { headers: { cookie: cookieHeader } });
      const json = await res.json();
      ck(`HTTP 200 (${qsMode || "일반"})`, res.ok && json.success === true, `status=${res.status}`);
      if (!json.success) continue;
      const pv = json.data.preview;
      const byTeam = new Map();
      for (const c of pv.crewResults) {
        if (c.result === "not_applicable") continue;
        const t = (c.teamName ?? "").trim();
        byTeam.set(t, (byTeam.get(t) ?? 0) + 1);
      }
      const bad = pv.teamResults.filter((t) => (byTeam.get(t.teamName) ?? 0) !== t.totalCrew);
      ck(
        `  crewResults 팀별 인원 == teamResults.totalCrew (${qsMode || "일반"})`,
        bad.length === 0,
        pv.teamResults.map((t) => `${t.teamName}: ${byTeam.get(t.teamName) ?? 0}/${t.totalCrew}`).join(" · "),
      );
      ck(
        `  사운드(T) HTTP 인원 일치 (${qsMode || "일반"})`,
        (byTeam.get("사운드(T)") ?? 0) ===
          (pv.teamResults.find((t) => t.teamName === "사운드(T)")?.totalCrew ?? -1),
        `crewResults ${byTeam.get("사운드(T)") ?? 0} / teamResults ${pv.teamResults.find((t) => t.teamName === "사운드(T)")?.totalCrew}`,
      );
      ck(
        `  teamResults 에 teamId=null 없음 (${qsMode || "일반"})`,
        pv.teamResults.every((t) => t.teamId != null),
        pv.teamResults.map((t) => `${t.teamName}:${t.teamId ? "ok" : "NULL"}`).join(", "),
      );
      ck(
        `  Σ totalCrew == memberCount (${qsMode || "일반"})`,
        pv.teamResults.reduce((a, t) => a + t.totalCrew, 0) === pv.memberCount,
        `${pv.teamResults.reduce((a, t) => a + t.totalCrew, 0)} vs ${pv.memberCount}`,
      );
    }

    // ── 크루명 → 회원 상세 링크 ─────────────────────────────────────────────
    console.log("\n[크루명 링크] /admin/members/{userId}");
    const links = await page.$$eval("[data-crew-name-link]", (ns) =>
      ns.map((n) => ({
        userId: n.getAttribute("data-crew-name-link"),
        href: n.getAttribute("href"),
        target: n.getAttribute("target"),
        text: n.textContent.trim(),
      })),
    );
    ck("모든 크루 행에 링크가 있다", links.length === afterTeam.rowCount, `${links.length}/${afterTeam.rowCount}`);
    ck(
      "href = /admin/members/{그 행의 userId}",
      links.every((l) => (l.href ?? "").startsWith(`/admin/members/${l.userId}`)),
      links[0] ? `${links[0].text} → ${links[0].href}` : "링크 없음",
    );
    ck("새 탭 아님(target 미지정)", links.every((l) => l.target == null));
    // 실제로 눌러서 상세 페이지가 뜨는지(그 크루의 페이지인지) 확인.
    const first = links[0];
    await page.click(`[data-crew-name-link="${first.userId}"]`);
    await page.waitForURL((u) => u.pathname.startsWith(`/admin/members/${first.userId}`), {
      timeout: 30000,
    });
    ck("클릭 시 현재 탭에서 회원 상세로 이동", page.url().includes(`/admin/members/${first.userId}`), page.url());
    ck("페이지 수 1개(새 탭 미생성)", ctx.pages().length === 1, `${ctx.pages().length}`);
    await page.goBack({ waitUntil: "networkidle" });
    await page.waitForSelector("[data-crew-week-publish]", { timeout: 30000 });

    // mode=test 에서도 동일 — 컨텍스트가 href 로 전달돼야 한다.
    await page.goto(`${detailUrl}?mode=test`, { waitUntil: "networkidle" });
    await readPanel(page);
    const testLinks = await page.$$eval("[data-crew-name-link]", (ns) =>
      ns.map((n) => ({ userId: n.getAttribute("data-crew-name-link"), href: n.getAttribute("href") })),
    );
    ck(
      "mode=test 도 같은 경로 + mode 컨텍스트 유지",
      testLinks.length > 0 &&
        testLinks.every(
          (l) => (l.href ?? "").startsWith(`/admin/members/${l.userId}`) && (l.href ?? "").includes("mode=test"),
        ),
      testLinks[0]?.href ?? "링크 없음",
    );
    await page.goto(detailUrl, { waitUntil: "networkidle" });
    await readPanel(page);
    await page.click("[data-tab='crew']").catch(() => {});

    // ── 성장성공(주차) = 고객 앱 CrewRankShowcase.cumulativeSuccessWeeks 동일 원천 ──
    console.log("\n[성장성공(주차)] 고객 앱 원천과 동일");
    const userIds = Object.keys(afterTeam.cumWeeksByUser);
    const expected = await expectedCumWeeksByUser(sb, userIds, weekId);
    const cumMismatch = userIds.filter((uid) => {
      const shown = afterTeam.cumWeeksByUser[uid];
      const exp = expected.get(uid);
      return exp == null ? shown !== "-" : shown !== `${exp}주`;
    });
    ck(
      "표시값이 weekly-card snapshot(accumulatedApprovedWeeks)과 1:1 일치",
      cumMismatch.length === 0,
      cumMismatch.length
        ? cumMismatch
            .slice(0, 3)
            .map((u) => `${u.slice(0, 8)}: 표시=${afterTeam.cumWeeksByUser[u]} 기대=${expected.get(u)}`)
            .join(" / ")
        : `${userIds.length}명 일치`,
    );
    ck(
      "'-' 로 남은 행 없음(원천 있는 크루)",
      userIds.filter((u) => afterTeam.cumWeeksByUser[u] === "-" && expected.has(u)).length === 0,
    );
    ck(
      "0 은 '0주' 로 표시(0 폴백/공백 아님)",
      userIds.every((u) => expected.get(u) !== 0 || afterTeam.cumWeeksByUser[u] === "0주"),
      `0주 대상 ${[...expected.values()].filter((v) => v === 0).length}명`,
    );

    // 공표 후 새로고침에도 동일(= snapshot 에 저장된 값으로 재현).
    await page.reload({ waitUntil: "networkidle" });
    const reloaded = await readPanel(page);
    ck(
      "새로고침 후에도 성장성공(주차) 동일",
      userIds.every((u) => reloaded.cumWeeksByUser[u] === afterTeam.cumWeeksByUser[u]),
    );
    await page.click("[data-tab='team']");
    const reloadedTeam = await readPanel(page);
    ck(
      "새로고침 후에도 팀 3행 · 미배정 없음",
      reloadedTeam.teamTableRows === 3 && !reloadedTeam.teamRowNames.includes("미배정"),
      reloadedTeam.teamRowNames.join(", "),
    );
    ck(
      "새로고침 후에도 팀 수 3 · 전적 0승 3패",
      reloadedTeam.teamMetrics["팀 수"] === "3" && reloadedTeam.teamMetrics["전적"] === "0승 3패",
      `${reloadedTeam.teamMetrics["팀 수"]} / ${reloadedTeam.teamMetrics["전적"]}`,
    );
    await page.click("[data-tab='crew']");

    // ── B. 검수 완료 + 새 예비 결과 ─────────────────────────────────────────
    console.log("\n[B] 검수 완료 + 새 예비 결과");
    await page.click("[data-action-preview]");
    await dismissAlert(page);
    await page.waitForSelector("[data-summary-source='preview']", { timeout: 20000 });
    s = await readPanel(page);
    ck("새 예비 결과 표시", s.summarySource === "preview", `source=${s.summarySource}`);
    ck("재공표 활성", s.publishEnabled && s.publishKind === "republish", s.publishLabel ?? "");
    ck("공표 취소 활성", s.unpublishPresent && s.unpublishEnabled);
    ck("예비 검수 재실행 가능", s.previewEnabled);
    ck("상태는 검수 완료 유지", s.step === "completed", `step=${s.step}`);
    ck(
      "공표 결과 유지 안내 노출",
      await page.$eval("[data-summary-both]", (n) => n.textContent.includes("새 예비 결과")).catch(() => false),
    );

    // ── C. 공표 취소 직후 ───────────────────────────────────────────────────
    console.log("\n[C] 공표 취소 직후");
    await actAndAwaitPost(page, weekId, "[data-action-unpublish]");
    await page.waitForFunction(
      () => !document.querySelector("[data-action-unpublish]"),
      null,
      { timeout: 60000 },
    );
    await page.waitForSelector("[data-details-base]", { timeout: 30000 });
    s = await readPanel(page);
    ck("상태 = 집계 중", s.step === "aggregating", `step=${s.step}`);
    ck("공표 취소 버튼 숨김", !s.unpublishPresent);
    ck("공표 버튼 비활성(예비도 함께 비워짐)", s.publishPresent && !s.publishEnabled);
    ck("base 행 유지", s.rowCount > 0, `${s.rowCount}행`);
    ck(
      "결과 컬럼 '-'",
      s.rankCells.every((v) => v === "-") && s.resultCells.every((v) => v === "-"),
      `등수 uniq=${[...new Set(s.rankCells)].join(",")} / 결과 uniq=${[...new Set(s.resultCells)].join(",")}`,
    );
    ck(
      "상단 종합 지표 전부 '-'",
      Object.values(s.metrics).every((v) => v === "-"),
      JSON.stringify(s.metrics),
    );

    // 다른 어드민 화면(통합 목록)에서도 비노출인지.
    await page.goto(`${BASE}${PATH}`, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-week-row]", { timeout: 30000 });
    const listCell = await page.evaluate(
      ([wid, org]) => {
        const n = [...document.querySelectorAll("[data-cell-week]")].find(
          (e) =>
            e.getAttribute("data-cell-week") === wid && e.getAttribute("data-cell-org") === org,
        );
        return n
          ? {
              displayStatus: n.getAttribute("data-display-status"),
              reviewStatus: n.getAttribute("data-review-status"),
              text: n.innerText.replace(/\s+/g, " "),
            }
          : null;
      },
      [weekId, ORG],
    );
    ck("목록 셀 존재", listCell != null, JSON.stringify(listCell));
    ck(
      "목록에서 검수 완료가 아님(결과 비노출)",
      listCell?.displayStatus === "aggregating",
      JSON.stringify(listCell),
    );

    // ── 모드 파리티 ─────────────────────────────────────────────────────────
    console.log("\n[모드] 일반 / mode=test 동일 상태 전이");
    await page.goto(`${detailUrl}?mode=test`, { waitUntil: "networkidle" });
    const t = await readPanel(page);
    ck("mode=test 도 동일 단계", t.step === s.step, `${t.step} vs ${s.step}`);
    ck("mode=test 도 동일 버튼 상태", t.publishEnabled === s.publishEnabled && t.unpublishPresent === s.unpublishPresent);
    ck("mode=test 도 동일 행 수", t.rowCount === s.rowCount, `${t.rowCount} vs ${s.rowCount}`);
  } finally {
    await browser.close();
    // 원래 상태로 복원 — legacy 검수 완료(published · 활성 snapshot 없음).
    //   중간 실패로 활성 run 이 남았을 수 있으므로 여기서도 반드시 철회한다(다음 회차 전제 보장).
    const left = await revertActiveRuns(sb, weekId);
    for (const row of before ?? []) {
      await sb
        .from("cluster4_week_org_result_states")
        .update({ status: row.status })
        .eq("week_id", row.week_id)
        .eq("organization_slug", row.organization_slug)
        .eq("scope", row.scope);
    }
    console.log(
      `\n원래 상태로 복원 완료(활성 run ${left}건 철회 · org 검수 상태 원복. finalize run 은 reverted 이력으로 남음).`,
    );
  }

  console.log(fail === 0 ? "\n전부 PASS" : `\n실패 ${fail}건`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
