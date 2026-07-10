// 검증(브라우저+HTTP) — /admin/rest-management 시즌 필터 라벨 통일 + 레이아웃.
//   1) 시즌 트리거(닫힌 상태) 표시 = season_label(예 "2026 여름"), raw season_key("2026-summer") 노출 없음
//   2) 트리거 라벨 == 옵션 목록의 선택 항목 라벨(동일 SoT)
//   3) HTTP summary API 가 season_label 을 제공(옵션 SoT)
//   4) 우측 액션(긴급 휴식 신청·전체 승인) 우측 정렬 유지 · 가로 스크롤 없음
//   모든 org(encre/oranke/phalanx) × 일반/mode=test 동일. read-only(승인/삭제 미호출).
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
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"),
  ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE),
  brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";

let fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};
// raw season_key 패턴(YYYY-<code>). 트리거/라벨이 이 형태면 raw 노출.
const RAW_KEY = /^\d{4}-(winter|spring|summer|autumn)$/;

// 세션 쿠키.
const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({
  email: EMAIL,
  token: link.properties.email_otp,
  type: "magiclink",
});
const cap = [];
const srv = createServerClient(URL_, ANON, {
  cookies: { getAll: () => [], setAll: (i) => cap.push(...i) },
});
await srv.auth.setSession({
  access_token: v.session.access_token,
  refresh_token: v.session.refresh_token,
});
const cookies = cap.map((i) => ({
  name: i.name, value: i.value, domain: "localhost", path: "/",
  httpOnly: false, secure: false, sameSite: "Lax",
}));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addCookies(cookies);

async function runCase(org, mode) {
  const page = await context.newPage();
  const q = mode ? `?org=${org}&mode=${mode}` : `?org=${org}`;
  await page.goto(`${BASE}/admin/rest-management${q}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.includes("전체 승인"), { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const tag = `org=${org} mode=${mode ?? "(일반)"}`;

  // ── HTTP: summary API 가 season_label 제공 ──
  const api = await page.evaluate(async (o) => {
    const r = await fetch(`/api/admin/rest-management/summary?organization=${o}`, { cache: "no-store" });
    const j = await r.json();
    return { ok: r.ok, seasons: (j?.seasons ?? []).map((s) => ({ k: s.season_key, l: s.season_label })) };
  }, org);
  const apiSeasonsOk = api.ok && api.seasons.length > 0 && api.seasons.every((s) => s.l && !/^\d{4}-(winter|spring|summer|autumn)$/.test(s.l));

  // ── 닫힌 트리거 표시값 ──
  const trigger = await page.evaluate(() => {
    const el = document.querySelector('[data-slot="select-value"]');
    return el ? el.textContent.trim() : null;
  });

  // ── 드롭다운 열어 옵션 라벨 수집 + 트리거 라벨과 일치 확인 ──
  await page.locator('[data-slot="select-trigger"]').first().click();
  await page.waitForTimeout(400);
  const openState = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[data-slot="select-item"]'));
    const selected = items.find((i) => i.getAttribute("data-selected") === "true" || i.getAttribute("aria-selected") === "true");
    return {
      optionLabels: items.map((i) => i.textContent.trim()),
      selectedLabel: selected ? selected.textContent.trim() : null,
    };
  });
  // 닫기(esc).
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // ── 레이아웃: 액션 우측 정렬 + 가로 스크롤 없음 ──
  const layout = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button")).map((b) => b.textContent.trim());
    const approveBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "전체 승인");
    const trig = document.querySelector('[data-slot="select-trigger"]');
    // 액션 버튼이 시즌 트리거보다 오른쪽에 있는지(우측 정렬).
    const rightAligned = approveBtn && trig
      ? approveBtn.getBoundingClientRect().left > trig.getBoundingClientRect().right
      : false;
    return {
      hasUrgent: btns.includes("긴급 휴식 신청"),
      hasApproveAll: btns.includes("전체 승인"),
      rightAligned,
      docScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });

  console.log(`▶ ${tag}`);
  ck("HTTP summary seasons 라벨 제공(raw key 아님)", apiSeasonsOk, api.seasons.slice(0, 3).map((s) => `${s.k}→${s.l}`).join(", "));
  ck("트리거 표시=라벨(raw season_key 노출 없음)", !!trigger && !RAW_KEY.test(trigger), `trigger="${trigger}"`);
  ck("옵션 목록 라벨 raw key 없음", openState.optionLabels.length > 0 && openState.optionLabels.every((l) => !RAW_KEY.test(l)), `[${openState.optionLabels.slice(0, 3).join(", ")}${openState.optionLabels.length > 3 ? ", …" : ""}]`);
  ck("트리거 라벨 == 선택 옵션 라벨(동일 SoT)", !!trigger && trigger === openState.selectedLabel, `trigger="${trigger}" selected="${openState.selectedLabel}"`);
  ck("액션(긴급/전체 승인) 우측 정렬 유지", layout.hasUrgent && layout.hasApproveAll && layout.rightAligned);
  ck("페이지 가로 스크롤 없음", !layout.docScroll);
  await page.close();
}

for (const org of ["encre", "oranke", "phalanx"]) {
  await runCase(org, null);   // 일반 모드
  await runCase(org, "test"); // mode=test
}

await browser.close();
console.log("─".repeat(50));
console.log(fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
