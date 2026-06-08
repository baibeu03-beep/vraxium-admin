// 라인 등록 페이지 설계용 read-only 조사 스크립트.
// 실행: npx tsx --env-file=.env.local scripts/diag-line-register-tables.ts
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key, { auth: { persistSession: false } });

async function main() {
  // 1. activity_types 전체 (라인 종류 후보)
  const { data: at } = await sb.from("activity_types").select("*").order("id");
  console.log("== activity_types ==");
  console.log(JSON.stringify(at, null, 1));

  // 2. experience masters 의 experience_category 분포
  const { data: em } = await sb
    .from("cluster4_experience_line_masters")
    .select("line_code,line_name,experience_category,organization_slug,is_active")
    .limit(20);
  console.log("== experience_line_masters sample ==");
  console.log(JSON.stringify(em, null, 1));

  // 3. competency masters sample
  const { data: cm } = await sb
    .from("cluster4_competency_line_masters")
    .select("line_code,line_name,main_title,organization_slug,is_active")
    .limit(10);
  console.log("== competency_line_masters sample ==");
  console.log(JSON.stringify(cm, null, 1));

  // 4. career_projects sample (career 전용 필드 확인)
  const { data: cp } = await sb
    .from("career_projects")
    .select(
      "id,company_name,company_logo_url,line_code,line_name,supervisor_name,supervisor_position,supervisor_department,supervisor_profile_img,output_links,output_images,organization_slug,default_main_title",
    )
    .limit(5);
  console.log("== career_projects sample ==");
  console.log(JSON.stringify(cp, null, 1));

  // 5. cluster4_lines part_type 별 카운트 + 최근 1건
  const { data: lines } = await sb
    .from("cluster4_lines")
    .select("id,part_type,line_code,main_title,activity_type_id,source_type,is_active,created_at")
    .order("created_at", { ascending: false })
    .limit(8);
  console.log("== cluster4_lines recent ==");
  console.log(JSON.stringify(lines, null, 1));

  // 6. line_registrations 류 신규 테이블 존재 여부 probe
  for (const t of ["line_registrations", "line_masters", "lines", "cluster4_line_registry"]) {
    const { error } = await sb.from(t).select("*").limit(1);
    console.log(`probe table ${t}:`, error ? `MISSING (${error.code})` : "EXISTS");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
