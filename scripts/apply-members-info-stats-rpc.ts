/**
 * 집계 RPC 마이그레이션 적용 — db/migrations/2026-06-25_members_info_stats_aggregate.sql.
 *   exec_sql RPC 가 있으면 그걸로 DDL 적용(read 전용 함수 2종 생성, idempotent).
 *   exec_sql 부재/오류면 수동(Supabase SQL Editor) 적용 안내만 출력하고 종료.
 *   ⚠ snapshot 재계산/생성 없음 — 조회용 함수만 생성.
 * Usage: npx tsx --env-file=.env.local scripts/apply-members-info-stats-rpc.ts
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
  const file = resolve("db/migrations/2026-06-25_members_info_stats_aggregate.sql");
  const sql = readFileSync(file, "utf8");
  // "create or replace function" 경계로 분리(함수 본문 $$ 내부 ; 안전). 각 조각=완전한 1 statement.
  const statements = sql
    .split(/(?=create or replace function)/i)
    .map((s) => s.trim())
    .filter((s) => /^create or replace function/i.test(s));
  console.log(`마이그레이션 statement ${statements.length}개 추출`);

  // exec_sql 가용성 1회 확인(가벼운 select).
  const probe = await execSql("select 1");
  if (!probe.ok) {
    console.log(`\n❌ exec_sql 사용 불가(${probe.err}).`);
    console.log("→ 수동 적용 필요: Supabase SQL Editor 에서 아래 파일 내용을 실행하세요.");
    console.log(`   ${file}`);
    process.exit(2);
  }
  console.log("exec_sql 사용 가능 — DDL 적용 시작");

  for (let i = 0; i < statements.length; i++) {
    const head = statements[i].split("\n")[0].slice(0, 70);
    const res = await execSql(statements[i]);
    console.log(`  [${i + 1}/${statements.length}] ${res.ok ? "✓" : "✗"} ${head}${res.ok ? "" : ` — ${res.err}`}`);
    if (!res.ok) { console.log("\n❌ 적용 실패 — 중단. 수동 SQL Editor 적용 권장."); process.exit(1); }
  }
  console.log("\n✅ RPC 마이그레이션 적용 완료(members_info_stats_card_rows·members_info_stats_valid_users)");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
