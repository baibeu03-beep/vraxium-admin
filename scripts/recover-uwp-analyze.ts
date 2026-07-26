/**
 * READ-ONLY — dry-run 산출물(recover-uwp-dryrun-*.json)의 그룹 분해 · 중복 위험 분석.
 *   npx tsx --env-file=.env.local scripts/recover-uwp-analyze.ts [file.json]
 * write 0.
 */
import { readdirSync, readFileSync } from "fs";

type Row = {
  group: 1 | 2 | 3 | 4; user_id: string; display_name: string; org: string; is_test: boolean;
  source_system: string; week_start_date: string; week_kind: string; year: number | null; week_number: number | null;
  cur_a: number; exp_a: number; d_a: number; cur_adv: number; exp_adv: number; d_adv: number;
  cur_pen: number; exp_pen: number; d_pen: number;
  checks_migrated: boolean; wiped: boolean; has_award: boolean;
  ledger_rows: number; voided_rows: number; protected_zeroed: number; uwp_row_id: string | null; basis: string;
};

const file = process.argv[2] ?? "claudedocs/" + readdirSync("claudedocs").filter((x) => x.startsWith("recover-uwp-dryrun-") && x.endsWith(".json")).sort().pop()!;
const { rows } = JSON.parse(readFileSync(file, "utf8")) as { rows: Row[] };
console.log("source:", file, "rows:", rows.length);

const sum = (rs: Row[], f: (r: Row) => number) => rs.reduce((s, r) => s + f(r), 0);
const desc = (label: string, rs: Row[]) =>
  console.log(
    `${label.padEnd(58)} rows=${String(rs.length).padStart(6)} users=${String(new Set(rs.map((r) => r.user_id)).size).padStart(4)}` +
      ` | curA=${String(sum(rs, (r) => r.cur_a)).padStart(7)} expA=${String(sum(rs, (r) => r.exp_a)).padStart(7)} ΔA=${String(sum(rs, (r) => r.d_a)).padStart(7)}` +
      ` | curAdv=${String(sum(rs, (r) => r.cur_adv)).padStart(6)} expAdv=${String(sum(rs, (r) => r.exp_adv)).padStart(6)}` +
      ` | curPen=${String(sum(rs, (r) => r.cur_pen)).padStart(6)} expPen=${String(sum(rs, (r) => r.exp_pen)).padStart(6)}`,
  );

const g1 = rows.filter((r) => r.group === 1);
const g2 = rows.filter((r) => r.group === 2);
const g3 = rows.filter((r) => r.group === 3);

console.log("\n════ GROUP 1 (현재 0 · 원장 값 존재) ════");
desc("전체", g1);
desc("  wiped(§2) ∧ cm=true ∧ award 없음  ← 복구 후보", g1.filter((r) => r.wiped && r.checks_migrated && !r.has_award));
desc("  wiped ∧ award 있음", g1.filter((r) => r.wiped && r.has_award));
desc("  wiped 아님(§2 미대상)", g1.filter((r) => !r.wiped));
desc("    └ 그중 cm=false(FLIP/전환)", g1.filter((r) => !r.wiped && !r.checks_migrated));
desc("    └ 그중 cm=true", g1.filter((r) => !r.wiped && r.checks_migrated));

console.log("\n════ GROUP 2 (현재 비영 · 원장과 다름) ════");
desc("전체", g2);
desc("  award 있음 (awards SoT — 복구 금지)", g2.filter((r) => r.has_award));
desc("  award 없음", g2.filter((r) => !r.has_award));
desc("    └ wiped ∧ cm=true", g2.filter((r) => !r.has_award && r.wiped && r.checks_migrated));
desc("    └ wiped 아님 ∧ cm=false", g2.filter((r) => !r.has_award && !r.wiped && !r.checks_migrated));
desc("    └ wiped 아님 ∧ cm=true", g2.filter((r) => !r.has_award && !r.wiped && r.checks_migrated));
desc("  현재>원장 (복구 시 값 감소 = 위험)", g2.filter((r) => r.cur_a > r.exp_a));
desc("  현재<원장 (복구 시 값 증가)", g2.filter((r) => r.cur_a < r.exp_a));

console.log("\n  ── group2 · award 없음 · 현재>원장 상위 25 ──");
for (const r of g2.filter((x) => !x.has_award && x.cur_a > x.exp_a).sort((a, b) => (b.cur_a - b.exp_a) - (a.cur_a - a.exp_a)).slice(0, 25))
  console.log(`   ${r.display_name}(${r.org}${r.is_test ? ",T" : ""}) ${r.week_start_date}[${r.week_kind}] A ${r.cur_a}→${r.exp_a} adv ${r.cur_adv}→${r.exp_adv} pen ${r.cur_pen}→${r.exp_pen} cm=${r.checks_migrated} wiped=${r.wiped} ledgerRows=${r.ledger_rows}`);

