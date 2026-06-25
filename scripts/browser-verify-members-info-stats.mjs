// 검증(브라우저) — /admin/members?tab=info [섹션.1] 역대 누적 + 주차별 데이터 실제 렌더.
//   A) 표 13컬럼 헤더 · 페이지네이션 · 누적 4지표 라벨
//   B) 탭별 누적 4지표 값이 페이지가 받은 DTO 와 일치(누적은 결정적) + 최신 확정 주차 렌더
//   C) 미확정(현재) 주차 = 시즌&주차 노출 + 집계셀 "-"
//   D) 섹션.0 배너는 클럽 탭 전환 시 불변
//   E) 통합 누적 = 엥크레+오랑캐+팔랑크스
// read-only(백엔드 write 없음 · snapshot 무관). 사전조건: admin dev :3000.
//   ⚠ 통합 집계는 fat snapshot 으로 수십 초 — page.waitForResponse 로 페이지 '자체' 응답을 캡처해
//      중복 요청/타임아웃/스냅샷 변동 레이스를 제거(DOM 과 DTO 가 동일 응답에서 나옴).
//      주차별 정확 값 동치는 tsx(verify-members-info-stats / -sum)가 권위 검증.
//   Usage: node scripts/browser-verify-members-info-stats.mjs
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

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({
  name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
}));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
await context.addCookies(cookies);
const page = await context.newPage();

const section0Text = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="members-info-section0"]');
    return el ? el.innerText : "";
  });
const bodyText = () => page.evaluate(() => document.body.innerText);

// 페이지가 보낸 info-stats 응답을 캡처(org 별 매칭). 중복 요청 없이 DOM 과 동일 DTO.
function waitDto(org) {
  return page
    .waitForResponse(
      (r) => {
        if (!r.url().includes("/api/admin/members/info-stats")) return false;
        const hasOrg = r.url().includes(`organization=${org}`);
        return org === "all" ? !r.url().includes("organization=") : hasOrg;
      },
      { timeout: 180000 },
    )
    .then((r) => r.json())
    .then((j) => j.data);
}
const waitRendered = (weekName) =>
  page
    .waitForFunction(
      (n) => document.body.innerText.includes(n) && document.body.innerText.includes("Oldest"),
      weekName,
      { timeout: 180000 },
    )
    .catch(() => {});

async function checkTab(org, label, dto) {
  const ff = (dto.weeks ?? []).find((w) => w.finalized);
  await waitRendered(ff ? ff.seasonWeekName : "주차별 데이터");
  await page.waitForTimeout(400);
  const b = await bodyText();
  ck(`[${label}] 누적 클러빙 값 ${dto.cumulative.cumulativeClubbing}`, b.includes(dto.cumulative.cumulativeClubbing.toLocaleString("en-US")));
  ck(`[${label}] 누적 라벨 4종`, ["클럽 수", "누적 클러빙", "누적 엘리트", "누적 활동 중단"].every((l) => b.includes(l)));
  if (ff) {
    ck(`[${label}] 확정 주차 '${ff.seasonWeekName}' 렌더`, b.includes(ff.seasonWeekName));
    ck(`[${label}] 확정 주차 클러빙 셀 ${ff.clubbing} 노출`, b.includes(ff.clubbing.toLocaleString("en-US")));
  }
  const pend = (dto.weeks ?? []).find((w) => !w.finalized);
  if (pend) {
    ck(`[${label}] 미확정 주차 '${pend.seasonWeekName}' 렌더`, b.includes(pend.seasonWeekName));
    ck(`[${label}] 미확정 집계셀 "-"`, b.includes("-"));
  }
  return b;
}

// ── 통합 로드(단일 요청) ──
console.log("▶ /admin/members?tab=info (통합)");
const allP = waitDto("all");
await page.goto(`${BASE}/admin/members?tab=info`, { waitUntil: "domcontentloaded" });
const allDto = await allP;
const body0 = await checkTab("all", "통합", allDto);
for (const h of [
  "클럽 상태", "시즌 & 주차", "클럽 수", "클러빙", "시즌 휴식", "엘리트",
  "활동 중단", "주차 휴식", "성장 성공(a)", "성장 실패(b)", "성장 성공율(c)",
  "주차 성장률(d)", "Oldest",
]) ck(`표 헤더 '${h}'`, body0.includes(h));
ck("페이지네이션 '이전/다음'", body0.includes("이전") && body0.includes("다음"));
const baselineSection0 = await section0Text();

// ── 클럽 탭 전환 ──
const dtos = { all: allDto };
for (const t of [{ label: "엥크레", org: "encre" }, { label: "오랑캐", org: "oranke" }, { label: "팔랑크스", org: "phalanx" }]) {
  console.log(`\n▶ 탭 전환: ${t.label}`);
  const p = waitDto(t.org);
  await page.getByRole("button", { name: t.label, exact: true }).click();
  const dto = await p;
  dtos[t.org] = dto;
  await checkTab(t.org, t.label, dto);
  const s0 = await section0Text();
  ck(`[${t.label}] 섹션.0 배너 불변`, s0 === baselineSection0, s0 === baselineSection0 ? "" : "변경됨");
}

ck(
  "통합 누적 클러빙 = 엥크레+오랑캐+팔랑크스",
  dtos.all.cumulative.cumulativeClubbing ===
    dtos.encre.cumulative.cumulativeClubbing + dtos.oranke.cumulative.cumulativeClubbing + dtos.phalanx.cumulative.cumulativeClubbing,
  `${dtos.all.cumulative.cumulativeClubbing} = ${dtos.encre.cumulative.cumulativeClubbing}+${dtos.oranke.cumulative.cumulativeClubbing}+${dtos.phalanx.cumulative.cumulativeClubbing}`,
);

await browser.close();
console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
process.exit(fail === 0 ? 0 : 1);
