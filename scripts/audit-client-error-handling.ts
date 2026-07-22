/**
 * 감사 — 클라이언트 catch 블록의 오류 처리 상태를 "사용자 행동 단위"로 분류한다.
 *   npx tsx scripts/audit-client-error-handling.ts [--csv] [--file <substr>]
 *
 * 분류:
 *   OK      공통 helper(lib/apiError · t.apiError) 적용 완료
 *   RAW     err.message 를 사용자에게 직접 노출 (5xx 원문 유출 위험)
 *   LOST    서버 문구를 받고도 일반 문구로 덮어씀
 *   SILENT  사용자 표시 없음(무음) — 의도된 fallback 인지 별도 판단 필요
 *
 * 행동 추정은 함수/핸들러 이름 + fetch method + 주변 토큰으로 한다(휴리스틱).
 * 최종 분류표는 사람이 확인해 확정한다 — 이 스크립트는 대상 수집·회귀 감시용이다.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

type Kind = "OK" | "RAW" | "LOST" | "SILENT";

type Site = {
  file: string;
  line: number;
  kind: Kind;
  action: string;
  method: string;
  fn: string;
  snippet: string;
};

const argFile = (() => {
  const i = process.argv.indexOf("--file");
  return i >= 0 ? process.argv[i + 1] : null;
})();

const files = execSync('git ls-files "components/**/*.tsx" "app/**/*.tsx"', { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean)
  .filter((f) => (argFile ? f.includes(argFile) : true));

// 사용자 표시 싱크 — 이 중 하나라도 있으면 "사용자에게 보이는" catch 다.
const SINK_RE =
  /t\.(error|apiError)\(|toast\(\s*"(error|warning)"|toast\.error\(|adminDialog\.alert|setError\(|setBanner\(|setLoadError\(|setSaveError\(|setRcError\(|setCreateError\(|setLookupError\(|setMessage\(|onError\(|setFormError\(/;
const HELPER_RE = /getApiErrorMessage\(|t\.apiError\(|\.userMessage\b|resolveApiError\(|toApiErrorInfo\(/;

// 사용자 행동 추정 — 함수명/변수명 토큰 → 행동 라벨.
const ACTION_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(handleDelete|onDelete|confirmDelete|remove|삭제)/i, "삭제"],
  [/\b(handleCreate|onCreate|create|register|add|추가|등록)/i, "생성"],
  [/\b(upload|파일|image|logo|csv)/i, "업로드"],
  [/\b(publish|finalize|confirm|review|확정|검수)/i, "확정·검수"],
  [/\b(revert|rollback|undo|취소|실행\s*취소)/i, "실행 취소"],
  [/\b(run|execute|trigger|recompute|sync|실행|재실행)/i, "실행"],
  [/\b(handleSave|onSave|save|submit|update|patch|저장|수정)/i, "저장·수정"],
  [/\b(grant|payout|지급)/i, "수동 지급"],
  [/\b(open|opening|개설)/i, "개설"],
  [/\b(load|fetch|refresh|reload|list|search|조회|목록)/i, "조회"],
];

function guessAction(context: string): string {
  for (const [re, label] of ACTION_RULES) if (re.test(context)) return label;
  return "기타";
}

const sites: Site[] = [];

for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\}?\s*catch\s*(\(\s*(\w+)\s*\))?\s*\{/);
    if (!m) continue;
    const v = m[2] ?? null;
    const body = lines.slice(i, i + 16).join("\n");
    // 앞쪽 40줄에서 함수명 / fetch method 를 추정한다.
    const before = lines.slice(Math.max(0, i - 45), i).join("\n");
    const fnMatch = [...before.matchAll(/(?:const|function|async)\s+(\w+)\s*[=(]/g)].pop();
    const fn = fnMatch?.[1] ?? "";
    const methodMatch = [...before.matchAll(/method:\s*"(\w+)"/g)].pop();
    const method = methodMatch?.[1] ?? "GET";
    const urlMatch = [...before.matchAll(/fetch\(\s*[`"']([^`"'$]*)/g)].pop();

    const sink = SINK_RE.test(body);
    const helper = HELPER_RE.test(body);
    const rawMsg = v ? new RegExp(String.raw`\b` + v + String.raw`\.message\b`).test(body) : false;

    let kind: Kind;
    if (!sink) kind = "SILENT";
    else if (helper) kind = "OK";
    else if (rawMsg) kind = "RAW";
    else kind = "LOST";

    sites.push({
      file,
      line: i + 1,
      kind,
      action: guessAction(`${fn} ${method} ${urlMatch?.[1] ?? ""}`),
      method,
      fn,
      snippet: (urlMatch?.[1] ?? "").slice(0, 60),
    });
  }
}

if (process.argv.includes("--csv")) {
  console.log("kind,file,line,action,method,fn,url");
  for (const s of sites) {
    console.log([s.kind, s.file, s.line, s.action, s.method, s.fn, s.snippet].join(","));
  }
  process.exit(0);
}

const byKind = (k: Kind) => sites.filter((s) => s.kind === k);
console.log(`총 catch 블록: ${sites.length} (${files.length}개 파일)\n`);
for (const k of ["OK", "RAW", "LOST", "SILENT"] as const) {
  console.log(`  ${k.padEnd(7)} ${byKind(k).length}`);
}

for (const k of ["RAW", "LOST"] as const) {
  console.log(`\n── ${k} — 행동별 ──`);
  const group = new Map<string, Site[]>();
  for (const s of byKind(k)) {
    const list = group.get(s.action) ?? [];
    list.push(s);
    group.set(s.action, list);
  }
  for (const [action, list] of [...group.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(list.length).padStart(3)}  ${action}`);
    const files = new Map<string, number[]>();
    for (const s of list) {
      const l = files.get(s.file) ?? [];
      l.push(s.line);
      files.set(s.file, l);
    }
    for (const [f, ls] of [...files.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`         ${f.replace("components/admin/", "")}:${ls.join(",")}`);
    }
  }
}
