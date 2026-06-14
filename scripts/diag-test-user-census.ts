/**
 * diag-test-user-census.ts  (READ-ONLY — write 0)
 * test_user_markers 총원/org/dto_version 정합성 조사 (90 vs 83/8 불일치 추적).
 * 실행: npx tsx --env-file=.env.local scripts/diag-test-user-census.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  console.log(`현재 DTO_VERSION=${WEEKLY_CARDS_DTO_VERSION}\n`);

  // [1·2] test_user_markers 총 row / 고유 user_id.
  const { data: markers, count: markerCount } = await sb
    .from("test_user_markers")
    .select("user_id", { count: "exact" })
    .range(0, 4999);
  const markerRows = (markers ?? []) as Array<{ user_id: string }>;
  const ids = markerRows.map((m) => m.user_id);
  const uniq = Array.from(new Set(ids));
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  console.log(`[1] test_user_markers 총 row = ${markerCount ?? markerRows.length}`);
  console.log(`[2] 고유 user_id = ${uniq.length}${dupes.length ? ` (중복 ${dupes.length}: ${Array.from(new Set(dupes)).join(",")})` : " (중복 없음)"}`);

  // 프로필(org/role/growth_status).
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id,display_name,organization_slug,role,growth_status")
    .in("user_id", uniq);
  const profMap = new Map((profs ?? []).map((p: any) => [p.user_id, p]));
  const noProfile = uniq.filter((u) => !profMap.has(u));

  // [3] org별 배분.
  const byOrg = new Map<string, number>();
  for (const u of uniq) {
    const org = profMap.get(u)?.organization_slug ?? "(미배정/프로필없음)";
    byOrg.set(org, (byOrg.get(org) ?? 0) + 1);
  }
  console.log(`\n[3] org별 배분:`);
  for (const [org, n] of Array.from(byOrg.entries()).sort()) console.log(`    ${org}: ${n}`);

  // snapshot dto_version.
  const { data: snaps } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,dto_version,is_stale,computed_at")
    .in("user_id", uniq);
  const snapMap = new Map((snaps ?? []).map((s: any) => [s.user_id, s]));
  const noSnap = uniq.filter((u) => !snapMap.has(u));

  const verDist = new Map<string, number>();
  for (const u of uniq) {
    const v = snapMap.has(u) ? `v${snapMap.get(u).dto_version}` : "snapshot없음(miss)";
    verDist.set(v, (verDist.get(v) ?? 0) + 1);
  }
  console.log(`\n[4·6] 테스트 유저 dto_version 분포 (현재 = 수렴 후):`);
  for (const [v, n] of Array.from(verDist.entries()).sort()) console.log(`    ${v}: ${n}${v === `v${WEEKLY_CARDS_DTO_VERSION}` ? "  ← 현재" : ""}`);

  const v20 = uniq.filter((u) => snapMap.get(u)?.dto_version === WEEKLY_CARDS_DTO_VERSION).length;
  const v19 = uniq.filter((u) => snapMap.get(u)?.dto_version === 19).length;
  console.log(`\n[6] 수렴 후: 테스트 유저 총원=${uniq.length} / v20=${v20} / v19=${v19} / snapshot없음=${noSnap.length}`);

  // [5] 수렴 전 재구성: 수렴 작업은 v19 테스트 83명 → v20. 따라서 수렴 전 v20 = 현재 v20 - 83.
  console.log(`\n[5] 수렴 전(재구성): 수렴=83명(test∩v19)→v20. 수렴 전 v20=${v20 - 83}, v19=${v19 + 83}, 총원 동일=${uniq.length}`);

  // [7] 90 불일치 — 누락/이상 진단.
  console.log(`\n[7] 정합성 진단 (기대 90):`);
  console.log(`    고유 test_user_markers = ${uniq.length} → 90 대비 ${uniq.length - 90 >= 0 ? "+" : ""}${uniq.length - 90}`);
  if (noProfile.length) {
    console.log(`    ⚠ 프로필 없는 marker(${noProfile.length}): ${noProfile.join(", ")}`);
  } else console.log(`    프로필 없는 marker: 0`);
  if (noSnap.length) {
    console.log(`    snapshot 없는(miss) 테스트 유저(${noSnap.length}):`);
    for (const u of noSnap) {
      const p = profMap.get(u);
      console.log(`      ${u} | ${p?.display_name ?? "?"} | org=${p?.organization_slug ?? "-"} | role=${p?.role ?? "-"} | growth=${p?.growth_status ?? "-"}`);
    }
  } else console.log(`    snapshot 없는 테스트 유저: 0`);
  // suspended/org 미배정.
  const suspended = uniq.filter((u) => ["suspended", "paused"].includes(profMap.get(u)?.growth_status));
  const noOrg = uniq.filter((u) => profMap.has(u) && !profMap.get(u)?.organization_slug);
  console.log(`    suspended/paused: ${suspended.length}${suspended.length ? ` (${suspended.map((u) => profMap.get(u)?.display_name ?? u).join(",")})` : ""}`);
  console.log(`    org 미배정(프로필O·org없음): ${noOrg.length}${noOrg.length ? ` (${noOrg.join(",")})` : ""}`);

  // 합산 검산.
  console.log(`\n=== 검산 ===`);
  console.log(`    v20(${v20}) + v19(${v19}) + miss(${noSnap.length}) = ${v20 + v19 + noSnap.length} (= 고유 ${uniq.length})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
