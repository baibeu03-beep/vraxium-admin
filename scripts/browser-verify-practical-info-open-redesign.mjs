// 브라우저 검증 — practical-info 라인 개설(open) 탭 UI 수정(2026-06-14).
//   #1 상단 활동유형 탭 유지 + 라인명 드롭다운=현재 탭 유형만 + 탭 변경 시 선택 초기화
//   #2 개설/검수 기록 카드 제거  #3 설명 문구 제거  #4 "개설 주차"/"라인명" 라벨
//   #5 아웃풋 링크/이미지 2행 1열 + 필드명(링크1/설명1/이미지1)  #7 수동입력 위치
//   표시 검증 — DB/저장 무접촉.
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
const ORG = "oranke";

async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, SERVICE);
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

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 2200 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

// 라인명 select 의 옵션 텍스트 + 현재값 읽기.
async function readLineSelect() {
  return page.evaluate(() => {
    const sel = document.querySelector('select[aria-label="라인명"]');
    if (!sel) return null;
    return {
      value: sel.value,
      valueText: sel.options[sel.selectedIndex]?.text ?? "",
      options: Array.from(sel.options).map((o) => o.text),
    };
  });
}

try {
  console.log("\n[라인 개설(open) 탭]");
  await page.goto(`${BASE}/admin/line-opening/practical-info?org=${ORG}&tab=open`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("document.body.innerText.includes('라인 개설')", undefined, { timeout: 60000 });
  await page.waitForFunction("document.querySelector('select[aria-label=\"라인명\"]') !== null", undefined, { timeout: 60000 });
  const body = await page.evaluate("document.body.innerText");

  // #1 상단 활동유형 탭 유지
  const hasTabs = ["위즈덤", "에세이", "인포데스크", "캘린더", "포럼", "세션", "아카데미", "커뮤니티", "기타A"].every((t) => body.includes(t));
  check("[#1] 상단 활동유형 탭 9종 유지", hasTabs);

  // #4 라벨
  check("[#4] '라인명' 라벨 노출", body.includes("라인명"));
  check("[#4] '개설할 라인' 라벨 제거", !body.includes("개설할 라인"));
  check("[#4] '개설 주차' 라벨 노출", body.includes("개설 주차"));
  check("[#4] '개설할 주차' 라벨 제거", !body.includes("개설할 주차"));

  // #2 개설/검수 기록 카드 제거
  check("[#2] '개설/검수 기록' 카드 제거", !body.includes("개설/검수 기록"));

  // #3 설명 문구 제거
  check("[#3] '개설할 주차는 자동 고정됩니다' 설명 제거", !body.includes("개설할 주차는 자동 고정"));
  check("[#3] '링크 1개 + 이미지 1개 모두 필수' 설명 제거", !body.includes("링크 1개 + 이미지 1개"));
  check("[#3] '0명 가능 (0명 = 전체 크루 강화 실패)' 설명 제거", !body.includes("0명 가능"));

  // #5 아웃풋 필드명
  check("[#5] 아웃풋 '링크 1' 필드명", body.includes("링크 1"));
  check("[#5] 아웃풋 '이미지 1' 필드명", body.includes("이미지 1"));
  check("[#5] 아웃풋 '설명 1' 필드명", body.includes("설명 1"));
  const imgControls = await page.evaluate(`
    !!document.querySelector('[aria-label="이미지 업로드"]') && !!document.querySelector('[aria-label="이미지 삭제"]')
  `);
  check("[#5] 이미지 업로드/삭제 아이콘 버튼 존재", imgControls);

  // #7 수동 추가 검색 = 인원/초기화 바에 위치
  check("[#7] '검수 크루 목록' 노출", body.includes("검수 크루 목록"));
  check("[#7] 크루 수동 추가 검색창 존재", await page.evaluate(`!!document.querySelector('[aria-label="크루 수동 추가 검색"]')`));

  // #1 라인명 드롭다운 = 현재 탭(기본=위즈덤) 유형만
  const sel1 = await readLineSelect();
  // 옵션 = ["라인을 선택해주세요", "<현재 탭>"] → 실제 라인 옵션 1개
  const realOpts1 = sel1.options.filter((t) => t !== "라인을 선택해주세요");
  check("[#1] 라인명 드롭다운 후보=현재 탭 1종", realOpts1.length === 1, `options=${JSON.stringify(sel1.options)} value=${sel1.valueText}`);
  check("[#1] 라인명 값=상단 탭 유형(위즈덤)", sel1.valueText === "위즈덤", `value=${sel1.valueText}`);

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-practical-info-open-redesign.png"), fullPage: true });

  // #1 탭 변경 시 라인명 후보/선택 초기화 → '에세이' 탭 클릭
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "에세이");
    btn?.click();
  });
  await page.waitForFunction(`
    (() => { const s = document.querySelector('select[aria-label="라인명"]');
      return s && s.options[s.selectedIndex]?.text === "에세이"; })()
  `, undefined, { timeout: 10000 }).catch(() => {});
  const sel2 = await readLineSelect();
  const realOpts2 = sel2.options.filter((t) => t !== "라인을 선택해주세요");
  check("[#1] 탭 변경(에세이) 후 후보=에세이 1종", realOpts2.length === 1 && realOpts2[0] === "에세이", `options=${JSON.stringify(sel2.options)}`);
  check("[#1] 탭 변경 후 선택값=에세이(이전 위즈덤 초기화)", sel2.valueText === "에세이", `value=${sel2.valueText}`);
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-practical-info-open-redesign-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
