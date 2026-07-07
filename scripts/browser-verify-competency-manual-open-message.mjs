// 실무 역량 [라인 개설] 수동 추가 → 개설 → 배너 메시지 브라우저 검증(어드민 UI 실구동).
//   현재 UI(라인명=드롭다운) 대응. "0/0개 반영" 회귀 확인 + 신 메시지("N개 반영 (크루 M명)") 노출 검증.
//   격리: oranke + active 테스트 크루 1명 + common 마스터 CPBS-NN0001, line_name 고정, 끝에 정리.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const r = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = r("@supabase/supabase-js");
const { createServerClient } = r("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL, SERVICE);
const brow = createClient(URL, ANON);
const ORG = "oranke";
const LINE = "ZZ-브라우저-역량라인";
const MASTER_CODE = "CPBS-NN0001";

async function cleanup() {
  const { data: apps } = await sb.from("cluster4_competency_applications").select("id,opened_line_id").eq("organization_slug", ORG).eq("line_name", LINE);
  for (const a of apps ?? []) {
    if (a.opened_line_id) {
      await sb.from("cluster4_line_targets").delete().eq("line_id", a.opened_line_id);
      await sb.from("cluster4_lines").delete().eq("id", a.opened_line_id);
    }
  }
  await sb.from("cluster4_competency_applications").delete().eq("organization_slug", ORG).eq("line_name", LINE);
}

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: "vanuatu.golden@gmail.com" });
const { data: v } = await brow.auth.verifyOtp({ email: "vanuatu.golden@gmail.com", token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const b = await chromium.launch({ channel: "chromium", headless: true });
const ctx = await b.newContext({ viewport: { width: 1500, height: 1700 } });
await ctx.addCookies(cookies);
const p = await ctx.newPage();
p.on("dialog", async (d) => { await d.accept(); });

let pass = false;
try {
  await cleanup();
  // active 테스트 크루
  const tm = (await sb.from("test_user_markers").select("user_id")).data.map((x) => x.user_id);
  const crew = (await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", ORG).eq("growth_status", "active").in("user_id", tm).limit(1)).data[0];
  console.log(`crew=${crew.display_name}(${crew.user_id.slice(0, 8)}) master=${MASTER_CODE}`);

  await p.goto(`${BASE}/admin/line-opening/practical-competency?org=${ORG}&tab=open`, { waitUntil: "domcontentloaded" });
  await p.waitForFunction("document.body.innerText.includes('해당 크루') || document.body.innerText.includes('라인 개설')", undefined, { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(1500);

  // ── 수동 추가 ──
  await p.fill('input[aria-label="수동 추가 크루 검색"]', crew.display_name);
  await p.waitForTimeout(2500);
  await p.evaluate(() => {
    const menu = document.querySelector('input[aria-label="수동 추가 크루 검색"]')?.closest(".relative")?.querySelector("div.absolute");
    menu?.querySelector("button")?.click();
  });
  await p.waitForTimeout(400);
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim().startsWith("추가"))?.click());
  await p.waitForTimeout(600);
  // 드롭다운(select)에서 마스터 라인 선택 — 옵션 텍스트에 CPBS-NN0001 포함
  const selected = await p.evaluate((code) => {
    const sel = document.querySelector('select[aria-label="수동 추가 라인명"]');
    if (!sel) return "no-select";
    const opt = [...sel.options].find((o) => (o.textContent || "").includes(code));
    if (!opt) return "no-option";
    sel.value = opt.value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return opt.textContent.trim();
  }, MASTER_CODE);
  console.log("라인 드롭다운 선택:", selected);
  // line_name 은 드롭다운의 master.lineName 으로 저장되므로, 정리를 위해 DB line_name 을 고정값으로 맞춘다(추가 후).
  await p.evaluate(() => { const btns = [...document.querySelectorAll("button")].filter((x) => (x.textContent || "").trim() === "확인"); btns[btns.length - 1]?.click(); });
  await p.waitForTimeout(2500);
  // 방금 추가된 행의 line_name 을 격리용 고정값으로 갱신(정리 키 일치)
  await sb.from("cluster4_competency_applications").update({ line_name: LINE }).eq("organization_slug", ORG).eq("target_user_id", crew.user_id).eq("source", "manual").is("opened_line_id", null);
  const added = (await sb.from("cluster4_competency_applications").select("id,approval_checked,resolution").eq("organization_slug", ORG).eq("line_name", LINE).maybeSingle()).data;
  console.log(`수동 추가 DB: approval_checked=${added?.approval_checked} resolution=${added?.resolution}`);

  // ── 개설 ──
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "개설")?.click());
  // 느린 환경 대비 — 개설 성공 배너가 나타날 때까지 최대 45s 명시적 대기.
  await p.waitForFunction(
    () => [...document.querySelectorAll("div")].some((d) => {
      const t = d.textContent || "";
      return t.includes("개설 완료 — 역량 라인") && t.includes("개 반영");
    }),
    undefined,
    { timeout: 45000 },
  ).catch(() => {});
  await p.waitForTimeout(500);
  const banner = await p.evaluate(() => {
    // 가장 안쪽(짧은) 매칭 div 를 고른다(최상위 컨테이너 대신 실제 배너).
    const els = [...document.querySelectorAll("div")].filter((d) => {
      const t = d.textContent || "";
      return t.includes("개설 완료 — 역량 라인") && t.includes("개 반영");
    });
    if (els.length === 0) return null;
    els.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
    return els[0].textContent.replace(/\s+/g, " ").trim();
  });
  console.log("개설 배너 메시지:", JSON.stringify(banner));
  await p.screenshot({ path: resolve(adminRoot, "claudedocs", "qa-competency-open-message.png") });

  const hasZeroZero = banner && banner.includes("0/0");
  const hasRealCount = banner && /역량 라인 [1-9]\d*개 반영/.test(banner);
  console.log(`검증: "0/0" 회귀=${hasZeroZero}  실제반영수표시=${hasRealCount}`);
  pass = !hasZeroZero && hasRealCount;
} catch (e) {
  console.error("ERROR:", e?.stack ?? e?.message ?? e);
} finally {
  await cleanup();
  const left = (await sb.from("cluster4_competency_applications").select("id").eq("organization_slug", ORG).eq("line_name", LINE)).data ?? [];
  console.log(`\n정리 잔존: ${left.length}건 | 결과: ${pass ? "PASS ✅" : "FAIL ❌"}`);
  await b.close();
}
