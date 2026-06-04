/**
 * Google OAuth 도입 전 DB 베이스라인 진단. (exec_sql RPC 부재 → PostgREST 직조회)
 *   npx tsx --env-file=.env.local scripts/diag-google-auth-baseline.ts
 *
 * 확인 항목:
 * 1. applicants.provider 분포(고객 ensurePendingApplicant 가 provider 미지정 insert → 기본값 확인)
 * 2. applicants.provider_user_id / linked_user_id 컬럼 존재 여부
 * 3. auth_accounts 테이블 존재 여부
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  // 1. applicants provider/status 분포 (행수 적은 테이블 — 전수 조회)
  const { data: rows, error: rowsErr } = await sb
    .from("applicants")
    .select("provider, status")
    .order("provider", { ascending: true })
    .range(0, 4999);
  if (rowsErr) {
    console.log("applicants 조회 ERR:", rowsErr.message);
  } else {
    const dist = new Map<string, number>();
    for (const r of rows ?? []) {
      const key = `${r.provider ?? "(null)"} / ${r.status ?? "(null)"}`;
      dist.set(key, (dist.get(key) ?? 0) + 1);
    }
    console.log(`applicants 총 ${rows?.length}건 — provider/status 분포:`);
    for (const [k, v] of [...dist.entries()].sort()) console.log(`  ${k}: ${v}`);
  }

  // 2. provider_user_id / linked_user_id 컬럼 존재 여부 (select 시도로 판별)
  for (const col of ["provider_user_id", "linked_user_id", "approved_at"]) {
    const { error } = await sb.from("applicants").select(col).limit(1);
    console.log(`applicants.${col}: ${error ? `없음(${error.message})` : "존재"}`);
  }

  // 3. auth_accounts 테이블 존재 여부
  const { error: aaErr } = await sb.from("auth_accounts").select("id").limit(1);
  console.log(`auth_accounts 테이블: ${aaErr ? `없음(${aaErr.message})` : "존재"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
