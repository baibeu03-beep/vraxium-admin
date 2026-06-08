/**
 * 2E-4 카나리: weekly-cards DTO 를 live compute 로 캡처 (저장/스냅샷 변경 없음).
 *   npx tsx --env-file=.env.local scripts/canary-weekly-cards-dto.ts <before|after> [userId]
 * userId 미지정 시 snapshot 보유 사용자 3명(조직별 1명씩 가능하면)을 자동 선정.
 * 결과: claudedocs/canary-weekly-cards-<label>.json
 */
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const label = process.argv[2];
if (!label || !/^[a-z0-9-]+$/.test(label)) {
  console.error("usage: ... <label> [userId]");
  process.exit(1);
}
const explicitUser = process.argv[3];

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  let userIds: string[] = [];
  if (explicitUser) {
    userIds = [explicitUser];
  } else {
    // 조직 다양성 확보 — snapshot 보유자 중 org 별 1명씩.
    const { data: snaps } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("user_id")
      .order("user_id");
    const ids = ((snaps ?? []) as { user_id: string }[]).map((r) => r.user_id);
    const { data: profs } = await sb
      .from("user_profiles")
      .select("user_id,organization_slug")
      .in("user_id", ids);
    const byOrg = new Map<string, string>();
    for (const p of (profs ?? []) as { user_id: string; organization_slug: string | null }[]) {
      const org = p.organization_slug ?? "none";
      if (!byOrg.has(org)) byOrg.set(org, p.user_id);
    }
    userIds = [...byOrg.values()].slice(0, 3);
  }

  const out: Record<string, unknown> = {};
  for (const uid of userIds) {
    const dto = await getCluster4WeeklyCardsForProfileUser(uid);
    out[uid] = dto;
    console.log(`  ${uid}: cards=${dto.length}`);
  }
  const path = `claudedocs/canary-weekly-cards-${label}.json`;
  writeFileSync(path, JSON.stringify(out, null, 1), "utf8");
  console.log(`saved: ${path} (users=${userIds.length})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
