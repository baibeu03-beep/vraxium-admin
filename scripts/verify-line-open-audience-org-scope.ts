// 검증: 라인 개설/취소의 org audience(분모 A stale 대상) 산정이 조직 격리를 지키는가.
//
//   npx tsx --env-file=.env.local scripts/verify-line-open-audience-org-scope.ts
//
// 배경(2026-07-28 실측 버그): loadLineOrgPopulation 이 스냅샷 보유자 전원(730명)을 단일
//   .in("user_id", [...730 UUID]) 로 조회했다. URL 27KB → PostgREST 가 매번 400 Bad Request 를
//   돌려주는데 error 를 읽지 않아 조용히 삼켜졌다 → orgByUser 가 항상 빈 맵 → 모든 사용자 org 가
//   null 로 해석되고(=항상 노출) **audience 가 전원**이 되었다. 조직 격리가 무력화된 상태.
//
// 이 스크립트는 청크 조회 수정 후 다음을 검증한다:
//   ① 모집단 org 맵이 실제로 채워진다(빈 맵이면 즉시 실패 — 회귀 재발 감지).
//   ② org 소유 라인(line_code 토큰이 특정 org)의 audience 에 **타 org 확정 사용자**가 없다.
//   ③ audience 판정이 고객 weekly-cards Step 2 노출 필터(isLineVisibleForUserOrg)와 일치한다
//      — 즉 "audience 에서 빠진 사용자 = 그 라인이 애초에 보이지 않는 사용자"임을 전수 대조한다.
//      (그래서 stale 대상이 줄어도 카드 내용은 달라질 수 없다.)
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { collectLineOrgAudience } from "@/lib/adminCluster4LinesData";
import { resolveLineScope, isLineScopeVisibleForOrg } from "@/lib/lineScope";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import { IN_FILTER_ID_CHUNK } from "@/lib/supabaseInChunk";

let failures = 0;
const fail = (m: string) => {
  failures++;
  console.error("  ✗", m);
};
const ok = (m: string) => console.log("  ✓", m);

async function loadPopulation() {
  const { data: snaps } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id");
  const userIds = Array.from(
    new Set(((snaps ?? []) as { user_id: string }[]).map((r) => r.user_id).filter(Boolean)),
  );
  const orgByUser = new Map<string, OrganizationSlug | null>();
  for (let i = 0; i < userIds.length; i += IN_FILTER_ID_CHUNK) {
    const chunk = userIds.slice(i, i + IN_FILTER_ID_CHUNK);
    const { data, error } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,organization_slug")
      .in("user_id", chunk);
    if (error) throw new Error(`user_profiles chunk failed: ${error.message}`);
    for (const p of (data ?? []) as Array<{ user_id: string; organization_slug: string | null }>) {
      orgByUser.set(p.user_id, isOrganizationSlug(p.organization_slug) ? p.organization_slug : null);
    }
  }
  return { userIds, orgByUser };
}

async function main() {
  console.log("=== ① 모집단 org 맵이 채워지는가 (회귀: 400 Bad Request 무음 실패) ===");
  const { userIds, orgByUser } = await loadPopulation();
  const resolvedCount = [...orgByUser.values()].filter((v) => v !== null).length;
  console.log(`  snapshot 보유자 ${userIds.length}명 · org 해석 ${orgByUser.size}건 (비null ${resolvedCount})`);
  if (userIds.length === 0) {
    console.log("  (스냅샷 0건 — 검증 스킵)");
    return;
  }
  if (orgByUser.size === 0) fail("org 맵이 비어 있다 — 청크 조회가 실패했거나 회귀했다");
  else ok("org 맵이 채워졌다");
  if (resolvedCount === 0) fail("모든 사용자 org 가 null — 조직 격리가 동작할 수 없다");
  else ok(`org 확정 사용자 ${resolvedCount}명`);

  console.log("\n=== ②③ org 소유 라인별 audience 대조 ===");
  const { data: lines } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,part_type,line_code,experience_line_master_id,competency_line_master_id,career_project_id")
    .eq("is_active", true)
    .limit(40);

  let checked = 0;
  for (const row of (lines ?? []) as Array<Record<string, string | null>>) {
    const scope = await resolveLineScope(row as never);
    // career / 판정불가는 audience 없음이 정책 — 대조 대상에서 제외.
    if (row.part_type === "career" || scope.unknown) continue;

    const audience = new Set(await collectLineOrgAudience(String(row.id)));
    // 기대 집합 = 고객 weekly-cards Step 2 노출 필터와 동일 판정.
    const expected = new Set(
      userIds.filter((uid) => isLineScopeVisibleForOrg(scope, orgByUser.get(uid) ?? null)),
    );

    const extra = [...audience].filter((u) => !expected.has(u));
    const missing = [...expected].filter((u) => !audience.has(u));
    const label = `${row.part_type}/${String(row.id).slice(0, 8)} lineOrg=${scope.org ?? "null"}`;
    if (extra.length > 0 || missing.length > 0) {
      fail(`${label}: audience 불일치 (초과 ${extra.length} · 누락 ${missing.length})`);
    } else {
      // 타 org 확정 사용자가 섞였는지 별도 확인(② — lineOrg 가 특정 조직일 때만 의미 있음).
      if (scope.org && scope.org !== "common") {
        const foreign = [...audience].filter((u) => {
          const o = orgByUser.get(u) ?? null;
          return o !== null && o !== scope.org;
        });
        if (foreign.length > 0) {
          fail(`${label}: 타 org 확정 사용자 ${foreign.length}명이 audience 에 포함됐다`);
        } else {
          ok(`${label}: audience ${audience.size}명 — 타 org 0명, Step2 필터와 일치`);
        }
      } else {
        ok(`${label}: audience ${audience.size}명 — Step2 필터와 일치(common)`);
      }
    }
    checked++;
    if (checked >= 12) break;
  }
  if (checked === 0) console.log("  (활성 라인 없음 — 대조 스킵)");

  console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
