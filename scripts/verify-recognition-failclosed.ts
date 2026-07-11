/**
 * fail-closed 순수 로직 검증(§7) — DB 무의존.
 *   1) formatMissingPointConfigMessage: 사람이 읽는 미설정 오류 메시지 형식.
 *   2) isConfigured 판정 규칙(0=정상·NULL/부재=미설정)을 순수 재현으로 검증.
 * 마이그 미적용 환경에서도 실행 가능(실 DB 조회 없음). 실행: npx tsx scripts/verify-recognition-failclosed.ts
 */
import {
  formatMissingPointConfigMessage,
  type MissingPointConfig,
} from "@/lib/weekRecognitionResolve";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

// ── 1. 오류 메시지 형식 ───────────────────────────────────────────────────
const missing: MissingPointConfig[] = [
  { hub: "info", configKey: "at-1", hubLabel: "실무 정보", label: "위즈덤" },
  { hub: "experience", configKey: "analysis", hubLabel: "실무 경험", label: "분석" },
  { hub: "competency", configKey: "CPBS-NN0003", hubLabel: "실무 역량", label: "CPBS-NN0003" },
];
const msg = formatMissingPointConfigMessage(missing);
console.log("[1] 미설정 오류 메시지");
check("헤더 포함", msg.startsWith("다음 오픈 항목의 포인트 설정이 없습니다."));
check("실무 정보: 위즈덤", msg.includes("- 실무 정보: 위즈덤"));
check("실무 경험: 분석", msg.includes("- 실무 경험: 분석"));
check("실무 역량: CPBS-NN0003", msg.includes("- 실무 역량: CPBS-NN0003"));
check("안내 문구", msg.includes("라인 등록 또는 포인트 설정을 완료한 뒤 다시 오픈 확인해주세요."));

// ── 2. configured 판정 규칙(순수 재현) ────────────────────────────────────
//   loadLinePointConfigs.isConfigured 와 동일 규칙: row 존재 && A·B 둘 다 non-null.
function isConfiguredRule(row: { point_a: number | null; point_b: number | null } | undefined): boolean {
  if (!row) return false; // row 부재
  return row.point_a !== null && row.point_b !== null;
}
console.log("[2] configured 판정 규칙");
check("A=0,B=20 → configured(0 정상값)", isConfiguredRule({ point_a: 0, point_b: 20 }) === true);
check("A=5,B=0 → configured", isConfiguredRule({ point_a: 5, point_b: 0 }) === true);
check("A=0,B=0 → configured", isConfiguredRule({ point_a: 0, point_b: 0 }) === true);
check("A=null → 미설정", isConfiguredRule({ point_a: null, point_b: 7 }) === false);
check("B=null → 미설정", isConfiguredRule({ point_a: 7, point_b: null }) === false);
check("row 부재 → 미설정", isConfiguredRule(undefined) === false);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
