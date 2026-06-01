/**
 * [READ-ONLY] career_projects 6 sponsor-card 필드 실데이터 조사.
 *   npx tsx --env-file=.env.local scripts/inspect-career-fields.ts
 * DB 는 읽기만 한다(수정 없음).
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

function j(label: string, v: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(v, null, 2));
}

function looksLikeLogo(v: string | null): string {
  if (!v) return "(null)";
  const isImg = /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(v);
  const isGithub = /github\.com/i.test(v);
  const isSupabase = /supabase|storage/i.test(v);
  return `${isImg ? "IMG" : "NOT-IMG"}${isGithub ? " GITHUB!" : ""}${isSupabase ? " storage" : ""}`;
}

async function main() {
  // 라인 코드가 있는(=라인 등록된) career_projects 만, 최근 순.
  const { data, error } = await sb
    .from("career_projects")
    .select(
      "id,line_code,line_name,company_name,company_logo_url,supervisor_name,supervisor_department,supervisor_position,supervisor_profile_img,supervisor_company,created_at",
    )
    .not("line_code", "is", null)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("query error", error.message);
    return;
  }

  console.log(`career_projects (line_code 보유) ${data?.length ?? 0}건\n`);

  for (const r of (data ?? []) as any[]) {
    j(`[${r.line_code}] ${r.line_name ?? ""}  id=${r.id}`, {
      company_name: r.company_name,
      supervisor_company: r.supervisor_company,
      company_logo_url: r.company_logo_url,
      "logo?": looksLikeLogo(r.company_logo_url),
      supervisor_name: r.supervisor_name,
      supervisor_department: r.supervisor_department,
      supervisor_position: r.supervisor_position,
      supervisor_profile_img: r.supervisor_profile_img,
      "photo?": looksLikeLogo(r.supervisor_profile_img),
      created_at: r.created_at,
    });
  }

  // 요약 카운트
  const rows = (data ?? []) as any[];
  const summary = {
    total: rows.length,
    company_name_null: rows.filter((r) => !r.company_name).length,
    company_name_present: rows.filter((r) => r.company_name).length,
    supervisor_company_present: rows.filter((r) => r.supervisor_company).length,
    logo_github: rows.filter((r) => r.company_logo_url && /github\.com/i.test(r.company_logo_url)).length,
    logo_notimg: rows.filter((r) => r.company_logo_url && !/\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(r.company_logo_url)).length,
    supervisor_dept_null: rows.filter((r) => !r.supervisor_department).length,
    supervisor_pos_null: rows.filter((r) => !r.supervisor_position).length,
    supervisor_photo_null: rows.filter((r) => !r.supervisor_profile_img).length,
  };
  j("SUMMARY", summary);
}

main().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});
