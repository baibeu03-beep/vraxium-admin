/**
 * 2025-summer 합성 주차 이동: W1~W4 → W5~W8 (a=30 불변, 2026-06-07 지시).
 *
 *   npx tsx --env-file=.env.local scripts/apply-summer-weeks-move-to-w5-8.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/apply-summer-weeks-move-to-w5-8.ts --apply  # 실반영
 *
 * 배경: REDUCE-TO-4(06-06)가 8주 생성분의 꼬리(W5~8)를 잘라 W1~4 가 남았으나,
 *   테스터 6명의 연속 활동이 2025-09-01(가을)부터라 가을 직전에 붙는 W5~W8 이
 *   활동 이력상 자연스러움(2026-06-07 지시). 수치 불변: a=30 · graduated ·
 *   이력서 "4/8 정상 완료" 유지. activity_started_at 2025-06-30 → 2025-07-28 동반 정합.
 *
 * 처리(생성 설계 = apply-tester-summer-weeks.ts, 삭제 설계 = apply-summer-weeks-reduce-to-4.ts 재사용):
 *   0) 캘린더 규칙(W5~8 전부 running) + test_user_markers assert + 실사용자 지문 채취
 *   1) 안전 assert — W1~4 참조 데이터가 본 작업 산출물뿐인지 전수 확인:
 *      uws(6명 24행 외 0) · cluster4_lines(EXBS-UN 4행 외 0) · 타깃(6명 24 외 0) ·
 *      user_weekly_points(W1~4·W5~8 해당 iso 주차 전부 0행) · 프로필(6명 전원 graduated)
 *   2) W5~W8 생성: weeks(week_number 5~8, published 선세팅, check_threshold=0)
 *      + 통합 라인(v17 모형) + 타깃/더미 제출/평점 4~10 + uws success (6명 × 4주)
 *   3) W1~W4 삭제: 평가 → 제출 → 타깃 → 라인 → uws → weeks (id 화이트리스트, 참조 역순)
 *   4) user_profiles.activity_started_at → 2025-07-28 (growth_status=graduated 가드, 상태 무변경)
 *   5) recalcUserGrowthStats + weekly-cards snapshot 재계산 (6명)
 *   6) 실사용자 지문(전/후) diff=0
 *
 * 실사용자 보호: 실사용자 최소 uws=2026-05-04 ≫ 2025-08-18 (구조적 격리 동일),
 *   쓰기 직전 test_user_markers assert + 6명 고정 화이트리스트 + 삭제는 사전 조회 id 만.
 * 멱등: 생성은 존재 검사 후 삽입, 삭제는 0건 매치 시 무시 — 재실행 안전.
 * 원복 키: 로그 JSON (claudedocs/tester-summer-weeks-20260606.json) runs[] 의
 *   insertedWeeks/.../insertedUws(신규 W5~8) + removed(W1~4 원행) + profileBefore.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { LEGACY_UNIFIED_LINE_NAME } from "@/lib/lineAvailability";
import {
  getSeasonForDate,
  getSeasonWeekStatusForDate,
  seasonDbKey,
} from "@/lib/seasonCalendar";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ADMIN_ID = "c28b2409-4118-49fc-a42e-68e18dbd194c";
const MARKER = "tester-summer-weeks-20260606";
const LOG_PATH = "claudedocs/tester-summer-weeks-20260606.json";

const SEASON_KEY = "2025-summer";
// 삭제 대상(현행 합성분) — week_number 1~4
const OLD_STARTS = ["2025-06-30", "2025-07-07", "2025-07-14", "2025-07-21"] as const;
// 생성 대상 — week_number 5~8 (캘린더 규칙 실측: 전부 running, REDUCE 전 생성 이력으로 재검증됨)
const NEW_STARTS = ["2025-07-28", "2025-08-04", "2025-08-11", "2025-08-18"] as const;
const NEW_WEEK_NUMBER_BASE = 5;
const NEW_STARTED_AT = "2025-07-28"; // activity_started_at 정합값 (= 첫 활동 주차 W5)

const SIX = [
  ["T윤도현", "bf3b4305-751a-49e3-88ad-95a20e5c4dad"],
  ["T임다인", "42864260-e4ea-4150-a87f-cff545b02af1"],
  ["T장유준", "4a81b6d1-e488-4f14-8530-0cad60fe4f0d"],
  ["T윤태현", "05ff6b96-b3e7-4050-97f1-080633f183d3"],
  ["T임건우", "e4dcb97e-a515-4ec5-a91e-32ca4e629dae"],
  ["T장시현", "cc1b58e6-b14d-45a0-b389-2df3c27a0b25"],
] as const;
const SIX_IDS = new Set(SIX.map((s) => s[1]));

const APPLY = process.argv.includes("--apply");

// 결정적 PRNG (v17/생성 스크립트와 동일 — 제출문구/평점 재현성)
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const GROWTH_POINT_TEMPLATES = [
  "중앙 세션 참여 후 팀 단위 실무 과제를 진행했습니다. 주간 회고에서 개선점을 정리하고 다음 주 실행 계획을 세웠습니다.",
  "팀 정기 미팅에서 담당 파트 진행 상황을 공유하고, 중앙 활동 산출물을 정리해 기록했습니다.",
  "이번 주 클럽 중앙 활동과 팀 프로젝트 작업을 병행했습니다. 산출물 초안을 완성해 팀 내 피드백을 받았습니다.",
  "주간 목표에 맞춰 개인 실무 과제를 수행하고, 팀 활동 회의록과 결과물을 정리했습니다.",
  "중앙 프로그램 참석 및 팀 단위 협업 작업을 진행했습니다. 주요 논의 내용과 결정 사항을 기록으로 남겼습니다.",
  "팀 활동에서 맡은 역할을 수행하고, 한 주 동안의 진행 내역을 통합 기록으로 정리했습니다.",
  "클럽 중앙 일정에 참여하고 팀별 실무 작업을 이어갔습니다. 산출물과 회고를 함께 정리했습니다.",
  "주차 계획 대비 수행 내역을 점검하고, 중앙·팀 활동 결과를 통합 기록했습니다.",
] as const;

function weekOpensAtIso(startDate: string): string {
  const ms = Date.UTC(+startDate.slice(0, 4), +startDate.slice(5, 7) - 1, +startDate.slice(8, 10));
  return new Date(ms - 9 * 3_600_000).toISOString();
}
function weekClosesAtIso(startDate: string): string {
  const ms = Date.UTC(+startDate.slice(0, 4), +startDate.slice(5, 7) - 1, +startDate.slice(8, 10));
  return new Date(ms + 7 * 86_400_000 - 9 * 3_600_000 - 1000).toISOString();
}
function addDaysIso(startDate: string, days: number): string {
  const ms = Date.UTC(+startDate.slice(0, 4), +startDate.slice(5, 7) - 1, +startDate.slice(8, 10));
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}
function isoWeekOf(mondayIso: string): { isoYear: number; isoWeek: number } {
  const ms = Date.UTC(+mondayIso.slice(0, 4), +mondayIso.slice(5, 7) - 1, +mondayIso.slice(8, 10));
  const thursday = new Date(ms + 3 * 86_400_000);
  const isoYear = thursday.getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const isoWeek = Math.floor((thursday.getTime() - jan1) / 86_400_000 / 7) + 1;
  return { isoYear, isoWeek };
}

async function pageAll<T>(
  table: string,
  select: string,
  filter?: (q: any) => any,
  orderCol = "id",
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(select).order(orderCol, { ascending: true }).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// 실사용자 지문 — 대상 외 전원의 uws/프로필/포인트/스냅샷 해시 (기존 스크립트와 동일 식)
async function realUserFingerprint(excludeIds: Set<string>): Promise<{ hash: string; counts: Record<string, number> }> {
  const [uws, profiles, points, snaps] = await Promise.all([
    pageAll<any>("user_week_statuses", "user_id,week_start_date,status"),
    pageAll<any>("user_profiles", "user_id,growth_status,activity_started_at,activity_ended_at", undefined, "user_id"),
    pageAll<any>("user_weekly_points", "user_id,year,week_number,points"),
    pageAll<any>("cluster4_weekly_card_snapshots", "user_id,is_stale", undefined, "user_id"),
  ]);
  const pick = (rows: any[]) => rows.filter((r) => !excludeIds.has(r.user_id));
  const u = pick(uws).map((r) => `${r.user_id}|${r.week_start_date}|${r.status}`).sort();
  const p = pick(profiles).map((r) => `${r.user_id}|${r.growth_status}|${r.activity_started_at}|${r.activity_ended_at}`).sort();
  const w = pick(points).map((r) => `${r.user_id}|${r.year}|${r.week_number}|${r.points}`).sort();
  const s = pick(snaps).map((r) => `${r.user_id}|${r.is_stale}`).sort();
  const hash = createHash("sha256").update([u.join("\n"), p.join("\n"), w.join("\n"), s.join("\n")].join("\n#\n")).digest("hex");
  return { hash, counts: { uws: u.length, profiles: p.length, points: w.length, snapshots: s.length } };
}

async function main() {
  console.log(`모드: ${APPLY ? "APPLY" : "DRY-RUN"} | 이동: ${SEASON_KEY} W1~W4 → W5~W8 (a=30 불변)`);

  // ── 0. 캘린더 규칙 + 테스터 assert + 사전 지문 ────────────────────────
  for (const ws of NEW_STARTS) {
    const s = getSeasonForDate(ws);
    const st = getSeasonWeekStatusForDate(ws);
    if (!s || seasonDbKey(s) !== SEASON_KEY || st !== "running") {
      throw new Error(`캘린더 규칙 불일치: ${ws} → ${s ? seasonDbKey(s) : null}/${st} (running 이어야 함)`);
    }
  }
  console.log(`캘린더 규칙 검증: W5~W8 ${NEW_STARTS.length}주 전부 ${SEASON_KEY} running ✓`);

  const markers = await pageAll<{ user_id: string }>("test_user_markers", "user_id", undefined, "user_id");
  const testerIds = new Set(markers.map((m) => m.user_id));
  for (const [name, uid] of SIX) {
    if (!testerIds.has(uid)) throw new Error(`비테스터가 대상에 포함: ${name} ${uid}`);
  }
  console.log(`테스터 assert: 6/6 ✓ | 실사용자 지문 채취 중...`);
  const fpBefore = await realUserFingerprint(SIX_IDS);
  console.log(`  before: ${JSON.stringify(fpBefore.counts)} hash=${fpBefore.hash.slice(0, 16)}…`);

  // ── 1. 삭제 대상(W1~4) 안전 assert ───────────────────────────────────
  const { data: oldWeeksData, error: owErr } = await sb
    .from("weeks")
    .select("id,start_date,end_date,season_id,season_key,week_number,iso_year,iso_week")
    .in("start_date", [...OLD_STARTS]);
  if (owErr) throw new Error(`weeks(W1~4): ${owErr.message}`);
  const oldWeeks = (oldWeeksData ?? []) as any[];
  if (oldWeeks.length !== 4) throw new Error(`W1~4 weeks 행 수 예상 밖: ${oldWeeks.length} (4 이어야 함)`);
  for (const w of oldWeeks) {
    if (w.season_key !== SEASON_KEY) throw new Error(`예상 밖 season_key: ${w.start_date}=${w.season_key}`);
  }
  const seasonId = oldWeeks[0].season_id as string; // 신규 W5~8 도 동일 seasons uuid 재사용
  const oldWeekIds = oldWeeks.map((w) => w.id);
  console.log(`\n1) 삭제 대상 weeks: 4행 (W${oldWeeks.map((w) => w.week_number).sort().join(",W")})`);
  for (const w of [...oldWeeks].sort((a, b) => a.start_date.localeCompare(b.start_date))) {
    console.log(`   - W${w.week_number} ${w.start_date}~${w.end_date} id=${w.id}`);
  }

  // uws: W1~4 의 전 사용자 행 = 6명 × 4 = 24행만 존재해야 함
  const oldUws = await pageAll<any>("user_week_statuses", "id,user_id,week_start_date,status", (q) =>
    q.in("week_start_date", [...OLD_STARTS]),
  );
  const uwsForeign = oldUws.filter((r) => !SIX_IDS.has(r.user_id));
  if (uwsForeign.length > 0) {
    throw new Error(`W1~4 에 비대상 사용자 uws 존재(${uwsForeign.length}행) — 중단: ${uwsForeign.slice(0, 3).map((r: any) => r.user_id).join(",")}`);
  }
  if (oldUws.length !== 24) throw new Error(`W1~4 uws 행 수 예상 밖: ${oldUws.length} (24 이어야 함)`);
  console.log(`   uws: 24행 전부 6명 소속 ✓ (status=${[...new Set(oldUws.map((r: any) => r.status))].join(",")})`);

  // lines: 통합 라인(EXBS-UN) 외 없어야 함
  const oldLines = await pageAll<any>("cluster4_lines", "id,week_id,line_code", (q) => q.in("week_id", oldWeekIds));
  const foreignLines = oldLines.filter((l) => !String(l.line_code ?? "").startsWith("EXBS-UN"));
  if (foreignLines.length > 0) throw new Error(`W1~4 에 통합 외 라인 존재 — 중단: ${foreignLines.map((l: any) => l.line_code).join(",")}`);
  console.log(`   lines: ${oldLines.length}행 전부 EXBS-UN ✓`);
  const oldLineIds = oldLines.map((l) => l.id);

  // targets: 전부 6명 소속이어야 함
  const oldTargets = oldLineIds.length
    ? await pageAll<any>("cluster4_line_targets", "id,line_id,target_user_id", (q) => q.in("line_id", oldLineIds))
    : [];
  const foreignTargets = oldTargets.filter((t) => !SIX_IDS.has(t.target_user_id));
  if (foreignTargets.length > 0) throw new Error(`W1~4 라인에 비대상 타깃 존재(${foreignTargets.length}) — 중단`);
  console.log(`   targets: ${oldTargets.length}행 전부 6명 ✓`);
  const oldTargetIds = oldTargets.map((t) => t.id);

  const oldSubs = oldTargetIds.length
    ? await pageAll<any>("cluster4_line_submissions", "id,line_target_id,user_id", (q) => q.in("line_target_id", oldTargetIds))
    : [];
  const oldEvals = oldTargetIds.length
    ? await pageAll<any>("cluster4_experience_line_evaluations", "id,line_target_id,user_id", (q) => q.in("line_target_id", oldTargetIds))
    : [];
  console.log(`   submissions: ${oldSubs.length} | evaluations: ${oldEvals.length}`);

  // user_weekly_points: W1~4·W5~8 해당 iso 주차 전부 0행이어야 함 (본 작업군은 포인트 미생성)
  const isoPairs = [
    ...oldWeeks.map((w) => ({ y: w.iso_year, wk: w.iso_week })),
    ...NEW_STARTS.map((ws) => {
      const { isoYear, isoWeek } = isoWeekOf(ws);
      return { y: isoYear, wk: isoWeek };
    }),
  ];
  for (const { y, wk } of isoPairs) {
    const { count, error } = await sb
      .from("user_weekly_points")
      .select("id", { count: "exact", head: true })
      .eq("year", y)
      .eq("week_number", wk);
    if (error) throw new Error(`points 확인 실패: ${error.message}`);
    if ((count ?? 0) > 0) throw new Error(`iso ${y}-W${wk} 에 user_weekly_points ${count}행 존재 — 중단`);
  }
  console.log(`   user_weekly_points: iso 8개 주차 전부 0행 ✓`);

  // 프로필: 6명 전원 graduated + started=2025-06-30 이어야 함 (상태는 건드리지 않음)
  const { data: profNow } = await sb
    .from("user_profiles")
    .select("user_id,growth_status,activity_started_at,activity_ended_at")
    .in("user_id", [...SIX_IDS]);
  const profById = new Map(((profNow ?? []) as any[]).map((p) => [p.user_id, p]));
  for (const [name, uid] of SIX) {
    const p = profById.get(uid);
    if (p?.growth_status !== "graduated") throw new Error(`${name} growth_status=${p?.growth_status} (graduated 이어야 함) — 중단`);
    if (!String(p?.activity_started_at ?? "").startsWith("2025-06-30")) {
      throw new Error(`${name} activity_started_at=${p?.activity_started_at} (2025-06-30 이어야 함) — 중단`);
    }
  }
  console.log(`   프로필: 6명 전원 graduated · started=2025-06-30 ✓ → ${NEW_STARTED_AT} 로 이동 예정 (상태 무변경)`);

  // ── 1b. 생성 대상(W5~8) 충돌 assert ──────────────────────────────────
  const { data: newExisting } = await sb
    .from("weeks")
    .select("id,start_date,season_key,week_number,iso_year,iso_week,result_published_at,check_threshold")
    .in("start_date", [...NEW_STARTS]);
  const newWeekByStart = new Map<string, any>(((newExisting ?? []) as any[]).map((w) => [w.start_date, w]));
  for (const w of newWeekByStart.values()) {
    if (w.season_key !== SEASON_KEY) throw new Error(`W5~8 자리에 타 시즌 행 존재: ${w.start_date} season_key=${w.season_key} — 중단`);
  }
  console.log(`\n1b) 생성 대상 W5~W8: 기존 ${newWeekByStart.size}행 / 신규 ${NEW_STARTS.length - newWeekByStart.size}행`);
  for (const ws of NEW_STARTS) {
    const n = NEW_WEEK_NUMBER_BASE + NEW_STARTS.indexOf(ws);
    const { isoYear, isoWeek } = isoWeekOf(ws);
    const exist = newWeekByStart.get(ws);
    console.log(
      `   ${exist ? "=" : "+"} W${n} ${ws}~${addDaysIso(ws, 6)} iso=${isoYear}-W${isoWeek} published=${addDaysIso(ws, 7)} threshold=0${exist ? " (기존 재사용)" : ""}`,
    );
  }

  // ── 1c. 사용자별 이동 계획 ────────────────────────────────────────────
  const newUwsExisting = await pageAll<any>("user_week_statuses", "id,user_id,week_start_date", (q) =>
    q.in("user_id", [...SIX_IDS]).in("week_start_date", [...NEW_STARTS]),
  );
  const uwsHaveNew = new Set(newUwsExisting.map((r: any) => `${r.user_id}|${r.week_start_date}`));
  console.log(`\n1c) 사용자별 계획 (6명) — snapshot 재계산 대상:`);
  for (const [name, uid] of SIX) {
    const oldCnt = oldUws.filter((r: any) => r.user_id === uid).length;
    const newMissing = NEW_STARTS.filter((ws) => !uwsHaveNew.has(`${uid}|${ws}`));
    console.log(`   ${name}: uws W1~4 삭제 ${oldCnt} → W5~8 신규 ${newMissing.length} | started 2025-06-30→${NEW_STARTED_AT} | recalc+snapshot 대상 ✓`);
  }

  if (!APPLY) {
    console.log(
      `\n(dry-run — DB 변경 없음) 순서: W5~8 생성(weeks ${NEW_STARTS.length - newWeekByStart.size}·lines·targets 24·subs 24·evals 24·uws 24) → W1~4 삭제(evals ${oldEvals.length} → subs ${oldSubs.length} → targets ${oldTargets.length} → lines ${oldLines.length} → uws ${oldUws.length} → weeks 4) → 프로필 6 → recalc+snapshot 6 → 지문 diff=0`,
    );
    return;
  }

  // ── 2. W5~W8 생성 ─────────────────────────────────────────────────────
  const log: any = existsSync(LOG_PATH) ? JSON.parse(readFileSync(LOG_PATH, "utf8")) : { runs: [] };
  const run: any = {
    runAt: new Date().toISOString(),
    mode: "MOVE W1~4 → W5~8",
    fpBefore: { ...fpBefore.counts, hash: fpBefore.hash },
    insertedWeeks: [],
    insertedLines: [],
    insertedTargets: [],
    insertedSubmissions: [],
    insertedEvals: [],
    insertedUws: [],
    removed: null,
    profileBefore: [],
  };

  for (const ws of NEW_STARTS) {
    if (newWeekByStart.has(ws)) continue;
    const n = NEW_WEEK_NUMBER_BASE + NEW_STARTS.indexOf(ws);
    const { isoYear, isoWeek } = isoWeekOf(ws);
    const endDate = addDaysIso(ws, 6);
    const payload = {
      season_id: seasonId,
      week_index: isoWeek,
      started_at: `${ws}T00:00:00+00:00`,
      ended_at: `${endDate}T00:00:00+00:00`,
      week_number: n,
      start_date: ws,
      end_date: endDate,
      season_key: SEASON_KEY,
      is_official_rest: false,
      holiday_name: null,
      iso_year: isoYear,
      iso_week: isoWeek,
      result_published_at: `${addDaysIso(ws, 7)}T00:00:00+00:00`,
      check_threshold: 0,
    };
    const { data, error } = await sb.from("weeks").insert(payload).select("id,start_date").single();
    if (error || !data) throw new Error(`weeks INSERT 실패(${ws}): ${error?.message}`);
    newWeekByStart.set(ws, { ...payload, id: (data as any).id });
    run.insertedWeeks.push({ id: (data as any).id, start: ws });
  }
  console.log(`\n2) weeks 적용: 신규 ${run.insertedWeeks.length} (총 ${newWeekByStart.size}/4)`);

  // 통합 라인 ensure
  const { data: masterRow, error: mErr } = await sb
    .from("cluster4_experience_line_masters")
    .select("id")
    .eq("line_name", LEGACY_UNIFIED_LINE_NAME)
    .single();
  if (mErr || !masterRow) throw new Error(`통합 마스터 조회 실패: ${mErr?.message}`);
  const masterId = (masterRow as any).id as string;

  const newWeekIds = [...newWeekByStart.values()].map((w: any) => w.id);
  const { data: existingNewLines } = await sb
    .from("cluster4_lines")
    .select("id,week_id")
    .eq("experience_line_master_id", masterId)
    .in("week_id", newWeekIds);
  const lineIdByWeekStart = new Map<string, string>();
  for (const l of (existingNewLines ?? []) as any[]) {
    const w = [...newWeekByStart.values()].find((x: any) => x.id === l.week_id);
    if (w) lineIdByWeekStart.set((w as any).start_date, l.id);
  }
  for (const ws of NEW_STARTS) {
    if (lineIdByWeekStart.has(ws)) continue;
    const w = newWeekByStart.get(ws)!;
    const code = `EXBS-UN${ws.slice(2, 4)}${ws.slice(5, 7)}${ws.slice(8, 10)}`;
    const { data, error } = await sb
      .from("cluster4_lines")
      .insert({
        part_type: "experience",
        main_title:
          "한 주 동안 클럽에서 진행한 중앙, 팀 활동 내역을 아우르는 통합 기록입니다. (26년 6월 이전)",
        experience_line_master_id: masterId,
        line_code: code,
        week_id: w.id,
        submission_opens_at: weekOpensAtIso(ws),
        submission_closes_at: weekClosesAtIso(ws),
        is_active: true,
        source_file_name: MARKER,
        created_by: ADMIN_ID,
        updated_by: ADMIN_ID,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`라인 INSERT 실패(${ws}): ${error?.message}`);
    lineIdByWeekStart.set(ws, (data as any).id);
    run.insertedLines.push({ weekStart: ws, id: (data as any).id });
  }
  console.log(`   통합 라인 준비: ${lineIdByWeekStart.size}/4주차 (신규 ${run.insertedLines.length})`);

  // 타깃/제출/평가 + uws (6명 × W5~8)
  const { data: existingNewTargets } = await sb
    .from("cluster4_line_targets")
    .select("id,week_id,target_user_id")
    .in("line_id", [...lineIdByWeekStart.values()]);
  const targetIdByUserWeek = new Map<string, string>();
  for (const t of (existingNewTargets ?? []) as any[]) {
    const w = [...newWeekByStart.values()].find((x: any) => x.id === t.week_id);
    if (w && t.target_user_id) targetIdByUserWeek.set(`${t.target_user_id}|${(w as any).start_date}`, t.id);
  }

  for (const [name, uid] of SIX) {
    if (!testerIds.has(uid)) throw new Error(`쓰기 직전 assert 실패 — 비테스터: ${uid}`);
    for (const ws of NEW_STARTS) {
      const w = newWeekByStart.get(ws)!;
      let targetId = targetIdByUserWeek.get(`${uid}|${ws}`);
      if (!targetId) {
        const { data, error } = await sb
          .from("cluster4_line_targets")
          .insert({
            line_id: lineIdByWeekStart.get(ws)!,
            week_id: w.id,
            target_mode: "user",
            target_user_id: uid,
            target_rule: {},
            created_by: ADMIN_ID,
            updated_by: ADMIN_ID,
          })
          .select("id")
          .single();
        if (error || !data) throw new Error(`타깃 INSERT 실패(${name} ${ws}): ${error?.message}`);
        targetId = (data as any).id as string;
        targetIdByUserWeek.set(`${uid}|${ws}`, targetId);
        run.insertedTargets.push(targetId);
      }
      const rng = mulberry32(fnv1a(`${uid}|${ws}|content`));
      const { data: subEx } = await sb
        .from("cluster4_line_submissions")
        .select("id")
        .eq("line_target_id", targetId)
        .limit(1);
      if (!subEx || subEx.length === 0) {
        const tpl = GROWTH_POINT_TEMPLATES[Math.floor(rng() * GROWTH_POINT_TEMPLATES.length)];
        const { error } = await sb.from("cluster4_line_submissions").insert({
          line_target_id: targetId,
          user_id: uid,
          subtitle: "기존 주차 활동 내역",
          growth_point: tpl,
          submitted_at: new Date(
            new Date(weekClosesAtIso(ws)).getTime() - (10 + Math.floor(rng() * 30)) * 3_600_000,
          ).toISOString(),
        });
        if (error) throw new Error(`제출 INSERT 실패(${name} ${ws}): ${error.message}`);
        run.insertedSubmissions.push(`${uid}|${ws}`);
      }
      const { data: evalEx } = await sb
        .from("cluster4_experience_line_evaluations")
        .select("id")
        .eq("line_target_id", targetId)
        .limit(1);
      if (!evalEx || evalEx.length === 0) {
        const rating = 4 + Math.floor(rng() * 7); // 4~10 (성공)
        const { error } = await sb.from("cluster4_experience_line_evaluations").insert({
          line_target_id: targetId,
          user_id: uid,
          rating,
          evaluated_by: ADMIN_ID,
          evaluated_at: weekClosesAtIso(ws),
        });
        if (error) throw new Error(`평가 INSERT 실패(${name} ${ws}): ${error.message}`);
        run.insertedEvals.push(`${uid}|${ws}`);
      }
      if (!uwsHaveNew.has(`${uid}|${ws}`)) {
        const { data, error } = await sb
          .from("user_week_statuses")
          .insert({
            user_id: uid,
            year: w.iso_year,
            week_number: w.iso_week,
            week_start_date: ws,
            season_key: SEASON_KEY,
            status: "success",
            is_official_rest_override: false,
          })
          .select("id")
          .single();
        if (error || !data) throw new Error(`uws INSERT 실패(${name} ${ws}): ${error?.message}`);
        uwsHaveNew.add(`${uid}|${ws}`);
        run.insertedUws.push({ id: (data as any).id, uid, weekStart: ws });
      }
    }
    console.log(`   W5~8 생성 완료: ${name}`);
  }

  // ── 3. W1~W4 삭제 (참조 역순, id 화이트리스트) ────────────────────────
  console.log(`\n3) W1~W4 삭제:`);
  const delByIds = async (table: string, ids: string[]) => {
    for (let i = 0; i < ids.length; i += 200) {
      const c = ids.slice(i, i + 200);
      const { error } = await sb.from(table).delete().in("id", c);
      if (error) throw new Error(`${table} DELETE 실패: ${error.message}`);
    }
    console.log(`   ${table}: ${ids.length}행 삭제`);
  };
  await delByIds("cluster4_experience_line_evaluations", oldEvals.map((e: any) => e.id));
  await delByIds("cluster4_line_submissions", oldSubs.map((s: any) => s.id));
  await delByIds("cluster4_line_targets", oldTargetIds);
  await delByIds("cluster4_lines", oldLineIds);
  await delByIds("user_week_statuses", oldUws.map((r: any) => r.id));
  await delByIds("weeks", oldWeekIds);
  run.removed = {
    weekStarts: [...OLD_STARTS],
    weeks: oldWeeks.map((w) => ({ id: w.id, start: w.start_date, week_number: w.week_number })),
    lines: oldLineIds,
    targets: oldTargetIds.length,
    submissions: oldSubs.length,
    evaluations: oldEvals.length,
    uws: oldUws.map((r: any) => ({ id: r.id, uid: r.user_id, weekStart: r.week_start_date })),
  };

  // ── 4. 프로필 started_at 이동 (상태 무변경, graduated 가드) ───────────
  for (const [name, uid] of SIX) {
    const p = profById.get(uid);
    run.profileBefore.push({
      uid,
      name,
      growth_status: p?.growth_status ?? null,
      activity_started_at: p?.activity_started_at ?? null,
      activity_ended_at: p?.activity_ended_at ?? null,
    });
    const { error: pErr } = await sb
      .from("user_profiles")
      .update({ activity_started_at: NEW_STARTED_AT })
      .eq("user_id", uid)
      .eq("growth_status", "graduated"); // 동시 변경 가드 — graduated 행만
    if (pErr) throw new Error(`프로필 UPDATE 실패(${name}): ${pErr.message}`);
  }
  console.log(`\n4) 프로필: 6명 activity_started_at → ${NEW_STARTED_AT} (growth_status 무변경)`);

  // ── 5. 재계산 (6명) ───────────────────────────────────────────────────
  console.log(`\n5) 재계산:`);
  for (const [name, uid] of SIX) {
    await recalcUserGrowthStats(uid);
    await recomputeAndStoreWeeklyCardsSnapshot(uid);
    console.log(`   재계산 완료: ${name}`);
  }

  // ── 6. 사후 지문 diff ─────────────────────────────────────────────────
  const fpAfter = await realUserFingerprint(SIX_IDS);
  const diffOk = fpAfter.hash === fpBefore.hash;
  run.fpAfter = { ...fpAfter.counts, hash: fpAfter.hash };
  run.realUserDiffZero = diffOk;
  console.log(
    `\n6) 실사용자 지문 diff: ${diffOk ? "✓ 0 (일치)" : "✗ 변경 감지!"} after=${JSON.stringify(fpAfter.counts)} hash=${fpAfter.hash.slice(0, 16)}…`,
  );
  if (!diffOk) {
    console.error("⚠ 대상 외 사용자 데이터 변화 감지 — 즉시 원인 조사 필요 (로그의 fpBefore/fpAfter 비교)");
  }

  log.runs.push(run);
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
  console.log(`로그 기록: ${LOG_PATH}`);
  if (!diffOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
