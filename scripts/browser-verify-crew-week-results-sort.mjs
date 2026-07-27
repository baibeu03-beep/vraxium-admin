// 주차 결과(크루) 하위 전 화면 — **컬럼 정렬** 브라우저 검증(dev :3000, owner 세션).
//
//   대상 표 4종(/admin/team-parts/info/crew-week-results/*):
//     [A] 통합 매트릭스   (행=주차 × 열=클럽)              — data-crew-week-results-matrix
//     [B] 클럽 상세 13컬럼 (행=주차)                        — data-crew-week-results-detail
//     [C] 주차 세부 크루 표(14컬럼)                          — data-crew-table
//     [D] 주차 세부 팀 표 (12컬럼)                          — data-team-table
//
//   검증 방식 = **DTO 원본으로 기대 순서를 독립 계산**해 DOM 행 순서와 대조한다.
//     · 화면 문자열을 파싱해 비교하지 않는다(= 숫자/날짜가 문자열로 정렬되면 반드시 실패한다).
//     · 기대 comparator 는 lib/adminTableSort 규칙을 스크립트에서 **다시** 구현한다(독립 검산).
//   추가로: 3단계 순환(asc→desc→기본 복원) · aria-sort · 활성 컬럼 1개 · 정렬 중 API 재호출 없음 ·
//           정렬 후에도 페이지네이션 표시/총 개수 불변 · operating == test 동일 동작.
//
//   실행: node scripts/browser-verify-crew-week-results-sort.mjs
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
const API = "/api/admin/team-parts/info/crew-week-results";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const OWNER_EMAIL = "vanuatu.golden@gmail.com";

let fail = 0;
const ck = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

// ── 기대 comparator(lib/adminTableSort 규칙의 독립 재구현) ────────────────────
const isEmpty = (v) =>
  v == null ||
  (typeof v === "number" && Number.isNaN(v)) ||
  (typeof v === "string" && (v.trim() === "" || v.trim() === "-" || v.trim() === "—"));
const cmpNum = (a, b, dir) => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return dir === "asc" ? a - b : b - a;
};
const num = (v) => (isEmpty(v) ? null : Number.isNaN(Number(v)) ? null : Number(v));
const epoch = (v) => {
  if (isEmpty(v)) return null;
  if (typeof v === "number") return v;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
};
function compareValues(a, b, type, dir) {
  if (type === "number") return cmpNum(num(a), num(b), dir);
  if (type === "date") return cmpNum(epoch(a), epoch(b), dir);
  const ae = isEmpty(a);
  const be = isEmpty(b);
  if (ae && be) return 0;
  if (ae) return 1;
  if (be) return -1;
  const c = String(a).localeCompare(String(b), "ko-KR", { numeric: true, sensitivity: "base" });
  return dir === "asc" ? c : -c;
}
// 기대 순서 = 안정 정렬(동률은 원본 인덱스 유지).
function expectedOrder(rows, spec, dir, idOf) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => {
      const c = compareValues(spec.value(x.row), spec.value(y.row), spec.type, dir);
      return c !== 0 ? c : x.index - y.index;
    })
    .map((d) => idOf(d.row));
}

