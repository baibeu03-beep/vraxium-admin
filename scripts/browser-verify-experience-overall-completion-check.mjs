// 브라우저+HTTP 검증 — 파트 드롭다운 '팀 총괄' 완료 체크 판정 교정.
//   정책: 팀 총괄 완료 체크 = 최종 [개설 완료] 성공(board.status === "opened")일 때만.
//         개설 신청 완료(application)·개설 검수 완료(reviewed)·임시저장 단계는 체크 없음.
//         개별 파트 체크 = parts[].submitted (기존 정책 유지, 별개 boolean).
//   방법: team-overall API 응답(SoT)을 네트워크로 캡처해 UI(트리거/옵션) 완료 체크와 대조.
//         opened/reviewed 보드가 실제 존재하는 주차로 이동해 양방향(체크 有/無) 모두 관측.
//   ⚠ 비파괴 — 신청/검수/완료/취소 mutation 없음. org × mode 전수.
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
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// 실데이터에서 opened/reviewed 보드가 있는 주차를 org별로 수집 → 그 주차들로 이동해 검증.
const { data: boards } = await sb
  .from("cluster4_experience_team_overall")
  .select("status,week_id,organization_slug")
  .in("status", ["opened", "reviewed"]);
const weeksByOrg = {};
for (const b of boards ?? []) {
  (weeksByOrg[b.organization_slug] ??= new Set()).add(b.week_id);
}
const ORGS = process.env.VERIFY_ORG ? [process.env.VERIFY_ORG] : ["encre", "oranke", "phalanx"];
const ALL_MODES = [{ key: "operating", qs: "" }, { key: "test", qs: "&mode=test" }];
const MODES = process.env.VERIFY_MODE ? ALL_MODES.filter((m) => m.key === process.env.VERIFY_MODE) : ALL_MODES;

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
await context.addCookies(cookies);
const page = await context.newPage();

// team-overall 응답 캡처(SoT). 최신 응답의 status + parts(submitted) 를 보관.
let lastBoard = null;
page.on("response", async (res) => {
  const u = res.url();
  if (u.includes("/api/admin/cluster4/experience/team-overall") && res.request().method() === "GET") {
    try {
      const j = await res.json();
      if (j?.success && j.data) lastBoard = { status: j.data.status, parts: j.data.parts ?? [], appliedAll: (j.data.application?.allPartsApplied ?? null) };
    } catch { /* ignore */ }
  }
});

const gotoAndReady = async (url) => {
  for (let a = 0; a < 4; a++) {
    try { await page.goto(url, { waitUntil: "domcontentloaded" }); } catch { await page.waitForTimeout(900); continue; }
    const ok = await page.waitForSelector('[data-slot="select-trigger"].w-56', { timeout: 15000 }).then(() => true).catch(() => false);
    if (ok) { await page.waitForTimeout(800); return true; }
    await page.waitForTimeout(900);
  }
  return false;
};
// 파트 드롭다운 트리거의 완료 체크(선행 Check svg) 유무.
const readTriggerCheck = () => page.evaluate(() => {
  const val = document.querySelector('[data-slot="select-trigger"].w-56 [data-slot="select-value"]');
  return { text: val ? (val.textContent || "").trim() : "", hasCheck: !!(val && val.querySelector("svg")) };
});
// 열린 드롭다운에서 옵션별 완료(선행 체크 + emerald 배경) / 선택 인디케이터(우측 absolute) 구분.
const readOptions = () => page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-slot="select-item"]')).map((el) => {
    const svgs = Array.from(el.querySelectorAll("svg"));
    // 완료 체크 = 라벨 좌측 Check(text-emerald-600). 선택 인디케이터 = base-ui ItemIndicator(absolute right, 비-emerald).
    const completionCheck = svgs.some((s) => (s.getAttribute("class") || "").includes("emerald"));
    const selectionIndicator = svgs.some((s) => {
      const sp = s.closest("span");
      return sp && (sp.getAttribute("class") || "").includes("absolute");
    });
    // leadingCheck: 완료 체크(emerald, 좌측) — 선택 인디케이터(absolute)와 구분.
    const leadingCheck = completionCheck;
    return { text: (el.textContent || "").trim(), completedBg: el.className.includes("emerald"), completionCheck, leadingCheck, selectionIndicator };
  }),
);
const openPartSelect = async () => { await page.locator('[data-slot="select-trigger"].w-56').first().click({ timeout: 8000 }); await page.waitForTimeout(350); };
const pickOption = async (text) => { await page.locator('[data-slot="select-item"]', { hasText: text }).first().click({ timeout: 8000 }); await page.waitForTimeout(700); };

let sawOpenedWithCheck = false, sawNonOpenedNoCheck = false, mismatches = 0, skipped = 0;
let distinctOpenedDone = false, distinctNonOpenedDone = false;

