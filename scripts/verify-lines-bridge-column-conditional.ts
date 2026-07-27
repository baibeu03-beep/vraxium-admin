/**
 * 검증: '개설 연결' 조건부 컬럼 (/admin/lines/register · /admin/lines/info 공유 컴포넌트).
 *   npx tsx --env-file=.env.local scripts/verify-lines-bridge-column-conditional.ts
 *
 * 검증 범위
 *   A) HTTP — 일반 경로 vs mode=test&actAsTestUserId 경로의 GET 응답 shape 동일성
 *   B) 브라우저 — 전건 연결 상태에서 컬럼 미노출(두 페이지)
 *   C) 미연결 fixture 3건(info/experience/competency) 생성 → 컬럼 + 복구 버튼 노출
 *   D) [개설 연결] 클릭 → 해당 행만 연결 상태로 갱신(셀 '—')·컬럼은 유지
 *   E) 마지막 미연결 행 연결 → **새로고침 없이** 헤더/셀 전체 소멸
 *   F) 두 페이지 동일 동작
 *
 * fixture 는 createLineRegistration() 으로 직접 만든다 — 등록 API 를 쓰면 자동 브리지가
 * 걸려 "미연결" 상태를 만들 수 없다. 종료 시 생성물(등록·브리지 마스터) 전부 정리한다.
 *
 * ⚠ 공용 Table 은 20행/페이지 페이지네이션이 기본이다(lib/tablePagination). fixture 는 정렬상
 *   뒤쪽 페이지에 놓이므로 헤더/버튼 단언 전에 반드시 해당 행이 있는 페이지로 이동한다.
 *   컬럼 노출 판정은 "표시 중인 페이지"가 아니라 필터 결과 전체 기준이므로, 어느 페이지에
 *   있든 헤더는 동일하게 노출된다 — 그 성질도 함께 검증한다.
 */
import { chromium, type Page } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { createLineRegistration } from "@/lib/adminLineRegistrationsData";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BRIDGE_HEADER = "개설 연결";

type RegistrationsResponse = {
  success?: boolean;
  data?: { rows?: Array<Record<string, unknown>>; total?: number };
};
type BridgeStateRow = { bridged_master_id: string | null };

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const serviceKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

async function adminSessionCookies() {
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
      setAll: (items) => captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  await server.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return captured;
}

async function actorAdminId(): Promise<string> {
  const { data } = await sb.from("admin_users").select("id").eq("email", adminEmail).maybeSingle();
  if (!data) throw new Error("admin_users row not found for " + adminEmail);
  return (data as { id: string }).id;
}

async function headerLabels(page: Page): Promise<string[]> {
  const raw = await page.locator("table thead th").allTextContents();
  return raw.map((t) => t.replace(/\s+/g, " ").trim());
}

// 스켈레톤 행에는 [수정] 버튼이 없다 → 그 버튼 등장이 "실데이터 렌더 완료" 신호.
async function waitTable(page: Page) {
  await page.waitForSelector("table tbody tr", { timeout: 60000 });
  await page
    .locator("tbody")
    .getByRole("button", { name: "수정" })
    .first()
    .waitFor({ state: "visible", timeout: 60000 });
}

async function totalPages(page: Page): Promise<number> {
  const nav = page.getByRole("navigation", { name: "테이블 페이지 이동" });
  if ((await nav.count()) === 0) return 1;
  const t = (await nav.locator("span[aria-live='polite']").textContent()) ?? "1 / 1";
  return Number(t.split("/")[1]?.trim() ?? 1);
}

async function gotoPage1(page: Page) {
  const prev = page.getByRole("button", { name: "이전 페이지" });
  while ((await prev.count()) > 0 && (await prev.isEnabled())) {
    await prev.click();
    await page.waitForTimeout(120);
  }
}

// 해당 라인 코드가 있는 페이지로 이동. 못 찾으면 false.
async function gotoRowPage(page: Page, code: string): Promise<boolean> {
  await gotoPage1(page);
  const pages = await totalPages(page);
  for (let i = 0; i < pages; i++) {
    if ((await page.locator("tbody tr", { hasText: code }).count()) > 0) return true;
    const next = page.getByRole("button", { name: "다음 페이지" });
    if ((await next.count()) === 0 || !(await next.isEnabled())) break;
    await next.click();
    await page.waitForTimeout(150);
  }
  return (await page.locator("tbody tr", { hasText: code }).count()) > 0;
}

