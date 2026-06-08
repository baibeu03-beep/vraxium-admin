/**
 * 2025-summer W5~W8 result_published_at 복구 (데이터 오류 정정 — 계산식 변경 없음).
 *
 * 근거:
 *   - 의도(claudedocs/summer-weeks-move-w5-8-20260607.md): W5~W8 = 졸업 인정 주차,
 *     a=30 유지. 이동 스크립트는 result_published_at = start+7d 로 "선세팅" 생성(00:30 UTC).
 *   - 회귀: 06-07 01:03 UTC 별도 작업이 W5~8 을 update(pub→NULL)·W1~4 재생성(pub=NULL)
 *     → success 가 read-time 에 tallying 강등 → 표시 a 30→26.
 *   - 본 스크립트는 이동 스크립트와 동일 산식(start+7d)으로 publish 원값만 복원하고
 *     영향 사용자 snapshot 을 재계산한다. uws/points/profiles 무접촉.
 *
 * 안전장치: 영향 사용자 전원이 테스터(test_user_markers)가 아니면 중단.
 * 롤백: 출력되는 SQL (result_published_at=NULL 원복) + snapshot 재계산.
 *
 * Usage: npx tsx --env-file=.env.local scripts/fix-summer-w5-8-publish-restore.ts [--apply]
 *   (기본 dry-run — --apply 없으면 write 0건)
 */
import { supabaseAdmin } from "../lib/supabaseAdmin";
import { getGrowthIndicatorsInternal } from "../lib/cluster3GrowthData";
import { recomputeAndStoreWeeklyCardsSnapshot } from "../lib/cluster4WeeklyCardsSnapshot";

const APPLY = process.argv.includes("--apply");
const SEASON_KEY = "2025-summer";
const TARGET_STARTS = ["2025-07-28", "2025-08-04", "2025-08-11", "2025-08-18"]; // W5~W8

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

let pass = 0,
  fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function snapSummerCards(uid: string) {
  const { data } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("cards,computed_at,is_stale")
    .eq("user_id", uid)
    .maybeSingle();
  const cards = ((data as { cards?: Array<Record<string, unknown>> } | null)?.cards ?? []).filter(
    (c) => c.seasonKey === SEASON_KEY,
  );
  return {
    statuses: cards.map((c) => `W${c.weekNumber}:${c.userWeekStatus}`).sort().join(" "),
    computedAt: (data as { computed_at?: string } | null)?.computed_at ?? null,
  };
}

