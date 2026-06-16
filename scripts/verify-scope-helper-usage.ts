/**
 * 스코프 중앙화 가드(정적 분석 · DB/서버 불필요).
 *
 * 신규 API(app/api/**\/route.ts)가 LineScope/RequestScope 헬퍼를 우회하지 못하도록 강제한다.
 * - 데모/스코프 해소는 반드시 lib/requestScope.resolveRequestScope 를 거친다.
 *   → 라우트에서 lib/demoMode.resolveDemoProfileUserId 를 직접 import/호출 금지.
 * - 라인 org 가시성 판정은 반드시 lib/lineScope 헬퍼를 거친다.
 *   → 라우트에서 lib/cluster4LineOrg 의 parseLineCodeOrg/isLineVisibleForUserOrg/normalizeLineOrg 직접 import 금지.
 *
 * 통과(전부 OK)해야 커밋 가능. 위반 시 비제로 종료.
 *
 * 사용: npm run verify:scope-helper-usage
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..");
const API_DIR = join(ROOT, "app", "api");

// 헬퍼 자체/내부 구현은 직접 사용이 정당하므로 가드에서 제외.
const ALLOWLIST = new Set<string>([
  // (현재 라우트 위반 없음 — 향후 정당한 예외가 생기면 여기에 상대경로를 추가하고 사유를 남길 것)
]);

type Violation = { file: string; rule: string; line: number; text: string };

function listRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listRouteFiles(full));
    } else if (entry === "route.ts" || entry === "route.tsx") {
      out.push(full);
    }
  }
  return out;
}

const RULES: Array<{ id: string; test: (line: string) => boolean; hint: string }> = [
  {
    id: "no-direct-resolveDemoProfileUserId",
    // import 또는 호출. 주석(파라미터 없는 언급)은 `(` 가 없어 매칭되지 않는다.
    test: (l) =>
      /resolveDemoProfileUserId\s*\(/.test(l) ||
      /import[^;]*resolveDemoProfileUserId/.test(l),
    hint: "라우트는 resolveDemoProfileUserId 대신 lib/requestScope.resolveRequestScope 를 사용하세요.",
  },
  {
    id: "no-direct-lineOrg-import",
    test: (l) =>
      /import[^;]*\b(parseLineCodeOrg|isLineVisibleForUserOrg|normalizeLineOrg)\b[^;]*from\s*["']@\/lib\/cluster4LineOrg["']/.test(
        l,
      ),
    hint: "라우트는 cluster4LineOrg 원시 함수 대신 lib/lineScope 헬퍼(resolveLineScope*/isLineScopeVisibleForOrg)를 사용하세요.",
  },
];

function scan(): Violation[] {
  const violations: Violation[] = [];
  const files = listRouteFiles(API_DIR);
  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (ALLOWLIST.has(rel)) continue;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, idx) => {
      // 한 줄 주석은 건너뛴다(설명 문구 오탐 방지).
      if (text.trim().startsWith("//")) return;
      for (const rule of RULES) {
        if (rule.test(text)) {
          violations.push({ file: rel, rule: rule.id, line: idx + 1, text: text.trim() });
        }
      }
    });
  }
  return violations;
}

function main() {
  const violations = scan();
  const scanned = listRouteFiles(API_DIR).length;
  if (violations.length === 0) {
    console.log(`OK scope-helper-usage :: ${scanned} route files, 0 violations`);
    return;
  }
  console.log(`FAIL scope-helper-usage :: ${violations.length} violation(s) across route files`);
  for (const v of violations) {
    const rule = RULES.find((r) => r.id === v.rule);
    console.log(`  ${v.file}:${v.line} [${v.rule}]`);
    console.log(`    ${v.text}`);
    if (rule) console.log(`    → ${rule.hint}`);
  }
  process.exit(1);
}

main();
