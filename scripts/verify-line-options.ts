/**
 * [READ-ONLY] career-line-options 응답(수정 후) 6필드 포함 검증.
 * route.ts 의 select + map 을 그대로 복제해 실데이터로 확인한다.
 *   npx tsx --env-file=.env.local scripts/verify-line-options.ts
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const toArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

async function main() {
  const { data, error } = await sb
    .from("career_projects")
    .select(
      "id,line_code,line_name,company_name,company_logo_url,supervisor_name,supervisor_department,supervisor_position,supervisor_profile_img,default_main_title,default_output_link_1,default_output_link_2,default_output_images,default_target_user_ids,start_date,end_date,organization_slug",
    )
    .not("line_code", "is", null)
    .order("line_code", { ascending: true });

  if (error) {
    console.error("query error", error.message);
    return;
  }

  const options = (data ?? []).map((r: any) => ({
    id: r.id,
    lineCode: r.line_code,
    lineName: r.line_name,
    companyName: r.company_name,
    companyLogoUrl: r.company_logo_url,
    supervisorName: r.supervisor_name,
    supervisorDepartment: r.supervisor_department,
    supervisorPosition: r.supervisor_position,
    supervisorPhotoUrl: r.supervisor_profile_img,
    defaultMainTitle: r.default_main_title,
    defaultOutputLink1: r.default_output_link_1,
    defaultOutputLink2: r.default_output_link_2,
    defaultOutputImages: toArr(r.default_output_images),
    defaultTargetUserIds: toArr(r.default_target_user_ids),
    startDate: r.start_date,
    endDate: r.end_date,
  }));

  console.log(JSON.stringify({ success: true, data: { options } }, null, 2));

  const six = ["companyName", "companyLogoUrl", "supervisorName", "supervisorDepartment", "supervisorPosition", "supervisorPhotoUrl"];
  for (const o of options) {
    const present = six.filter((k) => k in o);
    console.log(`\n[${o.lineCode}] 6필드 키 존재: ${present.length}/6 → ${present.join(", ")}`);
  }
}

main().catch((e) => { console.error("fatal", e); process.exit(1); });
