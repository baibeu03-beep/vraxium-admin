/**
 * cluster4_week_opening_configs 마이그레이션 적용 (exec_sql RPC).
 *   db/migrations/2026-07-02_cluster4_week_opening_configs.sql 의 핵심 DDL 을 멱등 적용한다.
 *   exec_sql 부재 시 SQL Editor 수동 적용 안내.
 *
 *   npx tsx --env-file=.env.local scripts/apply-week-opening-configs.ts
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

const DDL = `
CREATE TABLE IF NOT EXISTS public.cluster4_week_opening_configs (
  id                 uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  week_id            uuid         NOT NULL,
  organization_slug  text         NOT NULL
                       CHECK (organization_slug IN ('encre','oranke','phalanx')),
  config             jsonb        NOT NULL DEFAULT '{}'::jsonb,
  open_confirmed     boolean      NOT NULL DEFAULT false,
  open_confirmed_at  timestamptz  NULL,
  open_confirmed_by  uuid         NULL,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT cluster4_week_opening_configs_week_org_uq UNIQUE (week_id, organization_slug)
);
CREATE INDEX IF NOT EXISTS cluster4_week_opening_configs_week_idx
  ON public.cluster4_week_opening_configs (week_id);
DROP TRIGGER IF EXISTS cluster4_week_opening_configs_set_updated_at
  ON public.cluster4_week_opening_configs;
CREATE TRIGGER cluster4_week_opening_configs_set_updated_at
BEFORE UPDATE ON public.cluster4_week_opening_configs
FOR EACH ROW EXECUTE FUNCTION public.touch_cluster4_updated_at();
GRANT SELECT ON public.cluster4_week_opening_configs TO anon, authenticated;
`;

async function main() {
  const probe = await execSql("SELECT 1;");
  if (!probe.ok) {
    console.log(
      `❌ exec_sql 사용 불가(${probe.err}). Supabase SQL Editor 에 db/migrations/2026-07-02_cluster4_week_opening_configs.sql 수동 적용 요망.`,
    );
    process.exit(2);
  }
  const r = await execSql(DDL);
  console.log("cluster4_week_opening_configs DDL:", r.ok ? "OK" : `FAIL(${r.err})`);
  if (!r.ok) process.exit(1);
  const { count, error } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select("*", { count: "exact", head: true });
  console.log("table reachable:", error ? `FAIL(${error.message})` : `OK (rows=${count ?? 0})`);
  process.exit(error ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
