// 프로세스 체크 worker — 지정 운영 PC 세팅 점검(preflight).
//   비밀번호/토큰 등 env "값"은 절대 출력하지 않는다(존재 여부 boolean 만).
//   실제 크롤링은 하지 않는다(네트워크 부하/계정 영향 0). 세션 쿠키 존재만 확인.
//
//   사용: node scripts/win/preflight-worker.mjs
//         node scripts/win/preflight-worker.mjs --session   # .naver-profile 세션 쿠키까지 확인(브라우저 1회 기동)
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..", "..");
const req = createRequire(resolve(root, "package.json"));

let okCount = 0, warnCount = 0;
const line = (status, label, detail = "") => {
  const mark = status === "ok" ? "✓" : status === "warn" ? "△" : "✗";
  if (status === "ok") okCount++; else warnCount++;
  console.log(`  ${mark} ${label}${detail ? ` — ${detail}` : ""}`);
};

console.log("프로세스 체크 worker — 운영 PC 세팅 점검\n");

// 1) Node
const major = Number(process.versions.node.split(".")[0]);
line(major >= 18 ? "ok" : "fail", "1. Node 설치", `v${process.versions.node}${major >= 18 ? "" : " (18+ 권장)"}`);

// 2) npm install (핵심 의존성 resolvable)
let depsOk = true;
for (const m of ["@supabase/supabase-js", "@supabase/ssr", "playwright-core"]) {
  try { req.resolve(m); } catch { depsOk = false; line("fail", `2. npm install — ${m} 없음`, "npm install 필요"); }
}
if (depsOk) line("ok", "2. npm install", "핵심 의존성 존재");

// 3) Playwright chromium 바이너리
let chromiumPath = null;
try {
  const { chromium } = req("playwright-core");
  chromiumPath = chromium.executablePath();
} catch { /* not configured */ }
line(
  chromiumPath && existsSync(chromiumPath) ? "ok" : "fail",
  "3. Playwright chromium",
  chromiumPath && existsSync(chromiumPath) ? "설치됨" : "npx playwright-core install chromium 필요",
);

// 4) .env.local 존재
const envPath = resolve(root, ".env.local");
const hasEnv = existsSync(envPath);
line(hasEnv ? "ok" : "fail", "4. .env.local 존재", hasEnv ? "" : "루트에 .env.local 배치 필요");
const env = hasEnv ? readFileSync(envPath, "utf8") : "";
const isSet = (k) => new RegExp(`^${k}\\s*=\\s*.+`, "m").test(env); // 값 존재만 — 값 자체 미출력

// 5) NAVER_ID / NAVER_PASSWORD (값은 출력 안 함)
const naverOk = isSet("NAVER_ID") && isSet("NAVER_PASSWORD");
line(naverOk ? "ok" : "fail", "5. NAVER_ID / NAVER_PASSWORD 설정", naverOk ? "둘 다 설정됨" : "둘 다 필요");
// worker 필수 env 동시 점검(값 미출력).
for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
  line(isSet(k) ? "ok" : "fail", `   ${k} 설정`, isSet(k) ? "" : "필요");
}

// 6) .naver-profile 생성 여부
const profileDir = resolve(root, ".naver-profile");
const hasProfile = existsSync(profileDir) && readdirSync(profileDir).length > 0;
line(
  hasProfile ? "ok" : "warn",
  "6. .naver-profile 생성",
  hasProfile ? "프로필 존재" : "node scripts/naver-session-seed.mjs 1회 실행 필요",
);

// 7) 자동 시작 배치 파일 존재
const bat = resolve(root, "scripts", "win", "run-process-check-worker.bat");
line(existsSync(bat) ? "ok" : "warn", "7. run-process-check-worker.bat", existsSync(bat) ? "존재" : "없음");

// 8) admin 서버 접근 가능(크롤링 엔드포인트 라우트 존재 확인 — 실제 크롤링 안 함)
const BASE = process.env.WORKER_BASE_URL ?? env.match(/^WORKER_BASE_URL=(.+)$/m)?.[1]?.trim() ?? "http://localhost:3000";
try {
  const res = await fetch(`${BASE}/api/admin/cluster4/cafe-line-crew`, { method: "GET" });
  // 인증 없이 호출 → 401(인증 필요)이면 라우트 reachable. 200/4xx 모두 "서버 도달".
  line(res.status > 0 ? "ok" : "fail", "8. admin 서버 접근", `${BASE} → HTTP ${res.status}(라우트 도달)`);
} catch (e) {
  line("fail", "8. admin 서버 접근", `${BASE} 미응답 — admin 서버를 먼저 실행하세요 (${e?.cause?.code ?? e?.message ?? "no response"})`);
}

// (옵션) .naver-profile 세션 쿠키 확인 — 브라우저 1회 기동(크롤링 없음).
if (process.argv.includes("--session")) {
  try {
    const { chromium } = req("playwright-core");
    const ctx = await chromium.launchPersistentContext(profileDir, { headless: true });
    const cookies = await ctx.cookies("https://naver.com");
    const hasSession = cookies.some((c) => c.name === "NID_AUT");
    await ctx.close();
    line(hasSession ? "ok" : "warn", "6b. 네이버 세션(NID_AUT)", hasSession ? "유효 세션 존재" : "세션 없음 — naver-session-seed.mjs 재실행");
  } catch (e) {
    line("warn", "6b. 네이버 세션 확인 실패", e?.message ?? String(e));
  }
}

console.log(`\n결과: ${okCount} OK / ${warnCount} 조치 필요`);
console.log(warnCount === 0 ? "→ worker 실행 준비 완료: node scripts/process-check-worker.mjs" : "→ 위 ✗/△ 항목 처리 후 재점검하세요.");
process.exit(0);
