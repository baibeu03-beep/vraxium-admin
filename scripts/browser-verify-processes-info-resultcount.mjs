// 검증 — /admin/processes/info UI 변경: 카드 제목 제거 · 정렬/필터 좌측 · "결과 수 n개" 우측(필터 반영 전체).
//   career 허브에 42개 시드(페이지네이션 40 초과). 결과 수는 DB 실측 카운트와 대조. net-zero 정리.
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
const HUB = "career", TAG = "ZZ-pinfoRC";
const SEED_N = 42;
const sb = createClient(SUPABASE_URL, SERVICE);
const TIMES = ["06:00", "09:30", "12:00", "18:30", "21:00"];
const ACT_TYPES = ["required", "optional", "selection", "basic"];

async function cleanup() {
  const g = (await sb.from("process_line_groups").select("id").eq("hub", HUB).like("name", `${TAG}%`)).data ?? [];
  const ids = g.map((x) => x.id);
  if (ids.length) { await sb.from("process_acts").delete().in("line_group_id", ids); await sb.from("process_line_groups").delete().in("id", ids); }
}
async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({ email: adminEmail, token: linkData.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}
async function dbCount(extra) {
  let q = sb.from("process_acts").select("id", { count: "exact", head: true }).eq("hub", HUB);
  if (extra) q = extra(q);
  return (await q).count ?? -1;
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

await cleanup();
const grp = (await sb.from("process_line_groups").insert({ hub: HUB, name: `${TAG} 라인급` }).select("id").single()).data;
const seedRows = Array.from({ length: SEED_N }, (_, i) => ({
  line_group_id: grp.id, hub: HUB, act_name: `${TAG} 액트${String(i + 1).padStart(2, "0")}`,
  duration_minutes: 5 + (i % 18) * 5,
  occur_week: i < 21 ? "N" : "N1", occur_dow: i % 7, occur_time: TIMES[i % TIMES.length],
  check_week: "N1", check_dow: (i + 2) % 7, check_time: TIMES[(i + 1) % TIMES.length],
  point_check: i % 5, point_advantage: i % 3, point_penalty: i % 2,
  cafe: i % 3 === 0 ? "occur" : "none", check_target: i % 2 === 0 ? "check" : "none",
  act_type: ACT_TYPES[i % 4],
}));
const seedRes = await sb.from("process_acts").insert(seedRows).select("id");
if (seedRes.error) { console.error("seed insert error:", seedRes.error.message); process.exit(1); }
console.log(`(시드: career 허브 액트 ${seedRes.data?.length ?? 0}개 삽입)`);

// DB 실측 기대값(허브 전체 = 탭/필터 모집단).
const expAll = await dbCount();
const expRequired = await dbCount((q) => q.eq("act_type", "required"));
const expCheck = await dbCount((q) => q.eq("check_target", "check"));

const cookies = await makeAdminCookies();
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 2400 } });
await context.addCookies(cookies);
const page = await context.newPage();
page.on("dialog", (d) => d.accept().catch(() => {}));

const readResultCount = () => page.evaluate(() => {
  const el = [...document.querySelectorAll("span")].find((d) => /결과 수 \d+개/.test(d.textContent?.trim() ?? ""));
  const m = (el?.textContent ?? "").match(/결과 수 (\d+)개/);
  return m ? Number(m[1]) : -1;
});
const rowCount = () => page.evaluate(() => document.querySelectorAll("tbody tr").length);

