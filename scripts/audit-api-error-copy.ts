/**
 * 감사 — 서버가 내보내는 오류 문구가 "사용자 용어"인지 점검한다.
 *   app/api/**\/route.ts + lib/admin*Data|Types.ts 의 오류 문자열 리터럴을 뽑아
 *   lib/apiError 의 사용자 노출 필터(sanitizeServerMessage)에 통과시켜 3분류한다.
 *
 *     [노출]   그대로 사용자에게 보인다.
 *     [번역]   내부 필드명이 사용자 용어로 치환되어 보인다.
 *     [폐기]   개발 용어가 남아 사용자에게 보이지 않는다 → 화면 fallback 문구가 뜬다.
 *
 *   "[폐기]"가 많은 건 안전하지만 안내가 빈약하다는 뜻이다. 4xx 업무 문구가 폐기 목록에
 *   있으면 그 문구를 사용자 용어로 다시 쓰는 것이 다음 작업이다.
 *
 *   npx tsx scripts/audit-api-error-copy.ts [--list-dropped]
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { sanitizeServerMessage } from "@/lib/apiError";

const listDropped = process.argv.includes("--list-dropped");

const files = execSync(
  'git ls-files "app/api/**/route.ts" "lib/admin*.ts" "lib/*Data.ts"',
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);

// error: "…" / error: `…` / new XError(400, "…") 형태의 사용자 대상 문자열만 수집한다.
const PATTERNS: readonly RegExp[] = [
  /error:\s*"((?:[^"\\]|\\.)*)"/g,
  /error:\s*`((?:[^`\\$]|\\.)*)`/g,
  /Error\(\s*\d{3}\s*,\s*"((?:[^"\\]|\\.)*)"/g,
  /Error\(\s*\d{3}\s*,\s*`((?:[^`\\$]|\\.)*)`/g,
];

type Row = { file: string; raw: string; shown: string | null };
const rows: Row[] = [];
const seen = new Set<string>();

for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const raw = m[1].trim();
      if (!raw || raw.length < 3) continue;
      const key = `${file}::${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ file, raw, shown: sanitizeServerMessage(raw) });
    }
  }
}

const kept = rows.filter((r) => r.shown === r.raw);
const translated = rows.filter((r) => r.shown !== null && r.shown !== r.raw);
const dropped = rows.filter((r) => r.shown === null);

console.log(`수집한 오류 문구: ${rows.length}개 (${files.length}개 파일)\n`);
console.log(`  [노출] 그대로 표시  : ${kept.length}`);
console.log(`  [번역] 용어 치환 후 : ${translated.length}`);
console.log(`  [폐기] 화면 fallback: ${dropped.length}`);

if (translated.length) {
  console.log("\n── [번역] 내부 필드명이 사용자 용어로 치환되는 문구 ──");
  for (const r of translated.slice(0, 40)) {
    console.log(`  ${r.file}`);
    console.log(`    - ${r.raw}`);
    console.log(`    + ${r.shown}`);
  }
  if (translated.length > 40) console.log(`  … 외 ${translated.length - 40}건`);
}

if (listDropped) {
  console.log("\n── [폐기] 사용자에게 보이지 않는 문구(화면 fallback 사용) ──");
  const byFile = new Map<string, string[]>();
  for (const r of dropped) {
    const list = byFile.get(r.file) ?? [];
    list.push(r.raw);
    byFile.set(r.file, list);
  }
  for (const [file, list] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${list.length}  ${file}`);
    for (const raw of list.slice(0, 6)) console.log(`       · ${raw.slice(0, 110)}`);
    if (list.length > 6) console.log(`       … 외 ${list.length - 6}건`);
  }
} else {
  console.log("\n(--list-dropped 로 폐기 문구 목록을 볼 수 있습니다)");
}
