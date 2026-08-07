/**
 * 팀장 승격/복귀 시 team/part 가 user_memberships(SoT) 를 통해 정확히 갱신되는지 실증 검증.
 *   원인: lib/adminMembersData.ts:applyMemberRolePosition 이 user_profiles.current_team_name/
 *   current_part_name 에 "직접" 썼다 — 이 두 컬럼은 DB 트리거(user_memberships_sync_current)가
 *   user_memberships(is_current=true) 에서 미러링하는 파생 컬럼(직접 수정 금지, 마이그레이션 주석
 *   db/migrations/2026-06-01_member_roles_uniqueness.sql). positionResolver 의 멤버십 폴백은 멤버십
 *   행을 profile 보다 우선 읽으므로, 팀장 승격 후 클래스만 바뀌고 팀·파트는 옛 값이 남았다.
 *
 * 대상: QA 테스트 크루(mode=test, test_user_markers) 1명만 사용 — 실사용자 미접촉.
 *   격리 위해 임시로 "다른 팀"으로 승격 → 검증 → 원래 상태로 복원(직접 DB 원복, 등록 API 미사용).
 *
 * 검증:
 *   A) user_memberships — 새 팀 is_current 행 1개, 옛 팀 행은 is_current=false
 *   B) user_profiles.current_team_name/current_part_name — 트리거로 새 팀 반영
 *   C) positionResolver.resolveCurrentPosition — teamName=새 팀, classLabel=운영진(팀장)
 *   D) lib/adminMembersData 목록 DTO(getMember) — 위와 동일 값
 *
 * Usage: npx tsx --env-file=.env.local scripts/verify-team-leader-position-sync.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { applyMemberRolePosition } from "@/lib/adminMembersData";
import { resolveCurrentPosition } from "@/lib/positionResolver";
import { getCrewDetailDto } from "@/lib/adminCrewDetailData";

let pass = 0;
let fail = 0;
const ck = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
};

async function main() {
  // ── 대상 선정: mode=test 크루 중 user_memberships is_current 행이 있는 1명 ──
  const { data: markers } = await supabaseAdmin
    .from("test_user_markers")
    .select("user_id")
    .limit(200);
  const testIds = new Set((markers ?? []).map((r: { user_id: string }) => r.user_id));
  if (testIds.size === 0) {
    console.log("QA 테스트 크루가 없음 — abort");
    process.exit(1);
  }
  const { data: candProfiles } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,role,organization_slug,current_team_name,current_part_name")
    .in("user_id", Array.from(testIds))
    .eq("role", "crew")
    .not("organization_slug", "is", null);
  const { data: candMems } = await supabaseAdmin
    .from("user_memberships")
    .select("id,user_id,team_name,part_name,membership_level,membership_state,is_current,updated_at")
    .in("user_id", (candProfiles ?? []).map((p: { user_id: string }) => p.user_id))
    .eq("is_current", true);
  const memByUser = new Map((candMems ?? []).map((m: any) => [m.user_id, m]));

  const target = (candProfiles ?? []).find((p: any) => {
    const m = memByUser.get(p.user_id);
    return m && m.team_name;
  }) as { user_id: string; display_name: string; organization_slug: string } | undefined;

  if (!target) {
    console.log("현재 팀 멤버십이 있는 QA 테스트 크루를 찾지 못함 — abort");
    process.exit(1);
  }
  const originalMembership = memByUser.get(target.user_id) as {
    id: string;
    team_name: string | null;
    part_name: string | null;
    membership_level: string | null;
    membership_state: string | null;
  };
  console.log(
    `대상: ${target.display_name}(${target.user_id}, ${target.organization_slug}) — 원래 팀: ${originalMembership.team_name} / ${originalMembership.part_name}`,
  );

  // 원복용 프로필 스냅샷.
  const { data: origProfileRow } = await supabaseAdmin
    .from("user_profiles")
    .select("role,current_team_name,current_part_name")
    .eq("user_id", target.user_id)
    .single();
  const origProfile = origProfileRow as { role: string; current_team_name: string | null; current_part_name: string | null };

  // "다른 팀" 이름 — 실제 팀 목록과 겹치지 않는 합성 팀명(동적, 하드코딩 아님).
  const newTeamName = `__verify-team-leader-sync-${Date.now().toString(36)}__`;

  try {
    // ── 승격 실행 ──
    await applyMemberRolePosition({
      userId: target.user_id,
      role: "team_leader",
      currentTeamName: newTeamName,
      currentPartName: null,
      reason: "verify-team-leader-position-sync",
    });

    // ── A) user_memberships ──
    const { data: memsAfter } = await supabaseAdmin
      .from("user_memberships")
      .select("id,team_name,part_name,is_current")
      .eq("user_id", target.user_id);
    const rows = (memsAfter ?? []) as Array<{ id: string; team_name: string | null; part_name: string | null; is_current: boolean }>;
    const newCurrent = rows.filter((r) => r.is_current);
    ck("user_memberships 현재 행 정확히 1개", newCurrent.length === 1, newCurrent);
    ck(
      `user_memberships 현재 행 팀=${newTeamName}, 파트=null`,
      newCurrent[0]?.team_name === newTeamName && newCurrent[0]?.part_name === null,
      newCurrent[0],
    );
    // 대상 크루는 원래 멤버십 행이 1개뿐이라 "은퇴 후 새 행 생성"이 아니라 "그 행을 재사용"이 정답
    //   구현이다(불필요한 행 증식 방지). 이미 위에서 현재 행이 정확히 1개·새 팀임을 확인했으므로,
    //   여기서는 그 현재 행이 원래 행과 같은 id 를 재사용했는지만 별도로 확인한다(증식 없음 확인).
    ck("멤버십 행 재사용(신규 행 증식 없음)", newCurrent[0]?.id === originalMembership.id, {
      before: originalMembership.id,
      after: newCurrent[0]?.id,
    });

    // ── B) user_profiles (트리거 미러링) ──
    const { data: profAfter } = await supabaseAdmin
      .from("user_profiles")
      .select("role,current_team_name,current_part_name")
      .eq("user_id", target.user_id)
      .single();
    const prof = profAfter as { role: string; current_team_name: string | null; current_part_name: string | null };
    ck("user_profiles.role=team_leader", prof.role === "team_leader", prof.role);
    ck(
      `user_profiles.current_team_name=${newTeamName}(트리거 미러링)`,
      prof.current_team_name === newTeamName,
      prof.current_team_name,
    );
    ck("user_profiles.current_part_name=null", prof.current_part_name === null, prof.current_part_name);

    // ── C) positionResolver (공용 SoT resolver) ──
    const resolved = await resolveCurrentPosition({ userId: target.user_id, organization: target.organization_slug });
    ck(`positionResolver.teamName=${newTeamName}`, resolved.teamName === newTeamName, resolved);
    ck("positionResolver.classLabel=운영진(팀장)", resolved.classLabel === "운영진(팀장)", resolved.classLabel);

    // ── D) /admin/members/[userId] 실제 DTO 조립 함수(getCrewDetailDto) ──
    const detailDto = await getCrewDetailDto(target.user_id, { generatedBy: null });
    ck(`getCrewDetailDto.teamName=${newTeamName}`, detailDto?.teamName === newTeamName, detailDto?.teamName);
    ck("getCrewDetailDto.classLabel=운영진(팀장)", detailDto?.classLabel === "운영진(팀장)", detailDto?.classLabel);

    console.log(`\n=== RESULT: PASS ${pass} / FAIL ${fail} ===`);

    // ── E) 강등(제약→비제약) 경로도 같은 함수로 실증 — applyMemberRolePosition 자체로 원복 ──
    //   원복은 곧 "team_leader → crew(원래 팀)" 강등이라, 승격과 반대 순서 보정이 필요한 경로다.
    await applyMemberRolePosition({
      userId: target.user_id,
      role: origProfile.role,
      currentTeamName: origProfile.current_team_name,
      currentPartName: origProfile.current_part_name,
      reason: "verify-team-leader-position-sync:restore",
    });
    const { data: viaFn } = await supabaseAdmin
      .from("user_profiles")
      .select("role,current_team_name,current_part_name")
      .eq("user_id", target.user_id)
      .single();
    ck(
      "E) applyMemberRolePosition 강등 경로로 원복 성공(재시도 없이 1회)",
      viaFn?.role === origProfile.role &&
        viaFn?.current_team_name === origProfile.current_team_name &&
        viaFn?.current_part_name === origProfile.current_part_name,
      viaFn,
    );
  } finally {
    // ── 안전망 — 위 E) 가 실패했을 경우를 대비한 raw 원복(재시도). 조용히 넘기지 않는다. ──
    let restored = false;
    for (let attempt = 1; attempt <= 3 && !restored; attempt++) {
      const { data: chk } = await supabaseAdmin
        .from("user_profiles")
        .select("role,current_team_name,current_part_name")
        .eq("user_id", target.user_id)
        .single();
      if (
        chk?.role === origProfile.role &&
        chk?.current_team_name === origProfile.current_team_name &&
        chk?.current_part_name === origProfile.current_part_name
      ) {
        restored = true;
        console.log(`원복 확인(시도 ${attempt}, 성공):`, chk);
        break;
      }
      const { error: memErr } = await supabaseAdmin
        .from("user_memberships")
        .update({
          team_name: originalMembership.team_name,
          part_name: originalMembership.part_name,
          is_current: true,
        })
        .eq("id", originalMembership.id);
      if (memErr) console.error(`원복 시도 ${attempt} — user_memberships update 실패:`, memErr.message);
      const { error: roleErr } = await supabaseAdmin
        .from("user_profiles")
        .update({ role: origProfile.role })
        .eq("user_id", target.user_id);
      if (roleErr) console.error(`원복 시도 ${attempt} — user_profiles role update 실패:`, roleErr.message);

      const { data: profRestored } = await supabaseAdmin
        .from("user_profiles")
        .select("role,current_team_name,current_part_name")
        .eq("user_id", target.user_id)
        .single();
      restored =
        profRestored?.role === origProfile.role &&
        profRestored?.current_team_name === origProfile.current_team_name &&
        profRestored?.current_part_name === origProfile.current_part_name;
      console.log(`원복 확인(시도 ${attempt}, ${restored ? "성공" : "재시도"}):`, profRestored);
    }
    if (!restored) {
      console.error(
        `⚠ 원복 실패 — 대상 user_id=${target.user_id} 를 수동으로 확인해주세요. 목표 상태:`,
        origProfile,
      );
      process.exitCode = 1;
    }
  }

  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