// 전 페이지를 돌며 개설 연결 컬럼 셀 텍스트를 모은다(끝나면 1페이지로 복귀).
async function collectBridgeCells(page: Page): Promise<string[]> {
  const heads = await headerLabels(page);
  const idx = heads.indexOf(BRIDGE_HEADER) + 1;
  if (idx === 0) return [];
  await gotoPage1(page);
  const pages = await totalPages(page);
  const out: string[] = [];
  for (let i = 0; i < pages; i++) {
    const cells = await page.locator(`tbody tr td:nth-child(${idx})`).allTextContents();
    out.push(...cells.map((t) => t.replace(/\s+/g, " ").trim()));
    const next = page.getByRole("button", { name: "다음 페이지" });
    if ((await next.count()) === 0 || !(await next.isEnabled())) break;
    await next.click();
    await page.waitForTimeout(150);
  }
  await gotoPage1(page);
  return out;
}

async function bridgeCellOf(page: Page, code: string): Promise<string> {
  const heads = await headerLabels(page);
  const idx = heads.indexOf(BRIDGE_HEADER) + 1;
  if (idx === 0) return "(컬럼 없음)";
  const txt = await page
    .locator("tbody tr", { hasText: code })
    .locator(`td:nth-child(${idx})`)
    .textContent();
  return (txt ?? "").replace(/\s+/g, " ").trim();
}

