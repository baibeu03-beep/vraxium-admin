/** db/migrations/2026-07-09_weeks_auto_publish_hold.sql 적용(exec_sql 있으면 자동, 없으면 안내). */
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
  } catch (e) { return { ok: false, err: (e as Error).message }; }
}

async function main() {
  const file = resolve("db/migrations/2026-07-09_weeks_auto_publish_hold.sql");
  const sql = readFileSync(file, "utf8");
  const statements = sql.split(";").map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim()).filter((s) => s.length > 0);
  const probe = await execSql("select 1");
  if (!probe.ok) { console.log(`❌ exec_sql 사용 불가(${probe.err}). → Supabase SQL Editor 로 수동 적용: ${file}`); process.exit(2); }
  for (const st of statements) {
    const r = await execSql(st);
    console.log(r.ok ? `✓ ${st.slice(0, 60).replace(/\n/g, " ")}...` : `✗ ${r.err} :: ${st.slice(0, 60)}`);
    if (!r.ok) process.exit(1);
  }
  // verify
  const chk: any = await execSql("select 1 from information_schema.columns where table_name='weeks' and column_name='auto_publish_hold_at'");
  console.log("verify weeks.auto_publish_hold_at:", chk.ok ? "OK" : chk.err);
  console.log("✅ 적용 완료");
}
main().then(()=>process.exit(0)).catch((e)=>{console.error(e);process.exit(1);});