const STATUS_RANK = { in_progress: 0, aggregating: 1, completed: 2 };
const BATTLE_RANK = { win: 0, draw: 1, lose: 2 };
const RESULT_LABEL = {
  success: "성장 성공",
  failure: "성장 실패",
  rest: "휴식",
  not_applicable: "해당 없음",
  pending: "집계 전",
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

// 표 헤더의 정렬 버튼(도움말 돋보기와 구분) — SortableTh 의 aria-label 계약.
const SORT_BTN = 'button[aria-label*="기준 정렬"]';

async function domRowIds(page, tableSel, rowAttr) {
  return page.$$eval(`${tableSel} tbody tr[${rowAttr}]`, (rows, attr) =>
    rows.map((r) => r.getAttribute(attr)), rowAttr);
}

async function ariaSorts(page, tableSel) {
  return page.$$eval(`${tableSel} thead th`, (ths) => ths.map((t) => t.getAttribute("aria-sort")));
}

/**
 * 한 표의 전 컬럼 정렬 검증.
 *   columns[i] = { label, spec:{type,value} } — i = 헤더 인덱스(렌더 순서와 1:1).
 *   rows       = 화면이 표시하는 **기본 순서** 그대로의 DTO 행 배열(정렬 전).
 */
async function checkTable(page, { name, tableSel, rowAttr, rows, idOf, columns }) {
  console.log(`\n── ${name} (${rows.length}행 · ${columns.length}컬럼)`);
  const baseIds = await domRowIds(page, tableSel, rowAttr);
  const visible = baseIds.length;
  ck(`${name}: 행 렌더`, visible > 0, `${visible}행 표시`);
  if (visible === 0) return;
  ck(
    `${name}: 기본 순서 = 서버(DTO) 순서`,
    JSON.stringify(baseIds) === JSON.stringify(rows.map(idOf).slice(0, visible)),
    baseIds.slice(0, 3).join(","),
  );

  const ths = await page.$$(`${tableSel} thead th`);
  ck(`${name}: 헤더 수 = 컬럼 수`, ths.length === columns.length, `${ths.length}/${columns.length}`);
  const sortable = await page.$$(`${tableSel} thead th ${SORT_BTN}`);
  ck(`${name}: 전 컬럼 정렬 가능(제목 행)`, sortable.length === columns.length, `${sortable.length}개`);

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const btn = await ths[i].$(SORT_BTN);
    if (!btn) {
      ck(`${name}[${col.label}]: 정렬 버튼 존재`, false);
      continue;
    }

    // 정렬 중 API 재호출이 없어야 한다(= 화면 정렬만, DTO 재조회/재계산 없음).
    const calls = [];
    const onReq = (r) => {
      if (r.url().includes("/api/admin/")) calls.push(r.url());
    };
    page.on("request", onReq);

    // ① 오름차순
    await btn.click();
    await page.waitForTimeout(60);
    const asc = await domRowIds(page, tableSel, rowAttr);
    const expAsc = expectedOrder(rows, col.spec, "asc", idOf).slice(0, asc.length);
    ck(
      `${name}[${col.label}] 오름차순(${col.spec.type})`,
      JSON.stringify(asc) === JSON.stringify(expAsc),
      asc.length === expAsc.length ? "" : `len ${asc.length}/${expAsc.length}`,
    );
    const sortsAsc = await ariaSorts(page, tableSel);
    ck(
      `${name}[${col.label}] aria-sort=ascending(활성 1개)`,
      sortsAsc[i] === "ascending" && sortsAsc.filter((s) => s !== "none").length === 1,
      sortsAsc.filter((s) => s !== "none").join(",") || "none",
    );

    // ② 내림차순
    await btn.click();
    await page.waitForTimeout(60);
    const desc = await domRowIds(page, tableSel, rowAttr);
    const expDesc = expectedOrder(rows, col.spec, "desc", idOf).slice(0, desc.length);
    ck(
      `${name}[${col.label}] 내림차순`,
      JSON.stringify(desc) === JSON.stringify(expDesc),
    );
    const sortsDesc = await ariaSorts(page, tableSel);
    ck(`${name}[${col.label}] aria-sort=descending`, sortsDesc[i] === "descending", String(sortsDesc[i]));

    // ③ 기본 복원
    await btn.click();
    await page.waitForTimeout(60);
    const restored = await domRowIds(page, tableSel, rowAttr);
    ck(
      `${name}[${col.label}] 기본 정렬 복원`,
      JSON.stringify(restored) === JSON.stringify(baseIds),
    );
    const sortsNone = await ariaSorts(page, tableSel);
    ck(
      `${name}[${col.label}] aria-sort 전부 none`,
      sortsNone.every((s) => s === "none" || s == null),
      sortsNone.filter((s) => s && s !== "none").join(","),
    );

    page.off("request", onReq);
    ck(`${name}[${col.label}] 정렬 중 API 재호출 없음(화면 정렬만)`, calls.length === 0, calls.join(" "));
  }
}

