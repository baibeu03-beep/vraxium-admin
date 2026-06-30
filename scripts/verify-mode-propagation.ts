/**
 * 프론트 mode 전파 정적 검증 — components/admin 의 "사용자/크루 모집단 API" fetch 가
 * mode(=test) 를 전파하는지 검사한다. HTTP 누수 스캐너(verify-scope-leak-scan)는 자신이 mode=test
 * 를 붙여 BACKEND scope 만 보므로, "백엔드는 scope되는데 프론트가 mode 미전달 → 운영 유저 노출"
 * (class 2) 누수를 못 잡는다. 본 스크립트가 그 갭을 닫는다.
 *
 *   누수 판정: 모집단 endpoint 를 fetch 하는 구문 주변에 appendModeQuery / mode 전파가 없으면 위반.
 *   npx tsx scripts/verify-mode-propagation.ts
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const ROOT = "components/admin";

// 사용자/크루 "모집단(목록/검색)" endpoint — 호출 시 반드시 mode 를 전파해야 한다.
//   (단건 by-id 조회는 제외 — 목록 누수만 대상.)
const POP_ENDPOINTS = [
  "/api/admin/cluster4/users",
  "/api/admin/cluster4/crews",
  "/api/admin/crews",
  "/api/admin/members/roster",
  "/api/admin/members?",
  "/api/admin/app-users",
  "/api/admin/user-profiles",
  "/api/admin/applicants",
  "/api/admin/season-participations?",
  "/api/admin/edit-windows?",
  "/api/admin/edit-windows/bulk",
  "/api/admin/cluster4/cafe-line-crew",
  "/api/admin/week-recognitions?",
  "/api/admin/team-parts/crew-lookup",
  "/api/admin/cluster4/competency/applications",
  "/api/admin/cluster4/info-lines/crew",
  "/api/admin/cluster4/experience/team-overall",
  "/api/admin/cluster4/experience/part-input",
  "/api/admin/processes/check/irregular/targets",
];
// mode 전파로 인정하는 토큰(주변에 하나라도 있으면 OK).
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
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".tsx") || name.endsWith(".ts")) out.push(p);
  }
  return out;
}

let violations = 0;
let checked = 0;
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ep = POP_ENDPOINTS.find((e) => line.includes(e));
    if (!ep) continue;
    // 단건 by-id 경로 제외: endpoint 바로 뒤가 '/' 면 /crews/${id} 같은 단건 라우트 → 목록 아님.
    //   (패턴에 '?'/'/bulk' 가 이미 포함된 건 목록·일괄이므로 그대로 검사.)
    if (!ep.endsWith("?") && !ep.endsWith("/bulk")) {
      const after = line.charAt(line.indexOf(ep) + ep.length);
      if (after === "/") continue; // 단건 by-id → skip
    }
    // 이 줄(또는 직전 몇 줄)에 fetch( 가 있는 fetch 구문인지 확인.
    const back = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
    if (!/fetch\s*\(/.test(back)) continue;
    // 쓰기(POST/PATCH/DELETE)는 제외 — 백엔드 assertUserIdsInScope 로 fail-closed(누수 아님·422).
    //   본 검사는 "목록 표시(GET) 누수"(class 2)만 대상.
    const optWin = lines.slice(i, i + 8).join("\n");
    if (/method:\s*["'`](POST|PATCH|DELETE|PUT)["'`]/.test(optWin)) continue;
    checked++;
    // 주변 window(같은 핸들러) 에서 mode 전파 토큰 탐색 — 핸들러 상단에서 sp.set("mode") 하는 경우 포함.
    const win = lines.slice(Math.max(0, i - 22), i + 5).join("\n");
    const hasMode = MODE_TOKENS.some((t) => win.includes(t));
    if (!hasMode) {
      violations++;
      console.log(`LEAK ${file}:${i + 1}  ${ep}  ← mode 전파 없음`);
      console.log(`     ${line.trim().slice(0, 100)}`);
    }
  }
}

console.log(`\n검사한 모집단 fetch: ${checked} · 위반(mode 미전파): ${violations}`);
console.log(violations === 0 ? "✅ 모든 모집단 fetch 가 mode 전파" : `❌ ${violations} 건 mode 미전파(class 2 누수)`);
process.exit(violations === 0 ? 0 : 1);
