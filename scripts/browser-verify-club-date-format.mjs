// 브라우저(인증 세션) 검증 — 어드민 클럽 일정 날짜 표기 통일("YY - MM - DD (요일)").
//   · 클럽 일정 페이지들에 신규 형식이 렌더되는가(positive presence)
//   · 신규 형식의 요일이 실제 날짜와 일치하는가(weekday 정확성 — 가장 강한 검사)
//   · 시각 동반 항목은 "YY - MM - DD (요일) HH:mm" 형식인가
//   · 크루 생년월일(멤버 관리)은 신규 형식으로 바뀌지 않았는가(제외 확인)
// 사용법: node scripts/browser-verify-club-date-format.mjs
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

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
// 신규 날짜 형식: "YY - MM - DD (요일)" — 날짜 내부 공백은 NBSP(U+00A0)이므로 \s 로 매칭.
const DATE_RE = /\b(\d{2})\s-\s(\d{2})\s-\s(\d{2})\s\(([일월화수목금토])\)/g;
const DATETIME_RE = /\b\d{2}\s-\s\d{2}\s-\s\d{2}\s\([일월화수목금토]\)\s\d{2}:\d{2}/g;
// 구(舊) 클럽 일정 형식(있으면 안 되는 표기 — 단, 메타/생성일 제외분은 페이지별로 판단)
const OLD_RES = [
  { name: "YYYY년 M월 D일", re: /\d{4}년 \d{1,2}월 \d{1,2}일/g },
  { name: "YYYY-MM-DD(요일)", re: /\d{4}-\d{2}-\d{2}\([일월화수목금토]\)/g },
];

// 신규 형식 날짜의 요일이 실제와 맞는지 검증. 연도 2자리는 2000+ 가정(클럽 일정 범위).
function weekdayMismatches(text) {
  const bad = [];
  let m;
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(text))) {
    const [whole, yy, mm, dd, dow] = m;
    const y = 2000 + Number(yy);
    const expected = WEEKDAYS[new Date(Date.UTC(y, Number(mm) - 1, Number(dd))).getUTCDay()];
    if (expected !== dow) bad.push(`${whole} (실제=${expected})`);
  }
  return bad;
}

function countNew(text) {
  DATE_RE.lastIndex = 0;
  const dates = text.match(DATE_RE) || [];
  const dts = text.match(DATETIME_RE) || [];
  return { dateCount: dates.length, dtCount: dts.length };
}

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

// 한 페이지 방문 → body 텍스트 회수.
async function visit(url) {
  await page.goto(url, { waitUntil: "networkidle" });
  // 일부 보드는 비동기 렌더 → 약간 대기
  await page.waitForTimeout(800);
  return page.evaluate(() => document.body.innerText);
}

// 클럽 일정 날짜가 등장해야 하는 페이지들(positive presence + weekday 정확성).
const PAGES = [
  { label: "시즌/주차 관리", url: `${BASE}/admin/season-weeks?org=encre`, expectDate: true },
  { label: "시즌 참여(season-participations)", url: `${BASE}/admin/season-participations?org=encre`, expectDate: true },
  { label: "기간 등록(periods/register)", url: `${BASE}/admin/periods/register?org=encre`, expectDate: false },
  { label: "주차 인정 결과(week-recognitions)", url: `${BASE}/admin/week-recognitions?org=encre`, expectDate: true },
  { label: "주차 카드 확정(weekly-card-finalization)", url: `${BASE}/admin/weekly-card-finalization?org=encre`, expectDate: false },
  { label: "공식 휴식 기간", url: `${BASE}/admin/official-rest-periods?org=encre`, expectDate: true },
  { label: "라인 개설 — 실무 정보", url: `${BASE}/admin/line-opening/practical-info?org=encre`, expectDate: true },
  { label: "라인 개설 — 실무 경험", url: `${BASE}/admin/line-opening/practical-experience?org=encre`, expectDate: false },
  { label: "라인 개설 — 실무 역량", url: `${BASE}/admin/line-opening/practical-competency?org=encre`, expectDate: false },
  { label: "라인 이력(line-history)", url: `${BASE}/admin/line-opening/line-history?org=encre`, expectDate: false },
  { label: "프로세스 체크 — info", url: `${BASE}/admin/processes/check/info?org=encre`, expectDate: false },
  { label: "수정 가능 기간(edit-windows)", url: `${BASE}/admin/settings/edit-windows?org=encre`, expectDate: false },
  { label: "라인 개설 기간(line-opening-windows)", url: `${BASE}/admin/settings/line-opening-windows?org=encre`, expectDate: false },
];

try {
  for (const p of PAGES) {
    console.log(`\n[${p.label}] ${p.url}`);
    let text;
    try {
      text = await visit(p.url);
    } catch (e) {
      check("페이지 로드", false, String(e).slice(0, 120));
      continue;
    }
    const { dateCount, dtCount } = countNew(text);
    const bad = weekdayMismatches(text);
    check("페이지 로드 OK", true, `신규날짜 ${dateCount}개 · 날짜+시각 ${dtCount}개`);
    if (p.expectDate) {
      check("신규 형식 'YY - MM - DD (요일)' 렌더됨", dateCount > 0, `count=${dateCount}`);
    }
    check("렌더된 신규 날짜의 요일 전부 정확", bad.length === 0, bad.slice(0, 5).join(" | "));
  }

  // ── 멤버 관리(크루 정보 탭): 상단 배너 신규 형식 + 생년월일 제외 확인 ──
  //   배너의 오늘/주차 기간(todayLabel/periodRange)은 '크루 정보' 탭(tab=info)에서만 노출된다.
  console.log(`\n[멤버 관리 — 크루 정보 배너 + 생년월일 제외] ${BASE}/admin/members?org=encre&tab=info`);
  const memText = await visit(`${BASE}/admin/members?org=encre&tab=info`);
  const memNew = countNew(memText);
  const memBad = weekdayMismatches(memText);
  // 배너의 오늘/주차 기간은 신규 형식이어야 함(클럽 일정)
  check("멤버 관리 상단 배너 신규 형식 존재", memNew.dateCount > 0, `count=${memNew.dateCount}`);
  check("멤버 관리 신규 날짜 요일 정확", memBad.length === 0, memBad.slice(0, 5).join(" | "));
  // 생년월일: user_profiles.birth_date 표본을 뽑아, 그 값이 신규 형식으로 렌더되지 않았는지 확인
  const { data: bd } = await admin
    .from("user_profiles")
    .select("birth_date")
    .not("birth_date", "is", null)
    .limit(1);
  if (bd && bd[0]?.birth_date) {
    const iso = String(bd[0].birth_date).slice(0, 10); // YYYY-MM-DD
    const [by, bm, bdd] = iso.split("-");
    // 신규 형식은 날짜 내부가 NBSP(U+00A0) → 생년월일이 잘못 변환됐다면 이 NBSP 형태로 렌더됨
    const newForm = `${by.slice(2)} - ${bm} - ${bdd} (`;
    check("생년월일이 신규 형식으로 렌더되지 않음(제외)", !memText.includes(newForm), `birth=${iso}`);
  } else {
    console.log("  (생년월일 표본 없음 — 제외 검사 생략)");
  }

  console.log(`\n=== RESULT: ${pass} pass / ${fail} fail ===`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
} finally {
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
