/**
 * converge-experience-snapshots.ts
 * 실무경험 신규 라인 "고객 앱 미반영" 수렴 진단/수렴.
 *
 *   1차(인자 없음)  = READ-ONLY. 상태 + 레거시 게이트 증명 + 실사용자 영향. write 0.
 *   2차(--apply)    = 영향 테스트 유저 snapshot 재계산(recomputeAndStore) + direct==HTTP 검증.
 *
 * 실행: npx tsx --env-file=.env.local scripts/converge-experience-snapshots.ts [--apply]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  WEEKLY_CARDS_DTO_VERSION,
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const APPLY = process.argv.includes("--apply");
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";

function expCardLines(card: any): Array<{ lineCode: string | null; lineName: string | null; status: string }> {
  return (card?.lines ?? []).filter((l: any) => l.partType === "experience").map((l: any) => ({ lineCode: l.lineCode ?? null, lineName: l.lineName ?? null, status: l.enhancementStatus }));
}

async function main() {
  console.log(`현재 WEEKLY_CARDS_DTO_VERSION=${WEEKLY_CARDS_DTO_VERSION} · 레거시 경계=${CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM}`);
  console.log(`모드: ${APPLY ? "APPLY(재계산 write)" : "READ-ONLY"}\n`);

  // ── 영향 개설: 최근 opened 팀총괄(실무경험) ──
  const { data: header } = await sb.from("cluster4_experience_team_overall").select("id,organization_slug,week_id,team_id,opened_at").eq("status", "opened").order("opened_at", { ascending: false }).limit(1).maybeSingle();
  if (!header) { console.log("opened 팀총괄 없음"); return; }
  const h = header as any;
  const week = (await sb.from("weeks").select("week_number,start_date,season_key").eq("id", h.week_id).maybeSingle()).data as any;
  const teamName = (await sb.from("cluster4_teams").select("team_name").eq("id", h.team_id).maybeSingle()).data?.team_name ?? "?";
  const isLegacy = week?.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM;
  console.log(`개설: ${h.organization_slug}/${teamName} ${week?.season_key} W${week?.week_number} ${week?.start_date} (weekId=${h.week_id})`);
  console.log(`  → start_date ${week?.start_date} ${isLegacy ? "<" : ">="} ${CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM} ⇒ ${isLegacy ? "레거시 주차(통합 라인만 렌더)" : "신정책 주차(허브/라인 렌더)"}\n`);

  // ── 영향 라인/유저 ──
  const { data: oLines } = await sb.from("cluster4_experience_team_overall_opened_lines").select("line_id").eq("overall_id", h.id);
  const lineIds = (oLines ?? []).map((r: any) => r.line_id);
  const { data: lineRows } = await sb.from("cluster4_lines").select("id,line_code,main_title").in("id", lineIds.length ? lineIds : ["x"]);
  const newCodes = new Set((lineRows ?? []).map((l: any) => l.line_code));
  const { data: tgtRows } = await sb.from("cluster4_line_targets").select("target_user_id").in("line_id", lineIds.length ? lineIds : ["x"]);
  const users = Array.from(new Set((tgtRows ?? []).map((t: any) => t.target_user_id)));
  const { data: markers } = await sb.from("test_user_markers").select("user_id").in("user_id", users);
  const testSet = new Set((markers ?? []).map((m: any) => m.user_id));
  const realUsers = users.filter((u) => !testSet.has(u));
  console.log(`[2] 신규 라인 ${lineIds.length}개 codes=${Array.from(newCodes).join(",")}`);
  console.log(`    영향 unique 유저 ${users.length} (테스트 ${testSet.size} / 실유저 ${realUsers.length})`);
  if (realUsers.length) console.log(`    ⚠ 실유저: ${realUsers.join(",")}`);

  // ── [1] snapshot 상태(영향 유저) ──
  const sel = "user_id,dto_version,is_stale,computed_at,card_count";
  const { data: snaps } = await sb.from("cluster4_weekly_card_snapshots").select(sel).in("user_id", users);
  const snapBy = new Map((snaps ?? []).map((s: any) => [s.user_id, s]));
  console.log(`\n[1] 영향 유저 snapshot 상태:`);
  const verCount = new Map<number, number>();
  for (const u of users) {
    const s = snapBy.get(u);
    const v = s?.dto_version ?? -1;
    verCount.set(v, (verCount.get(v) ?? 0) + 1);
  }
  for (const [v, n] of verCount) console.log(`    dto_version=${v}: ${n}명 (현재=${WEEKLY_CARDS_DTO_VERSION})`);
  const sample = snapBy.get(users[0]);
  console.log(`    표본 ${users[0]}: dto_version=${sample?.dto_version} is_stale=${sample?.is_stale} computed_at=${sample?.computed_at}`);

  // ── [read 분류] version_mismatch 게이트 확인 ──
  const outcome = await readWeeklyCardsSnapshot(users[0]);
  console.log(`\n[read 경로] readWeeklyCardsSnapshot(표본) → status=${outcome.status}${(outcome as any).reason ? `/${(outcome as any).reason}` : ""}`);
  console.log(`    ⇒ version_mismatch 면 라우트가 lazy 재계산 안 함(구 카드 노출) — 신규 라인 미반영 원인.`);

  // ── [레거시 게이트 증명] 현재 v20 compute(미저장) 의 개설주차 experience 라인 ──
  console.log(`\n[레거시 게이트] 표본 유저 v${WEEKLY_CARDS_DTO_VERSION} 재계산(미저장) — 개설주차(${week?.season_key} W${week?.week_number}) experience 라인:`);
  const computedNow = await getCluster4WeeklyCardsForProfileUser(users[0]);
  const wkCardNow = computedNow.find((c: any) => c.weekId === h.week_id);
  const expNow = expCardLines(wkCardNow);
  console.log(`    ${JSON.stringify(expNow)}`);
  const hasNewCode = expNow.some((l) => l.lineCode && newCodes.has(l.lineCode));
  console.log(`    신규 라인 코드(${Array.from(newCodes).join(",")}) 카드 포함? ${hasNewCode ? "예" : "아니오 ← 레거시 주차라 통합 라인만 렌더(재계산해도 동일)"}`);

  // ── 실사용자 영향(전역 dto_version 분포) ──
  console.log(`\n[실사용자 영향] 전역 snapshot dto_version 분포:`);
  const { data: allMarkers } = await sb.from("test_user_markers").select("user_id");
  const allTest = new Set((allMarkers ?? []).map((m: any) => m.user_id));
  for (const v of [WEEKLY_CARDS_DTO_VERSION, 19, 18]) {
    const { count } = await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true }).eq("dto_version", v);
    // 실유저만(테스트 제외) 별도 카운트는 비용↑ → 표본 생략, 전체 카운트로 규모만.
    console.log(`    dto_version=${v}: ${count ?? 0}행(테스트+실유저 합산)`);
  }
  const { count: staleCount } = await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true }).eq("is_stale", true);
  console.log(`    is_stale=true: ${staleCount ?? 0}행`);

  if (!APPLY) {
    console.log(`\n=== READ-ONLY 종료. 재계산하려면 --apply 로 재실행. ===`);
    console.log(`결론(예상): version_mismatch 로 lazy 미수렴 + 개설주차가 ${isLegacy ? "레거시(통합 라인만)" : "신정책"} 임.`);
    return;
  }

  // ── [3] 재계산(영향 테스트 유저만) ──
  console.log(`\n[3] 재계산 실행 (테스트 유저 ${testSet.size}명, 실유저 제외):`);
  const recomputeTargets = users.filter((u) => testSet.has(u));
  let okN = 0, failN = 0;
  for (const u of recomputeTargets) {
    try { await recomputeAndStoreWeeklyCardsSnapshot(u); okN++; }
    catch (e) { failN++; console.log(`    ✗ ${u}: ${e instanceof Error ? e.message : e}`); }
  }
  console.log(`    재계산 완료: ok=${okN} fail=${failN}`);

  // ── [4] 재계산 후 상태 + direct==HTTP ──
  const { data: snaps2 } = await sb.from("cluster4_weekly_card_snapshots").select(sel).in("user_id", recomputeTargets);
  const conv = (snaps2 ?? []).filter((s: any) => s.dto_version === WEEKLY_CARDS_DTO_VERSION && !s.is_stale).length;
  console.log(`\n[4] 재계산 후: dto_version=${WEEKLY_CARDS_DTO_VERSION} & is_stale=false 인 유저 = ${conv}/${recomputeTargets.length}`);

  // 표본 direct vs HTTP(internal key).
  const su = recomputeTargets[0];
  const direct = await getCluster4WeeklyCardsForProfileUser(su);
  let httpCards: any[] = [];
  let httpStatus = 0;
  try {
    const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${su}`, { headers: { "x-internal-api-key": INTERNAL_KEY } });
    httpStatus = res.status;
    const json = await res.json();
    httpCards = json.data ?? [];
  } catch (e) { console.log("    HTTP 호출 실패:", e instanceof Error ? e.message : e); }
  const dWk = direct.find((c: any) => c.weekId === h.week_id);
  const hWk = httpCards.find((c: any) => c.weekId === h.week_id);
  console.log(`    표본 ${su}: HTTP status=${httpStatus}, direct cards=${direct.length} HTTP cards=${httpCards.length}`);
  console.log(`    개설주차 experience — direct: ${JSON.stringify(expCardLines(dWk))}`);
  console.log(`    개설주차 experience — HTTP  : ${JSON.stringify(expCardLines(hWk))}`);
  const parity = JSON.stringify(expCardLines(dWk)) === JSON.stringify(expCardLines(hWk));
  console.log(`    direct == HTTP (개설주차 experience): ${parity}`);
  const httpHasNew = expCardLines(hWk).some((l) => l.lineCode && newCodes.has(l.lineCode));
  console.log(`    HTTP 응답에 신규 라인 포함? ${httpHasNew ? "예" : "아니오 ← 레거시 주차라 통합 라인만(개설 주차를 여름 W1+ 로 해야 함)"}`);

  console.log(`\n=== 결론 ===`);
  console.log(`  · DB: 신규 라인/타깃 생성 정상.`);
  console.log(`  · snapshot: 재계산 전 dto_version<20(version_mismatch)+is_stale → lazy 미수렴. 재계산으로 v${WEEKLY_CARDS_DTO_VERSION} 수렴(${conv}/${recomputeTargets.length}).`);
  console.log(`  · HTTP/direct: 일치=${parity}. 단, 개설주차가 ${isLegacy ? "레거시라 통합 라인만 렌더 → 신규 라인 미노출" : "신정책이라 신규 라인 노출"}.`);
  console.log(`  · 실유저 영향: 이번 개설 타깃 실유저=${realUsers.length}명.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
