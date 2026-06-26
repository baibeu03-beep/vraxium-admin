// 팀장 이름 매칭 단일 SoT — 반드시 (이름 AND organization_slug) 둘 다 일치하는
// operating 크루만 자동 연결한다. 이름만으로는 절대 매칭하지 않는다.
//
// 정책(2026-06-26 확정):
//   · 같은 조직 안에서 이름 1명  → link(자동 연결).
//   · 같은 조직 안에서 동명이인 ≥2 → ambiguous(자동 연결 금지, 보고).
//   · 해당 조직에 이름 없음     → none(leader_name 만 표시, 나머지 "-").
//   · test 계정(test_user_markers)은 제외(operating). 다른 조직의 동명은 절대 가져오지 않음.
//
// 조직 강제: 후보 조회를 organization_slug 로 DB 레벨에서 1차 필터한 뒤, 이름 정규화 비교한다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveUserScope } from "@/lib/userScope";
import type { OrganizationSlug } from "@/lib/organizations";

export type LeaderMatch =
  | { status: "link"; userId: string }
  | { status: "none" }
  | { status: "ambiguous"; userIds: string[] };

// 이름 비교 정규화 — 공백 제거(앞/뒤/중간). 동일 이름 판정의 단일 규칙.
export function normalizeLeaderName(name: string | null | undefined): string {
  return (name ?? "").replace(/\s+/g, "").trim();
}

// (org, name) → 그 조직의 operating 크루 중 동일 이름 후보.
//   organization 은 항상 필수. 비거나 이름이 비면 none.
export async function matchOperatingLeaderByOrgName(
  organization: OrganizationSlug,
  leaderName: string | null | undefined,
): Promise<LeaderMatch> {
  const name = normalizeLeaderName(leaderName);
  if (!organization || !name) return { status: "none" };

  // 1) 해당 조직 프로필만 DB 레벨에서 조회(조직 강제).
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name")
    .eq("organization_slug", organization);
  if (error) throw new Error(error.message);

  // 2) test 계정 제외(operating).
  const scope = await resolveUserScope("operating", organization);

  const candidates = ((data ?? []) as Array<{ user_id: string; display_name: string | null }>)
    .filter((p) => normalizeLeaderName(p.display_name) === name)
    .filter((p) => scope.includes(p.user_id))
    .map((p) => p.user_id);

  if (candidates.length === 0) return { status: "none" };
  if (candidates.length === 1) return { status: "link", userId: candidates[0] };
  return { status: "ambiguous", userIds: candidates };
}
