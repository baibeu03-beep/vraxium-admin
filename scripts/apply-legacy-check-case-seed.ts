/**
 * 레거시 통합 라인 check 게이트 — 더미 테스터 4케이스 시드 (2026-06-05 정책 정정).
 *
 *   npx tsx --env-file=.env.local scripts/apply-legacy-check-case-seed.ts            # dry-run
 *   npx tsx --env-file=.env.local scripts/apply-legacy-check-case-seed.ts --apply    # 실반영
 *
 * 정책:
 *   강화 성공 = [통합] 라인 평점 4점 이상. 주차 성공 = 평점 4점 이상 AND
 *   그 주차 point.check(user_weekly_points.points) >= 기준값(weeks.check_threshold ?? 30).
 *
 * 시드 원칙 — user_week_statuses(주차 SoT)는 절대 변경하지 않는다(졸업/누적 분포 보존):
 *   uws=success 주차 → 케이스 A: 평점 4~10 보장 + check >= 기준값.
 *   uws=fail    주차 → 결정적 PRNG 로 분기:
 *     케이스 B(40%): 평점 4~10 으로 갱신(강화 성공) + check < 기준값  → 강화 성공 / 주차 실패
 *     케이스 C(30%): 평점 1~3 유지/갱신                + check >= 기준값 → 강화 실패 / 주차 실패
 *     케이스 D(30%): 평점 1~3 유지/갱신                + check < 기준값  → 강화 실패 / 주차 실패
 *   휴식(personal/official_rest)·전환 주차·통합 타깃 없는 주차는 건너뛴다.
 *
 * 실사용자 보호: 모든 쓰기는 test_user_markers 의 user_id 로만 향한다 — 코드 레벨 assert.
 *   추가로 실사용자 영향 감사(read-only): uws=success 레거시 주차에서 check < 기준값이라
 *   read-time 판정이 fail 로 표시될 실사용자 주차를 리포트한다(데이터 변경 없음).
 *
 * 멱등: rating/points 모두 (user_id|week_start) 시드 PRNG 결정값 — 재실행 시 동일 결과.
 * 적용 후: 테스터 weekly-cards snapshot 일괄 재계산 (read-time 판정 반영).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import {
  CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
  LEGACY_UNIFIED_LINE_NAME,
} from "@/lib/lineAvailability";
import { DEFAULT_WEEK_CHECK_THRESHOLD } from "@/lib/cluster4Enhancement";
import { isTransitionWeekStart } from "@/lib/seasonCalendar";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const APPLY = process.argv.includes("--apply");
const LOG_PATH = "claudedocs/legacy-check-case-seed-20260605.json";

// ── 결정적 PRNG (v17 마이그레이션과 동일 구현) ─────────────────────────
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

function pageAll<T>(
  table: string,
  select: string,
  filter?: (q: any) => any,
  orderCol = "id",
): Promise<T[]> {
  return (async () => {
    const out: T[] = [];
    for (let from = 0; ; from += 1000) {
      let q = sb
        .from(table)
        .select(select)
        .order(orderCol, { ascending: true })
        .range(from, from + 999);
      if (filter) q = filter(q);
      const { data, error } = await q;
      if (error) throw new Error(`${table}: ${error.message}`);
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

type WeekRow = {
  id: string;
  start_date: string;
  season_key: string | null;
  week_number: number | null;
  iso_year: number | null;
  iso_week: number | null;
  check_threshold?: number | null;
};
type UwsRow = {
  user_id: string;
  week_start_date: string;
  status: string;
};
type TargetRow = {
  id: string;
  week_id: string;
  line_id: string;
  target_mode: string;
  target_user_id: string | null;
};
type EvalRow = { id: string; line_target_id: string; user_id: string; rating: number };
type PointsRow = { user_id: string; year: number; week_number: number; points: number };

type Case = "A" | "B" | "C" | "D";

async function main() {
  console.log(`모드: ${APPLY ? "APPLY" : "DRY-RUN"} | 레거시 경계 < ${CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM}`);

  // ── 0. 로드 ──────────────────────────────────────────────────────────
  let weeks: WeekRow[];
  try {
    weeks = await pageAll<WeekRow>(
      "weeks",
      "id,start_date,season_key,week_number,iso_year,iso_week,check_threshold",
      (q) => q.lt("start_date", CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM),
    );
  } catch (e) {
    throw new Error(
      `weeks 로드 실패 — check_threshold 컬럼이 없으면 db/migrations/2026-06-05_weeks_check_threshold.sql 을 먼저 적용하세요: ${e instanceof Error ? e.message : e}`,
    );
  }
  const weekById = new Map(weeks.map((w) => [w.id, w]));
  const weekByStart = new Map(weeks.map((w) => [w.start_date, w]));

  const { data: markerRows, error: markerErr } = await sb
    .from("test_user_markers")
    .select("user_id");
  if (markerErr) throw new Error(`test_user_markers: ${markerErr.message}`);
  const testerIds = new Set((markerRows ?? []).map((m: any) => m.user_id as string));
  console.log(`레거시 주차: ${weeks.length} | 테스터: ${testerIds.size}`);

  // 통합 마스터/라인/타깃
  const { data: master } = await sb
    .from("cluster4_experience_line_masters")
    .select("id")
    .eq("line_name", LEGACY_UNIFIED_LINE_NAME)
    .limit(1)
    .maybeSingle();
  if (!master) throw new Error("통합 마스터 미생성 — v17 마이그레이션을 먼저 적용하세요.");
  const lines = await pageAll<{ id: string }>(
    "cluster4_lines",
    "id",
    (q) => q.eq("experience_line_master_id", (master as any).id).eq("is_active", true),
  );
  const lineIds = lines.map((l) => l.id);
  const targets: TargetRow[] = [];
  for (const c of chunk(lineIds, 100)) {
    targets.push(
      ...(await pageAll<TargetRow>(
        "cluster4_line_targets",
        "id,week_id,line_id,target_mode,target_user_id",
        (q) => q.in("line_id", c).eq("target_mode", "user"),
      )),
    );
  }
  console.log(`통합 라인: ${lineIds.length} | user 타깃: ${targets.length}`);

  // 테스터 uws (레거시 범위)
  const uwsAll = await pageAll<UwsRow>(
    "user_week_statuses",
    "user_id,week_start_date,status",
    (q) => q.lt("week_start_date", CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM),
  );
  const uwsByUserWeek = new Map<string, string>();
  for (const r of uwsAll) uwsByUserWeek.set(`${r.user_id}|${r.week_start_date}`, r.status);

  // 평가 (통합 타깃 한정)
  const targetIds = targets.map((t) => t.id);
  const evals: EvalRow[] = [];
  for (const c of chunk(targetIds, 100)) {
    evals.push(
      ...(await pageAll<EvalRow>(
        "cluster4_experience_line_evaluations",
        "id,line_target_id,user_id,rating",
        (q) => q.in("line_target_id", c),
      )),
    );
  }
  const evalByTarget = new Map(evals.map((e) => [e.line_target_id, e]));

  // ── 1. 케이스 계획 ───────────────────────────────────────────────────
  type Plan = {
    userId: string;
    weekStart: string;
    isoYear: number;
    isoWeek: number;
    targetId: string;
    uwsStatus: string;
    threshold: number;
    case: Case;
    rating: number; // 목표 평점
    points: number; // 목표 check
    currentRating: number | null;
  };
  const plans: Plan[] = [];
  const realUserAudit: {
    userId: string;
    weekStart: string;
    threshold: number;
  }[] = [];

  // 실사용자 감사용 points 선로드 대상 수집
  const realSuccessKeys: { userId: string; week: WeekRow }[] = [];

  for (const t of targets) {
    const uid = t.target_user_id;
    if (!uid) continue;
    const week = weekById.get(t.week_id);
    if (!week) continue;
    if (isTransitionWeekStart(week.start_date)) continue;
    if (week.iso_year == null || week.iso_week == null) continue;
    const status = uwsByUserWeek.get(`${uid}|${week.start_date}`);
    if (status !== "success" && status !== "fail") continue; // 휴식/uws 없음 → 건너뜀

    if (!testerIds.has(uid)) {
      if (status === "success") realSuccessKeys.push({ userId: uid, week });
      continue; // 실사용자 — 쓰기 금지
    }

    const threshold = week.check_threshold ?? DEFAULT_WEEK_CHECK_THRESHOLD;
    const rng = mulberry32(fnv1a(`${uid}|${week.start_date}|checkcase`));
    let kase: Case;
    let rating: number;
    let points: number;
    if (status === "success") {
      kase = "A";
      rating = 4 + Math.floor(rng() * 7); // 4~10
      points = threshold + Math.floor(rng() * 15); // >= 기준
    } else {
      const r = rng();
      if (r < 0.4) {
        kase = "B";
        rating = 4 + Math.floor(rng() * 7); // 강화 성공
        points = Math.max(0, Math.floor(threshold * 0.3) + Math.floor(rng() * threshold * 0.6)); // < 기준
      } else if (r < 0.7) {
        kase = "C";
        rating = 1 + Math.floor(rng() * 3); // 1~3
        points = threshold + Math.floor(rng() * 15); // >= 기준
      } else {
        kase = "D";
        rating = 1 + Math.floor(rng() * 3);
        points = Math.floor(rng() * threshold * 0.5); // < 기준
      }
      if (points >= threshold && (kase === "B" || kase === "D")) {
        points = Math.max(0, threshold - 1); // 방어: 반드시 기준 미달
      }
    }
    const cur = evalByTarget.get(t.id);
    // 케이스 조건을 이미 충족하는 평점은 보존(분산 유지) — 미충족 시에만 교체.
    if (cur) {
      const passNeeded = kase === "A" || kase === "B";
      const curPass = cur.rating >= 4;
      if (curPass === passNeeded) rating = cur.rating;
    }
    plans.push({
      userId: uid,
      weekStart: week.start_date,
      isoYear: week.iso_year,
      isoWeek: week.iso_week,
      targetId: t.id,
      uwsStatus: status,
      threshold,
      case: kase,
      rating,
      points,
      currentRating: cur?.rating ?? null,
    });
  }

  const caseCounts: Record<Case, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const p of plans) caseCounts[p.case]++;
  console.log(
    `테스터 계획: ${plans.length}건 | A=${caseCounts.A} B=${caseCounts.B} C=${caseCounts.C} D=${caseCounts.D}`,
  );
  if (plans.length > 0 && (caseCounts.A === 0 || caseCounts.B === 0 || caseCounts.C === 0 || caseCounts.D === 0)) {
    console.warn("⚠ 일부 케이스가 0건 — 분포 확인 필요");
  }

  // 조직별 분포 리포트
  {
    const profiles = await (async () => {
      const ids = [...new Set(plans.map((p) => p.userId))];
      const out = new Map<string, string>();
      for (const c of chunk(ids, 150)) {
        const rows = await pageAll<{ user_id: string; organization_slug: string | null }>(
          "user_profiles",
          "user_id,organization_slug",
          (q) => q.in("user_id", c),
          "user_id",
        );
        for (const r of rows) out.set(r.user_id, r.organization_slug ?? "unknown");
      }
      return out;
    })();
    const byOrg = new Map<string, Record<Case, number>>();
    for (const p of plans) {
      const org = profiles.get(p.userId) ?? "unknown";
      if (!byOrg.has(org)) byOrg.set(org, { A: 0, B: 0, C: 0, D: 0 });
      byOrg.get(org)![p.case]++;
    }
    for (const [org, c] of byOrg) {
      console.log(`  org=${org}: A=${c.A} B=${c.B} C=${c.C} D=${c.D}`);
    }
  }

  // ── 2. 실사용자 영향 감사 (read-only) ─────────────────────────────────
  if (realSuccessKeys.length > 0) {
    const realIds = [...new Set(realSuccessKeys.map((r) => r.userId))];
    const pointsRows: PointsRow[] = [];
    for (const c of chunk(realIds, 100)) {
      pointsRows.push(
        ...(await pageAll<PointsRow>(
          "user_weekly_points",
          "user_id,year,week_number,points",
          (q) => q.in("user_id", c),
          "user_id",
        )),
      );
    }
    const ptsByKey = new Map(
      pointsRows.map((p) => [`${p.user_id}|${p.year}-${p.week_number}`, p.points]),
    );
    for (const { userId, week } of realSuccessKeys) {
      const threshold = week.check_threshold ?? DEFAULT_WEEK_CHECK_THRESHOLD;
      const pts = ptsByKey.get(`${userId}|${week.iso_year}-${week.iso_week}`) ?? 0;
      if (pts < threshold) {
        realUserAudit.push({ userId, weekStart: week.start_date, threshold });
      }
    }
    console.log(
      `실사용자 감사: uws=success 레거시 주차 ${realSuccessKeys.length}건 중 check<기준 → 표시상 주차 실패로 바뀌는 건: ${realUserAudit.length}`,
    );
    for (const a of realUserAudit.slice(0, 20)) {
      console.log(`  ⚠ real user ${a.userId} | ${a.weekStart} | 기준 ${a.threshold}`);
    }
  }

  // ── 3. 쓰기 ──────────────────────────────────────────────────────────
  const log = {
    mode: APPLY ? "apply" : "dry-run",
    generatedAt: new Date().toISOString(),
    caseCounts,
    planCount: plans.length,
    ratingUpdates: 0,
    evalInserts: 0,
    pointsUpserts: 0,
    realUserAudit,
    plans: plans.map((p) => ({
      userId: p.userId,
      weekStart: p.weekStart,
      case: p.case,
      uwsStatus: p.uwsStatus,
      threshold: p.threshold,
      rating: p.rating,
      points: p.points,
      prevRating: p.currentRating,
    })),
  };

  if (!APPLY) {
    writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
    console.log(`DRY-RUN 완료 — 로그: ${LOG_PATH}`);
    return;
  }

  // 실사용자 보호 assert
  for (const p of plans) {
    if (!testerIds.has(p.userId)) {
      throw new Error(`ASSERT: 비테스터 쓰기 시도 차단 — ${p.userId}`);
    }
  }

  // 3a. 평점 갱신/삽입
  const ADMIN_ID = "c28b2409-4118-49fc-a42e-68e18dbd194c";
  for (const p of plans) {
    const cur = evalByTarget.get(p.targetId);
    if (cur) {
      if (cur.rating !== p.rating) {
        const { error } = await sb
          .from("cluster4_experience_line_evaluations")
          .update({ rating: p.rating })
          .eq("id", cur.id);
        if (error) throw new Error(`평가 UPDATE 실패(${p.userId}|${p.weekStart}): ${error.message}`);
        log.ratingUpdates++;
      }
    } else {
      const { error } = await sb.from("cluster4_experience_line_evaluations").insert({
        line_target_id: p.targetId,
        user_id: p.userId,
        rating: p.rating,
        evaluated_by: ADMIN_ID,
        evaluated_at: new Date().toISOString(),
      });
      if (error) throw new Error(`평가 INSERT 실패(${p.userId}|${p.weekStart}): ${error.message}`);
      log.evalInserts++;
    }
  }

  // 3b. points upsert (UNIQUE user_id,year,week_number — points 만 갱신, advantage/penalty 불변)
  //   checks_migrated=true: 테스터 행은 "이관 완료" 취급 → check 게이트 강제(enforce) 대상.
  for (const c of chunk(plans, 200)) {
    const rows = c.map((p) => ({
      user_id: p.userId,
      year: p.isoYear,
      week_number: p.isoWeek,
      week_start_date: p.weekStart,
      points: p.points,
      checks_migrated: true,
    }));
    const { error } = await sb
      .from("user_weekly_points")
      .upsert(rows, { onConflict: "user_id,year,week_number" });
    if (error) throw new Error(`points UPSERT 실패: ${error.message}`);
    log.pointsUpserts += rows.length;
  }

  console.log(
    `쓰기 완료 — 평점 갱신 ${log.ratingUpdates} / 삽입 ${log.evalInserts} / points upsert ${log.pointsUpserts}`,
  );

  // 3c. 테스터 snapshot 일괄 재계산 (read-time 판정 반영)
  const affected = [...new Set(plans.map((p) => p.userId))];
  console.log(`snapshot 재계산: ${affected.length}명...`);
  const r = await recomputeWeeklyCardsSnapshotsForUsers(affected, { concurrency: 4 });
  console.log(`snapshot 재계산 결과: ${r.recomputed}/${r.requested} (실패 ${r.failed})`);

  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
  console.log(`APPLY 완료 — 로그: ${LOG_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