async function main() {
  console.log(`mode=${APPLY ? "APPLY" : "dry-run"}`);

  // ── 0. 대상 weeks 행 확인 ────────────────────────────────────────────
  const { data: weekRows, error: wErr } = await supabaseAdmin
    .from("weeks")
    .select("id,week_number,start_date,season_key,result_published_at")
    .eq("season_key", SEASON_KEY)
    .in("start_date", TARGET_STARTS)
    .order("start_date");
  if (wErr) throw new Error(wErr.message);
  const weeks = (weekRows ?? []) as Array<{
    id: string;
    week_number: number | null;
    start_date: string;
    result_published_at: string | null;
  }>;
  console.log("\n=== 0) 대상 weeks (W5~W8) ===");
  for (const w of weeks) {
    console.log(`  W${w.week_number} ${w.start_date} pub=${w.result_published_at} → ${addDaysIso(w.start_date, 7)}T00:00:00+00:00`);
  }
  if (weeks.length !== 4) throw new Error(`대상 4행이 아님: ${weeks.length} — 중단`);
  if (weeks.some((w) => w.result_published_at !== null)) {
    console.log("  ! 일부 행이 이미 published — 멱등 진행(NULL 행만 복구)");
  }

  // ── 1. 영향 사용자 식별 + 전원 테스터 가드 ──────────────────────────
  const { data: uwsRows } = await supabaseAdmin
    .from("user_week_statuses")
    .select("user_id,week_start_date,status")
    .eq("season_key", SEASON_KEY);
  const userIds = [...new Set(((uwsRows ?? []) as Array<{ user_id: string }>).map((r) => r.user_id))];
  const { data: markers } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const testerIds = new Set(((markers ?? []) as Array<{ user_id: string }>).map((m) => m.user_id));
  const nonTesters = userIds.filter((u) => !testerIds.has(u));
  console.log(`\n=== 1) 영향 사용자: ${userIds.length}명 (2025-summer uws 보유) — 비테스터 ${nonTesters.length}명 ===`);
  if (nonTesters.length > 0) throw new Error(`실사용자 포함 — 중단: ${nonTesters.join(",")}`);
  const { data: profs } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,organization_slug,growth_status")
    .in("user_id", userIds);
  const nameOf = new Map(
    ((profs ?? []) as Array<{ user_id: string; display_name: string | null }>).map((p) => [p.user_id, p.display_name]),
  );

  // ── 2. BEFORE 캡처 ──────────────────────────────────────────────────
  console.log("\n=== 2) BEFORE (direct a · display · snapshot 여름 카드) ===");
  const before = new Map<string, { a: number; display: string; snap: string }>();
  for (const uid of userIds) {
    const g = await getGrowthIndicatorsInternal(uid);
    const s = await snapSummerCards(uid);
    before.set(uid, { a: g.period.a, display: g.process.growthDisplayKey, snap: s.statuses });
    console.log(`  ${nameOf.get(uid)}: a=${g.period.a} display=${g.process.growthDisplayKey} | snap[${s.statuses}]`);
  }
  // 실사용자 회귀 기준점 (이유나)
  const REAL = "247021bc-374b-48f4-8d49-b181d149ee33";
  const realBefore = await getGrowthIndicatorsInternal(REAL);
  console.log(`  [회귀기준] 이유나: a=${realBefore.period.a} display=${realBefore.process.growthDisplayKey}`);

  if (!APPLY) {
    console.log("\n(dry-run 종료 — write 0건. --apply 로 실행)");
    return;
  }

  // ── 3. WRITE: publish 원값 복원 (이동 스크립트와 동일 산식 start+7d) ──
  console.log("\n=== 3) result_published_at 복원 ===");
  for (const w of weeks) {
    if (w.result_published_at !== null) {
      console.log(`  skip W${w.week_number} (이미 published)`);
      continue;
    }
    const pub = `${addDaysIso(w.start_date, 7)}T00:00:00+00:00`;
    const { error } = await supabaseAdmin
      .from("weeks")
      .update({ result_published_at: pub })
      .eq("id", w.id);
    if (error) throw new Error(`update 실패 W${w.week_number}: ${error.message}`);
    console.log(`  ✓ W${w.week_number} ${w.start_date} → pub=${pub}`);
  }

  // ── 4. snapshot 재계산 (영향 사용자만 — weeks 변경은 자동 무효화 안 됨) ──
  console.log("\n=== 4) snapshot 재계산 ===");
  for (const uid of userIds) {
    await recomputeAndStoreWeeklyCardsSnapshot(uid);
    console.log(`  ✓ ${nameOf.get(uid)}`);
  }

  // ── 5. AFTER 검증 ───────────────────────────────────────────────────
  console.log("\n=== 5) AFTER ===");
  for (const uid of userIds) {
    const g = await getGrowthIndicatorsInternal(uid);
    const s = await snapSummerCards(uid);
    const b = before.get(uid)!;
    console.log(`  ${nameOf.get(uid)}: a=${b.a}→${g.period.a} display=${b.display}→${g.process.growthDisplayKey} | snap[${s.statuses}]`);
    check(`${nameOf.get(uid)}: a +4 (${b.a}→${b.a + 4})`, g.period.a === b.a + 4, `실제=${g.period.a}`);
    check(`${nameOf.get(uid)}: display 불변(${b.display})`, g.process.growthDisplayKey === b.display, `실제=${g.process.growthDisplayKey}`);
    check(`${nameOf.get(uid)}: 여름 카드 4장 전부 success`, s.statuses === "W5:success W6:success W7:success W8:success", s.statuses);
  }
  const realAfter = await getGrowthIndicatorsInternal(REAL);
  check("실사용자(이유나) 불변", realAfter.period.a === realBefore.period.a && realAfter.process.growthDisplayKey === realBefore.process.growthDisplayKey,
    `a=${realBefore.period.a}→${realAfter.period.a}`);

  console.log("\n롤백 SQL:");
  console.log(`  UPDATE public.weeks SET result_published_at = NULL WHERE season_key='${SEASON_KEY}' AND start_date IN ('${TARGET_STARTS.join("','")}');`);
  console.log("  + 영향 사용자 snapshot 재계산 (recomputeAndStoreWeeklyCardsSnapshot)");
  console.log(`\n결과: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}
void main();
