/**
 * englishName 노출 검증 — TEST 사용자 1명을 골라
 * (1) AdminCrewDto.englishName
 * (2) ResumeCardBundle.englishName 및 profile.english_name
 * 가 실제 user_profiles.english_name 값과 동일하게 내려오는지 확인한다.
 *
 *   npx tsx --env-file=.env.local scripts/verify-english-name-api.ts
 */
import { createClient } from "@supabase/supabase-js";
import { getAdminCrewDtoByLegacyUserId } from "@/lib/adminCrewData";
import { getResumeCardForCrew } from "@/lib/adminResumeCardData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  // english_name 이 채워진 임의 TEST 사용자 1명 선택
  const { data: candidates, error } = await sb
    .from("user_profiles")
    .select("user_id,display_name,english_name,organization_slug")
    .not("english_name", "is", null)
    .neq("english_name", "")
    .limit(1);

  if (error) throw error;
  if (!candidates || candidates.length === 0) {
    console.log("english_name 이 채워진 user_profiles row 가 없습니다.");
    return;
  }

  const target = candidates[0] as {
    user_id: string;
    display_name: string | null;
    english_name: string | null;
    organization_slug: string | null;
  };

  console.log("[Target user_profiles row]");
  console.log(JSON.stringify(target, null, 2));
  console.log();

  // 1) AdminCrewDto
  const crew = await getAdminCrewDtoByLegacyUserId(target.user_id);
  console.log("[GET /api/admin/crews/{id}] AdminCrewDto.englishName");
  console.log(
    JSON.stringify(
      {
        userId: crew?.userId,
        displayName: crew?.displayName,
        englishName: crew?.englishName,
        organizationSlug: crew?.organizationSlug,
      },
      null,
      2,
    ),
  );
  console.log();

  // 2) ResumeCardBundle
  const bundle = await getResumeCardForCrew(target.user_id);
  console.log("[GET /api/admin/crews/{id}/resume-card] ResumeCardBundle");
  console.log(
    JSON.stringify(
      {
        legacyUserId: bundle?.legacyUserId,
        userId: bundle?.userId,
        englishName: bundle?.englishName,
        profile_display_name: bundle?.profile?.display_name ?? null,
        profile_english_name: bundle?.profile?.english_name ?? null,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