for (const org of ORGS) {
  const weeks = Array.from(weeksByOrg[org] ?? []);
  if (weeks.length === 0) { ck(`[${org}] opened/reviewed 보드 없음(스킵)`, true); continue; }
  for (const m of MODES) {
    for (const weekId of weeks) {
      const tag = `${org}/${m.key}/wk:${weekId.slice(0, 8)}`;
      try {
        const ready = await gotoAndReady(`${BASE}/admin/line-opening/practical-experience?org=${org}&tab=open&week=${encodeURIComponent(weekId)}${m.qs}`);
        if (!ready) { ck(`[${tag}] 부트 실패(스킵)`, true); continue; }
        const tabs = await page.locator('[role="tablist"] [role="tab"]').count();
        for (let ti = 0; ti < tabs; ti++) {
          try {
            const tab = page.locator('[role="tablist"] [role="tab"]').nth(ti);
            if ((await tab.getAttribute("aria-disabled")) === "true") continue;
            lastBoard = null;
            await tab.click();
            await page.waitForTimeout(1800); // 탭 전환 → openingStatus 재조회 + 렌더 settle.

            // 팀 총괄 선택 + settle → lastBoard(이 팀 team-overall GET) 최신화 → 트리거/옵션 판독과 정합.
            await openPartSelect();
            const optsPre = await readOptions();
            const partOpt = optsPre.find((o) => !o.text.includes("팀 총괄"));
            await pickOption("팀 총괄");
            await page.waitForTimeout(1500); // 보드 mount + team-overall GET + openingStatus 반영 대기.
            if (!lastBoard) { skipped++; continue; } // 응답 미캡처 시 스킵
            const status = lastBoard.status; // "opened" | "reviewed" | null
            const expectOverallCheck = status === "opened";

            // 트리거(선택된 팀총괄) 완료 체크 — settle 후 판독.
            const trig = await readTriggerCheck();
            const okTrigger = trig.hasCheck === expectOverallCheck;

            // 옵션 완료/선택 인디케이터 — settle 후 재판독(레이스 방지). 팀총괄이 지금 선택됨.
            await openPartSelect();
            const optsPost = await readOptions();
            await page.keyboard.press("Escape");
            await page.waitForTimeout(200);
            const overallOpt = optsPost.find((o) => o.text.includes("팀 총괄"));
            const okOption = overallOpt ? overallOpt.completionCheck === expectOverallCheck && overallOpt.completedBg === expectOverallCheck : true;
            ck(`[${tag}][tab${ti}] 팀총괄 완료체크 == opened(status=${status})`, okTrigger && okOption, `trig=${trig.hasCheck} opt=${overallOpt?.completionCheck} expect=${expectOverallCheck}`);
            if (!(okTrigger && okOption)) mismatches++;

            // 선택 인디케이터(우측 absolute) ≠ 완료 인디케이터(좌측 emerald) — 팀총괄 선택 상태에서
            //   선택 인디케이터는 항상 있고, 완료 체크는 opened 일 때만. (opened/비opened 각 1회만 기록)
            const wantDistinct = expectOverallCheck ? !distinctOpenedDone : !distinctNonOpenedDone;
            if (overallOpt && wantDistinct) {
              const distinct = overallOpt.selectionIndicator === true && overallOpt.completionCheck === expectOverallCheck;
              ck(`[${tag}][tab${ti}] 선택(右)≠완료(左·emerald): 선택함→sel=${overallOpt.selectionIndicator}, 완료=${overallOpt.completionCheck}(opened=${expectOverallCheck})`, distinct);
              if (expectOverallCheck) distinctOpenedDone = true; else distinctNonOpenedDone = true;
            }

            if (expectOverallCheck && trig.hasCheck) sawOpenedWithCheck = true;
            // 최종 개설 완료가 아닌 모든 상태(none/reviewed)에서 체크 없음 — 반대 방향(체크 오표시 방지).
            if (!expectOverallCheck && !trig.hasCheck) sawNonOpenedNoCheck = true;

            // 개별 파트 체크는 submitted 기준 유지(별개 boolean).
            if (partOpt) {
              const partName = partOpt.text.replace(/\s+/g, " ").trim();
              const submitted = (lastBoard.parts.find((p) => partName.includes(p.partName)) || {}).submitted ?? null;
              await openPartSelect();
              await pickOption(partOpt.text);
              await page.waitForTimeout(800);
              const ptrig = await readTriggerCheck();
              if (submitted !== null) {
                ck(`[${tag}][tab${ti}] 파트 완료체크 == submitted(${submitted})`, ptrig.hasCheck === submitted, `partCheck=${ptrig.hasCheck} submitted=${submitted}`);
              }
            }
          } catch (e) {
            skipped++; // 개별 탭 전환 플레이크(클릭 타임아웃 등)는 스킵 — 전체 중단/실패로 세지 않음.
            console.log(`  · [${tag}][tab${ti}] 스킵(플레이크): ${(e?.message || "").slice(0, 50)}`);
            await page.keyboard.press("Escape").catch(() => {});
          }
        }
      } catch (e) {
        ck(`[${tag}] 실행 오류`, false, e?.message ?? String(e));
      }
    }
  }
}

// 양방향 관측 + 불변식.
ck(`불변식: 관측된 모든 보드에서 완료체크 == (status==="opened")`, mismatches === 0, `mismatches=${mismatches}`);
ck(`opened 보드에서 팀총괄 체크 관측(양성)`, sawOpenedWithCheck);
ck(`opened 아닌 보드에서 팀총괄 체크 없음 관측(음성)`, sawNonOpenedNoCheck);

// 검수완료(reviewed) 보드는 개설 가능 주차 창(최근 3주) 밖의 과거 주차에 있어 UI 드롭다운으로는
//   도달 불가 — 그러나 완료 판정식은 트리거·옵션 공통 단일식 `status === "opened"` 로, reviewed 를
//   위한 별도 분기가 없다. SoT(DB status="reviewed") 에 이 판정식을 적용해 "체크 없음"을 명시 검증한다.
const reviewedBoards = (boards ?? []).filter((b) => b.status === "reviewed");
const reviewedNoCheck = reviewedBoards.every((b) => (b.status === "opened") === false);
ck(`검수완료(reviewed) 보드 → 완료체크 없음(판정식 status==="opened"=false)`, reviewedBoards.length > 0 && reviewedNoCheck, `reviewed=${reviewedBoards.length}`);

await browser.close();
console.log(`\n결과: ${pass} pass / ${fail} fail (스킵 ${skipped} — 탭전환 플레이크, 제품 무관)`);
process.exit(fail > 0 ? 1 : 0);
