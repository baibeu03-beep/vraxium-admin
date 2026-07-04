/**
 * process_check_logs.action CHECK 제약 확장(+check_rolled_back) 적용 — 실행 취소(↩) 로그 정식 라벨.
 *   db/migrations/2026-07-04_process_check_logs_rollback_action.sql.
 *   exec_sql RPC 가 있으면 그걸로 DDL 적용(멱등), 없으면 수동(Supabase SQL Editor) 안내만 출력.
 *   ⚠ 미적용 상태에서도 코드는 check_cancelled 로 폴백 기록하므로 실행 취소 로그 자체는 유실되지 않는다
 *     (적용 후에야 정식 action='check_rolled_back' · 라벨 "실행 취소" 로 남는다).
 * Usage: npx tsx --env-file=.env.local scripts/apply-process-check-rollback-action.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const wt = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error("local-timeout")), ms))]);

async function execSql(query: string): Promise<{ ok: boolean; err?: string }> {
  try {
    const r: any = await wt(supabaseAdmin.rpc("exec_sql", { query }) as any, 30000);
    if (r.error) return { ok: false, err: `${r.error.code ?? ""} ${r.error.message ?? ""}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, err: (e as Error).message };
  }
}

async function main() {
  const file = resolve("db/migrations/2026-07-04_process_check_logs_rollback_action.sql");
  const sql = readFileSync(file, "utf8");
  // 세미콜론 단위 statement(주석/빈 줄 제거) — DROP CONSTRAINT + ADD CONSTRAINT 2문.
  const statements = sql
    .split(";")
    .map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim())
    .filter((s) => s.length > 0);

  const probe = await execSql("select 1");
  if (!probe.ok) {
    console.log(`\n❌ exec_sql 사용 불가(${probe.err}).`);
    console.log("→ 수동 적용 필요: Supabase SQL Editor 에서 아래 파일 내용을 실행하세요.");
    console.log(`   ${file}`);
    console.log("   (미적용 상태에서도 실행 취소 로그는 check_cancelled 폴백으로 기록됩니다.)");
    process.exit(2);
  }
  console.log("exec_sql 사용 가능 — DDL 적용 시작");
  for (let i = 0; i < statements.length; i++) {
    const head = statements[i].split("\n")[0].slice(0, 70);
    const res = await execSql(statements[i]);
    console.log(`  [${i + 1}/${statements.length}] ${res.ok ? "✓" : "✗"} ${head}${res.ok ? "" : ` — ${res.err}`}`);
    if (!res.ok) { console.log("\n❌ 적용 실패 — 중단. 수동 SQL Editor 적용 권장."); process.exit(1); }
  }
  console.log("\n✅ process_check_logs.action CHECK 확장 완료(+check_rolled_back).");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