try {
  await page.goto(`${BASE}/admin/processes/info`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('select[aria-label="정렬"]', { timeout: 30000 });
  await page.getByRole("button", { name: "실무 경력 급" }).click();
  await page.waitForFunction(
    (t) => [...document.querySelectorAll("tbody tr")].some((tr) => tr.textContent?.includes(t)),
    `${TAG} 액트`, { timeout: 30000 },
  );

  // 1) 카드 제목 "액트 목록 (n)" 제거
  const bodyText = await page.evaluate(() => document.body.innerText);
  check('[제목] "액트 목록" 카드 제목 부재', !/액트 목록\s*\(/.test(bodyText) && !bodyText.includes("액트 목록"));

  // 2) 정렬/필터 좌측 · 결과 수 우측 (boundingRect left 비교)
  const pos = await page.evaluate(() => {
    const sort = document.querySelector('select[aria-label="정렬"]')?.getBoundingClientRect();
    const rc = [...document.querySelectorAll("span")].find((d) => /결과 수 \d+개/.test(d.textContent?.trim() ?? ""))?.getBoundingClientRect();
    return { sortLeft: sort?.left ?? -1, rcLeft: rc?.left ?? -1, rcExists: !!rc };
  });
  check("[배치] 정렬/필터가 좌측, 결과 수가 우측", pos.rcExists && pos.sortLeft < pos.rcLeft, `sortLeft=${Math.round(pos.sortLeft)} rcLeft=${Math.round(pos.rcLeft)}`);

  // 3) 결과 수(전체) = DB 실측 · 페이지(40)보다 큼 = 페이지 행수 아님
  const rcAll = await readResultCount();
  const rowsAll = await rowCount();
  check("[결과 수] 전체 = DB 실측 카운트", rcAll === expAll, `ui=${rcAll} db=${expAll}`);
  check("[결과 수] 페이지네이션 무관(전체 필터 결과) — 결과수 > page1 행수", expAll > 40 && rowsAll === 40 && rcAll > rowsAll, `결과수=${rcAll} page1행=${rowsAll}`);

  // 4) 필터 변경 → 결과 수 = 실제 필터 결과
  await page.selectOption('select[aria-label="필터"]', "required");
  await page.waitForTimeout(200);
  const rcReq = await readResultCount();
  const rowsReq = await rowCount();
  check("[결과 수] 필터=필수 → DB 실측 일치 + 렌더 행수 일치", rcReq === expRequired && rowsReq === expRequired, `ui=${rcReq} db=${expRequired} rows=${rowsReq}`);

  await page.selectOption('select[aria-label="필터"]', "check");
  await page.waitForTimeout(200);
  const rcChk = await readResultCount();
  check("[결과 수] 필터=체크 → DB 실측 일치", rcChk === expCheck, `ui=${rcChk} db=${expCheck}`);

  await page.selectOption('select[aria-label="필터"]', "all");
  await page.waitForTimeout(200);
  check("[결과 수] 필터=전체 복귀 → 전체 카운트", (await readResultCount()) === expAll);

  // 5) 삭제 기능 유지 — 삭제 후 결과 수 -1 + DB 제거
  const firstName = await page.evaluate(() => document.querySelector("tbody tr td:nth-child(2)")?.textContent?.trim() ?? "");
  const before = await readResultCount();
  await page.locator("tr", { hasText: firstName }).locator("button", { hasText: "삭제" }).click();
  const settled = await page.waitForFunction((w) => {
    const el = [...document.querySelectorAll("span")].find((d) => /결과 수 \d+개/.test(d.textContent?.trim() ?? ""));
    const m = (el?.textContent ?? "").match(/결과 수 (\d+)개/);
    return m && Number(m[1]) === w;
  }, before - 1, { timeout: 15000 }).then(() => true).catch(() => false);
  const dbGone = (await sb.from("process_acts").select("id").eq("act_name", firstName).maybeSingle()).data;
  check("[삭제] 삭제 후 결과 수 -1 + DB 제거", settled && !dbGone, `before=${before} after=${await readResultCount()}`);

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-processes-info-resultcount.png"), fullPage: true });
  console.log("  screenshot → claudedocs/browser-processes-info-resultcount.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
} finally {
  await browser.close();
  await cleanup();
  console.log("(cleanup 완료 — net-zero)");
}
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
