/**
 * line_registrations 검증 더미 정리 (Phase 2C 선행).
 *   npx tsx --env-file=.env.local scripts/apply-line-registrations-dummy-cleanup.ts            # dry-run
 *   npx tsx --env-file=.env.local scripts/apply-line-registrations-dummy-cleanup.ts --apply    # 실삭제
 * 대상: 2026-06-07 검증 과정에서 생성된 더미 전수 (운영 등록 0건 확인됨).
 *   라인명 prefix: 검증 / UL검증 / 브라우저 / 레이아웃 / 초기화
 * rollback: 삭제 전 전체 행을 claudedocs/line-registrations-dummy-backup-<ts>.json 에 저장.
 */
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const APPLY = process.argv.includes("--apply");
const DUMMY_PREFIX = /^(검증|UL검증|브라우저|레이아웃|초기화)/;

async function main() {
  const { data, error } = await sb
    .from("line_registrations")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  const targets = rows.filter((r) => DUMMY_PREFIX.test(r.line_name as string));
  const keep = rows.filter((r) => !DUMMY_PREFIX.test(r.line_name as string));

  console.log(`전체 ${rows.length}건 / 삭제 대상 ${targets.length}건 / 보존 ${keep.length}건\n`);
  console.log("== 삭제 대상 ==");
  for (const r of targets) {
    console.log(`  - ${r.line_name} | ${r.hub} | ${r.line_code} | ${r.created_at}`);
  }
  if (keep.length > 0) {
    console.log("\n== 보존 (운영 등록 추정 — 삭제하지 않음) ==");
    for (const r of keep) {
      console.log(`  - ${r.line_name} | ${r.hub} | ${r.line_code} | ${r.created_at}`);
    }
  }

  if (!APPLY) {
    console.log("\n[dry-run] 삭제하지 않았습니다. 실삭제: --apply");
    return;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `claudedocs/line-registrations-dummy-backup-${ts}.json`;
  writeFileSync(backupPath, JSON.stringify(targets, null, 2), "utf8");
  console.log(`\nrollback 백업 저장: ${backupPath}`);

  const ids = targets.map((r) => r.id as string);
  if (ids.length === 0) {
    console.log("삭제 대상 없음.");
    return;
  }
  const { error: delError, count } = await sb
    .from("line_registrations")
    .delete({ count: "exact" })
    .in("id", ids);
  if (delError) throw new Error(delError.message);
  console.log(`삭제 완료: ${count}건`);

  const { count: remain } = await sb
    .from("line_registrations")
    .select("*", { count: "exact", head: true });
  console.log(`잔여: ${remain}건`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