// ── 표별 컬럼 계약(화면 렌더 순서와 1:1) ─────────────────────────────────────
const detailColumns = (cellOf) => {
  const numOf = (pick) => ({ type: "number", value: (w) => (cellOf(w) ? pick(cellOf(w)) : null) });
  return [
    { label: "상태", spec: { type: "number", value: (w) => (cellOf(w) ? STATUS_RANK[cellOf(w).displayStatus] : null) } },
    { label: "주차명", spec: { type: "date", value: (w) => w.startDate } },
    { label: "기간", spec: { type: "date", value: (w) => w.startDate } },
    { label: "클럽 활동", spec: { type: "text", value: (w) => cellOf(w)?.activityKindLabel ?? w.activityKindLabel } },
    { label: "기준 포인트 A", spec: numOf((c) => c.criterionPointA) },
    { label: "소속 크루", spec: numOf((c) => c.memberCount) },
    { label: "시즌 휴식", spec: numOf((c) => c.seasonRestCount) },
    { label: "개인 휴식", spec: numOf((c) => c.personalRestCount) },
    { label: "성장 도전", spec: numOf((c) => c.growthChallengeCount) },
    { label: "성장 성공", spec: numOf((c) => c.growthSuccessCount) },
    { label: "성장 실패", spec: numOf((c) => c.growthFailureCount) },
    { label: "성장 성공률", spec: numOf((c) => c.growthSuccessRatePercent) },
    { label: "성장 도전율", spec: numOf((c) => c.growthChallengeRatePercent) },
  ];
};

const crewColumns = (hasResult) => [
  { label: "등수", spec: { type: "number", value: (c) => c.rank } },
  { label: "크루명", spec: { type: "text", value: (c) => c.crewDisplayName ?? c.crewCode ?? c.userId.slice(0, 8) } },
  { label: "학적", spec: { type: "text", value: (c) => c.schoolName } },
  { label: "성장 결과", spec: { type: "text", value: (c) => (hasResult ? RESULT_LABEL[c.result] : null) } },
  { label: "클래스", spec: { type: "text", value: (c) => c.classLabel } },
  { label: "소속 팀", spec: { type: "text", value: (c) => c.teamName } },
  { label: "소속 파트", spec: { type: "text", value: (c) => c.partName } },
  { label: "품계", spec: { type: "number", value: (c) => c.grade } },
  { label: "액트 체크율", spec: { type: "number", value: (c) => c.actCompletionRatePercent } },
  { label: "주차 성장률", spec: { type: "number", value: (c) => c.weeklyGrowthRatePercent } },
  { label: "포인트 A", spec: { type: "number", value: (c) => c.earnedPointA } },
  { label: "포인트 B", spec: { type: "number", value: (c) => c.pointB } },
  { label: "포인트 C", spec: { type: "number", value: (c) => c.pointC } },
  { label: "성장성공(주차)", spec: { type: "number", value: (c) => c.cumulativeSuccessWeeks } },
];

const teamColumns = (hasResult) => [
  { label: "팀명", spec: { type: "text", value: (t) => t.teamName } },
  { label: "팀 결과", spec: { type: "number", value: (t) => (hasResult && t.battleResult ? BATTLE_RANK[t.battleResult] : null) } },
  { label: "팀장", spec: { type: "text", value: (t) => t.leader.displayName } },
  { label: "파트 수", spec: { type: "number", value: (t) => t.partCount } },
  { label: "소속 크루", spec: { type: "number", value: (t) => t.totalCrew } },
  { label: "심화 크루", spec: { type: "number", value: (t) => t.advancedCrew } },
  { label: "정규 크루", spec: { type: "number", value: (t) => t.regularCrew } },
  { label: "성장 도전", spec: { type: "number", value: (t) => t.challengeCrew } },
  { label: "성장 휴식", spec: { type: "number", value: (t) => t.restCrew } },
  { label: "성장 성공", spec: { type: "number", value: (t) => t.successCrew } },
  { label: "성장 실패", spec: { type: "number", value: (t) => t.failCrew } },
  { label: "승률", spec: { type: "number", value: (t) => (hasResult ? t.winRatePercent : null) } },
];

