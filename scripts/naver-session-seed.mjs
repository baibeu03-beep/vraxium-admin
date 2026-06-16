// 네이버 로그인 세션 1회 시드 (캡차/기기확인 대응) — 로컬 전용.
//
// 사용법:  node scripts/naver-session-seed.mjs
//   - 창이 열리면 직접 로그인 (NAVER_ID/NAVER_PASSWORD 가 .env.local 에 있으면 자동 입력 보조)
//   - 반드시 "로그인 상태 유지"가 체크된 상태로 로그인해야 한다(미체크 시 네이버가 세션 쿠키를
//     발급 → Playwright persistent context 가 디스크에 저장하지 않아 재기동 시 expired 가 된다).
//   - 로그인 후 cafe.naver.com 으로 이동 → 운영자가 실제 글/댓글이 보이는지 확인하고 Enter.
//   - Enter 후 context 를 닫았다가 새로 열어 디스크에 NID_AUT 가 남았는지 검증한다
//     (= crawler 의 checkNaverSession 과 동일한 기준). 검증 통과해야만 "저장 완료"로 종료(exit 0).
//   - 계정 정보·세션값은 어떤 로그에도 출력하지 않는다.
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { chromium } from "playwright-core";

// .env.local 에서 NAVER_* 만 읽는다 (값은 절대 출력 금지)
const envPath = path.join(process.cwd(), ".env.local");
const env = {};
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^(NAVER_ID|NAVER_PASSWORD)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const PROFILE_DIR = path.join(process.cwd(), ".naver-profile");

// crawler/lib 의 hasNaverSession 과 동일 기준: https://naver.com 의 NID_AUT 존재 여부.
const hasAuthCookie = async (context) =>
  (await context.cookies("https://naver.com")).some((c) => c.name === "NID_AUT");

// checkNaverSession(lib/naverCafeComments.ts) 과 동일 로직 — 새 persistent context 를
// 띄워 "디스크에 저장된" 세션을 검증한다. headless 기본 → 실패 시 full Chromium 채널 폴백.
async function verifyPersistedSession() {
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true });
  } catch {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      channel: "chromium",
    });
  }
  try {
    return await hasAuthCookie(context);
  } finally {
    await context.close().catch(() => undefined);
  }
}

function waitForEnter(promptText) {
  if (!process.stdin.isTTY) return Promise.resolve(); // 비대화형 실행이면 대기 생략
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(promptText, () => { rl.close(); resolve(); }));
}

// ── 0) 이미 디스크에 세션이 있으면(=재기동에도 유효) 재시드 없이 종료 ──
if (await verifyPersistedSession()) {
  console.log("이미 유효한 로그인 세션이 저장되어 있습니다(디스크 검증 OK). 종료합니다.");
  process.exit(0);
}

// ── 1) 로그인 창 ──
const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1100, height: 850 },
});
const page = context.pages()[0] ?? (await context.newPage());

await page.goto("https://nid.naver.com/nidlogin.login?mode=form&url=https://cafe.naver.com");

// "로그인 상태 유지"를 켠다 — 미체크 시 세션 쿠키만 발급되어 디스크에 저장되지 않는다(핵심).
await page
  .locator("#keep, input#keep, label[for='keep']")
  .first()
  .check({ timeout: 3000 })
  .catch(() => {});

if (env.NAVER_ID && env.NAVER_PASSWORD) {
  await page.fill("#id", env.NAVER_ID).catch(() => {});
  await page.fill("#pw", env.NAVER_PASSWORD).catch(() => {});
  console.log("계정 정보를 입력했습니다. 창에서 '로그인 상태 유지'가 켜진 채로 로그인하고");
  console.log("캡차/기기확인/2단계 인증을 완료해주세요. (1차 시도에서 비밀번호 오류가 나면 다시 시도하세요)");
} else {
  console.log("창에서 직접 로그인해주세요. '로그인 상태 유지'를 반드시 체크하세요.");
  console.log("(.env.local 에 NAVER_ID/NAVER_PASSWORD 설정 시 자동 입력 보조)");
}

// ── 2) 로그인 감지 (메모리상 NID_AUT) ──
console.log("로그인 완료를 기다리는 중... (최대 5분)");
const deadline = Date.now() + 5 * 60 * 1000;
let loggedIn = false;
while (Date.now() < deadline) {
  if (await hasAuthCookie(context)) { loggedIn = true; break; }
  await new Promise((r) => setTimeout(r, 2000));
}

if (!loggedIn) {
  console.log("[세션 저장 실패] 로그인이 확인되지 않았습니다. 다시 실행해주세요.");
  await context.close().catch(() => undefined);
  process.exit(1);
}

// ── 3) 카페 접속 + 운영자 확인 ──
await page.goto("https://cafe.naver.com").catch(() => {});
console.log("");
console.log("로그인이 감지되었습니다. 열린 창에서 실제 카페 글을 열어 댓글이 보이는지 확인하세요.");
await waitForEnter("확인이 끝나면 Enter 를 누르세요... ");

// ── 4) context 를 닫아 쿠키를 디스크에 flush ──
await context.close().catch(() => undefined);
await new Promise((r) => setTimeout(r, 800)); // 프로필 잠금 해제 여유

// ── 5) checkNaverSession 과 동일 기준으로 "디스크 저장" 검증 ──
const persisted = await verifyPersistedSession();
if (persisted) {
  console.log("[세션 저장 완료] 디스크 검증 OK (NID_AUT 영구 쿠키 확인).");
  console.log("이제 .\\crawler\\check-health-windows.bat 의 deep 이 session=valid 여야 합니다.");
  process.exit(0);
} else {
  console.log("[세션 저장 실패] 로그인은 됐지만 쿠키가 디스크에 저장되지 않았습니다.");
  console.log("→ 원인: '로그인 상태 유지'를 체크하지 않으면 네이버가 세션 쿠키만 발급하여 저장되지 않습니다.");
  console.log("→ 조치: 다시 실행해 '로그인 상태 유지'를 켠 상태로 로그인해주세요.");
  process.exit(1);
}