console.log("\n  ── group2 · award 없음 · 현재<원장 상위 25 ──");
for (const r of g2.filter((x) => !x.has_award && x.cur_a < x.exp_a).sort((a, b) => b.d_a - a.d_a).slice(0, 25))
  console.log(`   ${r.display_name}(${r.org}${r.is_test ? ",T" : ""}) ${r.week_start_date}[${r.week_kind}] A ${r.cur_a}→${r.exp_a} adv ${r.cur_adv}→${r.exp_adv} pen ${r.cur_pen}→${r.exp_pen} cm=${r.checks_migrated} wiped=${r.wiped} ledgerRows=${r.ledger_rows}`);

console.log("\n════ GROUP 3 (동일) ════");
desc("전체", g3);
desc("  wiped(원래도 0이었던 행)", g3.filter((r) => r.wiped));

// ── 확정 복구 스코프 ──
const SCOPE = rows.filter(
  (r) => r.wiped && r.checks_migrated && !r.has_award && r.cur_a === 0 && r.cur_adv === 0 && r.cur_pen === 0 && (r.exp_a !== 0 || r.exp_adv !== 0 || r.exp_pen !== 0),
);
console.log("\n════ 확정 복구 스코프 (wiped ∧ cm=true ∧ award없음 ∧ 현재 전부0 ∧ 원장 비영) ════");
desc("SCOPE", SCOPE);
console.log("  주차유형:", JSON.stringify(Object.entries(SCOPE.reduce((m: Record<string, number>, r) => ((m[r.week_kind] = (m[r.week_kind] ?? 0) + 1), m), {}))));
console.log("  org:", JSON.stringify(Object.entries(SCOPE.reduce((m: Record<string, number>, r) => ((m[r.org] = (m[r.org] ?? 0) + 1), m), {}))));
console.log("  테스트계정 행:", SCOPE.filter((r) => r.is_test).length, "/ 사용자", new Set(SCOPE.filter((r) => r.is_test).map((r) => r.user_id)).size);
console.log("  exp_a<0 인 행:", SCOPE.filter((r) => r.exp_a < 0).length, "ΣA", sum(SCOPE.filter((r) => r.exp_a < 0), (r) => r.exp_a));

// 스코프 밖이지만 §2 wipe 흔적이 있는 행 = 검토 필요
const wipedOutOfScope = rows.filter((r) => r.wiped && !SCOPE.includes(r));
console.log("\n════ wiped 이지만 스코프 밖 (검토 필요) ════");
desc("전체", wipedOutOfScope);
desc("  award 있음(=§1 이 awards 값으로 덮음)", wipedOutOfScope.filter((r) => r.has_award));
desc("  award 없음 ∧ 현재 비영(=§2 이후 재적립?)", wipedOutOfScope.filter((r) => !r.has_award && (r.cur_a !== 0 || r.cur_adv !== 0 || r.cur_pen !== 0)));
desc("  award 없음 ∧ 현재 0 ∧ 원장도 0", wipedOutOfScope.filter((r) => !r.has_award && r.cur_a === 0 && r.cur_adv === 0 && r.cur_pen === 0));

// 사용자 단위 집계
const byUser = new Map<string, { name: string; org: string; test: boolean; rows: number; curA: number; expA: number; dA: number; dAdv: number; dPen: number }>();
for (const r of SCOPE) {
  const e = byUser.get(r.user_id) ?? { name: r.display_name, org: r.org, test: r.is_test, rows: 0, curA: 0, expA: 0, dA: 0, dAdv: 0, dPen: 0 };
  e.rows++; e.curA += r.cur_a; e.expA += r.exp_a; e.dA += r.d_a; e.dAdv += r.d_adv; e.dPen += r.d_pen;
  byUser.set(r.user_id, e);
}
console.log(`\n════ 복구 대상 사용자 ${byUser.size}명 — ΔA 상위 25 ════`);
for (const [uid, e] of [...byUser].sort((a, b) => b[1].dA - a[1].dA).slice(0, 25))
  console.log(`  ${e.name.padEnd(6)} ${e.org.padEnd(8)}${e.test ? "T" : " "} rows=${String(e.rows).padStart(3)} ΔA=${String(e.dA).padStart(6)} Δadv=${String(e.dAdv).padStart(5)} Δpen=${String(e.dPen).padStart(5)}  ${uid}`);
console.log("  ΔA 음수 사용자:", [...byUser.values()].filter((e) => e.dA < 0).length);

console.log("\n=== DONE (writes: 0) ===");
