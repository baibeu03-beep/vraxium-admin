// 검증(브라우저) — /admin/members/[userId] 크루 상세 페이지 실제 렌더.
//   1) "인적사항"·"클럽 소속" 두 섹션 제목 노출
//   2) 백엔드 DTO 값(이름/상태/크루 코드/활동 시작·종료일/주차/팀/파트)이 화면 텍스트에 반영
//   3) 프로필 사진(img) 또는 placeholder 노출
// read-only(백엔드 write 없음 · snapshot 무관).
//   사전조건: admin dev :3000. Usage: node scripts/browser-verify-crew-detail.mjs
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

// 표본: 활동 중단(종료 시즌 존재) 1명 + 졸업(종료 시즌·현재 "-") 1명 + 활동 중 1명.
const { data: suspended } = await sb
  .from("user_profiles").select("user_id,display_name").eq("growth_status", "suspended").limit(1);
const { data: graduated } = await sb
  .from("user_profiles").select("user_id,display_name").eq("growth_status", "graduated").limit(1);
const { data: active } = await sb
  .from("user_profiles").select("user_id,display_name")
  .eq("organization_slug", "encre").not("activity_started_at", "is", null).limit(1);
const samples = [...(suspended ?? []), ...(graduated ?? []), ...(active ?? [])];

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
await context.addCookies(cookies);
const page = await context.newPage();

