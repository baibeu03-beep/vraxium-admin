// line_registrations 스키마 캐시 오류 진단 2단계 (read-only).
// 실행: npx tsx --env-file=.env.local scripts/diag-line-registrations-db.ts
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const MIGRATION_COLUMNS =
  "id,line_name,hub,line_type,line_code,main_title_mode,main_title," +
  "output_links,output_images,partner_company,company_logo_url,manager_name," +
  "manager_position,manager_job,manager_profile_key,is_active,created_by,created_at,updated_at";

async function probe(label: string, key: string) {
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data, error, count } = await sb
    .from("line_registrations")
    .select(MIGRATION_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(3);
  console.log(`\n== ${label}: 마이그레이션 19개 컬럼 전체 select ==`);
  if (error) {
    console.log("ERROR:", JSON.stringify({ code: error.code, message: error.message }));
  } else {
    console.log(`OK — total rows: ${count}`);
    console.log(JSON.stringify(data, null, 1));
  }
}

async function main() {
  console.log("DB:", url);
  await probe("service_role", serviceKey);
  await probe("anon key (RLS 경유)", anonKey);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
