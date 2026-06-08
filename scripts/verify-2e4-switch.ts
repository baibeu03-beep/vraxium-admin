/**
 * Phase 2E-4 검증: 메타 lookup·lineAvailability·detail 전환 등가성.
 *   npx tsx --env-file=.env.local scripts/verify-2e4-switch.ts
 * READ-ONLY.
 */
import { createClient } from "@supabase/supabase-js";
import {
  getCompetencyMetaByMasterIdsRegFirst,
  getExperienceCategorySlotByMasterIdRegFirst,
  getExperienceMetaByMasterIdsRegFirst,
  getExperienceSlotsByMasterIdsRegFirst,
} from "@/lib/lineRegistrationLookup";
import { fetchLegacyUnifiedMasterId, LEGACY_UNIFIED_LINE_NAME } from "@/lib/lineAvailability";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
}

async function count(table: string, filter?: (q: any) => any): Promise<number> {
  let q = sb.from(table).select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count: c, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return c ?? 0;
}

async function main() {
  const fpBefore = {
    snapTotal: await count("cluster4_weekly_card_snapshots"),
    snapStale: await count("cluster4_weekly_card_snapshots", (q) => q.eq("is_stale", true)),
    lines: await count("cluster4_lines"),
    targets: await count("cluster4_line_targets"),
  };

  // ── 1) experience 메타 26건 전수 등가 (batch + 단건) ──
  console.log("=== 1) experience 메타 등가 (전환 함수 vs 마스터 원본) ===");
  const { data: expMasters } = await sb
    .from("cluster4_experience_line_masters")
    .select("id,experience_category,experience_slot_order,line_name,organization_slug");
  const ids = (expMasters ?? []).map((m) => m.id as string);
  const regMeta = await getExperienceMetaByMasterIdsRegFirst(ids);
  let expDiff = 0;
  for (const m of expMasters ?? []) {
    const r = regMeta.get(m.id);
    if (
      !r ||
      r.category !== m.experience_category ||
      r.slotOrder !== m.experience_slot_order ||
      r.lineName !== m.line_name ||
      r.organizationSlug !== m.organization_slug
    ) {
      expDiff++;
      console.log("  !", m.line_name, JSON.stringify({ r, m }));
    }
  }
  check("exp batch 메타 26건 전수 diff 0", expDiff === 0, `diff=${expDiff}`);
  // 단건(고객 lines/detail 경로)
  let singleDiff = 0;
  for (const m of expMasters ?? []) {
    const s = await getExperienceCategorySlotByMasterIdRegFirst(m.id as string);
    if (s.category !== m.experience_category || s.slotOrder !== m.experience_slot_order) singleDiff++;
  }
  check("6) lines/detail 단건 메타 26건 전수 diff 0", singleDiff === 0, `diff=${singleDiff}`);
  // slot 맵 (lineAvailability 경로)
  const slots = await getExperienceSlotsByMasterIdsRegFirst(ids);
  let slotDiff = 0;
  for (const m of expMasters ?? []) {
    const expected = m.experience_slot_order as number | null;
    const actual = slots.get(m.id as string) ?? null;
    if ((expected ?? null) !== actual) slotDiff++;
  }
  check("5) lineAvailability slot 맵 26건 전수 diff 0", slotDiff === 0, `diff=${slotDiff}`);

  // ── 2) competency 메타 30건 전수 등가 ──
  console.log("\n=== 2) competency 메타 등가 ===");
  const { data: compMasters } = await sb
    .from("cluster4_competency_line_masters")
    .select("id,line_name,organization_slug");
  const compIds = (compMasters ?? []).map((m) => m.id as string);
  const compMeta = await getCompetencyMetaByMasterIdsRegFirst(compIds);
  let compDiff = 0;
  for (const m of compMasters ?? []) {
    const r = compMeta.get(m.id);
    if (!r || r.lineName !== m.line_name || r.organizationSlug !== m.organization_slug) compDiff++;
  }
  check("comp batch 메타 30건 전수 diff 0", compDiff === 0, `diff=${compDiff}`);

  // ── 3) 레거시 통합 마스터 id 등가 ──
  console.log("\n=== 3) legacy unified master id ===");
  const viaNew = await fetchLegacyUnifiedMasterId();
  const { data: legacyMaster } = await sb
    .from("cluster4_experience_line_masters")
    .select("id")
    .eq("line_name", LEGACY_UNIFIED_LINE_NAME)
    .limit(1)
    .maybeSingle();
  check(
    "fetchLegacyUnifiedMasterId(전환 후) = 마스터 직조 값",
    viaNew === (legacyMaster as { id: string } | null)?.id,
    `new=${viaNew}`,
  );

  // ── 4) fallback 게이트 — 미연결 가짜 id 는 마스터 fallback 으로도 미발견 → 빈/널 ──
  const fb = await getExperienceMetaByMasterIdsRegFirst(["00000000-0000-0000-0000-000000000000"]);
  check("fallback 게이트 — 미존재 id 미커버(빈 맵)", fb.size === 0);

  // ── 5) snapshot ──
  console.log("\n=== 5) snapshot ===");
  const fpAfter = {
    snapTotal: await count("cluster4_weekly_card_snapshots"),
    snapStale: await count("cluster4_weekly_card_snapshots", (q) => q.eq("is_stale", true)),
    lines: await count("cluster4_lines"),
    targets: await count("cluster4_line_targets"),
  };
  check(
    "7~8) snapshot stale 0·fingerprint 불변 (재계산 불필요)",
    JSON.stringify(fpBefore) === JSON.stringify(fpAfter) && fpAfter.snapStale === 0,
    JSON.stringify(fpAfter),
  );

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
