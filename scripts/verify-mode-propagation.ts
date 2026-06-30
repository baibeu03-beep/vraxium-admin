/**
 * 프론트 mode 전파 정적 검증 (catalog-free / 백엔드 파생).
 *
 *   문제: 손으로 적은 endpoint 화이트리스트는 누락된다(cluster4/lines·info-lines 미포함 → 실유저 노출 누수
 *   를 못 잡았다). 그래서 카탈로그를 **백엔드에서 파생**한다:
 *     1) app/api/admin/**\/route.ts 중 GET 이 있고 mode 를 읽는(readScopeMode|parseScopeMode) 라우트
 *        = "모드 인지 모집단 엔드포인트". 단건([id]) leaf 라우트는 제외(목록 아님).
 *     2) components/admin 의 그 엔드포인트 GET fetch 가 mode 를 전파하지 않으면 위반(class 2 누수).
 *
 *   npx tsx scripts/verify-mode-propagation.ts
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

// ── 1) 백엔드에서 "모드 인지 모집단 엔드포인트" 카탈로그 파생 ──────────────────
const API_ROOT = "app/api/admin";
const modeEndpoints = new Set<string>();
for (const file of walk(API_ROOT)) {
  if (!file.endsWith("route.ts")) continue;
  const src = readFileSync(file, "utf8");
  if (!/readScopeMode|parseScopeMode/.test(src)) continue; // mode 를 읽는 라우트만
  if (!/export\s+async\s+function\s+GET/.test(src)) continue; // GET(목록 표시) 있는 것만
  // 경로 파생: app/api/admin/cluster4/lines/route.ts → /api/admin/cluster4/lines
  const norm = file.replace(/\\/g, "/");
  const ep = norm.replace(/^app\/api\/admin/, "/api/admin").replace(/\/route\.ts$/, "");
  // leaf 가 동적 세그먼트([id]) 면 단건 라우트 → 목록 아님(제외).
  const segs = ep.split("/");
  if (/^\[.+\]$/.test(segs[segs.length - 1])) continue;
  // 동적 세그먼트가 중간에 있으면(예: /a/[id]/b) 매칭 단순화를 위해 정적 prefix 만 카탈로그에 둔다.
  const staticPrefix = (() => {
    const acc: string[] = [];
    for (const s of segs) {
      if (/^\[.+\]$/.test(s)) break;
      acc.push(s);
    }
    return acc.join("/");
  })();
  modeEndpoints.add(staticPrefix);
}

// ── 2) 프론트 fetch 가 그 엔드포인트에 mode 를 전파하는지 검사 ──────────────────
const FE_ROOT = "components/admin";
const MODE_TOKENS = [
  "appendModeQuery",
  'set("mode"',
  "set('mode'",
  "mode=test",
  "?mode",
  "&mode",
  ", mode)",
  ",mode)",
  "scopeMode",
  'get("mode")',
  "modeQs", // `?...${modeQs}` 패턴(modeQs = mode==="test" ? "&mode=test" : "")
  "${mode", // 템플릿 보간 mode 변수
];
// fetch 구문 줄에서 endpoint 추출: "/api/admin/...."(따옴표/백틱) 의 path 부분(? 이전).
function endpointOf(line: string): { ep: string; after: string } | null {
  const m = line.match(/["'`](\/api\/admin\/[^"'`?]*)/);
  if (!m) return null;
  const full = m[1];
  // path 끝 위치의 다음 문자(쿼리 `?` / 종료 따옴표 / `/`) 판별용.
  const idx = line.indexOf(full) + full.length;
  return { ep: full, after: line.charAt(idx) };
}

let violations = 0;
let checked = 0;
for (const file of walk(FE_ROOT)) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("/api/admin/")) continue;
    const parsed = endpointOf(line);
    if (!parsed) continue;
    let { ep } = parsed;
    // trailing slash 정리.
    ep = ep.replace(/\/$/, "");
    // 정확히 모드 인지 목록 엔드포인트인가? (단건 sub-path /ep/${id} 는 ep 와 불일치 → 자동 제외)
    if (!modeEndpoints.has(ep)) continue;
    // fetch 구문인지 확인(직전 몇 줄 포함).
    const back = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
    if (!/fetch\s*\(/.test(back)) continue;
    // 쓰기(POST/PATCH/DELETE/PUT)는 제외 — 백엔드 assertUserIdsInScope 로 fail-closed(누수 아님).
    const optWin = lines.slice(i, i + 8).join("\n");
    if (/method:\s*["'`](POST|PATCH|DELETE|PUT)["'`]/.test(optWin)) continue;
    checked++;
    // 주변 핸들러 window 에서 mode 전파 토큰 탐색.
    const win = lines.slice(Math.max(0, i - 24), i + 6).join("\n");
    const hasMode = MODE_TOKENS.some((t) => win.includes(t));
    if (!hasMode) {
      violations++;
      console.log(`LEAK ${file}:${i + 1}  ${ep}  ← mode 전파 없음`);
      console.log(`     ${line.trim().slice(0, 100)}`);
    }
  }
}

console.log(`\n백엔드 파생 모드 인지 엔드포인트: ${modeEndpoints.size}개`);
console.log([...modeEndpoints].sort().map((e) => `  · ${e}`).join("\n"));
console.log(`\n검사한 모집단 GET fetch: ${checked} · 위반(mode 미전파): ${violations}`);
console.log(violations === 0 ? "✅ 모든 모집단 fetch 가 mode 전파" : `❌ ${violations} 건 mode 미전파(class 2 누수)`);
process.exit(violations === 0 ? 0 : 1);
