/**
 * [IDEMPOTENT / NET-ZERO] sponsor-meta 저장 경로 검증.
 *   현재 career_projects 6필드를 읽어 "동일 값으로" 다시 update → 반환값이 일치하는지 확인한다.
 *   값이 바뀌지 않으므로 데이터 변경 없음. snapshot 도 건드리지 않는다(stale 함수 미호출).
 *   collectCareerProjectTargetUserIds 도 함께 확인(=저장 시 stale 대상자 집합).
 *
 *   npx tsx --env-file=.env.local scripts/verify-sponsor-meta-update.ts
 */
import { createClient } from "@supabase/supabase-js";
import {
  updateCareerProjectSponsorMeta,
  collectCareerProjectTargetUserIds,
} from "@/lib/adminCareerProjectsData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function j(label: string, v: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(v, null, 2));
}

async function main() {
  const { data: proj } = await sb
    .from("career_projects")
    .select("id")
    .not("line_code", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const id = (proj as { id: string } | null)?.id;
  if (!id) {
    console.log("line_code 보유 career_project 없음");
    return;
  }

  // 현재 6필드 읽기.
  const { data: before } = await sb
    .from("career_projects")
    .select(
      "company_name,company_logo_url,supervisor_name,supervisor_department,supervisor_position,supervisor_profile_img",
    )
    .eq("id", id)
    .maybeSingle();
  const b = before as Record<string, string | null>;
  j("BEFORE row 6필드", b);

  // 동일 값으로 idempotent update (데이터 변경 없음). 반환 DTO 확인.
  const result = await updateCareerProjectSponsorMeta(id, {
    companyName: b.company_name,
    companyLogoUrl: b.company_logo_url,
    supervisorName: b.supervisor_name,
    supervisorDepartment: b.supervisor_department,
    supervisorPosition: b.supervisor_position,
    supervisorProfileImg: b.supervisor_profile_img,
  });
  j("updateCareerProjectSponsorMeta() 반환 DTO", result);

  // stale 대상자 집합(저장 시 markWeeklyCardsSnapshotStaleMany 에 전달될 userIds).
  const targetUserIds = await collectCareerProjectTargetUserIds(id);
  j("collectCareerProjectTargetUserIds()", { count: targetUserIds.length, targetUserIds });

  // 변경 없음 확인.
  const { data: after } = await sb
    .from("career_projects")
    .select(
      "company_name,company_logo_url,supervisor_name,supervisor_department,supervisor_position,supervisor_profile_img,job_position,project_name,line_code,default_target_user_ids",
    )
    .eq("id", id)
    .maybeSingle();
  const a = after as Record<string, unknown>;
  const unchanged =
    a.company_name === b.company_name &&
    a.company_logo_url === b.company_logo_url &&
    a.supervisor_name === b.supervisor_name &&
    a.supervisor_department === b.supervisor_department &&
    a.supervisor_position === b.supervisor_position &&
    a.supervisor_profile_img === b.supervisor_profile_img;
  j("AFTER (다른 컬럼 보존 확인)", {
    sixFieldsUnchanged: unchanged,
    job_position: a.job_position,
    project_name: a.project_name,
    line_code: a.line_code,
    default_target_user_ids: a.default_target_user_ids,
  });
}

main().catch((e) => { console.error("fatal", e); process.exit(1); });
