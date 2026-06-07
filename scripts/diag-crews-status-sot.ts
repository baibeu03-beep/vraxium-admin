/**
 * /crews(고객앱) 상태 체계 전수 점검 — read-only 진단.
 *   1) T윤도현 등 표본의 user_profiles.status / growth_status raw 값
 *   2) direct: getGrowthIndicatorsInternal → auto/override/display (SoT)
 *   3) 고객앱 /crews 필터 로직(raw growthStatus)·카드 statusLabel(raw status) 재현
 *   4) 세 값의 일치/불일치 매트릭스 + 전 조직 불일치 인원 집계
 * Usage: npx tsx --env-file=.env.local scripts/diag-crews-status-sot.ts
 */
import { supabaseAdmin } from "../lib/supabaseAdmin";
import { getGrowthIndicatorsInternal } from "../lib/cluster3GrowthData";
import { GROWTH_STATUS_LABELS } from "../shared/growth.contracts";

// 고객앱 /crews 카드 배지 로직 1:1 재현 (app/(host)/(main-layout)/crews/page.tsx:44-49)
const frontCardLabel = (status: string, growthStatus: string) => {
  if (status === "graduated") return "졸업";
  if (status === "suspended") return "활동 정지";
  if (growthStatus === "seasonal_rest") return "시즌 휴식";
  return "활동 중";
};

// 고객앱 /crews 필터 로직 1:1 재현 (page.tsx:214-226)
const frontFilterGroup = (growthStatus: string) => {
  if (growthStatus === "graduated") return "활동 졸업";
  if (growthStatus === "suspended") return "활동 중단";
  return "활동 중";
};

async function main() {
  // ── 1) 표본: T윤도현 ──────────────────────────────────────────
  const { data: target, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, display_name, status, growth_status, organization_slug")
    .eq("display_name", "T윤도현")
    .maybeSingle();
  if (error) throw new Error(error.message);

  if (!target) {
    console.log("✗ T윤도현 user_profiles row 없음");
  } else {
    console.log("=== 1) T윤도현 raw ===");
    console.log(target);

    console.log("\n=== 2) direct SoT (getGrowthIndicatorsInternal) ===");
    const ind = await getGrowthIndicatorsInternal(target.user_id);
    const p = ind?.process as Record<string, unknown> | undefined;
    console.log({
      growthStatusRaw: p?.growthStatus,
      autoGrowthStatusKey: p?.autoGrowthStatusKey,
      manualOverrideStatus: p?.manualOverrideStatus,
      growthDisplayKey: p?.growthDisplayKey,
      growthStatusDisplay: p?.growthStatusDisplay,
      overrideMismatch: p?.overrideMismatch,
    });

    console.log("\n=== 3) 고객앱 /crews 로직 재현 ===");
    const s = target.status ?? "-";
    const gs = target.growth_status ?? "-";
    console.log({
      필터_그룹: frontFilterGroup(gs),
      카드_배지: frontCardLabel(s, gs),
      불일치: frontFilterGroup(gs) !== frontCardLabel(s, gs) ? "YES ← 보고된 증상" : "no",
    });
  }

  // ── 4) 전 조직 집계: 필터그룹 vs 카드배지 불일치 인원 ─────────
  console.log("\n=== 4) 전 조직 불일치 집계 (raw 기준) ===");
  const { data: all, error: allErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, display_name, status, growth_status, organization_slug")
    .not("organization_slug", "is", null);
  if (allErr) throw new Error(allErr.message);

  const rows = (all ?? []) as Array<{
    user_id: string;
    display_name: string | null;
    status: string | null;
    growth_status: string | null;
    organization_slug: string | null;
  }>;

  const statusDist = new Map<string, number>();
  const gsDist = new Map<string, number>();
  const mismatches: Array<{ name: string; org: string; status: string; gs: string; filter: string; card: string }> = [];

  for (const r of rows) {
    const s = r.status ?? "(null)";
    const gs = r.growth_status ?? "(null)";
    statusDist.set(s, (statusDist.get(s) ?? 0) + 1);
    gsDist.set(gs, (gsDist.get(gs) ?? 0) + 1);
    const filter = frontFilterGroup(gs);
    const card = frontCardLabel(s, gs);
    // 그룹↔배지 의미 불일치만 수집 (졸업/활동정지 표기는 같은 의미로 간주)
    const cardGroup =
      card === "졸업" ? "활동 졸업" : card === "활동 정지" ? "활동 중단" : "활동 중";
    if (filter !== cardGroup) {
      mismatches.push({
        name: r.display_name ?? r.user_id,
        org: r.organization_slug ?? "-",
        status: s,
        gs,
        filter,
        card,
      });
    }
  }

  console.log("user_profiles.status 분포:", Object.fromEntries(statusDist));
  console.log("user_profiles.growth_status 분포:", Object.fromEntries(gsDist));
  console.log(`필터그룹 vs 카드배지 불일치: ${mismatches.length}명 / ${rows.length}명`);
  for (const m of mismatches.slice(0, 40)) {
    console.log(
      `  - ${m.name} (${m.org}) status=${m.status} growth_status=${m.gs} → 필터=[${m.filter}] 카드=[${m.card}]`,
    );
  }
  if (mismatches.length > 40) console.log(`  ... 외 ${mismatches.length - 40}명`);

  // ── 5) legacy growth_status 값 보유자 (override 3종 외) ───────
  const legacyVals = rows.filter(
    (r) =>
      r.growth_status !== null &&
      !["graduated", "suspended", "paused", "active"].includes(r.growth_status),
  );
  console.log(`\n=== 5) legacy growth_status 보유 (override 3종+active 외): ${legacyVals.length}명 ===`);
  const legacyDist = new Map<string, number>();
  for (const r of legacyVals) {
    legacyDist.set(r.growth_status!, (legacyDist.get(r.growth_status!) ?? 0) + 1);
  }
  console.log(Object.fromEntries(legacyDist));

  console.log("\n참고: display 라벨 맵 =", GROWTH_STATUS_LABELS);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
