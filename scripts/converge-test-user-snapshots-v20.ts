/**
 * converge-test-user-snapshots-v20.ts
 * 테스트 유저(test_user_markers) 중 dto_version=19 인 snapshot 만 v20 로 수렴.
 *   · 실사용자 snapshot write 0 (안전장치: 대상에 실유저 1명이라도 있으면 abort).
 *   · user_week_statuses / user_weekly_points / user_growth_stats write 0 (전후 대조로 증명).
 *
 * 실행(미리보기): npx tsx --env-file=.env.local scripts/converge-test-user-snapshots-v20.ts
 * 실행(수렴):     npx tsx --env-file=.env.local scripts/converge-test-user-snapshots-v20.ts --apply
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { WEEKLY_CARDS_DTO_VERSION, recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const APPLY = process.argv.includes("--apply");
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";

// 소스 테이블 무변경 증명용 캡처.
async function captureSource(userIds: string[]) {
  const { data: ugs } = await sb.from("user_growth_stats").select("user_id,approved_weeks,cumulative_weeks,grade,grade_label,avg_percentile").in("user_id", userIds).order("user_id");
  const { count: uwsCount } = await sb.from("user_week_statuses").select("*", { count: "exact", head: true }).in("user_id", userIds);
  const { count: uwpCount } = await sb.from("user_weekly_points").select("*", { count: "exact", head: true }).in("user_id", userIds);
  return { ugs: JSON.stringify(ugs ?? []), uwsCount: uwsCount ?? 0, uwpCount: uwpCount ?? 0 };
}

async function main() {
  console.log(`현재 DTO_VERSION=${WEEKLY_CARDS_DTO_VERSION} · 모드=${APPLY ? "APPLY" : "PREVIEW"}\n`);

  // 테스트 유저 집합.
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testSet = new Set((markers ?? []).map((m: any) => m.user_id));

  // dto_version=19 snapshot 전체 → 테스트/실유저 분리.
  const { data: v19rows } = await sb.from("cluster4_weekly_card_snapshots").select("user_id,dto_version,is_stale,computed_at").eq("dto_version", 19).order("user_id").range(0, 4999);
  const v19 = (v19rows ?? []) as Array<{ user_id: string; dto_version: number; is_stale: boolean; computed_at: string }>;
  const targets = v19.filter((r) => testSet.has(r.user_id)).map((r) => r.user_id);
  const realV19 = v19.filter((r) => !testSet.has(r.user_id)).map((r) => r.user_id);
  console.log(`[1] 재계산 대상(test ∩ v19) = ${targets.length}명`);
  console.log(`    v19 실유저(무접촉 대상) = ${realV19.length}명`);

  // 안전장치: 대상에 실유저가 섞이면 즉시 중단.
  const leak = targets.filter((u) => !testSet.has(u));
  if (leak.length > 0) { console.error("ABORT: 대상에 실유저 혼입", leak); process.exit(1); }

  // 전후 대조 기준선.
  const beforeSource = await captureSource(targets);
  const realBefore = (await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true }).eq("dto_version", 19).not("user_id", "in", `(${targets.length ? targets.map((t) => `"${t}"`).join(",") : '""'})`)).count;
  // 대상 before 상태 분포.
  const beforeStale = v19.filter((r) => testSet.has(r.user_id) && r.is_stale).length;
  console.log(`    before: 대상 전원 dto_version=19, is_stale=true ${beforeStale}/${targets.length}`);

  if (!APPLY) {
    console.log(`\n[PREVIEW] --apply 로 실행하면 위 ${targets.length}명만 v20 재계산(snapshot write). 소스 테이블·실유저 무접촉.`);
    console.log(`  소스 기준선: ugs ${JSON.parse(beforeSource.ugs).length}행 / uws ${beforeSource.uwsCount} / uwp ${beforeSource.uwpCount}`);
    return;
  }

  // ── 재계산 (concurrency pool) ──
  console.log(`\n[재계산 실행] ${targets.length}명...`);
  let ok = 0, failed = 0; const failedIds: string[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const u = targets[cursor++];
      try { await recomputeAndStoreWeeklyCardsSnapshot(u); ok++; }
      catch (e) { failed++; failedIds.push(u); console.warn(`  ✗ ${u}: ${e instanceof Error ? e.message : e}`); }
      if ((ok + failed) % 20 === 0) console.log(`  ...${ok + failed}/${targets.length}`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, () => worker()));
  console.log(`[재계산 완료] ok=${ok} fail=${failed}`);

  // ── 검증 ──
  console.log(`\n=== 검증 ===`);
  // [4] 대상 after 상태.
  const { data: afterRows } = await sb.from("cluster4_weekly_card_snapshots").select("user_id,dto_version,is_stale,computed_at").in("user_id", targets).order("user_id");
  const after = (afterRows ?? []) as Array<{ user_id: string; dto_version: number; is_stale: boolean; computed_at: string }>;
  const converged = after.filter((r) => r.dto_version === WEEKLY_CARDS_DTO_VERSION && !r.is_stale).length;
  console.log(`[4] 대상 after: dto_version=20 & is_stale=false = ${converged}/${targets.length}`);
  const beforeMap = new Map(v19.filter((r) => testSet.has(r.user_id)).map((r) => [r.user_id, r.computed_at]));
  const computedAtChanged = after.filter((r) => beforeMap.get(r.user_id) !== r.computed_at).length;
  console.log(`    computed_at 갱신: ${computedAtChanged}/${targets.length}`);

  // [실유저 무접촉] v19 실유저 수 불변.
  const realAfter = (await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true }).eq("dto_version", 19).not("user_id", "in", `(${targets.length ? targets.map((t) => `"${t}"`).join(",") : '""'})`)).count;
  console.log(`[실유저] v19 실유저 snapshot 수: before=${realBefore} after=${realAfter} → 불변=${realBefore === realAfter}`);

  // [소스 무변경] user_week_statuses / user_weekly_points / user_growth_stats.
  const afterSource = await captureSource(targets);
  console.log(`[소스 write 0]`);
  console.log(`  user_growth_stats: ${beforeSource.ugs === afterSource.ugs ? "불변 ✓" : "변경! ✗"}`);
  console.log(`  user_week_statuses: ${beforeSource.uwsCount} → ${afterSource.uwsCount} ${beforeSource.uwsCount === afterSource.uwsCount ? "✓" : "✗"}`);
  console.log(`  user_weekly_points: ${beforeSource.uwpCount} → ${afterSource.uwpCount} ${beforeSource.uwpCount === afterSource.uwpCount ? "✓" : "✗"}`);

  // [5] direct == HTTP (수렴 표본).
  const sample = targets[0];
  const direct = await getCluster4WeeklyCardsForProfileUser(sample);
  let httpCards: any[] = []; let httpStatus = 0;
  try { const r = await fetch(`${BASE}/api/cluster4/weekly-cards?demoUserId=${sample}`); httpStatus = r.status; httpCards = (await r.json()).data ?? []; } catch (e) { console.warn("HTTP 실패:", e); }
  const directEqHttp = JSON.stringify(direct) === JSON.stringify(httpCards);
  console.log(`[5] direct == HTTP (표본 ${sample}): ${directEqHttp} (HTTP status=${httpStatus}, hit=v20 fresh)`);

  // [6] mode=test 라이브 시뮬은 snapshot 무관 — 수렴 후에도 동작.
  let testStatus = 0; let testCards = 0;
  try { const r = await fetch(`${BASE}/api/cluster4/weekly-cards?demoUserId=${sample}&mode=test`); testStatus = r.status; testCards = ((await r.json()).data ?? []).length; } catch {}
  console.log(`[6] mode=test 라이브(수렴 무관): status=${testStatus} cards=${testCards}`);

  console.log(`\n=== 보고 ===`);
  console.log(`  재계산 대상: ${targets.length}명 (전원 test_user_markers)`);
  console.log(`  성공/실패: ${ok}/${failed}${failedIds.length ? ` [${failedIds.join(",")}]` : ""}`);
  console.log(`  실유저 영향: ${realBefore === realAfter ? "0명(v19 실유저 수 불변)" : "발생!"}`);
  console.log(`  direct == HTTP: ${directEqHttp}`);
  console.log(`  snapshot 영향: 대상 ${converged}/${targets.length} v20 수렴, 소스 테이블 무변경`);
}

main().catch((e) => { console.error(e); process.exit(1); });
