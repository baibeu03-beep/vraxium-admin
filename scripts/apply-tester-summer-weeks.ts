/**
 * 더미 테스터 졸업 충족용 2025-summer W1~W8 추가 활동 주차 생성 (2026-06-06).
 *
 *   npx tsx --env-file=.env.local scripts/apply-tester-summer-weeks.ts                # dry-run
 *   npx tsx --env-file=.env.local scripts/apply-tester-summer-weeks.ts --pilot <uid>  # 테스터 1명 실반영
 *   npx tsx --env-file=.env.local scripts/apply-tester-summer-weeks.ts --apply        # 강등 6명 전체 실반영
 *
 * 배경(조사: claudedocs/tester-extra-weeks-investigation-20260606.md):
 *   encre/phalanx 임계 30 vs 캘린더 가용 활동 주차 27 → graduated 테스터 6명이 a=26 으로
 *   기준 미충족. 공식 휴식 override 는 기획 위배로 금지(2026-06-06 지시) — 대신 실존하되
 *   weeks 미수록 구간인 2025-summer(06-30~08-18, 캘린더 규칙상 W1~8 전부 running)를
 *   실제 활동 주차로 생성하고 테스터에게만 uws success 를 시드한다. 8주 전체 생성으로
 *   이력서 시즌 기록이 "8/8 정상 완료"가 되게 한다 (4/8 어색함 방지).
 *
 * 실사용자 무영향 구조(조사 실증):
 *   - 실사용자 31명 최소 uws 주차 = 2026-05-04 → 2025-summer 는 전원 카드 범위 밖
 *   - uws 자동 생성 코드 없음 · user_growth_stats = uws 직접 합산(weeks 비조인)
 *   - 유일 가시 영향 = admin /admin/season-weeks 에 2025-summer 그룹 노출(관리자 한정)
 *
 * 수행:
 *   1) weeks 2025-summer W1~W8 ensure — season_id 는 기존 단일 seasons uuid 재사용,
 *      week_index/iso_week=ISO 주차(27~34, 기존 36~52 와 비충돌), result_published_at=
 *      익주 월요일 00:00Z(공표 필수 — 미공표면 표시 a 미가산), check_threshold=0
 *      (합성 주차 — check 게이트 무요건. user_weekly_points 는 만들지 않는다:
 *       이력서 누적포인트가 전기간 직접 합산이라 points>0 은 오염)
 *   2) 통합 라인(v17 모형) ensure: cluster4_lines + 대상 테스터 타깃/더미 제출/평점 4~10
 *   3) 대상 테스터 uws 8행 INSERT (status=success, override=false)
 *   4) user_profiles: activity_started_at → 2025-06-30 (첫 활동 주차 정합),
 *      growth_status active→graduated 복원, activity_ended_at → 강등 전 원값 복원
 *   5) recalcUserGrowthStats + weekly-cards snapshot 재계산
 *   6) 실사용자 지문(전/후) diff=0 검증 — uws/프로필/포인트/스냅샷
 *
 * 실사용자 보호: 쓰기 직전 test_user_markers assert + 대상 6명 고정 화이트리스트.
 * 멱등: weeks/라인/타깃/제출/평가/uws 전부 존재 검사 후 삽입. 재실행 안전.
 * 원복 키: 로그 JSON (claudedocs/tester-summer-weeks-20260606.json) 의 inserted* / profileBefore.
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
// 2025-summer 정규 8주 (seasonCalendar 하드코딩 규칙 실측: 전부 running).
const SUMMER_STARTS = [
  "2025-06-30",
  "2025-07-07",
  "2025-07-14",
  "2025-07-21",
  "2025-07-28",
  "2025-08-04",
  "2025-08-11",
  "2025-08-18",
] as const;

// 강등 6명 (claudedocs/graduated-tester-threshold-fix-20260605.json) —
// activity_ended_at 은 강등 전 원값으로 복원한다.
const TARGETS: { name: string; uid: string; org: string; endedAtRestore: string | null }[] = [
  { name: "T윤도현", uid: "bf3b4305-751a-49e3-88ad-95a20e5c4dad", org: "encre", endedAtRestore: null },
  { name: "T임다인", uid: "42864260-e4ea-4150-a87f-cff545b02af1", org: "encre", endedAtRestore: "2026-05-19T00:00:00+00:00" },
  { name: "T장유준", uid: "4a81b6d1-e488-4f14-8530-0cad60fe4f0d", org: "encre", endedAtRestore: "2026-05-12T00:00:00+00:00" },
  { name: "T윤태현", uid: "05ff6b96-b3e7-4050-97f1-080633f183d3", org: "phalanx", endedAtRestore: null },
  { name: "T임건우", uid: "e4dcb97e-a515-4ec5-a91e-32ca4e629dae", org: "phalanx", endedAtRestore: "2026-05-19T00:00:00+00:00" },
  { name: "T장시현", uid: "cc1b58e6-b14d-45a0-b389-2df3c27a0b25", org: "phalanx", endedAtRestore: "2026-05-12T00:00:00+00:00" },
];

const APPLY = process.argv.includes("--apply");
const pilotIdx = process.argv.indexOf("--pilot");
const PILOT_USER = pilotIdx >= 0 ? process.argv[pilotIdx + 1] : null;
const WRITE = APPLY || Boolean(PILOT_USER);

// 결정적 PRNG (v17 과 동일 — 제출문구/평점 재현성)
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

// 주차 시작(월) 00:00 KST / 종료(일) 23:59:59 KST → UTC ISO (v17 동일).
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
// ISO 주차 (월요일 시작일 기준)
function isoWeekOf(mondayIso: string): { isoYear: number; isoWeek: number } {
  const ms = Date.UTC(+mondayIso.slice(0, 4), +mondayIso.slice(5, 7) - 1, +mondayIso.slice(8, 10));
  const thursday = new Date(ms + 3 * 86_400_000); // 월요일 + 3 = 목요일 (ISO 연도 결정)
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

// ── 실사용자 지문 — 대상 외 전원의 uws/프로필/포인트/스냅샷 해시 ────────
async function realUserFingerprint(excludeIds: Set<string>): Promise<{ hash: string; counts: Record<string, number> }> {
  const [uws, profiles, points, snaps] = await Promise.all([
    pageAll<{ user_id: string; week_start_date: string; status: string }>(
      "user_week_statuses",
      "user_id,week_start_date,status",
    ),
    pageAll<{ user_id: string; growth_status: string | null; activity_started_at: string | null; activity_ended_at: string | null }>(
      "user_profiles",
      "user_id,growth_status,activity_started_at,activity_ended_at",
      undefined,
      "user_id",
    ),
    pageAll<{ user_id: string; year: number; week_number: number; points: number }>(
      "user_weekly_points",
      "user_id,year,week_number,points",
    ),
    pageAll<{ user_id: string; is_stale: boolean }>(
      "cluster4_weekly_card_snapshots",
      "user_id,is_stale",
      undefined,
      "user_id",
    ),
  ]);
  const pick = <T extends { user_id: string }>(rows: T[]) => rows.filter((r) => !excludeIds.has(r.user_id));
  const u = pick(uws).map((r) => `${r.user_id}|${r.week_start_date}|${r.status}`).sort();
  const p = pick(profiles).map((r) => `${r.user_id}|${r.growth_status}|${r.activity_started_at}|${r.activity_ended_at}`).sort();
  const w = pick(points).map((r) => `${r.user_id}|${r.year}|${r.week_number}|${r.points}`).sort();
  const s = pick(snaps).map((r) => `${r.user_id}|${r.is_stale}`).sort();
  const hash = createHash("sha256").update([u.join("\n"), p.join("\n"), w.join("\n"), s.join("\n")].join("\n#\n")).digest("hex");
  return { hash, counts: { uws: u.length, profiles: p.length, points: w.length, snapshots: s.length } };
}

async function main() {
  const mode = PILOT_USER ? `PILOT(${PILOT_USER})` : APPLY ? "APPLY(6명 전체)" : "DRY-RUN";
  console.log(`모드: ${mode} | 시즌: ${SEASON_KEY} W1~W8`);

  // 대상 사용자 결정
  const writeUsers = PILOT_USER
    ? TARGETS.filter((t) => t.uid === PILOT_USER)
    : TARGETS;
  if (PILOT_USER && writeUsers.length === 0) {
    throw new Error(`--pilot 대상이 화이트리스트(강등 6명)에 없음: ${PILOT_USER}`);
  }

  // ── 0. 캘린더 규칙 재검증 + 테스터 assert + 사전 지문 ────────────────
  for (const ws of SUMMER_STARTS) {
    const s = getSeasonForDate(ws);
    const st = getSeasonWeekStatusForDate(ws);
    if (!s || seasonDbKey(s) !== SEASON_KEY || st !== "running") {
      throw new Error(`캘린더 규칙 불일치: ${ws} → ${s ? seasonDbKey(s) : null}/${st} (running 이어야 함)`);
    }
  }
  console.log(`캘린더 규칙 검증: ${SUMMER_STARTS.length}주 전부 ${SEASON_KEY} running ✓`);

  const markers = await pageAll<{ user_id: string }>("test_user_markers", "user_id", undefined, "user_id");
  const testerIds = new Set(markers.map((m) => m.user_id));
  for (const t of TARGETS) {
    if (!testerIds.has(t.uid)) throw new Error(`비테스터가 대상에 포함: ${t.name} ${t.uid}`);
  }
  const allTargetIds = new Set(TARGETS.map((t) => t.uid));
  console.log(`테스터 assert: 6/6 ✓ | 실사용자 지문 채취 중...`);
  const fpBefore = await realUserFingerprint(allTargetIds);
  console.log(`  before: ${JSON.stringify(fpBefore.counts)} hash=${fpBefore.hash.slice(0, 16)}…`);

  // ── 1. weeks ensure ──────────────────────────────────────────────────
  // season_id: 기존 행 전부가 단일 seasons uuid 를 가리킴 — 동일 값 재사용.
  const { data: anyWeek, error: awErr } = await sb
    .from("weeks")
    .select("season_id")
    .limit(1)
    .single();
  if (awErr || !anyWeek) throw new Error(`weeks season_id 조회 실패: ${awErr?.message}`);
  const seasonId = (anyWeek as any).season_id as string;

  const { data: existingSummer } = await sb
    .from("weeks")
    .select(
      "id,start_date,end_date,week_number,season_key,result_published_at,is_official_rest,check_threshold,iso_year,iso_week",
    )
    .in("start_date", [...SUMMER_STARTS]);
  const weekRowByStart = new Map<string, any>(
    ((existingSummer ?? []) as any[]).map((w) => [w.start_date, w]),
  );
  // 안전: 동일 start_date 에 다른 season_key 행이 있으면 중단(캘린더 충돌)
  for (const w of weekRowByStart.values()) {
    if (w.season_key !== SEASON_KEY) {
      throw new Error(`기존 weeks 충돌: ${w.start_date} season_key=${w.season_key}`);
    }
  }

  const weeksToInsert = SUMMER_STARTS.filter((ws) => !weekRowByStart.has(ws)).map((ws, idx) => {
    const n = SUMMER_STARTS.indexOf(ws) + 1;
    const { isoYear, isoWeek } = isoWeekOf(ws);
    const endDate = addDaysIso(ws, 6);
    return {
      season_id: seasonId,
      week_index: isoWeek, // 기존 규약: week_index = iso_week (2025 기존 행 36~52, 27~34 비충돌)
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
      // 공표 완료 필수 — 미공표 주차는 표시 a 미가산(2026-05-25 실증). 익주 월요일 00:00Z.
      result_published_at: `${addDaysIso(ws, 7)}T00:00:00+00:00`,
      // 합성 주차: check 게이트 무요건(포인트 행 없이도 명시적 pass — fail-safe 의존 제거)
      check_threshold: 0,
    };
  });
  console.log(`\n1) weeks: 기존 ${weekRowByStart.size} / 신규 ${weeksToInsert.length}`);
  for (const w of weeksToInsert) {
    console.log(`   + W${w.week_number} ${w.start_date}~${w.end_date} iso=${w.iso_year}-W${w.iso_week} published=${w.result_published_at.slice(0, 10)}`);
  }

  // ── 2~4. 사용자별 계획 (uws/타깃/제출/평가/프로필) ────────────────────
  const uwsExisting = await pageAll<{ id: string; user_id: string; week_start_date: string; status: string }>(
    "user_week_statuses",
    "id,user_id,week_start_date,status",
    (q) => q.in("user_id", TARGETS.map((t) => t.uid)).in("week_start_date", [...SUMMER_STARTS]),
  );
  const uwsHave = new Set(uwsExisting.map((r) => `${r.user_id}|${r.week_start_date}`));

  const { data: profNow } = await sb
    .from("user_profiles")
    .select("user_id,display_name,growth_status,activity_started_at,activity_ended_at")
    .in("user_id", TARGETS.map((t) => t.uid));
  const profById = new Map(((profNow ?? []) as any[]).map((p) => [p.user_id, p]));

  console.log(`\n2~4) 사용자별 계획 (${writeUsers.length}명):`);
  for (const t of writeUsers) {
    const p = profById.get(t.uid);
    const missing = SUMMER_STARTS.filter((ws) => !uwsHave.has(`${t.uid}|${ws}`));
    console.log(
      `   ${t.name}: uws 신규 ${missing.length}/8 | profile ${p?.growth_status}→graduated, started ${p?.activity_started_at?.slice(0, 10)}→2025-06-30, ended ${p?.activity_ended_at ?? "null"}→${t.endedAtRestore ?? "null"}`,
    );
    if (p?.growth_status !== "active") {
      console.log(`     ⚠ growth_status 가 active 가 아님(${p?.growth_status}) — graduated 복원은 active 행만 수행`);
    }
  }

  if (!WRITE) {
    console.log("\n(dry-run — DB 변경 없음. --pilot <uid> 또는 --apply 로 실행)");
    return;
  }

  // ── 적용 ─────────────────────────────────────────────────────────────
  const log: any = existsSync(LOG_PATH)
    ? JSON.parse(readFileSync(LOG_PATH, "utf8"))
    : { runs: [] };
  const run: any = {
    runAt: new Date().toISOString(),
    mode,
    fpBefore: { ...fpBefore.counts, hash: fpBefore.hash },
    insertedWeeks: [],
    insertedLines: [],
    insertedTargets: [],
    insertedSubmissions: [],
    insertedEvals: [],
    insertedUws: [],
    profileBefore: [],
  };

  // 1) weeks INSERT
  for (const w of weeksToInsert) {
    const { data, error } = await sb.from("weeks").insert(w).select("id,start_date").single();
    if (error || !data) throw new Error(`weeks INSERT 실패(${w.start_date}): ${error?.message}`);
    weekRowByStart.set(w.start_date, { ...w, id: (data as any).id });
    run.insertedWeeks.push({ id: (data as any).id, start: w.start_date });
  }
  console.log(`\nweeks 적용: 신규 ${run.insertedWeeks.length} (총 ${weekRowByStart.size}/8)`);

  // 2) 통합 라인 ensure
  const { data: masterRow, error: mErr } = await sb
    .from("cluster4_experience_line_masters")
    .select("id")
    .eq("line_name", LEGACY_UNIFIED_LINE_NAME)
    .single();
  if (mErr || !masterRow) throw new Error(`통합 마스터 조회 실패: ${mErr?.message}`);
  const masterId = (masterRow as any).id as string;

  const summerWeekIds = [...weekRowByStart.values()].map((w: any) => w.id);
  const { data: existingLines } = await sb
    .from("cluster4_lines")
    .select("id,week_id")
    .eq("experience_line_master_id", masterId)
    .in("week_id", summerWeekIds);
  const lineIdByWeekStart = new Map<string, string>();
  for (const l of (existingLines ?? []) as any[]) {
    const w = [...weekRowByStart.values()].find((x: any) => x.id === l.week_id);
    if (w) lineIdByWeekStart.set((w as any).start_date, l.id);
  }
  for (const ws of SUMMER_STARTS) {
    if (lineIdByWeekStart.has(ws)) continue;
    const w = weekRowByStart.get(ws)!;
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
  console.log(`통합 라인 준비: ${lineIdByWeekStart.size}/8주차 (신규 ${run.insertedLines.length})`);

  // 3) 타깃/제출/평가 + uws (대상 사용자만)
  const { data: existingTargets } = await sb
    .from("cluster4_line_targets")
    .select("id,week_id,target_user_id")
    .in("line_id", [...lineIdByWeekStart.values()]);
  const targetIdByUserWeek = new Map<string, string>();
  for (const t of (existingTargets ?? []) as any[]) {
    const w = [...weekRowByStart.values()].find((x: any) => x.id === t.week_id);
    if (w && t.target_user_id) targetIdByUserWeek.set(`${t.target_user_id}|${(w as any).start_date}`, t.id);
  }

  for (const tgt of writeUsers) {
    if (!testerIds.has(tgt.uid)) throw new Error(`쓰기 직전 assert 실패 — 비테스터: ${tgt.uid}`);

    for (const ws of SUMMER_STARTS) {
      const w = weekRowByStart.get(ws)!;
      // 타깃
      let targetId = targetIdByUserWeek.get(`${tgt.uid}|${ws}`);
      if (!targetId) {
        const { data, error } = await sb
          .from("cluster4_line_targets")
          .insert({
            line_id: lineIdByWeekStart.get(ws)!,
            week_id: w.id,
            target_mode: "user",
            target_user_id: tgt.uid,
            target_rule: {},
            created_by: ADMIN_ID,
            updated_by: ADMIN_ID,
          })
          .select("id")
          .single();
        if (error || !data) throw new Error(`타깃 INSERT 실패(${tgt.name} ${ws}): ${error?.message}`);
        targetId = (data as any).id as string;
        targetIdByUserWeek.set(`${tgt.uid}|${ws}`, targetId);
        run.insertedTargets.push(targetId);
      }
      // 제출 + 평가 (존재 검사)
      const rng = mulberry32(fnv1a(`${tgt.uid}|${ws}|content`));
      const { data: subEx } = await sb
        .from("cluster4_line_submissions")
        .select("id")
        .eq("line_target_id", targetId)
        .limit(1);
      if (!subEx || subEx.length === 0) {
        const tpl = GROWTH_POINT_TEMPLATES[Math.floor(rng() * GROWTH_POINT_TEMPLATES.length)];
        const { error } = await sb.from("cluster4_line_submissions").insert({
          line_target_id: targetId,
          user_id: tgt.uid,
          subtitle: "기존 주차 활동 내역",
          growth_point: tpl,
          submitted_at: new Date(
            new Date(weekClosesAtIso(ws)).getTime() - (10 + Math.floor(rng() * 30)) * 3_600_000,
          ).toISOString(),
        });
        if (error) throw new Error(`제출 INSERT 실패(${tgt.name} ${ws}): ${error.message}`);
        run.insertedSubmissions.push(`${tgt.uid}|${ws}`);
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
          user_id: tgt.uid,
          rating,
          evaluated_by: ADMIN_ID,
          evaluated_at: weekClosesAtIso(ws),
        });
        if (error) throw new Error(`평가 INSERT 실패(${tgt.name} ${ws}): ${error.message}`);
        run.insertedEvals.push(`${tgt.uid}|${ws}`);
      }
      // uws
      if (!uwsHave.has(`${tgt.uid}|${ws}`)) {
        const { data, error } = await sb
          .from("user_week_statuses")
          .insert({
            user_id: tgt.uid,
            year: w.iso_year,
            week_number: w.iso_week,
            week_start_date: ws,
            season_key: SEASON_KEY,
            status: "success",
            is_official_rest_override: false,
          })
          .select("id")
          .single();
        if (error || !data) throw new Error(`uws INSERT 실패(${tgt.name} ${ws}): ${error?.message}`);
        uwsHave.add(`${tgt.uid}|${ws}`);
        run.insertedUws.push({ id: (data as any).id, uid: tgt.uid, weekStart: ws });
      }
    }

    // 4) 프로필: started_at / graduated 복원 / ended_at 복원
    const p = profById.get(tgt.uid);
    run.profileBefore.push({
      uid: tgt.uid,
      name: tgt.name,
      growth_status: p?.growth_status ?? null,
      activity_started_at: p?.activity_started_at ?? null,
      activity_ended_at: p?.activity_ended_at ?? null,
    });
    const { error: pErr } = await sb
      .from("user_profiles")
      .update({
        activity_started_at: "2025-06-30",
        growth_status: "graduated",
        activity_ended_at: tgt.endedAtRestore,
      })
      .eq("user_id", tgt.uid)
      .eq("growth_status", "active"); // 동시 변경 가드 — active 행만 승격
    if (pErr) throw new Error(`프로필 UPDATE 실패(${tgt.name}): ${pErr.message}`);

    // 5) 재계산
    await recalcUserGrowthStats(tgt.uid);
    await recomputeAndStoreWeeklyCardsSnapshot(tgt.uid);
    console.log(`적용 완료: ${tgt.name} (uws 8 · 타깃/제출/평가 · graduated 복원 · recalc+snapshot)`);
  }

  // ── 6. 사후 지문 diff ────────────────────────────────────────────────
  const fpAfter = await realUserFingerprint(allTargetIds);
  const diffOk = fpAfter.hash === fpBefore.hash;
  run.fpAfter = { ...fpAfter.counts, hash: fpAfter.hash };
  run.realUserDiffZero = diffOk;
  console.log(
    `\n실사용자 지문 diff: ${diffOk ? "✓ 0 (일치)" : "✗ 변경 감지!"} after=${JSON.stringify(fpAfter.counts)} hash=${fpAfter.hash.slice(0, 16)}…`,
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
