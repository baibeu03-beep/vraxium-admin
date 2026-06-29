/**
 * admin_page_help_contents 마이그레이션 적용 (exec_sql RPC).
 *   db/migrations/2026-06-29_admin_page_help_contents.sql 의 CREATE TABLE + COMMENT 를 적용.
 *   exec_sql 부재 시 수동(Supabase SQL Editor) 적용 안내만 출력하고 종료(write 0).
 *
 *   npx tsx --env-file=.env.local scripts/apply-admin-page-help-contents.ts
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
CREATE TABLE IF NOT EXISTS public.admin_page_help_contents (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  page_path   text        NOT NULL UNIQUE,
  content     text        NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.admin_page_help_contents IS '어드민 페이지별 관련 도움말 본문. page_path 단위 단일 행, content 빈 문자열 허용.';
COMMENT ON COLUMN public.admin_page_help_contents.page_path IS '어드민 경로(usePathname, 쿼리스트링 제외).';
`;

async function main() {
  const probe = await execSql("SELECT 1;");
  if (!probe.ok) {
    console.log(
      `❌ exec_sql 사용 불가(${probe.err}). Supabase SQL Editor 에 db/migrations/2026-06-29_admin_page_help_contents.sql 수동 적용 요망.`,
    );
    process.exit(2);
  }
  console.log("exec_sql 사용 가능.");

  const create = await execSql(DDL);
  console.log("CREATE TABLE admin_page_help_contents:", create.ok ? "OK" : `FAIL(${create.err})`);
  if (!create.ok) process.exit(1);

  const { count } = await supabaseAdmin
    .from("admin_page_help_contents")
    .select("id", { count: "exact", head: true });
  console.log(`admin_page_help_contents 행 수 = ${count ?? 0}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
