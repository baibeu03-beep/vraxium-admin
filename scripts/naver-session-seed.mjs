// 네이버 로그인 세션 1회 시드 (캡차/기기확인 대응) — 로컬 전용.
//
// 사용법:  node scripts/naver-session-seed.mjs
//   - 창이 열리면 직접 로그인 (NAVER_ID/NAVER_PASSWORD 가 .env.local 에 있으면 자동 입력 시도)
//   - 로그인 성공이 감지되면 자동으로 종료되고 .naver-profile/ 에 세션이 저장된다
//   - 계정 정보는 어떤 로그에도 출력하지 않는다
import path from "node:path";
import fs from "node:fs";
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
const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1100, height: 850 },
});
const page = context.pages()[0] ?? (await context.newPage());

const hasSession = async () =>
  (await context.cookies("https://naver.com")).some((c) => c.name === "NID_AUT");

if (await hasSession()) {
  console.log("이미 로그인 세션이 있습니다. 종료합니다.");
  await context.close();
  process.exit(0);
}

await page.goto("https://nid.naver.com/nidlogin.login?mode=form&url=https://cafe.naver.com");
if (env.NAVER_ID && env.NAVER_PASSWORD) {
  await page.fill("#id", env.NAVER_ID).catch(() => {});
  await page.fill("#pw", env.NAVER_PASSWORD).catch(() => {});
  console.log("계정 정보를 입력했습니다. 창에서 로그인 버튼을 누르고 캡차/기기확인을 완료해주세요.");
} else {
  console.log("창에서 직접 로그인해주세요. (.env.local 에 NAVER_ID/NAVER_PASSWORD 설정 시 자동 입력)");
}

console.log("로그인 완료를 기다리는 중... (최대 5분)");
const deadline = Date.now() + 5 * 60 * 1000;
let ok = false;
while (Date.now() < deadline) {
  if (await hasSession()) { ok = true; break; }
  await new Promise((r) => setTimeout(r, 2000));
}

if (ok) {
  console.log("로그인 세션이 저장되었습니다 (.naver-profile/). 이제 카페 링크 집계 탭에서 수집할 수 있습니다.");
} else {
  console.log("로그인이 확인되지 않았습니다. 다시 실행해주세요.");
}
await context.close();
process.exit(ok ? 0 : 1);
