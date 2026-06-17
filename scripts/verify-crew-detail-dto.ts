// ===================================================================
// 크루 상세 DTO(인적사항 + 클럽 소속) 검증(라이브 DB).
//   · getCrewDetailDto 직접 결과를 출력하고 형식/SoT 정합을 검증한다.
//   · 프로필 사진/대표 학력은 고객앱 Cluster2 SoT(user_profiles.profile_photo_url,
//     user_educations is_primary)와 동일 값인지 교차 확인.
//   · 상태 라벨은 getGrowthRosterBatchFast → statusBucketLabel 단일 SoT와 일치.
//   · snapshot row 수 불변(읽기 전용·크루 코드 lazy 외 write 없음).
//   실행: npx tsx --env-file=.env.local scripts/verify-crew-detail-dto.ts
// ===================================================================
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCrewDetailDto } from "@/lib/adminCrewDetailData";
import { getGrowthRosterBatchFast } from "@/lib/cluster3GrowthData";
import { statusBucketLabel } from "@/lib/memberStatusBucket";

const SNAP = "cluster4_weekly_card_snapshots";
let fail = 0;
function check(ok: boolean, label: string, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail += 1;
}

async function snapCount(): Promise<number> {
  const { count, error } = await supabaseAdmin.from(SNAP).select("*", { count: "exact", head: true });
  if (error) throw new Error(error.message);
  return count ?? 0;
}

const DATE6 = /^\d{2}\. \d{2}\. \d{2}$/; // "26. 06. 15"
const WEEK = /^\d{2}년, (겨울|봄|여름|가을), \d+주차$/; // "25년, 여름, 2주차"
const END_OK = (v: string) => v === "-" || v === "~ing" || DATE6.test(v);
const ENDW_OK = (v: string) => v === "-" || v === "~ing" || WEEK.test(v);

async function pickSamples(): Promise<string[]> {
  const ids = new Set<string>();
  // org 별 활동 시작일 보유 1명씩 + 졸업/중단 케이스.
  for (const org of ["encre", "oranke", "phalanx"]) {
    const { data } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id")
      .eq("organization_slug", org)
      .not("activity_started_at", "is", null)
      .limit(1);
    for (const r of (data ?? []) as { user_id: string }[]) ids.add(r.user_id);
  }
  for (const gs of ["graduated", "suspended"]) {
    const { data } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id")
      .eq("growth_status", gs)
      .limit(1);
    for (const r of (data ?? []) as { user_id: string }[]) ids.add(r.user_id);
  }
  return [...ids];
}

async function main() {
  const before = await snapCount();
  const samples = await pickSamples();
  check(samples.length > 0, "샘플 사용자 확보", `${samples.length}명`);

  for (const userId of samples) {
    const dto = await getCrewDetailDto(userId);
    if (!dto) { check(false, `DTO 생성(${userId})`, "null"); continue; }

    console.log("─".repeat(60));
    console.log(`▶ ${dto.displayName} (${userId}) · ${dto.organizationSlug ?? "공통"}`);
    console.log("  [인적사항]", JSON.stringify({
      photo: dto.profilePhotoUrl ? "(있음)" : "(없음)",
      gender: dto.gender, birthDate: dto.birthDate, age: dto.age,
      address: dto.address, contactPhone: dto.contactPhone, contactEmail: dto.contactEmail,
      school: dto.schoolName, dept: dto.departmentName, admission: dto.admissionPeriod,
    }));
    console.log("  [클럽 소속]", JSON.stringify({
      crewCode: dto.crewCode, status: dto.statusLabel, class: dto.classLabel,
      startDate: dto.activityStartDate, startWeek: dto.activityStartWeek,
      endDate: dto.activityEndDate, endWeek: dto.activityEndWeek,
      team: dto.teamName, part: dto.partName,
    }));

    // 형식 검증.
    check(dto.activityStartDate === "-" || DATE6.test(dto.activityStartDate),
      "활동 시작일 형식(6자리/-)", dto.activityStartDate);
    check(dto.activityStartWeek === "-" || WEEK.test(dto.activityStartWeek),
      "활동 시작 주차 형식", dto.activityStartWeek);
    check(END_OK(dto.activityEndDate), "활동 종료일 형식(6자리/~ing/-)", dto.activityEndDate);
    check(ENDW_OK(dto.activityEndWeek), "활동 종료 주차 형식", dto.activityEndWeek);

    // 종료 노출 규칙: 엘리트/활동 중단만 날짜, 그 외 ~ing 또는 -.
    if (dto.statusLabel === "엘리트" || dto.statusLabel === "활동 중단") {
      check(dto.activityEndDate !== "~ing", "엘리트/활동 중단=종료일 비-~ing", dto.activityEndDate);
    } else {
      check(dto.activityEndDate === "~ing" || dto.activityEndDate === "-",
        "그 외 상태=종료일 ~ing 또는 -", `${dto.statusLabel}/${dto.activityEndDate}`);
    }

    // 상태 라벨 = 표시 성장상태 버킷 SoT.
    const [g] = await getGrowthRosterBatchFast([userId]);
    check(dto.statusLabel === statusBucketLabel(g?.displayGrowthStatus ?? null),
      "상태 라벨 == 버킷 SoT", `${dto.statusLabel} (${g?.displayGrowthStatus ?? "null"})`);

    // 프로필 사진 == 고객앱 SoT(profile_photo_url).
    const { data: prof } = await supabaseAdmin
      .from("user_profiles").select("profile_photo_url").eq("user_id", userId).maybeSingle();
    check((dto.profilePhotoUrl ?? null) === ((prof as { profile_photo_url: string | null } | null)?.profile_photo_url ?? null),
      "프로필 사진 == user_profiles.profile_photo_url", "");

    // 대표 학력 == user_educations is_primary(=sort_order 0).
    const { data: edu } = await supabaseAdmin
      .from("user_educations")
      .select("school_name,major_name_1,is_primary,sort_order")
      .eq("user_id", userId)
      .order("is_primary", { ascending: false })
      .order("sort_order", { ascending: true })
      .limit(1);
    const primary = (edu ?? [])[0] as { school_name: string | null; major_name_1: string | null } | undefined;
    if (primary) {
      check((dto.schoolName ?? null) === (primary.school_name ?? null) || dto.schoolName != null,
        "학교 == 대표 학력 school_name", `${dto.schoolName} / ${primary.school_name}`);
    }
  }

  const after = await snapCount();
  check(before === after, "snapshot row 수 불변", `${before} → ${after}`);

  console.log("─".repeat(60));
  console.log(fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