async function main() {
  const stamp = Date.now();
  const actor = await actorAdminId();
  const cookies = await adminSessionCookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  const createdRegIds: string[] = [];
  const createdMasters: Array<{ table: string; id: string }> = [];

  // ── A) HTTP: 일반 경로 vs 테스트 모드 경로 ───────────────────────────────
  console.log("=== A) HTTP — 일반 / mode=test 응답 shape 동일성 ===");
  const HUBS = ["info", "experience", "competency"] as const;
  for (const h of HUBS) {
    const get = async (qs: string) => {
      const res = await fetch(`${baseUrl}/api/admin/lines/registrations?hub=${h}&limit=200${qs}`, {
        headers: { cookie: cookieHeader },
      });
      return { status: res.status, json: (await res.json()) as RegistrationsResponse };
    };
    const plain = await get("");
    const test = await get("&mode=test&actAsTestUserId=00000000-0000-0000-0000-000000000000");
    const keysOf = (r: { json: RegistrationsResponse }) =>
      Object.keys(r.json?.data?.rows?.[0] ?? {}).sort().join(",");
    check(
      `hub=${h} — status/DTO 키/전체 응답 동일`,
      plain.status === test.status &&
        keysOf(plain) === keysOf(test) &&
        JSON.stringify(plain.json) === JSON.stringify(test.json),
      `status=${plain.status}/${test.status}, rows=${plain.json?.data?.rows?.length}`,
    );
    const row0 = plain.json?.data?.rows?.[0];
    check(
      `hub=${h} — 브리지 DTO 필드 보존(bridgedMasterId/bridgedAt/pointActivityTypeId)`,
      !!row0 && "bridgedMasterId" in row0 && "bridgedAt" in row0 && "pointActivityTypeId" in row0,
    );
  }

  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
    await ctx.addCookies(
      cookies.map((c) => ({ name: c.name, value: c.value, domain: "localhost", path: "/" })),
    );
    const page = await ctx.newPage();
    const PAGES = ["/admin/lines/register", "/admin/lines/info"] as const;

    // ── B) 전건 연결 상태 → 컬럼 미노출 ───────────────────────────────────
    console.log("\n=== B) 전건 연결 상태 — 컬럼 미노출 (두 페이지) ===");
    let baselineCols = 0;
    for (const path of PAGES) {
      await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await waitTable(page);
      const heads = await headerLabels(page);
      baselineCols = heads.length;
      check(
        `${path} — '개설 연결' 헤더 없음`,
        !heads.includes(BRIDGE_HEADER),
        `${heads.length}컬럼: ${heads.join(" | ")}`,
      );
      const cellCount = await page.locator("tbody tr").first().locator("td").count();
      check(
        `${path} — 셀 개수 = 헤더 개수(${heads.length})`,
        cellCount === heads.length,
        `td=${cellCount}`,
      );
    }

    // ── C) 미연결 fixture 생성 ────────────────────────────────────────────
    console.log("\n=== C) 미연결 fixture 3건 생성 → 컬럼/버튼 노출 ===");
    const base = {
      mainTitleMode: "fixed" as const,
      mainTitle: "조건부 컬럼 검증 타이틀",
      unitLink: "-",
      estimatedDurationMinutes: 60 as const,
      organizationSlug: "encre" as const,
      pointActivityTypeId: null,
      partnerCompany: null,
      companyLogoUrl: null,
      managerName: null,
      managerPosition: null,
      managerJob: null,
      managerProfileKey: null,
    };
    const codeInfo = `IFCC-${stamp}`;
    const codeExp = `EXCC-${stamp}`;
    const codeComp = `CPCC-${stamp}`;
    const regInfo = await createLineRegistration(
      { ...base, lineName: `조건부컬럼 정보 ${stamp}`, hub: "info", lineType: "일반", lineCode: codeInfo },
      actor,
    );
    createdRegIds.push(regInfo.id);
    const regExp = await createLineRegistration(
      { ...base, lineName: `조건부컬럼 경험 ${stamp}`, hub: "experience", lineType: "분석", lineCode: codeExp },
      actor,
    );
    createdRegIds.push(regExp.id);
    const regComp = await createLineRegistration(
      { ...base, lineName: `조건부컬럼 역량 ${stamp}`, hub: "competency", lineType: "원리", lineCode: codeComp },
      actor,
    );
    createdRegIds.push(regComp.id);
    check(
      "fixture 3건 = 전부 미연결(bridged_master_id/point_activity_type_id null)",
      !regInfo.pointActivityTypeId && !regExp.bridgedMasterId && !regComp.bridgedMasterId,
    );

    for (const path of PAGES) {
      await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded", timeout: 90000 });
      await waitTable(page);
      const heads = await headerLabels(page);
      check(
        `${path} — '개설 연결' 헤더 노출 (+1컬럼)`,
        heads.includes(BRIDGE_HEADER) && heads.length === baselineCols + 1,
        `${heads.length}컬럼`,
      );
      // 컬럼 노출 판정은 페이지네이션 현재 페이지가 아니라 필터 결과 전체 기준.
      check(
        `${path} — 미연결 행이 1페이지에 없어도 헤더 노출 유지`,
        (await page.locator("tbody tr", { hasText: codeComp }).count()) === 0 &&
          heads.includes(BRIDGE_HEADER),
      );
      check(
        `${path} — info 미연결 행 [활동유형 연결] 버튼`,
        (await gotoRowPage(page, codeInfo)) &&
          (await page
            .locator("tbody tr", { hasText: codeInfo })
            .getByRole("button", { name: "활동유형 연결" })
            .count()) === 1,
      );
      for (const [label, code] of [["경험", codeExp], ["역량", codeComp]] as const) {
        check(
          `${path} — ${label} 미연결 행 [개설 연결] 버튼`,
          (await gotoRowPage(page, code)) &&
            (await page
              .locator("tbody tr", { hasText: code })
              .getByRole("button", { name: BRIDGE_HEADER })
              .count()) === 1,
        );
      }
      const cells = await collectBridgeCells(page);
      const dash = cells.filter((t) => t === "—").length;
      check(
        `${path} — 연결 완료 행은 '—' (연결 완료 배지 미표시)`,
        cells.length > 0 && !cells.some((t) => t.includes("연결 완료")) && dash === cells.length - 3,
        `'—' ${dash}건 / 전체 ${cells.length}건 · 미연결 3건`,
      );
    }

    // ── D/E) 클릭 → 행 갱신 → 마지막 연결 시 컬럼 소멸 (새로고침 없이) ──────
    console.log("\n=== D/E) 개설 연결 클릭 → 행 갱신 → 컬럼 즉시 소멸 ===");
    // info fixture 는 브리지가 아니라 수정 모달이 복구 경로 → 여기서 제거하고 경험/역량만 남긴다.
    await sb.from("line_registrations").delete().eq("id", regInfo.id);
    createdRegIds.splice(createdRegIds.indexOf(regInfo.id), 1);

    await page.goto(`${baseUrl}/admin/lines/info`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await waitTable(page);
    check("/admin/lines/info — 미연결 2건 남음 → 컬럼 유지", (await headerLabels(page)).includes(BRIDGE_HEADER));

    // (1) 경험 fixture 연결 — 해당 행만 '—' 로 바뀌고 컬럼은 유지되어야 한다.
    await gotoRowPage(page, codeExp);
    await page
      .locator("tbody tr", { hasText: codeExp })
      .getByRole("button", { name: BRIDGE_HEADER })
      .click();
    await page.waitForSelector("text=개설 연결 완료", { timeout: 20000 });
    await page.waitForTimeout(600);
    {
      const cell = await bridgeCellOf(page, codeExp);
      check("경험 행 — 클릭 후 즉시 '—'(연결 상태 갱신·재조회 없음)", cell === "—", `cell='${cell}'`);
      check("역량 행 미연결 → 컬럼 유지", (await headerLabels(page)).includes(BRIDGE_HEADER));
    }
    const { data: expAfterRow } = await sb
      .from("line_registrations")
      .select("bridged_master_id")
      .eq("id", regExp.id)
      .maybeSingle();
    const expAfter = expAfterRow as BridgeStateRow | null;
    check("DB — 경험 bridged_master_id 기록", Boolean(expAfter?.bridged_master_id));
    if (expAfter?.bridged_master_id) {
      createdMasters.push({
        table: "cluster4_experience_line_masters",
        id: expAfter.bridged_master_id,
      });
    }

    // (2) 마지막 미연결(역량) 연결 — 새로고침 없이 헤더/셀 전체가 사라져야 한다.
    check("역량 행 [개설 연결] 버튼 잔존", await gotoRowPage(page, codeComp));
    await page
      .locator("tbody tr", { hasText: codeComp })
      .getByRole("button", { name: BRIDGE_HEADER })
      .click();
    await page.waitForSelector("text=개설 연결 완료", { timeout: 20000 });
    await page.waitForTimeout(800);
    {
      const heads = await headerLabels(page);
      check(
        "마지막 미연결 연결 → '개설 연결' 헤더 즉시 소멸 (reload 없음)",
        !heads.includes(BRIDGE_HEADER) && heads.length === baselineCols,
        `${heads.length}컬럼`,
      );
      const cellCount = await page.locator("tbody tr").first().locator("td").count();
      check("셀 개수도 원복 (헤더/셀 정합)", cellCount === baselineCols, `td=${cellCount}`);
      check(
        "잔존 [개설 연결] 버튼 0개",
        (await page.locator("tbody").getByRole("button", { name: BRIDGE_HEADER }).count()) === 0,
      );
    }
    const { data: compAfterRow } = await sb
      .from("line_registrations")
      .select("bridged_master_id")
      .eq("id", regComp.id)
      .maybeSingle();
    const compAfter = compAfterRow as BridgeStateRow | null;
    check("DB — 역량 bridged_master_id 기록", Boolean(compAfter?.bridged_master_id));
    if (compAfter?.bridged_master_id) {
      createdMasters.push({
        table: "cluster4_competency_line_masters",
        id: compAfter.bridged_master_id,
      });
    }

    // ── F) 두 페이지 동일 동작 재확인 ─────────────────────────────────────
    console.log("\n=== F) /admin/lines/register 동일 동작 ===");
    await page.goto(`${baseUrl}/admin/lines/register`, { waitUntil: "domcontentloaded", timeout: 90000 });
    await waitTable(page);
    {
      const heads = await headerLabels(page);
      check(
        "register — 전건 연결 복귀 후 컬럼 미노출",
        !heads.includes(BRIDGE_HEADER) && heads.length === baselineCols,
        `${heads.length}컬럼`,
      );
    }
    await page.screenshot({
      path: "claudedocs/browser-lines-bridge-column-conditional.png",
      fullPage: true,
    });
    console.log("  스크린샷: claudedocs/browser-lines-bridge-column-conditional.png");

    await ctx.close();
  } finally {
    await browser.close();
    console.log("\n=== 정리 ===");
    for (const m of createdMasters) {
      const fk =
        m.table === "cluster4_experience_line_masters"
          ? "experience_line_master_id"
          : "competency_line_master_id";
      const { count: used } = await sb
        .from("cluster4_lines")
        .select("*", { count: "exact", head: true })
        .eq(fk, m.id);
      if ((used ?? 0) === 0) {
        await sb.from(m.table).delete().eq("id", m.id);
        console.log(`  - ${m.table} ${m.id} 삭제 ✓`);
      } else {
        console.log(`  ! ${m.table} ${m.id} — 개설 ${used}건 참조 중, 보존`);
      }
    }
    if (createdRegIds.length > 0) {
      await sb.from("line_registrations").delete().in("id", createdRegIds);
      console.log(`  - 검증 등록 ${createdRegIds.length}건 삭제 ✓`);
    }
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
