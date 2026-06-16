// 브라우저(인증 세션) + 실제 HTTP 검증 — 어드민 공통 수정.
//   [A] edit-windows 작성항목 드롭다운 순서 (실무 경험 > 실무 역량) — DOM
//   [B] line_code 형식 가드 — POST /api/admin/lines/registrations 'IF99A - NR0007' → 400 (write 없음)
//   [C] 아웃풋 링크 설명 ≤30 — POST /api/admin/cluster4/info-lines label 31자 → 400 (write 없음)
//   [D] 아웃풋 이미지 캡션 ≤20 — POST /api/admin/cluster4/info-lines caption 21자 → 400 (write 없음)
//   [E] 실무 경험 관리(management) 일반 크루 차단 — POST team-overall review → 422 (있을 때만)
// 사용법: SMOKE_BASE_URL=http://localhost:3000 node scripts/browser-verify-admin-common-fixes.mjs
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
const admin = createClient(SUPABASE_URL, SERVICE);

async function makeAdminCookies() {
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

let pass = 0, fail = 0, skip = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const note = (m) => console.log(`  · ${m}`);

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

async function post(url, body) {
  return page.evaluate(async ([u, b]) => {
    const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  }, [url, body]);
}

try {
  // ── [A] edit-windows 드롭다운 순서 (DOM — shadcn/Radix Select) ──
  console.log("\n[A] edit-windows 작성항목 순서");
  await page.goto(`${BASE}/admin/settings/edit-windows`, { waitUntil: "networkidle" });
  // 작성항목 Select 트리거(현재값이 cluster4 실무 라벨 중 하나)를 찾아 열고 role=option 순서를 읽는다.
  const triggers = await page.locator('[role="combobox"]').all();
  let order = { exp: -1, abil: -1, opts: [] };
  for (const t of triggers) {
    await t.click();
    await page.waitForTimeout(200);
    const opts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent?.trim() ?? ""));
    const exp = opts.findIndex((t) => t.includes("실무 경험"));
    const abil = opts.findIndex((t) => t.includes("실무 역량"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    if (exp >= 0 && abil >= 0) {
      order = { exp, abil, opts: opts.filter((t) => t.includes("실무")) };
      break;
    }
  }
  check("실무 경험 옵션 존재", order.exp >= 0, `idx=${order.exp}`);
  check("실무 역량 옵션 존재", order.abil >= 0, `idx=${order.abil}`);
  check("실무 경험이 실무 역량보다 위", order.exp >= 0 && order.abil >= 0 && order.exp < order.abil,
    `경험=${order.exp} 역량=${order.abil}`);
  note(`실무 옵션 순서: ${order.opts.join(" | ")}`);

  // ── [B] line_code 형식 가드 (HTTP, write 없음) ──
  console.log("\n[B] line_code 형식 가드 (POST registrations)");
  const badCode = await post(`${BASE}/api/admin/lines/registrations`, {
    line_name: "검증용(거부예상)", hub: "info", line_type: "일반",
    line_code: "IF99A - NR0007", main_title_mode: "variable", main_title: "-", organization_slug: "common",
  });
  check("'IF99A - NR0007' → 400 (코드 형식 가드)",
    badCode.status === 400 && /line_code/.test(badCode.body?.error ?? ""),
    `status=${badCode.status} ${badCode.body?.error ?? ""}`);

  // ── [C] 아웃풋 링크 설명 ≤30 (HTTP, write 없음) ──
  console.log("\n[C] 아웃풋 링크 설명 ≤30 (POST info-lines)");
  const longLabel = await post(`${BASE}/api/admin/cluster4/info-lines`, {
    week_id: "00000000-0000-0000-0000-000000000000", activity_type_id: "x", main_title: "검증",
    target_user_ids: [], output_links: [{ url: "https://a.com", label: "가".repeat(31) }],
  });
  check("링크 설명 31자 → 400 (길이 가드)", longLabel.status === 400 && /30자/.test(longLabel.body?.error ?? ""),
    `status=${longLabel.status} ${longLabel.body?.error ?? ""}`);

  // ── [D] 아웃풋 이미지 캡션 ≤20 (HTTP, write 없음) ──
  console.log("\n[D] 아웃풋 이미지 캡션 ≤20 (POST info-lines)");
  const longCap = await post(`${BASE}/api/admin/cluster4/info-lines`, {
    week_id: "00000000-0000-0000-0000-000000000000", activity_type_id: "x", main_title: "검증",
    target_user_ids: [], output_images: [{ url: "https://a.com/x.png", caption: "가".repeat(21) }],
  });
  check("이미지 캡션 21자 → 400 (길이 가드)", longCap.status === 400 && /20자/.test(longCap.body?.error ?? ""),
    `status=${longCap.status} ${longCap.body?.error ?? ""}`);

  // ── [E] 실무 경험 관리(management) 일반 크루 차단 (HTTP 422) — 실데이터 있을 때만 ──
  console.log("\n[E] 실무 경험 관리 일반 크루 차단 (POST team-overall review)");
  // 일반 등급 + 실제 팀 보유 크루 1명 탐색.
  const { data: genMem } = await admin
    .from("user_memberships")
    .select("user_id,team_name,membership_level,is_current,membership_state")
    .eq("membership_level", "일반").eq("is_current", true).eq("membership_state", "active")
    .not("team_name", "is", null).limit(50);
  const cand = (genMem ?? []).find((m) => (m.team_name ?? "").trim());
  if (!cand) { note("일반 크루 후보 없음 — [E] skip"); skip++; }
  else {
    const { data: prof } = await admin.from("user_profiles").select("organization_slug").eq("user_id", cand.user_id).maybeSingle();
    const org = prof?.organization_slug;
    // 최근 experience 주차 1건.
    const { data: wk } = await admin.from("weeks").select("id").order("start_date", { ascending: false }).limit(1).maybeSingle();
    if (!org || !wk?.id) { note("org/week 미확보 — [E] skip"); skip++; }
    else {
      const res = await post(`${BASE}/api/admin/cluster4/experience/team-overall`, {
        action: "review", organization: org, week_id: wk.id,
        team_id: "verify-nonexistent-team", team_name: cand.team_name,
        leaderCells: [{ crewUserId: cand.user_id, category: "management", checked: false, score: 0 }],
        outputs: [],
      });
      // 일반 크루 관리 셀 → 422(자격 가드). (팀 미존재여도 가드가 persist 이전에 동작)
      check("일반 크루 관리 셀 → 422", res.status === 422, `status=${res.status} ${res.body?.error ?? ""}`);
      note(`대상 일반크루=${cand.user_id} org=${org} team=${cand.team_name}`);
    }
  }
  // ── [F] 입력 UI maxLength (DOM) — 실무 정보 라인 개설 폼 ──
  console.log("\n[F] 입력 UI maxLength (실무 정보 라인 개설 폼)");
  await page.goto(`${BASE}/admin/line-opening/practical-info?org=oranke&tab=open`, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(800);
  const ml = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input"));
    const labelInput = inputs.find((i) => /설명|label/i.test(i.getAttribute("aria-label") ?? ""));
    const capInput = inputs.find((i) => /캡션|caption/i.test(i.getAttribute("aria-label") ?? ""));
    return {
      label: labelInput ? labelInput.getAttribute("maxlength") : null,
      caption: capInput ? capInput.getAttribute("maxlength") : null,
    };
  });
  if (ml.label == null && ml.caption == null) { note("개설 폼 입력 미발견(탭/데이터) — [F] skip"); skip++; }
  else {
    check("링크 설명 input maxLength=30", ml.label === "30", `maxlength=${ml.label}`);
    check("이미지 캡션 input maxLength=20", ml.caption === "20", `maxlength=${ml.caption}`);
  }
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail / ${skip} skip`);
process.exit(fail > 0 ? 1 : 0);
