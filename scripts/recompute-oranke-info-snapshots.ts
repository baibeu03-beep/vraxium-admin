/**
 * recompute-oranke-info-snapshots.ts
 * 06-22 실무정보(oranke) 재동기화로 변경된 라인 콘텐츠를 고객 weekly-cards snapshot 에 반영.
 *   audience = collectLineOrgAudience(OK 라인) ∪ 변경 라인 target user (앱의 라인변경 무효화 경로와 동일).
 *   recomputeWeeklyCardsSnapshotsForUsers = 조회와 동일한 getCluster4WeeklyCardsForProfileUser 로 계산·저장
 *     → snapshot == live 보장. 고객 프론트 코드 무수정. cluster4_line_targets 무접촉(read-only union).
 *
 * dry-run(기본): audience 만 산정·출력. --execute 시에만 재계산.
 *   npx tsx --env-file=.env.local scripts/recompute-oranke-info-snapshots.ts [--execute]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { resolveLineScopeFromValues, isLineScopeVisibleForOrg } from "@/lib/lineScope";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const execute = process.argv.includes("--execute");

async function main() {
  // 변경/영향 대상 = 현재 active oranke(OK) info 라인 전체(제목/링크 변경분 + 신규 insert 포함).
  const okLines: Array<{ id: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("cluster4_lines")
      .select("id,line_code")
      .eq("part_type", "info")
      .eq("is_active", true)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ id: string; line_code: string | null }>) {
      if (typeof r.line_code === "string" && /OK/.test(r.line_code)) okLines.push({ id: r.id });
    }
    if (!data || data.length < 1000) break;
  }

  // org audience = 고객 카드 경로(cluster4WeeklyCardsData)와 동일한 SoT(resolveLineScopeFromValues)로 산정.
  //   OK 라인 가시 org = oranke (+ null/미지정, allowUnknown:false 에서도 visible). encre/phalanx 는 미가시 → 제외.
  //   ⚠ collectLineOrgAudience 는 info 라인을 registration=common 으로 봐 725 전원 반환(과대) → 사용 안 함.
  const okScope = resolveLineScopeFromValues({ partType: "info", lineCode: "info-OK-wisdom-2025w46" });
  const snapUsers: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("user_id")
      .order("user_id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    snapUsers.push(...((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
    if (!data || data.length < 1000) break;
  }
  const orgByUser = new Map<string, string | null>();
  for (let i = 0; i < snapUsers.length; i += 200) {
    const slice = snapUsers.slice(i, i + 200);
    const { data } = await sb.from("user_profiles").select("user_id,organization_slug").in("user_id", slice);
    for (const r of (data ?? []) as Array<{ user_id: string; organization_slug: string | null }>) {
      orgByUser.set(r.user_id, r.organization_slug);
    }
  }
  const orgAudience = snapUsers.filter((u) =>
    isLineScopeVisibleForOrg(okScope, (orgByUser.get(u) as any) ?? null, { allowUnknown: false }),
  );

  // belt-and-suspenders: 변경 라인들의 target user 도 union(보통 audience 의 부분집합).
  const targetUserIds = new Set<string>();
  const lineIds = okLines.map((l) => l.id);
  for (let i = 0; i < lineIds.length; i += 100) {
    const slice = lineIds.slice(i, i + 100);
    const { data, error } = await sb
      .from("cluster4_line_targets")
      .select("target_user_id")
      .in("line_id", slice)
      .eq("target_mode", "user");
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ target_user_id: string | null }>) {
      if (r.target_user_id) targetUserIds.add(r.target_user_id);
    }
  }

  const audience = Array.from(new Set([...orgAudience, ...targetUserIds]));

  console.log(
    JSON.stringify(
      {
        mode: execute ? "execute" : "dry-run",
        okLines: okLines.length,
        orgAudienceCount: orgAudience.length,
        targetUserUnionCount: targetUserIds.size,
        finalAudienceCount: audience.length,
        sampleAudience: audience.slice(0, 5),
      },
      null,
      2,
    ),
  );

  if (!execute) return;

  const result = await recomputeWeeklyCardsSnapshotsForUsers(audience, { concurrency: 4 });
  console.log(JSON.stringify({ recomputeResult: result }, null, 2));
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
