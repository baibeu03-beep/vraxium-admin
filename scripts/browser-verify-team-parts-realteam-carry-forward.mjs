/**
 * 실제 문제 재현 팀(oranke/콘텐츠실험(T))에서 실제 브라우저 [B] 저장 → **새로고침 없이** 매트릭스
 *   존재표가 여름6·7·8 전부 즉시 갱신되는지 검증. 서버(HTTP)는 이미 정답을 주는데 클라이언트가
 *   저장 후 매트릭스(data.selectedTeam.partWeekMatrix)를 재조회하지 않던 버그(TeamDetail.tsx
 *   load() 의 useEffect 가 weekReloadTick 을 안 봄)를 재현·회귀 검증한다.
 * ⚠ 실사용자 관리자 테스트 데이터를 건드린다 — 시작 전 override 스냅샷을 뜨고 종료 시 정확히 원복한다.
 * 사전조건: dev :3000. Usage: node scripts/browser-verify-team-parts-realteam-carry-forward.mjs
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
const OVR = "cluster4_team_week_position_overrides";

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
  const ORG = "oranke";
  const TEAM = "콘텐츠실험(T)";
  const WEEK5 = { id: "954f56af-0c07-4246-ae7d-b476c5225b30", start: "2026-07-27" };
  const WEEK6 = { id: "2c359d24-2251-406d-aa40-c42917a52878", start: "2026-08-03" };
  const WEEK7 = { id: "1dc3bcec-7fff-43a0-ba84-e1a0565e3875", start: "2026-08-10" };
  const WEEK8 = { id: "fa11886e-e465-4b1e-accf-1ce6c13d146c", start: "2026-08-17" };

  const { data: th } = await sb
    .from("cluster4_team_halves")
    .select("id,team_name,half_key")
    .eq("organization_slug", ORG)
    .eq("team_name", TEAM)
    .eq("half_key", "2026-H2")
    .limit(1);
  const team = th?.[0];
  if (!team) {
    console.log("대상 팀 없음 — abort");
    process.exit(1);
  }

  // ── 0) 현재 override 스냅샷(실제 관리자 테스트 데이터 — 종료 시 정확히 원복) ──
  const { data: snapshotBefore } = await sb.from(OVR).select("*").eq("organization", ORG).eq("raw_team", TEAM);
  console.log(`사전 스냅샷: override ${snapshotBefore?.length ?? 0}행`);

  const browser = await chromium.launch({ headless: true });
  try {
    // ── 1) 재현 전제 세팅 — 대상 유저를 여름5 시점에 "테스트" 파트로(carry-forward 로 여름6~8 도 "테스트"). ──
    //   기존 관리자가 이미 다루던 유저를 재사용하되, [B] 표(crewRows)는 배정 가능(집합②) 크루만 나오므로
    //   role=crew·현역(졸업 아님)인 유저를 골라야 한다 — 안 그러면 [B] select 를 찾지 못해 오탐한다
    //   (실제로 스냅샷 0번째가 졸업(엘리트) 유저라 1차 시도에서 타임아웃 발생).
    const snapUserIds = [...new Set((snapshotBefore ?? []).map((r) => r.user_id))];
    const { data: snapProfs } = await sb.from("user_profiles").select("user_id,role,growth_status").in("user_id", snapUserIds);
    const targetUser = (snapProfs ?? []).find((p) => p.role === "crew" && p.growth_status !== "graduated")?.user_id;
    if (!targetUser) {
      console.log("배정 가능한(현역 crew) 대상 유저 없음 — abort");
      process.exit(1);
    }
    const { data: uprof } = await sb.from("user_profiles").select("display_name").eq("user_id", targetUser).limit(1);
    console.log(`대상 크루: ${uprof?.[0]?.display_name} (${targetUser})`);

    const { error: setupErr } = await sb.from(OVR).upsert(
      {
        user_id: targetUser,
        organization: ORG,
        week_id: WEEK5.id,
        week_start_date: WEEK5.start,
        raw_team: TEAM,
        raw_part: "테스트",
        position_code: "regular",
        created_by: "verify-script",
        updated_by: "verify-script",
      },
      { onConflict: "user_id,week_start_date,organization,raw_team" },
    );
    ck("사전 세팅: 여름5에 '테스트' 파트로 배정", !setupErr, setupErr?.message);

    // ⚠ 여름6 이후 이 유저에 대한 다른 override 가 있으면(예: 방금 전 실제 관리자가 남긴 값) 여름5 값이
    //   안 이어진다 — 재현을 위해 이 유저의 여름6/7/8 override 를 잠시 지운다(스냅샷에 있으니 나중에 복원).
    await sb.from(OVR).delete().eq("organization", ORG).eq("raw_team", TEAM).eq("user_id", targetUser).in("week_start_date", [WEEK6.start, WEEK7.start, WEEK8.start]);

    // ── 2) 로그인 + 팀 상세 페이지 진입(현재 주차=여름6 상태로 로드) ──
    const context = await browser.newContext({ viewport: { width: 1700, height: 1400 } });
    await context.addCookies(await cookies());
    const page = await context.newPage();
    await page.goto(`${BASE}/admin/team-parts/info/${ORG}/${team.id}?mode=test&weekId=${WEEK6.id}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("[data-team-detail-crew-table]", { timeout: 25000 });
    await page.waitForFunction(
      () => {
        const sel = document.getElementById("team-detail-week-select");
        return sel && sel.value !== "";
      },
      { timeout: 25000 },
    );

    // 사전 상태 확인 — 매트릭스에 여름6·7·8 "테스트" ● 인지(재현 전제).
    const readMatrixWeek = async () => {
      return page.evaluate(() => {
        const rows = [...document.querySelectorAll("[data-pw-row]")];
        const out = {};
        for (const row of rows) {
          const part = row.getAttribute("data-pw-row");
          const cells = [...row.querySelectorAll("[data-pw-cell]")];
          // 헤더와 같은 순서로 라벨 텍스트를 대조하기 어려우므로, 표 전체 텍스트에서 주차 라벨 열 인덱스를 찾는다.
          out[part] = cells.map((c) => c.getAttribute("data-pw-cell"));
        }
        return out;
      });
    };
    const colIndexOf = async (weekLabel) =>
      page.evaluate((lbl) => {
        const ths = [...document.querySelectorAll("table thead th")];
        return ths.findIndex((th) => th.textContent?.trim() === lbl);
      }, weekLabel);

    // weekColumns 라벨 확보(서버 라벨과 동일 형식: "여름 N"). ⚠ thead th[0]은 "파트 \ 주차" 라벨열이라
    //   데이터 행의 [data-pw-cell] 배열(라벨 없는 주차 셀만)과는 인덱스가 1 어긋난다 — 반드시 -1 보정.
    const idx6 = (await colIndexOf("여름 6")) - 1;
    const idx7 = (await colIndexOf("여름 7")) - 1;
    const idx8 = (await colIndexOf("여름 8")) - 1;
    ck("매트릭스 헤더에서 여름6/7/8 열 인덱스 확보", idx6 >= 0 && idx7 >= 0 && idx8 >= 0, { idx6, idx7, idx8 });

    const preMatrix = await readMatrixWeek();
    const preTest = preMatrix["테스트"];
    // ⚠ "쿠키"는 이 팀의 다른 실제 관리자 데이터(e6574586 등)가 이미 6~8주차에 배정돼 있어 대상 유저와
    //   무관하게 이미 ● 일 수 있다 — 전제 검증은 "테스트"(대상 유저 단독 기여)만 본다.
    ck(
      "[재현 전제] 저장 전: 여름6·7·8 모두 테스트=●(대상 유저가 아직 테스트 파트)",
      preTest?.[idx6] === "1" && preTest?.[idx7] === "1" && preTest?.[idx8] === "1",
      { preTest, idx6, idx7, idx8 },
    );

    // ── 3) 실제 UI로 [B] 표에서 "테스트" 파트 크루를 "쿠키"로 변경 후 저장 ──
    const partSelect = page.locator(`[data-crew-part-select="${targetUser}"]`);
    await partSelect.waitFor({ timeout: 15000 });
    await partSelect.selectOption("쿠키");
    await page.click("[data-save-team-week-part-class]");
    await page.waitForFunction(
      () => {
        const btn = document.querySelector("[data-save-team-week-part-class]");
        return btn && btn.textContent?.includes("저장") && !btn.textContent?.includes("저장 중");
      },
      { timeout: 20000 },
    );
    // ⚠ 버튼 문구가 "저장 중…"에서 풀리는 시점 = saveRows() 가 load()+loadWeekSummary() 를 모두
    //   await 하고 끝난 시점(코드 보장) — 추가 임의 대기 없이 바로 확인해도 이미 최신이어야 한다.
    //   React 렌더 flush 만 최소 대기.
    await page.waitForTimeout(200);

    // ── 4) 새로고침 없이 — 매트릭스 여름6·7·8 열이 즉시 정답으로 바뀌었는지 ──
    //   (쿠키는 다른 유저 기여로 이미 ●일 수 있어 판별력이 없다 — "테스트"가 0으로 꺼지는지가 핵심.)
    const postMatrixNoReload = await readMatrixWeek();
    ck(
      "[핵심·새로고침 없음] 저장 직후 여름6 테스트=빈칸(대상 유저 즉시 반영)",
      postMatrixNoReload["테스트"]?.[idx6] === "0",
      { test: postMatrixNoReload["테스트"]?.[idx6] },
    );
    ck(
      "[핵심·새로고침 없음] 저장 직후 여름7 테스트=빈칸(이월, 새로고침 없이)",
      postMatrixNoReload["테스트"]?.[idx7] === "0",
      { test: postMatrixNoReload["테스트"]?.[idx7] },
    );
    ck(
      "[핵심·새로고침 없음] 저장 직후 여름8 테스트=빈칸(이월, 새로고침 없이)",
      postMatrixNoReload["테스트"]?.[idx8] === "0",
      { test: postMatrixNoReload["테스트"]?.[idx8] },
    );

    // ── 5) 페이지 새로고침 후에도 동일한지 ──
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-team-detail-crew-table]", { timeout: 25000 });
    await page.waitForTimeout(1500);
    const postMatrixReload = await readMatrixWeek();
    ck(
      "[새로고침 후] 여름6·7·8 쿠키=●·테스트=빈칸 유지",
      ["cookie6", "cookie7", "cookie8"].every((_, i) => {
        const idx = [idx6, idx7, idx8][i];
        return postMatrixReload["쿠키"]?.[idx] === "1" && postMatrixReload["테스트"]?.[idx] === "0";
      }),
      postMatrixReload,
    );

    // ── 6) 주차별 week-summary(crewRows/operatedParts) HTTP 도 동일한지(요구 §4·§5) ──
    const cookie = (await cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    for (const [label, w] of [["여름6", WEEK6], ["여름7", WEEK7], ["여름8", WEEK8]]) {
      const r = await fetch(
        `${BASE}/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${team.id}&mode=test&weekId=${w.id}`,
        { headers: { cookie } },
      );
      const j = await r.json();
      const opNames = new Set((j.data.operatedParts ?? []).map((p) => p.partName));
      const rowPart = (j.data.crewRows ?? []).find((row) => row.userId === targetUser)?.rawPart;
      ck(`[HTTP] ${label} crewRows 대상 유저 파트=쿠키`, rowPart === "쿠키", rowPart);
      ck(`[HTTP] ${label} operatedParts 에 쿠키 있음·테스트 없음`, opNames.has("쿠키") && !opNames.has("테스트"), [...opNames]);
    }

    console.log(`\n=== RESULT: PASS ${pass} / FAIL ${fail} ===`);
    await context.close();
  } finally {
    await browser.close();
    // ── 정리 — 실제 관리자 테스트 데이터를 원래 상태로 정확히 복원 ──
    console.log("\n정리(실제 관리자 데이터 원복)...");
    const { error: delErr } = await sb.from(OVR).delete().eq("organization", ORG).eq("raw_team", TEAM);
    console.log("전체 삭제:", delErr?.message ?? "OK");
    if (snapshotBefore && snapshotBefore.length > 0) {
      const restoreRows = snapshotBefore.map(({ id: _id, ...rest }) => rest);
      const { error: restoreErr } = await sb.from(OVR).insert(restoreRows);
      console.log(`원복(원본 ${restoreRows.length}행 재삽입):`, restoreErr?.message ?? "OK");
    }
    const { data: finalState } = await sb.from(OVR).select("user_id,week_start_date,raw_part").eq("organization", ORG).eq("raw_team", TEAM);
    console.log("최종 상태:", finalState);
  }
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