// 기본(서버) 정렬 — 화면 컴포넌트의 base 순서와 동일해야 한다.
const crewBaseOrder = (rows, hasResult) =>
  [...rows].sort((a, b) =>
    hasResult
      ? (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
        (a.grade ?? 10) - (b.grade ?? 10) ||
        (b.weeklyGrowthRatePercent ?? 0) - (a.weeklyGrowthRatePercent ?? 0) ||
        (a.crewDisplayName ?? "").localeCompare(b.crewDisplayName ?? "", "ko-KR") ||
        a.userId.localeCompare(b.userId)
      : (a.crewDisplayName ?? "").localeCompare(b.crewDisplayName ?? "", "ko-KR") ||
        a.userId.localeCompare(b.userId),
  );
const teamBaseOrder = (rows) =>
  [...rows].sort((a, b) => a.teamName.localeCompare(b.teamName, "ko-KR"));

async function runMode(page, mode) {
  const qs = mode === "test" ? "?mode=test" : "";
  const amp = mode === "test" ? "&mode=test" : "";
  console.log(`\n════════ mode=${mode} ════════`);

  // ── [A] 통합 매트릭스 ──────────────────────────────────────────────────────
  await page.goto(`${BASE}${PATH}${qs}`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-week-row]", { timeout: 30_000 });

  // 화면과 **같은 API·같은 파라미터**로 DTO 를 읽어 기대 순서를 만든다(같은 오리진에서 fetch).
  const listJson = await page.evaluate(
    async (url) => (await fetch(url, { cache: "no-store" })).json(),
    `${API}?page=1&pageSize=20${amp}`,
  );
  if (!listJson?.success) throw new Error(`API 실패: ${JSON.stringify(listJson).slice(0, 200)}`);
  const bundle = listJson.data;
  const orgs = bundle.organizations.map((o) => o.organizationSlug);
  const cellAt = (weekId, org) =>
    bundle.cells.find((c) => c.weekId === weekId && c.organizationSlug === org) ?? null;
  await checkTable(page, {
    name: `[A] 통합 매트릭스(${mode})`,
    tableSel: "[data-crew-week-results-matrix]",
    rowAttr: "data-week-row",
    rows: bundle.weeks,
    idOf: (w) => w.weekId,
    columns: [
      { label: "주차", spec: { type: "date", value: (w) => w.startDate } },
      ...orgs.map((org) => ({
        label: org,
        spec: {
          type: "number",
          value: (w) => {
            const c = cellAt(w.weekId, org);
            return c ? STATUS_RANK[c.displayStatus] : null;
          },
        },
      })),
    ],
  });

  // 정렬 후에도 페이지네이션 정보가 그대로인지(총 개수/표시 구간).
  const pagerText = await page.textContent('nav[aria-label="테이블 페이지 이동"] p').catch(() => null);
  if (pagerText) {
    const th = await page.$('[data-crew-week-results-matrix] thead th ' + SORT_BTN);
    await th.click();
    await page.waitForTimeout(80);
    const after = await page.textContent('nav[aria-label="테이블 페이지 이동"] p');
    ck("[A] 정렬 후 페이지네이션 총 개수 불변", after === pagerText, `${pagerText} → ${after}`);
    await th.click();
    await th.click();
  } else {
    console.log("    (참고) 페이지네이션 미표시 — 총 행이 1페이지 이내");
  }

  // ── [B] 클럽 상세 13컬럼 ───────────────────────────────────────────────────
  const org = orgs[0];
  const orgJson = await page.evaluate(
    async (url) => (await fetch(url, { cache: "no-store" })).json(),
    `${API}?organization=${org}&page=1&pageSize=20${amp}`,
  );
  const ob = orgJson.data;
  const cellOf = (w) => ob.cells.find((c) => c.weekId === w.weekId) ?? null;
  await page.goto(`${BASE}${PATH}/${org}${qs}`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-crew-week-results-detail] tbody tr", { timeout: 30_000 });
  await checkTable(page, {
    name: `[B] 클럽 상세(${mode}/${org})`,
    tableSel: "[data-crew-week-results-detail]",
    rowAttr: "data-week-row",
    rows: ob.weeks,
    idOf: (w) => w.weekId,
    columns: detailColumns(cellOf),
  });

  // ── [C][D] 주차 세부(크루/팀) ──────────────────────────────────────────────
  //   화면과 동일한 표시 우선순위로 소스를 고른다: 활성 공표 snapshot → base row.
  const weekId = ob.weeks[0]?.weekId;
  if (!weekId) {
    console.log("    (참고) 주차가 없어 [C][D] 생략");
    return;
  }
  const detailBase = `/api/admin/team-parts/info/crew-week-results/${org}/${weekId}`;
  const pub = await page.evaluate(
    async (url) => (await fetch(url, { cache: "no-store" })).json(),
    `${detailBase}${qs}`,
  );
  const hasSnapshot =
    pub?.data?.publication?.hasActiveSnapshot === true &&
    pub?.data?.published &&
    !pub.data.published.snapshotUnavailable;
  let crewRows = [];
  let teamRows = [];
  let hasResult = false;
  if (hasSnapshot) {
    crewRows = pub.data.published.crewResults ?? [];
    teamRows = pub.data.published.teamResults ?? [];
    hasResult = true;
  } else {
    const b = await page.evaluate(
      async (url) => (await fetch(url, { cache: "no-store" })).json(),
      `${detailBase}${qs ? `${qs}&` : "?"}action=base`,
    );
    crewRows = b?.data?.baseRows ?? [];
    teamRows = b?.data?.baseTeamRows ?? [];
  }

  await page.goto(`${BASE}${PATH}/${org}/${weekId}${qs}`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-crew-week-publish], [data-week-not-available]", { timeout: 30_000 });
  const notAvailable = await page.$("[data-week-not-available]");
  if (notAvailable) {
    console.log("    (참고) 조회 불가 주차 — [C][D] 생략");
    return;
  }

  const crewTable = await page.$("[data-crew-table]");
  if (crewTable && crewRows.length > 0) {
    const domHasResult = await page.getAttribute("[data-crew-table]", "data-crew-has-result");
    ck("[C] 결과 소스 판정 = 화면과 동일", (domHasResult === "true") === hasResult, `dom=${domHasResult}/api=${hasResult}`);
    await checkTable(page, {
      name: `[C] 주차 세부 크루(${mode})`,
      tableSel: "[data-crew-table]",
      rowAttr: "data-crew-row",
      rows: crewBaseOrder(crewRows, domHasResult === "true"),
      idOf: (c) => c.userId,
      columns: crewColumns(domHasResult === "true"),
    });
  } else {
    console.log("    (참고) 크루 행 없음 — [C] 생략");
  }

  // 팀 탭으로 전환(표시만 바뀐다).
  const teamTab = await page.$('[data-tab="team"]');
  if (teamTab && teamRows.length > 0) {
    await teamTab.click();
    await page.waitForSelector("[data-team-table]", { timeout: 30_000 });
    await checkTable(page, {
      name: `[D] 주차 세부 팀(${mode})`,
      tableSel: "[data-team-table]",
      rowAttr: "data-team-row",
      rows: teamBaseOrder(teamRows),
      idOf: (t) => t.teamName,
      columns: teamColumns(hasSnapshot),
    });
  } else {
    console.log("    (참고) 팀 행 없음 — [D] 생략");
  }
}

async function main() {
  const cookies = await sessionCookies();
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => {
    console.log(`  ✗ 페이지 예외: ${e.message}`);
    fail++;
  });

  for (const mode of ["operating", "test"]) {
    await runMode(page, mode);
  }

  await browser.close();
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — 실패 ${fail}건`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
