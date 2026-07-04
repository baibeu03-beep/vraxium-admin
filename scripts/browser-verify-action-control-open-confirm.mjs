// 브라우저(인증 세션) 검증 — Action Control: 오픈 확인 ↩ 실행 취소(⚡ 즉시 실행은 제거됨).
//   기존 [오픈 확인] 버튼이 이미 즉시 실행 역할이므로 ⚡ 중복 버튼은 두지 않고 ↩ 만 추가.
//   1) 상세 페이지: 기존 [오픈 확인] 버튼 유지 · ⚡ "즉시 실행" 미노출 · ↩ "실행 취소" 렌더
//   2) 최초(미확인) 시 ↩ 비활성(아직 되돌릴 것 없음)
//   3) 기존 [오픈 확인] 클릭 → 오픈 확인 완료(badge) + ↩ 활성화
//   4) ↩ 클릭 → 운영 확인 모달 필수 → 확인 → '오픈 확인 전' 복귀(badge 사라짐)
//   5) snapshot 무변경 · 원본 상태 복원
// 사용법: SMOKE_BASE_URL=http://localhost:3000 node scripts/browser-verify-action-control-open-confirm.mjs
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
const ORG = "encre";

async function makeAdminCookies() {
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({ email: adminEmail, token: linkData.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

async function fingerprint() {
  const { count } = await admin.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  const { data } = await admin.from("cluster4_weekly_card_snapshots").select("updated_at").order("updated_at", { ascending: false }).limit(1);
  return { count: count ?? 0, latest: data?.[0]?.updated_at ?? null };
}
async function readRow(weekId) {
  const { data } = await admin.from("cluster4_week_opening_configs")
    .select("config,open_confirmed,open_confirmed_at,open_confirmed_by")
    .eq("week_id", weekId).eq("organization_slug", ORG).maybeSingle();
  return data ?? null;
}

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
// 창 단위 어드민 세션(WindowSessionGuard) 통과 — 로그인 때 심어지는 wsid + 신선한 heartbeat 를
//   각 네비게이션 직전에 주입(addInitScript 는 매 로드마다 실행 → beat 는 항상 STALE_MS 이내).
const WSID = "verify-" + Date.now().toString(36);
await context.addInitScript((wsid) => {
  try {
    sessionStorage.setItem("admin.window.wsid", wsid);
    localStorage.setItem("admin.window.beat:" + wsid, String(Date.now()));
  } catch {}
}, WSID);
const page = await context.newPage();

let weekId = null, orig = null;
const snapBefore = await fingerprint();
try {
  // 유효한 관리 주차 id 확보(목록 API).
  await page.goto(`${BASE}/admin/team-parts/info/weeks?club=${ORG}`, { waitUntil: "domcontentloaded" });
  const list = await page.evaluate(async ([base, org]) => {
    const r = await fetch(`${base}/api/admin/team-parts/info/weeks?club=${org}`, { cache: "no-store" });
    return r.ok ? await r.json() : null;
  }, [BASE, ORG]);
  const arr = list?.data?.items ?? list?.data?.weeks ?? list?.data?.rows ?? list?.data ?? [];
  const first = Array.isArray(arr) ? arr.find((x) => x && (x.weekId || x.week_id || x.id)) : null;
  weekId = first?.weekId ?? first?.week_id ?? first?.id ?? null;
  check("관리 주차 id 확보", !!weekId, weekId ? String(weekId).slice(0, 8) : "none");
  if (!weekId) throw new Error("no weekId");

  orig = await readRow(weekId);
  // 깨끗한 시작 상태(미확인)로 맞춤 — 원본은 마지막에 복원.
  await admin.from("cluster4_week_opening_configs").update({ open_confirmed: false, open_confirmed_at: null, open_confirmed_by: null })
    .eq("week_id", weekId).eq("organization_slug", ORG);

  await page.goto(`${BASE}/admin/team-parts/info/weeks/${weekId}?club=${ORG}`, { waitUntil: "networkidle" });

  // 기존 '오픈 확인' 버튼은 그대로 유지(대체 아님).
  const origBtn = page.locator('[data-open-confirm-button]');
  await origBtn.first().waitFor({ timeout: 15000 });
  check("기존 '오픈 확인' 버튼 유지(라벨 불변)", (await origBtn.first().innerText()).includes("오픈 확인"));

  // 공용 컨트롤은 기존 버튼 옆에 ↩ 실행 취소만 추가(⚡ 즉시 실행은 제거 — 중복 방지).
  const scope = page.locator('[data-ac-open-confirm]');
  await scope.first().waitFor({ timeout: 15000 });
  const instantBtn = scope.getByRole("button", { name: /즉시 실행/ });
  const rollbackBtn = scope.getByRole("button", { name: /실행 취소/ });
  check("⚡ '즉시 실행' 버튼 미노출(제거됨)", await instantBtn.count() === 0);
  check("↩ '실행 취소' 버튼 추가 렌더", await rollbackBtn.count() > 0);
  check("최초(미확인) ↩ 비활성", await rollbackBtn.first().isDisabled());

  // 실행은 기존 [오픈 확인] 버튼으로 → 오픈 확인 완료.
  await origBtn.first().click();
  await page.locator('[data-open-confirmed="true"]').first().waitFor({ timeout: 15000 });
  check("기존 [오픈 확인] 실행 후 오픈 확인 완료 badge 표시", await page.locator('[data-open-confirmed="true"]').count() > 0);
  const rowAfterConfirm = await readRow(weekId);
  check("실행 후 DB open_confirmed=true", rowAfterConfirm?.open_confirmed === true);
  check("실행 후 ↩ 활성화", !(await rollbackBtn.first().isDisabled()));

  // ↩ 실행 취소 → 운영 확인 모달 필수 → 확인.
  await rollbackBtn.first().click();
  const dialog = page.locator('[role="alertdialog"]');
  await dialog.waitFor({ timeout: 8000 });
  check("↩ 클릭 시 운영 확인 모달 표시", await dialog.count() > 0);
  const dialogText = await dialog.innerText();
  check(
    "확인 모달 표준 문구",
    dialogText.includes("이 작업을 실행하기 전 상태로 되돌립니다") &&
      dialogText.includes("이 작업으로 변경된 내용도 함께 이전 상태로 복원됩니다") &&
      dialogText.includes("계속하시겠습니까"),
    dialogText.replace(/\s+/g, " ").slice(0, 80),
  );
  check("확인 버튼 '↩ 실행 취소'", (await dialog.getByRole("button").allInnerTexts()).some((t) => t.includes("↩") && t.includes("실행 취소")));
  await dialog.getByRole("button", { name: "실행 취소" }).click();

  await page.waitForFunction(() => !document.querySelector('[data-open-confirmed="true"]'), { timeout: 15000 });
  check("↩ 확인 후 오픈 확인 badge 사라짐('오픈 확인 전')", await page.locator('[data-open-confirmed="true"]').count() === 0);
  const rowAfterRevert = await readRow(weekId);
  check("↩ 확인 후 DB open_confirmed=false", rowAfterRevert?.open_confirmed === false);
  check("↩ 후에도 config 보존", JSON.stringify(rowAfterRevert?.config) === JSON.stringify(rowAfterConfirm?.config));
} catch (e) {
  check("예외 없음", false, String(e?.message ?? e));
} finally {
  // 원본 상태 복원.
  if (weekId) {
    if (orig) {
      await admin.from("cluster4_week_opening_configs").upsert({
        week_id: weekId, organization_slug: ORG, config: orig.config,
        open_confirmed: orig.open_confirmed, open_confirmed_at: orig.open_confirmed_at, open_confirmed_by: orig.open_confirmed_by,
      }, { onConflict: "week_id,organization_slug" });
    } else {
      await admin.from("cluster4_week_opening_configs").delete().eq("week_id", weekId).eq("organization_slug", ORG);
    }
  }
  const snapAfter = await fingerprint();
  check("snapshot 무변경", snapBefore.count === snapAfter.count && snapBefore.latest === snapAfter.latest, `${snapBefore.count}→${snapAfter.count}`);
  await browser.close();
  console.log(fail === 0 ? `\n✅ ALL PASS (${pass})` : `\n❌ ${fail} FAIL / ${pass} pass`);
  process.exit(fail === 0 ? 0 : 1);
}
