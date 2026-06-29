/**
 * weeks.result_reviewed_at 마이그레이션 적용 (exec_sql RPC).
 *   기본: ADD COLUMN + COMMENT 만 (백필 제외 — 검증용 단계 분리).
 *   --backfill : 기존 공표완료 주차 reviewed_at := published_at 백필 실행.
 *   exec_sql 부재 시 수동(SQL Editor) 안내만 출력.
 *
 *   npx tsx --env-file=.env.local scripts/apply-weeks-result-reviewed-at.ts [--backfill]
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function execSql(query: string): Promise<{ ok: boolean; err?: string }> {
  try {
    const r: any = await supabaseAdmin.rpc("exec_sql", { query });
    if (r?.error) return { ok: false, err: r.error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e instanceof Error ? e.message : String(e) };
  }
}

const ADD_COLUMN = `
ALTER TABLE public.weeks ADD COLUMN IF NOT EXISTS result_reviewed_at timestamptz NULL;
COMMENT ON COLUMN public.weeks.result_reviewed_at IS '주차 결과 검수 완료 시각(관리자 검수 완료 버튼). NULL=미검수. /weekly-ranking: 공표+검수 → 검수 완료.';
`;

const BACKFILL = `
UPDATE public.weeks SET result_reviewed_at = result_published_at
 WHERE result_published_at IS NOT NULL AND result_reviewed_at IS NULL;
`;

async function main() {
  const doBackfill = process.argv.includes("--backfill");
  // exec_sql 가용성 확인.
  const probe = await execSql("SELECT 1;");
  if (!probe.ok) {
    console.log(`❌ exec_sql 사용 불가(${probe.err}). Supabase SQL Editor 에 db/migrations/2026-06-29_weeks_result_reviewed_at.sql 수동 적용 요망.`);
    process.exit(2);
  }
  console.log("exec_sql 사용 가능.");

  const add = await execSql(ADD_COLUMN);
  console.log("ADD COLUMN result_reviewed_at:", add.ok ? "OK" : `FAIL(${add.err})`);
  if (!add.ok) process.exit(1);

  if (doBackfill) {
    const bf = await execSql(BACKFILL);
    console.log("BACKFILL (published→reviewed):", bf.ok ? "OK" : `FAIL(${bf.err})`);
    if (!bf.ok) process.exit(1);
  } else {
    console.log("(백필 생략 — --backfill 로 별도 실행)");
  }

  // 현황 카운트.
  const { count: total } = await supabaseAdmin.from("weeks").select("id", { count: "exact", head: true });
  const { count: published } = await supabaseAdmin.from("weeks").select("id", { count: "exact", head: true }).not("result_published_at", "is", null);
  const { count: reviewed } = await supabaseAdmin.from("weeks").select("id", { count: "exact", head: true }).not("result_reviewed_at", "is", null);
  console.log(`weeks 총=${total} | 공표됨=${published} | 검수됨=${reviewed}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
