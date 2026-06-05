/**
 * 레거시 통합 라인 마이그레이션 (2026-06-05 정책 — 허브/라인 체계는 2026 여름 W1 부터).
 *
 *   npx tsx --env-file=.env.local scripts/apply-legacy-unified-line-migration.ts                # dry-run
 *   npx tsx --env-file=.env.local scripts/apply-legacy-unified-line-migration.ts --pilot <uid>  # 테스터 1명 실반영
 *   npx tsx --env-file=.env.local scripts/apply-legacy-unified-line-migration.ts --apply        # 전수 실반영
 *
 * 수행 내용:
 *   1) [통합] 주차 활동 내역 마스터(cluster4_experience_line_masters, slot 1, EXBS-UN0000) 생성
 *   2) 레거시 활동 주차(2026-06-29 이전 · 비휴식 · 비전환)별 통합 라인(cluster4_lines) 생성
 *   3) 테스터 90명 — 레거시 주차 성공/실패 재분포(조직별 졸업/임박/중간/낮음, 휴식 주차 정규화,
 *      personal_rest 제거), 전 활동 주차 통합 타깃 + 더미 제출 + 평점(성공 4~10 / 실패 1~3)
 *   4) 실사용자 — uws success 레거시 주차에만 통합 타깃 생성(평점/상태 변경 절대 금지),
 *      기존 라인 제출 내용은 통합 타깃으로 복사
 *   5) 테스터의 비통합 레거시 타깃 삭제(전체 row 를 로그에 보존 — 원복 키)
 *   6) graduates 테스터 growth_status='graduated'
 *   7) 테스터 user_growth_stats 재계산
 *
 * 멱등: 마스터/라인/타깃/제출/평가 전부 존재 검사 후 삽입. 재실행 안전.
 * 실사용자 보호: user_week_statuses / user_profiles 의 쓰기는 테스터(test_user_markers)로만
 *   향한다 — 코드 레벨 assert.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import {
  CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
  LEGACY_UNIFIED_LINE_NAME,
} from "@/lib/lineAvailability";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import { isSeasonRuleRestForWeekStart, fetchActiveRestPeriods } from "@/lib/officialRestPeriodsData";
import { matchOfficialRestPeriods } from "@/lib/officialRestPeriodsTypes";
import { GRADUATION_THRESHOLDS } from "@/lib/pointLabels";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ADMIN_ID = "c28b2409-4118-49fc-a42e-68e18dbd194c";
const MARKER = "legacy-unified-migration-20260605";
const LOG_PATH = "claudedocs/legacy-unified-migration-20260605.json";

const UNIFIED_MASTER_CODE = "EXBS-UN0000";
const UNIFIED_MAIN_TITLE =
  "한 주 동안 클럽에서 진행한 중앙, 팀 활동 내역을 아우르는 통합 기록입니다. (26년 6월 이전)";
const UNIFIED_SUBTITLE = "기존 주차 활동 내역";

const APPLY = process.argv.includes("--apply");
const pilotIdx = process.argv.indexOf("--pilot");
const PILOT_USER = pilotIdx >= 0 ? process.argv[pilotIdx + 1] : null;
const WRITE = APPLY || Boolean(PILOT_USER);

// ── 결정적 PRNG (user_id 시드) ─────────────────────────────────────────
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

// 더미 활동내역(growth_point) 템플릿 — 통합 기록 문체.
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

function pageAll<T>(
  table: string,
  select: string,
  filter?: (q: any) => any,
  orderCol = "id",
): Promise<T[]> {
  return (async () => {
    const out: T[] = [];
    for (let from = 0; ; from += 1000) {
      let q = sb.from(table).select(select).order(orderCol, { ascending: true }).range(from, from + 999);
      if (filter) q = filter(q);
      let data: any = null, error: any = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try { const res = await q; data = res.data; error = res.error; if (!error) break; }
        catch (e) { error = e; }
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
      if (error) throw new Error(`${table}: ${error.message ?? error}`);
      out.push(...((data ?? []) as T[]));
      if (!data || data.length < 1000) break;
    }
    return out;
  })();
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// 주차 시작(월) 00:00 KST / 종료(일) 23:59:59 KST → UTC ISO.
function weekOpensAtIso(startDate: string): string {
  const ms = Date.UTC(+startDate.slice(0, 4), +startDate.slice(5, 7) - 1, +startDate.slice(8, 10));
  return new Date(ms - 9 * 3_600_000).toISOString();
}
function weekClosesAtIso(startDate: string): string {
  const ms = Date.UTC(+startDate.slice(0, 4), +startDate.slice(5, 7) - 1, +startDate.slice(8, 10));
  return new Date(ms + 7 * 86_400_000 - 9 * 3_600_000 - 1000).toISOString();
}

type WeekRow = {
  id: string;
  start_date: string;
  end_date: string | null;
  season_key: string | null;
  week_number: number | null;
  is_official_rest: boolean;
  result_published_at: string | null;
  iso_year: number | null;
  iso_week: number | null;
};
type UwsRow = {
  id: string;
  user_id: string;
  year: number;
  week_number: number;
  week_start_date: string;
  status: string;
};
type ProfileRow = {
  user_id: string;
  display_name: string | null;
  organization_slug: string | null;
  growth_status: string | null;
  activity_started_at: string | null;
};

async function main() {
  const mode = PILOT_USER ? `PILOT(${PILOT_USER})` : APPLY ? "APPLY(전수)" : "DRY-RUN";
  console.log(`모드: ${mode} | 레거시 경계 < ${CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM}`);

  // ── 0. 로드 ──────────────────────────────────────────────────────────
  const [weeks, markers, restPeriods] = await Promise.all([
    pageAll<WeekRow>(
      "weeks",
      "id,start_date,end_date,season_key,week_number,is_official_rest,result_published_at,iso_year,iso_week",
      (q) => q.lt("start_date", CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM),
    ),
    sb.from("test_user_markers").select("user_id").then((r) => {
      if (r.error) throw new Error(`test_user_markers: ${r.error.message}`);
      return (r.data ?? []) as { user_id: string }[];
    }),
    fetchActiveRestPeriods(),
  ]);
  const testerIds = new Set(markers.map((m) => m.user_id));
  console.log(`레거시 주차 수: ${weeks.length} | 테스터: ${testerIds.size}`);

  const weekByStart = new Map(weeks.map((w) => [w.start_date, w]));
  const weekById = new Map(weeks.map((w) => [w.id, w]));

  // 주차 분류 — 표시 레이어(buildResolvedWeeks)와 "정확히 동일한" rest 판정.
  //   ⚠ weeks.is_official_rest 플래그는 resolver 가 보지 않으므로 여기서도 쓰지 않는다
  //   (예: 2026-01-26 — DB 플래그만 rest 라 포함 시 표시는 활동 주차로 갈라진다).
  const isRestWeek = (w: WeekRow): boolean => {
    const endDate = w.end_date ?? w.start_date;
    return (
      isSeasonRuleRestForWeekStart(w.start_date) ||
      matchOfficialRestPeriods({ startDate: w.start_date, endDate }, restPeriods).length > 0
    );
  };
  const weekClass = new Map<string, "active" | "rest" | "transition">();
  for (const w of weeks) {
    weekClass.set(
      w.start_date,
      isTransitionWeekStart(w.start_date) ? "transition" : isRestWeek(w) ? "rest" : "active",
    );
  }
  const activeWeekStarts = [...weekClass.entries()]
    .filter(([, c]) => c === "active")
    .map(([s]) => s)
    .sort();
  console.log(`활동 주차(${activeWeekStarts.length}): ${activeWeekStarts.join(", ")}`);

  // uws 전수 (레거시 범위)
  const uwsAll = await pageAll<UwsRow>(
    "user_week_statuses",
    "id,user_id,year,week_number,week_start_date,status",
    (q) => q.lt("week_start_date", CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM),
  );
  console.log(`레거시 uws rows: ${uwsAll.length}`);

  // 프로필 (테스터 + 실사용자 구분/조직)
  const userIds = [...new Set(uwsAll.map((r) => r.user_id))];
  const profiles: ProfileRow[] = [];
  for (const c of chunk(userIds, 150)) {
    profiles.push(
      ...(await pageAll<ProfileRow>(
        "user_profiles",
        "user_id,display_name,organization_slug,growth_status,activity_started_at",
        (q) => q.in("user_id", c),
        "user_id",
      )),
    );
  }
  const profileById = new Map(profiles.map((p) => [p.user_id, p]));

  // ── 1. 테스터 재분포 계획 ─────────────────────────────────────────────
  type TesterPlan = {
    userId: string;
    org: string;
    activeWeeks: string[]; // start_date asc
    successWeeks: Set<string>;
    bucket: "graduate" | "near" | "mid" | "low";
    setGraduated: boolean;
  };
  const uwsByUser = new Map<string, UwsRow[]>();
  for (const r of uwsAll) {
    if (!uwsByUser.has(r.user_id)) uwsByUser.set(r.user_id, []);
    uwsByUser.get(r.user_id)!.push(r);
  }

  let planTesterIds = [...testerIds].filter((id) => uwsByUser.has(id));
  if (PILOT_USER) {
    if (!testerIds.has(PILOT_USER)) throw new Error(`--pilot ${PILOT_USER} 는 테스터가 아닙니다`);
    planTesterIds = planTesterIds.filter((id) => id === PILOT_USER);
  }

  const byOrg = new Map<string, string[]>();
  for (const id of planTesterIds) {
    const org = profileById.get(id)?.organization_slug ?? "unknown";
    if (!byOrg.has(org)) byOrg.set(org, []);
    byOrg.get(org)!.push(id);
  }

  const testerPlans = new Map<string, TesterPlan>();
  for (const [org, ids] of byOrg) {
    // 활동 주차 수 desc · 기존 graduated 우선 정렬 (결정적: uid tie-break)
    const meta = ids.map((id) => {
      const act = (uwsByUser.get(id) ?? [])
        .map((r) => r.week_start_date)
        .filter((s) => weekClass.get(s) === "active")
        .sort();
      return {
        id,
        act,
        wasGraduated: profileById.get(id)?.growth_status === "graduated",
      };
    });
    meta.sort((a, b) => {
      if (a.wasGraduated !== b.wasGraduated) return a.wasGraduated ? -1 : 1;
      if (a.act.length !== b.act.length) return b.act.length - a.act.length;
      return a.id.localeCompare(b.id);
    });
    const n = meta.length;
    const gradCount = Math.min(n, Math.max(3, meta.filter((m) => m.wasGraduated).length));
    const nearCount = Math.min(n - gradCount, Math.max(2, Math.ceil(n * 0.15)));
    const midCount = Math.min(n - gradCount - nearCount, Math.ceil(n * 0.4));
    meta.forEach((m, i) => {
      const rng = mulberry32(fnv1a(`${m.id}|legacy-redistribution`));
      let bucket: TesterPlan["bucket"];
      let successCount: number;
      // 졸업 트랙은 활동 스팬을 레거시 전 활동 주차(2025-09-01~)로 확장한다 —
      // 누적 성공 주차가 졸업 임계(25~30)에 최대한 근접하도록 (uws 미존재 주차는 신규 insert).
      if (i < gradCount) m.act = [...activeWeekStarts];
      const availN = m.act.length;
      if (i < gradCount) {
        bucket = "graduate";
        successCount = availN; // 전부 성공 — 졸업 조건 최대 충족
      } else if (i < gradCount + nearCount) {
        bucket = "near";
        successCount = Math.max(0, availN - (1 + Math.floor(rng() * 3)));
      } else if (i < gradCount + nearCount + midCount) {
        bucket = "mid";
        successCount = Math.round(availN * (0.5 + rng() * 0.25));
      } else {
        bucket = "low";
        successCount = Math.round(availN * (0.2 + rng() * 0.25));
      }
      // 성공 주차 선택 — 결정적 셔플
      const shuffled = [...m.act];
      for (let k = shuffled.length - 1; k > 0; k--) {
        const j = Math.floor(rng() * (k + 1));
        [shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]];
      }
      testerPlans.set(m.id, {
        userId: m.id,
        org,
        activeWeeks: m.act,
        successWeeks: new Set(shuffled.slice(0, successCount)),
        bucket,
        setGraduated: bucket === "graduate",
      });
    });
  }

  // 분포 리포트
  console.log("\n=== 테스터 재분포 계획 (org / bucket / 인원 / 성공주차 min~max) ===");
  for (const [org] of byOrg) {
    const plans = [...testerPlans.values()].filter((p) => p.org === org);
    const byBucket = new Map<string, TesterPlan[]>();
    for (const p of plans) {
      if (!byBucket.has(p.bucket)) byBucket.set(p.bucket, []);
      byBucket.get(p.bucket)!.push(p);
    }
    const thr = (GRADUATION_THRESHOLDS as Record<string, number>)[org] ?? null;
    console.log(`[${org}] 인원=${plans.length} 졸업임계=${thr}`);
    for (const b of ["graduate", "near", "mid", "low"]) {
      const ps = byBucket.get(b) ?? [];
      if (!ps.length) continue;
      const counts = ps.map((p) => p.successWeeks.size).sort((a, b2) => a - b2);
      console.log(
        `  ${b.padEnd(8)} n=${ps.length} 성공=${counts[0]}~${counts[counts.length - 1]} (활동주차 ${ps.map((p) => p.activeWeeks.length).sort((a, b2) => a - b2).join(",")})`,
      );
    }
  }

  // ── 2. 실사용자 success 주차 (타깃 생성 대상 — 절대 변경 없음, 읽기만) ──
  const realSuccess: { userId: string; weekStart: string }[] = [];
  for (const r of uwsAll) {
    if (testerIds.has(r.user_id)) continue;
    if (r.status !== "success") continue;
    if (weekClass.get(r.week_start_date) !== "active") continue;
    realSuccess.push({ userId: r.user_id, weekStart: r.week_start_date });
  }
  console.log(`\n실사용자 success 레거시 주차(타깃 생성): ${realSuccess.length}건`);

  // ── 3. 라인/타깃/제출/평가 계획 ──────────────────────────────────────
  // 주차별 타깃 대상: 테스터 = 전 활동 주차(성공+실패), 실사용자 = success 주차만.
  type TargetPlan = { userId: string; weekStart: string; isTester: boolean; success: boolean };
  const targetPlans: TargetPlan[] = [];
  for (const p of testerPlans.values()) {
    for (const ws of p.activeWeeks) {
      targetPlans.push({
        userId: p.userId,
        weekStart: ws,
        isTester: true,
        success: p.successWeeks.has(ws),
      });
    }
  }
  if (!PILOT_USER) {
    for (const r of realSuccess) {
      targetPlans.push({ userId: r.userId, weekStart: r.weekStart, isTester: false, success: true });
    }
  }
  const lineWeekStarts = [...new Set(targetPlans.map((t) => t.weekStart))].sort();
  console.log(`통합 라인 생성 대상 주차: ${lineWeekStarts.length} | 타깃 계획: ${targetPlans.length}`);

  // ── 4. uws 변경 계획 (테스터만) ──────────────────────────────────────
  type UwsChange = { id: string; userId: string; weekStart: string; before: string; after: string };
  const uwsChanges: UwsChange[] = [];
  for (const p of testerPlans.values()) {
    for (const r of uwsByUser.get(p.userId) ?? []) {
      const cls = weekClass.get(r.week_start_date);
      if (cls === "transition" || cls === undefined) continue; // weeks row 없는/전환 주차 불변
      let after: string;
      if (cls === "rest") after = "official_rest";
      else after = p.successWeeks.has(r.week_start_date) ? "success" : "fail";
      if (after !== r.status) {
        uwsChanges.push({
          id: r.id,
          userId: r.user_id,
          weekStart: r.week_start_date,
          before: r.status,
          after,
        });
      }
    }
  }
  // 졸업 트랙 스팬 확장 — uws 미존재 레거시 주차 신규 insert (active→success/fail, 그 외→official_rest)
  type UwsInsert = { userId: string; weekStart: string; status: string };
  const uwsInserts: UwsInsert[] = [];
  const activityStartChanges: { userId: string; before: string | null }[] = [];
  for (const p of testerPlans.values()) {
    if (p.bucket !== "graduate") continue;
    const existingStarts = new Set(
      (uwsByUser.get(p.userId) ?? []).map((r) => r.week_start_date),
    );
    for (const w of weeks) {
      if (existingStarts.has(w.start_date)) continue;
      const cls = weekClass.get(w.start_date)!;
      const status =
        cls === "active"
          ? p.successWeeks.has(w.start_date)
            ? "success"
            : "fail"
          : "official_rest";
      uwsInserts.push({ userId: p.userId, weekStart: w.start_date, status });
    }
    const before = profileById.get(p.userId)?.activity_started_at ?? null;
    if (!before || before.slice(0, 10) > "2025-09-01") {
      activityStartChanges.push({ userId: p.userId, before });
    }
  }
  console.log(
    `uws 상태 변경(테스터만): ${uwsChanges.length}건 | 신규 insert(졸업 스팬 확장): ${uwsInserts.length}건 | activity_started_at 확장: ${activityStartChanges.length}명`,
  );
  // 실사용자 보호 assert
  for (const c of uwsChanges) {
    if (!testerIds.has(c.userId)) throw new Error(`uws 변경에 비테스터 포함: ${c.userId}`);
  }
  for (const c of uwsInserts) {
    if (!testerIds.has(c.userId)) throw new Error(`uws insert 에 비테스터 포함: ${c.userId}`);
  }

  // growth_status 변경 계획
  const gradChanges: { userId: string; before: string | null }[] = [];
  for (const p of testerPlans.values()) {
    if (p.setGraduated && profileById.get(p.userId)?.growth_status !== "graduated") {
      gradChanges.push({ userId: p.userId, before: profileById.get(p.userId)?.growth_status ?? null });
    }
  }
  console.log(`growth_status → graduated 변경: ${gradChanges.length}명`);

  // ── 5. 클린업 계획: 테스터의 비통합 레거시 타깃 ─────────────────────────
  // (적용 시 통합 라인 id 확보 후 제외 — 여기서는 주차 범위의 테스터 타깃 전수를 모아둔다)
  const legacyWeekIds = weeks.map((w) => w.id);
  type TargetRow = {
    id: string; line_id: string; week_id: string; target_mode: string;
    target_user_id: string | null; target_rule: unknown;
  };
  const existingTargets: TargetRow[] = [];
  for (const c of chunk(legacyWeekIds, 30)) {
    existingTargets.push(
      ...(await pageAll<TargetRow>(
        "cluster4_line_targets",
        "id,line_id,week_id,target_mode,target_user_id,target_rule",
        (q) => q.in("week_id", c),
      )),
    );
  }
  console.log(`레거시 기존 타깃 전수: ${existingTargets.length}`);

  if (!WRITE) {
    console.log("\n(dry-run — DB 변경 없음. --pilot <uid> 또는 --apply 로 실행)");
    return;
  }

  // ═══════════════ 적용 단계 ═══════════════
  const log: any = {
    runAt: new Date().toISOString(),
    mode,
    marker: MARKER,
    master: null,
    insertedLines: [] as { weekStart: string; id: string }[],
    insertedTargets: [] as string[],
    insertedSubmissions: 0,
    insertedEvals: 0,
    uwsChanges,
    gradChanges,
    deletedTargets: [] as TargetRow[],
  };

  // A. 마스터 ensure
  let masterId: string;
  {
    const { data: existing } = await sb
      .from("cluster4_experience_line_masters")
      .select("id")
      .eq("line_name", LEGACY_UNIFIED_LINE_NAME)
      .maybeSingle();
    if (existing) {
      masterId = (existing as any).id;
      console.log(`마스터 재사용: ${masterId}`);
    } else {
      const { data, error } = await sb
        .from("cluster4_experience_line_masters")
        .insert({
          line_code: UNIFIED_MASTER_CODE,
          line_name: LEGACY_UNIFIED_LINE_NAME,
          default_main_title: UNIFIED_MAIN_TITLE,
          experience_category: "derivation",
          experience_slot_order: 1,
          // NOT NULL — 'common'(전 조직 공통, competency 마스터와 동일 관례).
          // 노출 판정은 라인 line_code 의 BS 토큰이 우선이라 마스터 org 는 참고값.
          organization_slug: "common",
          source_file_name: MARKER,
          is_active: true,
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(`마스터 INSERT 실패: ${error?.message}`);
      masterId = (data as any).id;
      console.log(`마스터 생성: ${masterId}`);
    }
    log.master = masterId;
  }

  // B. 주차별 통합 라인 ensure
  const lineIdByWeekStart = new Map<string, string>();
  {
    const { data: existingLines } = await sb
      .from("cluster4_lines")
      .select("id,week_id")
      .eq("experience_line_master_id", masterId);
    for (const l of (existingLines ?? []) as { id: string; week_id: string | null }[]) {
      const w = l.week_id ? weekById.get(l.week_id) : null;
      if (w) lineIdByWeekStart.set(w.start_date, l.id);
    }
    for (const ws of lineWeekStarts) {
      if (lineIdByWeekStart.has(ws)) continue;
      const w = weekByStart.get(ws)!;
      const code = `EXBS-UN${ws.slice(2, 4)}${ws.slice(5, 7)}${ws.slice(8, 10)}`;
      const { data, error } = await sb
        .from("cluster4_lines")
        .insert({
          part_type: "experience",
          main_title: UNIFIED_MAIN_TITLE,
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
      if (error || !data) throw new Error(`라인 INSERT 실패 (${ws}): ${error?.message}`);
      lineIdByWeekStart.set(ws, (data as any).id);
      log.insertedLines.push({ weekStart: ws, id: (data as any).id });
    }
    console.log(`통합 라인 준비: ${lineIdByWeekStart.size}주차 (신규 ${log.insertedLines.length})`);
  }
  const unifiedLineIds = new Set(lineIdByWeekStart.values());

  // C. uws 상태 변경 (status 그룹별 .in(id))
  {
    const byAfter = new Map<string, string[]>();
    for (const c of uwsChanges) {
      if (!byAfter.has(c.after)) byAfter.set(c.after, []);
      byAfter.get(c.after)!.push(c.id);
    }
    for (const [after, ids] of byAfter) {
      for (const c of chunk(ids, 200)) {
        const { error } = await sb
          .from("user_week_statuses")
          .update({ status: after, updated_at: new Date().toISOString() })
          .in("id", c);
        if (error) throw new Error(`uws UPDATE(${after}) 실패: ${error.message}`);
      }
    }
    // 졸업 스팬 확장 insert
    const insertRows = uwsInserts.map((c) => {
      const w = weekByStart.get(c.weekStart)!;
      return {
        user_id: c.userId,
        year: w.iso_year,
        week_number: w.iso_week,
        week_start_date: c.weekStart,
        season_key: w.season_key,
        status: c.status,
        is_official_rest_override: false,
      };
    });
    for (const c of chunk(insertRows, 200)) {
      const { error } = await sb.from("user_week_statuses").insert(c);
      if (error) throw new Error(`uws INSERT 실패: ${error.message}`);
    }
    // activity_started_at 확장 (졸업 트랙 테스터만)
    for (const a of activityStartChanges) {
      if (!testerIds.has(a.userId)) throw new Error(`activity_started_at 변경에 비테스터: ${a.userId}`);
      const { error } = await sb
        .from("user_profiles")
        .update({ activity_started_at: "2025-09-01" })
        .eq("user_id", a.userId);
      if (error) throw new Error(`activity_started_at UPDATE 실패(${a.userId}): ${error.message}`);
    }
    console.log(
      `uws 변경 적용: ${uwsChanges.length}건 + insert ${uwsInserts.length}건 | activity_started_at ${activityStartChanges.length}명`,
    );
    log.uwsInserts = uwsInserts;
    log.activityStartChanges = activityStartChanges;
  }

  // D. growth_status → graduated
  for (const g of gradChanges) {
    if (!testerIds.has(g.userId)) throw new Error(`graduated 변경에 비테스터: ${g.userId}`);
    const { error } = await sb
      .from("user_profiles")
      .update({ growth_status: "graduated" })
      .eq("user_id", g.userId);
    if (error) throw new Error(`growth_status UPDATE 실패(${g.userId}): ${error.message}`);
  }
  console.log(`growth_status 적용: ${gradChanges.length}명`);

  // E. 타깃 ensure (배치 insert, 중복은 사전 필터)
  const targetIdByUserWeek = new Map<string, string>(); // `${uid}|${ws}` → target id
  {
    // 기존 통합 타깃
    const { data: existing } = await sb
      .from("cluster4_line_targets")
      .select("id,week_id,target_user_id,line_id")
      .in("line_id", [...unifiedLineIds]);
    for (const t of (existing ?? []) as any[]) {
      const w = weekById.get(t.week_id);
      if (w && t.target_user_id) targetIdByUserWeek.set(`${t.target_user_id}|${w.start_date}`, t.id);
    }
    const rows: any[] = [];
    for (const t of targetPlans) {
      if (targetIdByUserWeek.has(`${t.userId}|${t.weekStart}`)) continue;
      const lineId = lineIdByWeekStart.get(t.weekStart);
      const w = weekByStart.get(t.weekStart);
      if (!lineId || !w) continue;
      rows.push({
        line_id: lineId,
        week_id: w.id,
        target_mode: "user",
        target_user_id: t.userId,
        target_rule: {},
        created_by: ADMIN_ID,
        updated_by: ADMIN_ID,
      });
    }
    for (const c of chunk(rows, 200)) {
      const { data, error } = await sb.from("cluster4_line_targets").insert(c).select("id,week_id,target_user_id");
      if (error) throw new Error(`타깃 INSERT 실패: ${error.message}`);
      for (const t of (data ?? []) as any[]) {
        const w = weekById.get(t.week_id);
        if (w && t.target_user_id) targetIdByUserWeek.set(`${t.target_user_id}|${w.start_date}`, t.id);
        log.insertedTargets.push(t.id);
      }
    }
    console.log(`타깃 적용: 신규 ${log.insertedTargets.length} (총 ${targetIdByUserWeek.size})`);
  }

  // F. 테스터 더미 제출 + 평가
  {
    const allTargetIds = [...targetIdByUserWeek.values()];
    const existingSubTargets = new Set<string>();
    const existingEvalTargets = new Set<string>();
    for (const c of chunk(allTargetIds, 150)) {
      const subs = await pageAll<any>("cluster4_line_submissions", "id,line_target_id", (q) =>
        q.in("line_target_id", c),
      );
      for (const s of subs) existingSubTargets.add(s.line_target_id);
      const evals = await pageAll<any>("cluster4_experience_line_evaluations", "id,line_target_id", (q) =>
        q.in("line_target_id", c),
      );
      for (const e of evals) existingEvalTargets.add(e.line_target_id);
    }

    const subRows: any[] = [];
    const evalRows: any[] = [];
    for (const t of targetPlans) {
      if (!t.isTester) continue;
      const targetId = targetIdByUserWeek.get(`${t.userId}|${t.weekStart}`);
      if (!targetId) continue;
      const rng = mulberry32(fnv1a(`${t.userId}|${t.weekStart}|content`));
      if (!existingSubTargets.has(targetId)) {
        const tpl = GROWTH_POINT_TEMPLATES[Math.floor(rng() * GROWTH_POINT_TEMPLATES.length)];
        subRows.push({
          line_target_id: targetId,
          user_id: t.userId,
          subtitle: UNIFIED_SUBTITLE,
          growth_point: tpl,
          submitted_at: new Date(
            new Date(weekClosesAtIso(t.weekStart)).getTime() - (10 + Math.floor(rng() * 30)) * 3_600_000,
          ).toISOString(),
        });
      }
      if (!existingEvalTargets.has(targetId)) {
        const rating = t.success ? 4 + Math.floor(rng() * 7) : 1 + Math.floor(rng() * 3); // 4~10 / 1~3
        evalRows.push({
          line_target_id: targetId,
          user_id: t.userId,
          rating,
          evaluated_by: ADMIN_ID,
          evaluated_at: weekClosesAtIso(t.weekStart),
        });
      }
    }
    for (const c of chunk(subRows, 200)) {
      const { error } = await sb.from("cluster4_line_submissions").insert(c);
      if (error) throw new Error(`제출 INSERT 실패: ${error.message}`);
      log.insertedSubmissions += c.length;
    }
    for (const c of chunk(evalRows, 200)) {
      const { error } = await sb.from("cluster4_experience_line_evaluations").insert(c);
      if (error) throw new Error(`평가 INSERT 실패: ${error.message}`);
      log.insertedEvals += c.length;
    }
    console.log(`제출 ${log.insertedSubmissions} / 평가 ${log.insertedEvals} 생성`);
  }

  // F2. 실사용자 기존 제출 내용 → 통합 타깃 복사 (있을 때만)
  if (!PILOT_USER) {
    const realIds = [...new Set(realSuccess.map((r) => r.userId))];
    const oldTargetIds = existingTargets
      .filter((t) => t.target_user_id && realIds.includes(t.target_user_id) && !unifiedLineIds.has(t.line_id))
      .map((t) => t.id);
    let migrated = 0;
    for (const c of chunk(oldTargetIds, 150)) {
      const subs = await pageAll<any>(
        "cluster4_line_submissions",
        "id,line_target_id,user_id,subtitle,growth_point,output_link_2,output_link_3,output_link_4,output_link_5,output_links,output_images,submitted_at",
        (q) => q.in("line_target_id", c),
      );
      for (const s of subs) {
        const oldTarget = existingTargets.find((t) => t.id === s.line_target_id);
        const w = oldTarget ? weekById.get(oldTarget.week_id) : null;
        if (!w) continue;
        const newTargetId = targetIdByUserWeek.get(`${s.user_id}|${w.start_date}`);
        if (!newTargetId) {
          console.log(`  (실유저 제출 이관 보류 — 통합 타깃 없음: user=${s.user_id} week=${w.start_date})`);
          continue;
        }
        const { data: dup } = await sb
          .from("cluster4_line_submissions")
          .select("id")
          .eq("line_target_id", newTargetId)
          .eq("user_id", s.user_id)
          .maybeSingle();
        if (dup) continue;
        const { error } = await sb.from("cluster4_line_submissions").insert({
          line_target_id: newTargetId,
          user_id: s.user_id,
          subtitle: s.subtitle ?? UNIFIED_SUBTITLE,
          growth_point: s.growth_point,
          output_link_2: s.output_link_2,
          output_link_3: s.output_link_3,
          output_link_4: s.output_link_4,
          output_link_5: s.output_link_5,
          output_links: s.output_links,
          output_images: s.output_images,
          submitted_at: s.submitted_at,
        });
        if (error) console.warn(`  실유저 제출 이관 실패(user=${s.user_id}): ${error.message}`);
        else migrated += 1;
      }
    }
    console.log(`실사용자 제출 이관: ${migrated}건`);
    log.migratedRealSubmissions = migrated;
  }

  // G. 클린업: 테스터의 비통합 레거시 타깃 삭제 (row 전체 로그 보존)
  {
    const planUserSet = new Set(planTesterIds);
    const toDelete = existingTargets.filter(
      (t) =>
        t.target_user_id &&
        planUserSet.has(t.target_user_id) &&
        !unifiedLineIds.has(t.line_id),
    );
    for (const c of chunk(toDelete.map((t) => t.id), 200)) {
      const { error } = await sb.from("cluster4_line_targets").delete().in("id", c);
      if (error) throw new Error(`타깃 DELETE 실패: ${error.message}`);
    }
    log.deletedTargets = toDelete;
    console.log(`테스터 비통합 타깃 삭제: ${toDelete.length}건`);
  }

  // H. user_growth_stats 재계산 (테스터)
  {
    let done = 0;
    for (const c of chunk(planTesterIds, 8)) {
      await Promise.all(
        c.map(async (id) => {
          try {
            await recalcUserGrowthStats(id);
          } catch (e) {
            console.warn(`  recalcUserGrowthStats 실패(${id}):`, (e as Error).message);
          }
        }),
      );
      done += c.length;
      if (done % 24 === 0) console.log(`  growth_stats 재계산 ${done}/${planTesterIds.length}`);
    }
    console.log(`growth_stats 재계산 완료: ${planTesterIds.length}명`);
  }

  // 로그 기록
  const fileLog = existsSync(LOG_PATH) ? JSON.parse(readFileSync(LOG_PATH, "utf8")) : { runs: [] };
  fileLog.runs.push(log);
  writeFileSync(LOG_PATH, JSON.stringify(fileLog, null, 2));
  console.log(`\n로그 기록: ${LOG_PATH}`);
  console.log("⚠ 다음 단계: 스냅샷 전수 재계산 (npm run backfill:weekly-card-snapshots)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
