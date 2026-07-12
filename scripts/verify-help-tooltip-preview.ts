// Help Key hover 툴팁 미리보기(buildHelpTooltipPreview / resolveHelpTooltip) 단위 검증.
//   실행: npx tsx scripts/verify-help-tooltip-preview.ts
//
// 검증 항목(요구사항):
//   · 내용이 있으면 앞부분 미리보기 표시
//   · 길면 설정한 길이에서 말줄임표(…) 처리
//   · null/undefined/빈문자열/공백만 → fallback("이 항목 도움말")
//   · HTML/Markdown/줄바꿈이 그대로 노출되지 않고 일반 텍스트로 정규화
//   · 순수 함수이므로 일반 모드/ mode=test / org 무관 동일 결과(입력이 같으면 출력이 같다)

import {
  HELP_TOOLTIP_PREVIEW_MAX,
  buildHelpTooltipPreview,
  normalizeHelpToPlainText,
  resolveHelpTooltip,
} from "../lib/helpTooltip";

const FALLBACK = "이 항목 도움말";

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("[1] 내용 있음 → 앞부분 미리보기 표시");
{
  const raw =
    "이 항목은 크루가 고객 앱에서 확인하게 되는 메인 타이틀입니다. 너무 긴 문장은 피해주세요.";
  const t = resolveHelpTooltip(raw, FALLBACK);
  check("fallback 이 아니라 내용 기반", t !== FALLBACK, t);
  check("앞부분으로 시작", t.startsWith("이 항목은 크루가 고객 앱에서"), t);
  check("길이 초과 시 말줄임표", t.endsWith("…"), t);
  console.log(`     → "${t}"`);
}

console.log("[2] 짧은 내용 → 잘리지 않고 그대로(말줄임표 없음)");
{
  const raw = "짧은 도움말";
  const t = resolveHelpTooltip(raw, FALLBACK);
  check("원문 그대로", t === "짧은 도움말", t);
  check("말줄임표 없음", !t.endsWith("…"), t);
}

console.log("[3] 정확한 최대 길이 경계");
{
  const exact = "가".repeat(HELP_TOOLTIP_PREVIEW_MAX);
  const over = "가".repeat(HELP_TOOLTIP_PREVIEW_MAX + 5);
  const tExact = buildHelpTooltipPreview(exact);
  const tOver = buildHelpTooltipPreview(over);
  check("최대 길이와 같으면 말줄임표 없음", tExact === exact && !tExact.endsWith("…"));
  check("최대 길이 초과면 말줄임표", tOver.endsWith("…"));
  check(
    "잘린 본문 길이 = maxLen(…제외)",
    Array.from(tOver).length === HELP_TOOLTIP_PREVIEW_MAX + 1,
    `len=${Array.from(tOver).length}`,
  );
}

console.log("[4] 빈/공백/널 → fallback");
{
  for (const [name, raw] of [
    ["null", null],
    ["undefined", undefined],
    ["빈 문자열", ""],
    ["공백만", "   "],
    ["줄바꿈/탭만", "\n\t  \n"],
  ] as Array<[string, string | null | undefined]>) {
    const t = resolveHelpTooltip(raw, FALLBACK);
    check(`${name} → fallback`, t === FALLBACK, t);
    check(`${name} → preview 는 빈 문자열`, buildHelpTooltipPreview(raw) === "");
  }
}

console.log("[5] HTML/Markdown/줄바꿈 → 일반 텍스트");
{
  const cases: Array<[string, string, (s: string) => boolean]> = [
    ["HTML 태그", "<b>굵게</b><br/>다음 줄", (s) => !/[<>]/.test(s) && s.includes("굵게")],
    ["HTML 엔티티", "A &amp; B &lt;태그&gt;", (s) => s.includes("A & B") && !s.includes("&amp;")],
    ["Markdown 강조", "**굵게** _기울임_ ~~취소~~", (s) => !/[*_~]/.test(s) && s.includes("굵게")],
    ["Markdown 제목", "# 제목\n본문", (s) => !s.startsWith("#") && s.includes("제목")],
    ["Markdown 링크", "[네이버](https://naver.com) 참고", (s) => s.includes("네이버") && !s.includes("http")],
    ["Markdown 목록", "- 첫째\n- 둘째", (s) => !s.includes("- ") && s.includes("첫째")],
    ["인라인 코드", "값은 `code` 입니다", (s) => !s.includes("`") && s.includes("code")],
    ["연속 공백/줄바꿈", "여러    칸\n\n\n줄바꿈", (s) => !/\s{2,}/.test(s) && !s.includes("\n")],
  ];
  for (const [name, raw, ok] of cases) {
    const plain = normalizeHelpToPlainText(raw);
    check(`${name} 정규화`, ok(plain), `"${plain}"`);
  }
}

console.log("[6] 결정론(같은 입력=같은 출력) — 일반/mode=test/org 무관 동일 툴팁");
{
  const raw = "<p>모드에 상관없이 **동일**하게 보여야 합니다.</p>";
  const a = resolveHelpTooltip(raw, FALLBACK);
  const b = resolveHelpTooltip(raw, FALLBACK);
  check("동일 입력 → 동일 출력", a === b, `${a} / ${b}`);
  check("HTML/Markdown 노출 없음", !/[<>*_]/.test(a), a);
}

console.log("");
console.log(`결과: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
