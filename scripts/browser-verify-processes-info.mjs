// 검증 — /admin/processes/info 브라우저 반영 (요약 2열·정렬·필터·페이지네이션·식별자·삭제).
//   career 허브에 42개 액트 시드(페이지네이션 40 기준 결정적) — net-zero 정리.
//   사용자 실제 데이터(비TAG)는 무접촉.
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
const HUB = "career", TAG = "ZZ-pinfoUI";
const SEED_N = 42;
const sb = createClient(SUPABASE_URL, SERVICE);
const TIMES = ["06:00", "09:30", "12:00", "18:30", "21:00"];

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

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

await cleanup();
const grp = (await sb.from("process_line_groups").insert({ hub: HUB, name: `${TAG} 라인급` }).select("id").single()).data;
const ACT_TYPES = ["required", "optional", "selection", "basic"];
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

const cookies = await makeAdminCookies();
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 2400 } });
await context.addCookies(cookies);
const page = await context.newPage();
page.on("dialog", (d) => d.accept().catch(() => {}));

const readActCount = () => page.evaluate(() => {
  const label = [...document.querySelectorAll("span")].find((d) => d.textContent?.trim() === "산하 액트 수");
  const m = (label?.nextElementSibling?.textContent ?? "").match(/(\d+)/);
  return m ? Number(m[1]) : -1;
});
// tbody 행 → 셀 텍스트 배열. [번호,액트명,라인급,소요,발생,체크,A,B,C,크루반응,체크대상,카페,삭제]
const readRows = () => page.evaluate(() =>
  [...document.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent?.trim() ?? "")),
);
// "N주 일 06:00" / "N+1주 금 21:00" → 비교용 정수.
const whenRank = (s) => {
  const parts = s.trim().split(/\s+/); // [주, 요일, HH:MM]
  const w = parts[0].includes("N+1") ? 1 : 0;
  const dow = "일월화수목금토".indexOf(parts[1] ?? "");
  const tm = (parts[2] ?? "00:00").split(":");
  return w * 100000 + dow * 10000 + Number(tm[0]) * 60 + Number(tm[1]);
};
const isAsc = (arr) => arr.every((v, i) => i === 0 || arr[i - 1] <= v);