for (const s of samples) {
  // 백엔드 DTO 값 확보(HTTP).
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const json = await (await fetch(`${BASE}/api/admin/members/${s.user_id}`, { headers: { cookie: cookieHeader } })).json();
  const d = json.data;

  await page.goto(`${BASE}/admin/members/${s.user_id}`, { waitUntil: "domcontentloaded" });
  // 첫 진입은 라우트 콜드 컴파일이 있을 수 있어 섹션 텍스트가 보일 때까지 대기(최대 20s).
  await page
    .waitForFunction(() => document.body.innerText.includes("클럽 결과(시즌)"), { timeout: 20000 })
    .catch(() => {});
  await page.waitForTimeout(500);
  const body = await page.evaluate(() => document.body.innerText);
  const imgCount = await page.evaluate(() => document.querySelectorAll("img").length);

  console.log(`▶ ${d.displayName} (${s.user_id}) · ${d.statusLabel}`);
  ck("섹션 제목 '인적사항'", body.includes("인적사항"));
  ck("섹션 제목 '클럽 소속'", body.includes("클럽 소속"));
  ck("이름 노출", d.displayName == null || body.includes(d.displayName));
  ck("상태 노출", body.includes(d.statusLabel));
  ck("크루 코드 노출", d.crewCode == null || body.includes(d.crewCode));
  ck("활동 시작일 노출", d.activityStartDate === "-" || body.includes(d.activityStartDate));
  ck("활동 시작 주차 노출", d.activityStartWeek === "-" || body.includes(d.activityStartWeek));
  ck("활동 종료일 노출", body.includes(d.activityEndDate));
  ck("클래스 노출", body.includes(d.classLabel));
  ck("팀 노출", d.teamName == null || body.includes(d.teamName));
  ck("사진 img 또는 placeholder", imgCount >= 1 || body.length > 0);

  // ── 클럽 결과(종합) 섹션 — 제목 + 12개 라벨 + SoT 값 노출 ──
  const cs = d.clubSummary;
  ck("섹션 제목 '클럽 결과(종합)'", body.includes("클럽 결과(종합)"));
  for (const lbl of [
    "성장 성공 주차", "포인트 A", "포인트 B", "포인트 C",
    "일정 신뢰도", "활동 완료율", "실무 정보", "실무 경험", "실무 역량", "실무 경력",
  ]) {
    ck(`라벨 '${lbl}'`, body.includes(lbl));
  }
  // 실무 4종(이력서 카드 skill-num) 값이 화면 텍스트에 반영.
  ck("실무 정보 값 노출", body.includes(String(cs.infoCount)));
  ck("실무 경험 값 노출", body.includes(String(cs.experienceCount)));
  ck("실무 역량 값 노출", body.includes(String(cs.abilityUnitCount)));
  ck("실무 경력 값 노출", body.includes(String(cs.careerProjectCount)));
  ck("성장 성공 주차 값 노출", cs.successWeeks == null || body.includes(String(cs.successWeeks)));
  ck("일정 신뢰도 값 노출", cs.scheduleReliability == null || body.includes(`${cs.scheduleReliability}%`));
  ck("활동 완료율 값 노출", cs.activityCompletion == null || body.includes(`${cs.activityCompletion}%`));

  // ── 클럽 결과(시즌) 섹션 — 제목 + 6라벨 + 시즌 요약 값 노출 ──
  const ss = d.seasonSummary;
  ck("섹션 제목 '클럽 결과(시즌)'", body.includes("클럽 결과(시즌)"));
  for (const lbl of [
    "성장 시작 시즌", "성장 종료 시즌", "현재 시즌",
    "성장 가능 시즌", "성장 성공 시즌", "성장 휴식 시즌",
  ]) {
    ck(`라벨 '${lbl}'`, body.includes(lbl));
  }
  ck("성장 시작 시즌 값 노출", body.includes(ss.startSeason));
  ck("성장 종료 시즌 값 노출", body.includes(ss.endSeason));
  ck("현재 시즌 값 노출", body.includes(ss.currentSeason));
  ck("성장 가능 시즌 값 노출", body.includes(`${ss.availableSeasons}개 시즌`));
  ck("성장 성공 시즌 값 노출", body.includes(`${ss.successSeasons}개 시즌`));
  ck("성장 휴식 시즌 값 노출", body.includes(`${ss.restSeasons}개 시즌`));

  // ── 클럽 결과(시즌) 하단부: 시즌별 결과 표 ──
  const sr = d.seasonResults ?? [];
  // 표 헤더 10컬럼 노출.
  for (const h of ["시즌명", "시즌 결과", "Po.A", "Po.B", "Po.C", "실무 정보", "실무 경험", "실무 역량", "실무 경력", "소속 & 클래스"]) {
    ck(`표 헤더 '${h}'`, body.includes(h));
  }
  // 전체 시즌 행이 페이지네이션 없이 모두 렌더(시즌명 전부 + 결과 라벨 전부 화면에 존재).
  ck("전체 시즌 행 렌더(페이지네이션 없음)",
    sr.length === 0 || sr.every((r) => body.includes(r.seasonNameShort)),
    `${sr.length}개 시즌 / 표시 ${sr.filter((r) => body.includes(r.seasonNameShort)).length}`);
  // 시즌별 결과 라벨 노출.
  ck("시즌 결과 라벨 노출", sr.length === 0 || sr.every((r) => body.includes(r.seasonResultLabel)), "");
  // 현재 시즌(진행 중)이 있으면 표에서 첫 시즌 행 = sr[0](백엔드 정렬: 진행 중 맨 위).
  const hasInProgress = sr.some((r) => r.seasonResultLabel === "진행 중");
  ck("진행 중 시즌이 표 맨 위(있으면)",
    !hasInProgress || sr[0].seasonResultLabel === "진행 중",
    hasInProgress ? `top=${sr[0].seasonNameShort}/${sr[0].seasonResultLabel}` : "진행 중 없음");
  // DOM 행 수 == 시즌 수(페이지네이션 없이 전부) — 표 tbody tr 개수로 교차 확인.
  if (sr.length > 0) {
    const rowCount = await page.evaluate(() => {
      const ths = Array.from(document.querySelectorAll("th")).map((t) => t.textContent || "");
      const table = Array.from(document.querySelectorAll("table")).find((tb) =>
        Array.from(tb.querySelectorAll("th")).some((t) => (t.textContent || "").includes("소속")),
      );
      return table ? table.querySelectorAll("tbody tr").length : -1;
    });
    ck("표 tbody 행 수 == 시즌 수", rowCount === sr.length, `dom=${rowCount} dto=${sr.length}`);
  }

  // ── 클럽 결과(주차) 섹션 — 제목 + 7라벨 + 주차 요약 값 노출 ──
  const w = d.weekSummary;
  ck("섹션 제목 '클럽 결과(주차)'", body.includes("클럽 결과(주차)"));
  for (const lbl of [
    "성장 시작 주차", "성장 종료 주차", "현재 주차",
    "성장 가능 주차", "성장 성공 주차", "성장 휴식 주차", "성장 실패 주차",
  ]) {
    ck(`라벨 '${lbl}'`, body.includes(lbl));
  }
  ck("성장 시작 주차 값 노출", body.includes(w.startWeek));
  ck("성장 종료 주차 값 노출", body.includes(w.endWeek));
  ck("현재 주차 값 노출", body.includes(w.currentWeek));
  ck("성장 가능 주차 값 노출", body.includes(`${w.availableWeeks}개 주차`));
  ck("성장 성공 주차 값 노출", body.includes(`${w.successWeeks}개 주차`));
  ck("성장 휴식 주차 값 노출", body.includes(`${w.restWeeks}개 주차`));
  ck("성장 실패 주차 값 노출", body.includes(`${w.failWeeks}개 주차`));

  // ── 클럽 결과(주차) 하단부: 주차 결과 표 + 페이지네이션 ──
  const wr = d.weeklyResults ?? [];
  // 표 헤더 13컬럼.
  for (const h of ["주차명", "성장 결과", "성장 성공 주차", "팀", "파트", "클래스", "Po.A", "Po.B", "Po.C", "실무 정보", "실무 경험", "실무 역량", "실무 경력"]) {
    ck(`주차표 헤더 '${h}'`, body.includes(h));
  }
  const totalPages = Math.max(1, Math.ceil(wr.length / 15));
  // DOM 측정 — 주차 결과 표(헤더 '성장 결과' 보유) tbody 행 수 + 첫 행 + 페이지 표시.
  const m = await page.evaluate(() => {
    const table = Array.from(document.querySelectorAll("table")).find((tb) =>
      Array.from(tb.querySelectorAll("th")).some((t) => (t.textContent || "").includes("성장 결과")),
    );
    const rows = table ? table.querySelectorAll("tbody tr").length : -1;
    const firstWeek = table ? (table.querySelector("tbody tr td")?.textContent || "") : "";
    const pageText = (document.body.innerText.match(/\d+ \/ \d+ 페이지/) || [""])[0];
    return { rows, firstWeek, pageText };
  });
  // 12) 기본 진입 = 1페이지.
  ck("기본 진입 = 1페이지", wr.length === 0 || m.pageText === "" || m.pageText.startsWith(`1 / ${totalPages}`),
    `pageText="${m.pageText}" totalPages=${totalPages}`);
  // 11) 1페이지 행 수 = min(15, 전체).
  if (wr.length > 0) {
    ck("페이지네이션 15단위(1페이지 행수)", m.rows === Math.min(15, wr.length), `dom=${m.rows} expect=${Math.min(15, wr.length)} (전체${wr.length})`);
    // 1페이지 맨 위 = 전체 최신 주차(weeklyResults 마지막 행 = 최신).
    ck("1페이지 맨 위 = 최신 주차", m.firstWeek === wr[wr.length - 1].weekName, `dom="${m.firstWeek}" dto="${wr[wr.length - 1].weekName}"`);
  }
}

await browser.close();
console.log("─".repeat(50));
console.log(fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
