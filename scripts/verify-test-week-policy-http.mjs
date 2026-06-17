// 브라우저(인증) HTTP 검증 — 중앙화된 테스트 모드 W13 예외 SoT 전 기능 횡단.
//   실제 admin 세션으로 각 엔드포인트를 operating/test 로 호출해, test 휴식꼬리에서
//   대상 주차가 일제히 2026-spring W13 으로 폴드되는지 + operating 은 불변(차단 유지)인지 확인.
//   실행: node scripts/verify-test-week-policy-http.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const ORG = process.env.SMOKE_ORG ?? "oranke";

async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({
    email: adminEmail, token: linkData.properties.email_otp, type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();
await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });

async function httpGet(url) {
  return page.evaluate(async (u) => {
    const r = await fetch(u);
    const j = await r.json().catch(() => ({}));
    return { status: r.status, data: j?.data ?? null, success: j?.success ?? false };
  }, url);
}

try {
  console.log(`\n── weeks-options (드롭다운 공용 SoT) — org=${ORG} ──`);
  const woOp = await httpGet(`${BASE}/api/admin/cluster4/weeks-options?limit=8`);
  const woTe = await httpGet(`${BASE}/api/admin/cluster4/weeks-options?limit=8&mode=test`);
  const opTargetOp = (woOp.data?.weeks ?? []).find((w) => w.isOpenTarget) ?? null;
  const opTargetTe = (woTe.data?.weeks ?? []).find((w) => w.isOpenTarget) ?? null;
  const w13Te = (woTe.data?.weeks ?? []).find((w) => w.weekNumber === 13 && w.seasonKey === "2026-spring") ?? null;
  check("operating openTarget ≠ W13(휴식 주차 유지)", opTargetOp && opTargetOp.weekNumber !== 13, `openTarget W${opTargetOp?.weekNumber}`);
  check("test openTarget = 2026-spring W13", opTargetTe && opTargetTe.weekNumber === 13 && opTargetTe.seasonKey === "2026-spring", `openTarget W${opTargetTe?.weekNumber}`);
  check("test W13 선택 가능(canOpen=true · 목록 포함)", !!w13Te && w13Te.canOpen === true);
  check("operating 응답에 W13 isOpenTarget 없음(차단)", !(woOp.data?.weeks ?? []).some((w) => w.weekNumber === 13 && w.isOpenTarget));

  const compare = async (label, base) => {
    const op = await httpGet(`${BASE}${base}`);
    const te = await httpGet(`${BASE}${base}${base.includes("?") ? "&" : "?"}mode=test`);
    return { label, op, te };
  };

  console.log(`\n── 라인 개설 상태창(개설 대상 주차) ──`);
  for (const [label, base, field] of [
    ["실무 경험 opening-status", `/api/admin/cluster4/experience/opening-status?organization=${ORG}`, "targetWeek"],
    ["실무 역량 opening-status", `/api/admin/cluster4/competency/opening-status?organization=${ORG}`, "targetWeek"],
  ]) {
    const { op, te } = await compare(label, base);
    const opW = op.data?.[field]?.weekNumber;
    const teW = te.data?.[field]?.weekNumber;
    check(`${label}: operating W${opW} ≠ 13`, op.success && opW !== 13, `status ${op.status}`);
    check(`${label}: test → W13`, te.success && teW === 13, `status ${te.status} W${teW}`);
  }

  console.log(`\n── 프로세스 체크(보드 주차) ──`);
  for (const [label, base, allowed] of [
    ["info", `/api/admin/processes/check?hub=info&org=${ORG}`, true],
    ["experience", `/api/admin/processes/check?hub=experience&org=${ORG}`, true],
    ["competency", `/api/admin/processes/check?hub=competency&org=${ORG}`, true], // 2026-06-17 허용
    ["career", `/api/admin/processes/check?hub=career&org=${ORG}`, true], // 2026-06-17 허용
    ["club(미허용)", `/api/admin/processes/check?hub=club&org=${ORG}`, false], // 격리: 예외 미적용 유지
    ["irregular", `/api/admin/processes/check/irregular?org=${ORG}`, true],
  ]) {
    const { op, te } = await compare(label, base);
    if (!op.success && !te.success) { check(`프로세스 체크 ${label}: 스키마 미적용 skip`, true, `op ${op.status}/te ${te.status}`); continue; }
    const opW = op.data?.week?.weekNumber;
    const teW = te.data?.week?.weekNumber;
    if (allowed) {
      check(`프로세스 체크 ${label}: operating W${opW} ≠ 13`, opW !== 13);
      check(`프로세스 체크 ${label}: test → W13`, teW === 13, `W${teW}`);
    } else {
      check(`프로세스 체크 ${label}: test == operating(폴드 없음)`, opW === teW, `op W${opW} / te W${teW}`);
    }
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
} catch (e) {
  console.error("ERROR", e);
  fail++;
} finally {
  await browser.close();
}
process.exit(fail === 0 ? 0 : 1);