try {
  await page.goto(`${BASE}/admin/processes/info`, { waitUntil: "domcontentloaded" });
  // 하이드레이션 완료 대기(클라 컴포넌트 렌더 = 정렬 셀렉트 존재) 후 탭 클릭 — 클릭 유실 방지.
  await page.waitForSelector('select[aria-label="정렬"]', { timeout: 30000 });
  // career 탭으로 전환 (locator 클릭 + career 행 로드 대기 = 전환 성공 신호).
  await page.getByRole("button", { name: "실무 경력 급" }).click();
  await page.waitForFunction(
    (t) => [...document.querySelectorAll("tbody tr")].some((tr) => tr.textContent?.includes(t)),
    `${TAG} 액트`,
    { timeout: 30000 },
  );

  // 1) 요약 2열 레이아웃 (좌 3 / 우 3) — md:grid-cols-2 컨테이너 안에 두 컬럼.
  const layout = await page.evaluate(() => {
    const labels = ["산하 액트 수", "산하 라인급 수", "총합 소요 시간", "필수 포인트 총합", "우수 포인트 총합", "최대 포인트 총합"];
    const present = labels.every((t) => document.body.innerText.includes(t));
    // 좌/우 컬럼 분리: '산하 액트 수'와 '필수 포인트 총합'의 좌표 left 비교(우측이 더 오른쪽).
    const find = (t) => [...document.querySelectorAll("span")].find((d) => d.textContent?.trim() === t);
    const a = find("산하 액트 수")?.getBoundingClientRect();
    const b = find("필수 포인트 총합")?.getBoundingClientRect();
    const twoCol = !!a && !!b && b.left > a.right - 5;
    // 우측 값 포맷 "A n | B n | C n"
    const reqVal = find("필수 포인트 총합")?.nextElementSibling?.textContent?.trim() ?? "";
    return { present, twoCol, reqFmt: /A \d+ \| B \d+ \| C \d+/.test(reqVal), reqVal };
  });
  check("[요약] 6항목 라벨 + 2열 배치(좌 액트/우 포인트)", layout.present && layout.twoCol);
  check("[요약] 포인트 'A n | B n | C n' 포맷", layout.reqFmt, layout.reqVal);

  // 2) 식별자 컬럼 — 8자리 hex
  const rows0 = await readRows();
  check("[식별자] 번호 컬럼 = UUID 앞 8자리(hex)", rows0.length > 0 && rows0.every((r) => /^[0-9a-f]{8}$/.test(r[0])), rows0[0]?.[0]);

  // 3) 페이지네이션 — 시드42(career) → 전체 42 → page1 40행, page2 2행
  const total = await readActCount();
  check("[요약] 산하 액트 수 = 시드 42 반영", total === SEED_N, `count=${total}`);
  check("[페이지] page1 = 40행", rows0.length === 40, `rows=${rows0.length}`);
  const hasPager = await page.evaluate(() => !!document.querySelector('[aria-label="페이지네이션"]'));
  check("[페이지] 페이지네이션 컨트롤 표시(>40)", hasPager);
  await page.click('button[aria-label="2 페이지"]');
  await page.waitForFunction("[...document.querySelectorAll('tbody tr')].length === 2", undefined, { timeout: 10000 }).catch(() => {});
  const rows2 = await readRows();
  check("[페이지] page2 = 나머지 2행", rows2.length === SEED_N - 40, `rows=${rows2.length}`);

  // 4) 정렬 — 기본(발생 시점 순) page1 단조 증가
  await page.click('button[aria-label="1 페이지"]').catch(() => {});
  await page.waitForFunction("[...document.querySelectorAll('tbody tr')].length === 40", undefined, { timeout: 10000 }).catch(() => {});
  const occurRows = await readRows();
  check("[정렬] 발생 시점 순(기본) — page1 발생시점 오름차순(N→N+1·요일·시간)",
    isAsc(occurRows.map((r) => whenRank(r[4]))));
  // 소요 시간 순
  await page.selectOption('select[aria-label="정렬"]', "duration");
  await page.waitForTimeout(200);
  const durRows = await readRows();
  check("[정렬] 소요 시간 순 — page1 소요(m) 오름차순", isAsc(durRows.map((r) => Number(r[3]))));
  // 정렬 변경 시 page=1 유지(리셋) — 현재 page 버튼 1이 활성.
  const onPage1 = await page.evaluate(() => document.querySelector('button[aria-current="page"]')?.textContent?.trim() === "1");
  check("[정렬] 정렬 변경 시 1페이지로 리셋", onPage1);

  // 5) 필터 — 필수 → 모든 행 크루 반응=필수 / 체크 → 체크대상=체크 / 포스팅 → 카페=발생
  await page.selectOption('select[aria-label="필터"]', "required");
  await page.waitForTimeout(200);
  const reqRows = await readRows();
  check("[필터] 필수 → 모든 행 크루 반응=필수", reqRows.length > 0 && reqRows.every((r) => r[9] === "필수"), `n=${reqRows.length}`);
  await page.selectOption('select[aria-label="필터"]', "check");
  await page.waitForTimeout(200);
  const chkRows = await readRows();
  check("[필터] 체크 → 모든 행 체크 대상=체크", chkRows.length > 0 && chkRows.every((r) => r[10] === "체크"));
  await page.selectOption('select[aria-label="필터"]', "posting");
  await page.waitForTimeout(200);
  const postRows = await readRows();
  check("[필터] 포스팅 → 모든 행 카페=발생", postRows.length > 0 && postRows.every((r) => r[11] === "발생"));
  await page.selectOption('select[aria-label="필터"]', "all");
  await page.waitForTimeout(200);

  // 6) 삭제 후 요약 재계산 (요약은 허브 전체 기준 → 42→41)
  const before = await readActCount();
  const firstName = (await readRows())[0]?.[1];
  const delBtn = page.locator("tr", { hasText: firstName }).locator("button", { hasText: "삭제" });
  await delBtn.click();
  const settled = await page.waitForFunction((w) => {
    const label = [...document.querySelectorAll("span")].find((d) => d.textContent?.trim() === "산하 액트 수");
    const m = (label?.nextElementSibling?.textContent ?? "").match(/(\d+)/);
    return m && Number(m[1]) === w;
  }, before - 1, { timeout: 15000 }).then(() => true).catch(() => false);
  const after = await readActCount();
  const dbGone = (await sb.from("process_acts").select("id").eq("act_name", firstName).maybeSingle()).data;
  check("[삭제] 액트 삭제 후 요약 재계산(산하 액트 수 -1) + DB 삭제", settled && after === before - 1 && !dbGone, `before=${before} after=${after}`);

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-processes-info.png"), fullPage: true });
  console.log("  screenshot → claudedocs/browser-processes-info.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-processes-info-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
  await cleanup();
  console.log("(cleanup 완료 — net-zero)");
}
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
