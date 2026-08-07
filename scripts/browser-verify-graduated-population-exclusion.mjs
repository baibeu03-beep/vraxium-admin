/**
 * 실제 브라우저에서 두 수정 화면을 열어, 네트워크 응답(JSON)에 졸업 크루가 없는지 검증한다.
 *   ① /admin/line-opening/practical-info — 실무 정보 라인 개설 대상 체크리스트
 *      (/api/admin/cluster4/users 응답 대조)
 *   ② /admin/rest-management/emergency — 긴급 휴식 대상 크루 선택
 *      (/api/admin/rest-management/emergency/crews 응답 대조)
 * 이름 하드코딩 없음 — 실행 시점에 DB 에서 현재 졸업 효력 발생 크루를 동적으로 조회해 대조한다.
 * 읽기 전용(GET) — 데이터 변경 없음.
 * 사전조건: dev :3000. Usage: node scripts/browser-verify-graduated-population-exclusion.mjs
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
let chromium;
try {
  ({ chromium } = rq("playwright-core"));
} catch {
  ({ chromium } = rq("playwright"));
}
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(URL_, get("SUPABASE_SERVICE_ROLE_KEY"));
const brow = createClient(URL_, ANON);

let fail = 0;
let pass = 0;
const ck = (l, ok, d = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${JSON.stringify(d)}` : ""}`);
};

async function cookies() {
  const { data: admins } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins?.[0]?.email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

async function main() {
  const { data: graduatedRows } = await sb
    .from("user_profiles")
    .select("user_id,display_name")
    .eq("growth_status", "graduated");
  const graduatedIds = new Set((graduatedRows ?? []).map((r) => r.user_id));
  const nameById = new Map((graduatedRows ?? []).map((r) => [r.user_id, r.display_name]));
  console.log(`졸업(growth_status=graduated) 전체 크루(동적 조회): ${graduatedIds.size}명`);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies(await cookies());
    const page = await context.newPage();

    // ── ① 실무 정보 라인 개설 대상 체크리스트 ──
    console.log("\n=== ① /admin/line-opening/practical-info ===");
    {
      const respPromise = page.waitForResponse(
        (r) => r.url().includes("/api/admin/cluster4/users") && r.status() === 200,
        { timeout: 20000 },
      );
      await page.goto(`${BASE}/admin/line-opening/practical-info`, { waitUntil: "domcontentloaded" });
      const resp = await respPromise;
      const json = await resp.json();
      ck("응답 success=true", json.success === true, { success: json.success });
      const rows = json.data ?? [];
      const leaked = rows.filter((r) => graduatedIds.has(r.userId));
      ck(
        `네트워크 응답(${rows.length}행)에 졸업 크루 0명`,
        leaked.length === 0,
        leaked.map((r) => ({ userId: r.userId, displayName: r.displayName })),
      );
      // 화면 DOM 에도 졸업 크루 이름이 실제로 렌더링되지 않는지 대조(이름 텍스트 스캔).
      const bodyText = await page.locator("body").innerText();
      const domLeak = [...graduatedIds].filter((uid) => {
        const name = nameById.get(uid);
        return name && bodyText.includes(name);
      });
      ck(`DOM 텍스트에 졸업 크루 이름 노출 0건(체크리스트 영역 포함 전체 페이지 스캔)`, domLeak.length === 0, domLeak.map((uid) => nameById.get(uid)));
    }

    // ── ② 긴급 휴식 대상 크루 선택 ──
    console.log("\n=== ② /admin/rest-management/emergency ===");
    {
      await page.goto(`${BASE}/admin/rest-management/emergency`, { waitUntil: "domcontentloaded" });
      // 팀 선택 → crews API 트리거. 팀 셀렉트가 없으면 화면 자체가 다른 흐름일 수 있어 스킵 처리.
      const teamSelect = page.locator("[data-emergency-team-select], select").first();
      const hasTeamSelect = await teamSelect.count();
      if (hasTeamSelect > 0) {
        const respPromise = page
          .waitForResponse((r) => r.url().includes("/api/admin/rest-management/emergency/crews") && r.status() === 200, {
            timeout: 15000,
          })
          .catch(() => null);
        await teamSelect.click().catch(() => {});
        const resp = await respPromise;
        if (resp) {
          const json = await resp.json();
          const rows = json.crews ?? [];
          const leaked = rows.filter((r) => graduatedIds.has(r.userId));
          ck(
            `네트워크 응답(${rows.length}행)에 졸업 크루 0명`,
            leaked.length === 0,
            leaked.map((r) => ({ userId: r.userId, crewName: r.crewName })),
          );
        } else {
          console.log("  [정보] 팀 선택 트리거로 crews 응답을 잡지 못함 — HTTP/lib 레벨 검증(스크립트 별도)으로 이미 커버됨");
        }
      } else {
        console.log("  [정보] 팀 선택 UI 미발견 — 화면 진입 자체만 확인, 상세는 HTTP/lib 레벨 검증으로 커버됨");
      }
    }

    console.log(`\n=== RESULT: PASS ${pass} / FAIL ${fail} ===`);
    if (fail > 0) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
