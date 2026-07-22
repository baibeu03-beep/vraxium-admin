/**
 * 회귀 방지 — 오류 처리 안티패턴 검사 (lint 가 아니라 검증 스크립트).
 *   npx tsx scripts/verify-error-handling-regressions.ts
 *
 * lint 규칙으로 만들지 않는 이유: 아래 판정은 catch 블록의 "주변 문맥"(어떤 싱크로
 * 흘러가는지·의도적 무음인지)에 의존해 false positive 가 잦다. 사람이 예외를 명시할 수 있는
 * 스크립트로 두고, CI/수동 실행에서 경고 형태로 본다.
 *
 * 검출 대상
 *   [E1] catch 에서 err.message 를 사용자에게 직접 노출 (5xx 원문 유출 위험)
 *   [E2] catch 에서 서버 원인을 버리고 일반 문구만 표시 (t.error(bare) 등)
 *   [E3] t.error(action, { message: json.error }) — 안전 필터 우회 경로
 *   [E4] route handler 의 5xx 응답에 error.message 를 그대로 담는 코드
 *
 * 의도적 예외는 ALLOWLIST 에 사유와 함께 등록한다.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

type Finding = { rule: string; file: string; line: number; detail: string };

// 의도적으로 유지하는 흐름 — "파일:라인 근처" 가 아니라 파일+사유로 관리한다.
const ALLOWLIST: ReadonlyArray<{ file: string; rule: string; reason: string }> = [
  {
    file: "components/admin/ProcessCheckActDialog.tsx",
    rule: "E2",
    reason:
      "댓글 재수집 실패는 RECOLLECT_FAIL_MESSAGE(일시적 실패를 뜻하는 도메인 문구)로 안내한다. 단정적 실패 문구 금지 정책.",
  },
  {
    file: "components/admin/ProcessIrregularReviewDetail.tsx",
    rule: "E2",
    reason: "위와 동일 — 변동 액트 댓글 재수집.",
  },
  {
    file: "components/admin/TeamPartsInfoWeekDetailManager.tsx",
    rule: "E2",
    reason:
      "인정 개수 N 미리보기는 입력 중 300ms 디바운스로 반복 요청되는 보조 계산이다. 실패해도 저장에 영향 없고 토스트는 방해가 되므로 기존 표시 유지(무음).",
  },
];

const isAllowed = (file: string, rule: string) =>
  ALLOWLIST.some((a) => a.file === file && a.rule === rule);

const SINK_RE =
  /t\.(error|apiError)\(|toast\(\s*"(error|warning)"|toast\.error\(|adminDialog\.alert|setError\(|setBanner\(|setLoadError\(|setSaveError\(|setRcError\(|setCreateError\(|setLookupError\(|setMessage\(|onError\(|setFormError\(/;
const HELPER_RE = /getApiErrorMessage\(|t\.apiError\(|\.userMessage\b|resolveApiError\(|toApiErrorInfo\(/;

const findings: Finding[] = [];

// ── 클라이언트 (E1·E2·E3) ──
const clientFiles = execSync('git ls-files "components/**/*.tsx" "app/**/*.tsx"', {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);

for (const file of clientFiles) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    // E3 — 안전 필터를 우회해 서버 원문을 override 로 밀어넣는 호출.
    if (/t\.error\([^)]*message:\s*json\??\.\w+/.test(lines[i])) {
      findings.push({
        rule: "E3",
        file,
        line: i + 1,
        detail: "t.error(…, { message: json.error }) — t.apiError 를 쓰세요(안전 필터 통과).",
      });
    }

    const m = lines[i].match(/^\s*\}?\s*catch\s*(\(\s*(\w+)\s*\))?\s*\{/);
    if (!m) continue;
    const v = m[2] ?? null;
    const body = lines.slice(i, i + 16).join("\n");
    if (!SINK_RE.test(body)) continue; // 무음 catch 는 이 검사 대상이 아니다.
    if (HELPER_RE.test(body)) continue; // 공통 helper 적용 완료.

    const usesRawMsg = v
      ? new RegExp(String.raw`\b` + v + String.raw`\.message\b`).test(body)
      : false;
    const rule = usesRawMsg ? "E1" : "E2";
    if (isAllowed(file, rule)) continue;
    findings.push({
      rule,
      file,
      line: i + 1,
      detail: usesRawMsg
        ? "err.message 직접 노출 — getApiErrorMessage(err, fallback) 를 쓰세요."
        : "서버 원인 유실 — t.apiError(action, err, fallback) 또는 getApiErrorMessage 를 쓰세요.",
    });
  }
}

// ── 서버 (E4) ──
const routeFiles = execSync('git ls-files "app/api/**/route.ts"', { encoding: "utf8" })
  .trim()
  .split("\n")
  .filter(Boolean);

const RAW_500_RE = /(\w+) instanceof Error \? \1\.message/;

for (const file of routeFiles) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!RAW_500_RE.test(lines[i])) continue;
    findings.push({
      rule: "E4",
      file,
      line: i + 1,
      detail: "5xx 응답에 error.message 원문 — publicErrorMessage(error, status, fallback) 를 쓰세요.",
    });
  }
}

// E1~E3(클라이언트)은 실패 처리 — 이미 0 이므로 새 회귀만 걸린다.
// E4(서버 5xx 원문)는 경고 — 클라이언트 파서가 5xx 원문을 이미 차단하므로 실제 노출은 없고,
//   아직 정리하지 않은 라우트가 많아 실패로 두면 잡음이 된다. 남은 건수를 추세로만 본다.
const BLOCKING = ["E1", "E2", "E3"];
const byRule = (r: string) => findings.filter((f) => f.rule === r);
const blocking = findings.filter((f) => BLOCKING.includes(f.rule));
const warnings = findings.filter((f) => !BLOCKING.includes(f.rule));

console.log("오류 처리 안티패턴 검사\n");
for (const rule of ["E1", "E2", "E3", "E4"]) {
  const list = byRule(rule);
  const tag = BLOCKING.includes(rule) ? "FAIL" : "warn";
  console.log(`  ${rule}  ${String(list.length).padStart(3)}  (${tag})`);
}
console.log(`\n허용 목록(의도적 유지): ${ALLOWLIST.length}건`);
for (const a of ALLOWLIST) console.log(`  · [${a.rule}] ${a.file} — ${a.reason}`);

if (blocking.length) {
  console.log("\n── 반드시 고칠 것 ──");
  for (const f of blocking) {
    console.log(`  [${f.rule}] ${f.file}:${f.line}`);
    console.log(`         ${f.detail}`);
  }
}
if (warnings.length && process.argv.includes("--list-warnings")) {
  console.log("\n── 경고(남은 서버 라우트) ──");
  for (const f of warnings) console.log(`  [${f.rule}] ${f.file}:${f.line}`);
}

console.log(
  `\n═══ ${blocking.length === 0 ? "PASS" : `FAIL(${blocking.length})`}` +
    ` · warn ${warnings.length} ═══`,
);
process.exit(blocking.length > 0 ? 1 : 0);
