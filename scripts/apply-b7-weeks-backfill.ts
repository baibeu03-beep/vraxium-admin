/**
 * B7 apply — seasons(uuid)·weeks 백필 적용기 (dry-run plan 소비형).
 *
 *   npx tsx --env-file=.env.local scripts/apply-b7-weeks-backfill.ts            # preview (쓰기 0)
 *   npx tsx --env-file=.env.local scripts/apply-b7-weeks-backfill.ts --apply    # 실제 적용
 *   npx tsx --env-file=.env.local scripts/apply-b7-weeks-backfill.ts --rollback claudedocs/b7-apply-<ts>.json
 *
 * 계약 (2026-06-06 운영 확정 반영):
 *   - 입력 = claudedocs/backfill-seasons-weeks-dryrun-20260605.json 의 plan 행 그대로 실행
 *     (재계산 없음 — 검토된 산출물이 실행 계약. plan↔live drift 검출 시 전체 중단, 재dry-run 요구).
 *   - seasons: insert 12 (이름 기준 존재 확인 멱등). 기존 42주의 season_id 재배선 없음 (quirk 보존).
 *     season_index 는 testUsers.resolveCurrentSeasonName 의 최후순위 tiebreaker 로만 소비 —
 *     신설 행은 started_at 시간순 2..N 부여 (현재 시즌 해석 불변: 전부 ended_at 보유·과거 started_at).
 *   - weeks insert 111: 라이브 컨벤션 미러 (week_index=iso_week, started_at/ended_at=date 00:00Z).
 *   - weeks update 25: plan.diff 에 있는 컬럼만 PATCH (check_threshold·holiday_name·is_official_rest).
 *     prior 값 가드(.is/.eq) — 갱신 행수 1 검증.
 *   - conflict 7행: 적용하지 않음 (라이브 보존) — 수동 확정 큐 그대로.
 *   - result_published_at: payload 빌더에 키 자체가 없음 (비가역 — 기존 PATCH publish-result 경로 전용).
 *   - 2026-winter W8 = 공식 휴식 (운영 확정, 06-05 fix 로 이미 적용) — 무회귀 가드만 수행, 본 적용은 무접촉.
 *   - apply 후 snapshot 명시 재계산: checks_migrated=true 행 보유 사용자 전원
 *     (checkGate.required 가 snapshot 에 구워짐 — 기존 '원장 직접수정 시 명시 재계산' 룰 그대로).
 *   - uws/uwp/라인/DTO/API 일절 무접촉. demoUserId 경로 영향 없음 (조회대상 override only).
 *   - 롤백: run log 의 insertedWeekIds/insertedSeasonIds 삭제 + updatedRows prior 복원 + snapshot 재계산.
 */
import { readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import {
  assertProtectedPublishWrite,
  assertSummerW58PublishGuard,
  PROTECTED_SUMMER_STARTS,
} from "@/lib/summerWeeksPublishGuard";

const PLAN_PATH = "claudedocs/backfill-seasons-weeks-dryrun-20260605.json";
const APPLY = process.argv.includes("--apply");
const rollbackIdx = process.argv.indexOf("--rollback");
const ROLLBACK_LOG = rollbackIdx >= 0 ? process.argv[rollbackIdx + 1] : null;
if (APPLY && ROLLBACK_LOG) throw new Error("--apply 와 --rollback 동시 지정 불가");

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// ── 라이브 컨벤션 미러 ───────────────────────────────────────────────────
// week_index = iso_week, started_at/ended_at = date 00:00Z (라이브 표본 실측 2026-06-06).
function isoWeekOf(dateIso: string): { isoYear: number; isoWeek: number } {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const day = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // 그 주의 목요일
  const isoYear = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
  return { isoYear, isoWeek };
}
const tsOf = (dateIso: string) => `${dateIso}T00:00:00+00:00`;

type PlanWeekRow = {
  start: string;
  end: string;
  season: string; // season_key
  week: number;
  threshold: number | null;
  rest: boolean;
  holiday: string | null;
  action: "insert" | "update" | "conflict" | "noop";
  diff: Record<string, { live: unknown; plan: unknown }> | null;
};
type PlanSeasonRow = {
  season_key: string;
  name: string;
  exists: boolean;
  action: "insert" | "noop";
  started_at: string;
  ended_at: string;
};
type LiveWeek = {
  id: string;
  start_date: string;
  season_key: string | null;
  week_number: number | null;
  check_threshold: number | null;
  holiday_name: string | null;
  is_official_rest: boolean;
  result_published_at: string | null;
};

// update 대상 컬럼 화이트리스트 — 이외 diff 키는 적용 거부 (season_key/week_number 충돌 등).
const UPDATABLE = new Set(["check_threshold", "holiday_name", "is_official_rest"]);

// 병행 작업 산출물 스킵 (2026-06-06): apply-tester-summer-weeks.ts 가 졸업 테스터 충족용으로
// 2025-summer W1~8 을 의도적으로 생성 (check_threshold=0·publish 세팅 — 합성 주차 설계).
// plan(06-05)의 동일 주차 insert 와 충돌 → conflict 와 동일하게 스킵(라이브 보존)·리포트.
// pms 기대값(confirmStar 24/24/34/34/37/37/35/37·미공표)은 실사용자 이관 단계에서 재결정 —
// 테스터는 해당 주차 uwp 행이 없어 enforced=false (threshold 값 무관).
const CONCURRENT_SKIP_STARTS = new Set([
  "2025-06-30", "2025-07-07", "2025-07-14", "2025-07-21",
  "2025-07-28", "2025-08-04", "2025-08-11", "2025-08-18",
]);

async function fetchAllWeeks(): Promise<LiveWeek[]> {
  const out: LiveWeek[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("weeks")
      .select(
        "id,start_date,season_key,week_number,check_threshold,holiday_name,is_official_rest,result_published_at",
      )
      .order("start_date", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`weeks 조회 실패: ${error.message}`);
    out.push(...((data ?? []) as LiveWeek[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function fetchCmUserIds(): Promise<string[]> {
  const ids = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("user_weekly_points")
      .select("user_id")
      .eq("checks_migrated", true)
      .order("user_id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`uwp cm 조회 실패: ${error.message}`);
    for (const r of (data ?? []) as { user_id: string }[]) ids.add(r.user_id);
    if (!data || data.length < 1000) break;
  }
  return [...ids];
}

async function recomputeSnapshots(userIds: string[], label: string) {
  console.log(`\n[snapshot] ${label} — ${userIds.length}명 재계산 시작`);
  let ok = 0;
  const failed: string[] = [];
  for (const uid of userIds) {
    try {
      await recomputeAndStoreWeeklyCardsSnapshot(uid);
      ok++;
      if (ok % 10 === 0) console.log(`  ...${ok}/${userIds.length}`);
    } catch (e) {
      failed.push(uid);
      console.error(`  ❌ snapshot 재계산 실패 ${uid}:`, (e as Error).message);
    }
  }
  console.log(`[snapshot] 완료 ${ok}/${userIds.length}${failed.length ? ` (실패 ${failed.length})` : ""}`);
  return { ok, failed };
}

// ════════════════ 롤백 모드 ════════════════
async function rollback(logPath: string) {
  const log = JSON.parse(readFileSync(logPath, "utf8"));
  console.log(`══ B7 롤백 — ${logPath} (적용 시각 ${log.appliedAt}) ══`);
  if (!log.applied) throw new Error("run log 가 적용 기록이 아님 (preview 로그?)");

  // 1. 갱신 복원 (prior 값으로) — 현재값이 plan 값일 때만 (가드)
  let restored = 0;
  for (const u of log.updatedRows as {
    weekId: string;
    start: string;
    col: string;
    prior: unknown;
    applied: unknown;
  }[]) {
    // 보호 구간 publish 쓰기 의도 차단 (rollback 경로 포함 이중 방어).
    assertProtectedPublishWrite({ start: u.start, col: u.col, value: u.prior });
    let q = sb.from("weeks").update({ [u.col]: u.prior }).eq("id", u.weekId);
    // 현재값 가드: 적용값과 다르면(이후 수동 변경) 건드리지 않음
    q = u.applied === null ? q.is(u.col, null) : q.eq(u.col, u.applied as never);
    const { data, error } = await q.select("id");
    if (error) throw new Error(`롤백 갱신 실패 ${u.start} ${u.col}: ${error.message}`);
    if ((data ?? []).length === 1) restored++;
    else console.warn(`  ⚠️ ${u.start} ${u.col}: 현재값이 적용값과 달라 스킵 (수동 변경 추정)`);
  }
  console.log(`[rollback] 갱신 복원 ${restored}/${log.updatedRows.length}`);

  // 2. 삽입 삭제 (weeks → seasons 순서: FK)
  if (log.insertedWeekIds.length > 0) {
    const { data, error } = await sb
      .from("weeks")
      .delete()
      .in("id", log.insertedWeekIds)
      .select("id");
    if (error) throw new Error(`weeks 삭제 실패: ${error.message}`);
    console.log(`[rollback] weeks 삭제 ${(data ?? []).length}/${log.insertedWeekIds.length}`);
  }
  if (log.insertedSeasonIds.length > 0) {
    const { data, error } = await sb
      .from("seasons")
      .delete()
      .in("id", log.insertedSeasonIds)
      .select("id");
    if (error) throw new Error(`seasons 삭제 실패: ${error.message}`);
    console.log(`[rollback] seasons 삭제 ${(data ?? []).length}/${log.insertedSeasonIds.length}`);
  }

  // 3. snapshot 재계산 (threshold 원복 반영)
  const cm = await fetchCmUserIds();
  await recomputeSnapshots(cm, "롤백 후");
  console.log("\n✅ 롤백 완료 — 이관 전 상태 (검증: 주차 수·threshold NULL 복귀 확인 권장)");
}

// ════════════════ 메인 (preview / apply) ════════════════
async function main() {
  if (ROLLBACK_LOG) return rollback(ROLLBACK_LOG);

  const plan = JSON.parse(readFileSync(PLAN_PATH, "utf8"));
  const weekRows = plan.weeksPlan.rows as PlanWeekRow[];
  const seasonRows = plan.seasonsPlan.rows as PlanSeasonRow[];

  // ── 0. preflight — plan ↔ live drift 전수 검사 (fail-closed) ──
  // 2025-summer W5~8 publish 보호 가드 (2026-06-07 운영 확정 — 세션 간 덮어쓰기 재발 방지).
  //   현재 DB 가 기대값(start+7d published)과 다르면 dry-run 단계에서 즉시 중단.
  await assertSummerW58PublishGuard(sb);
  const live = await fetchAllWeeks();
  const liveByStart = new Map(live.map((w) => [w.start_date, w]));
  const drift: string[] = [];

  const concurrentSkips = weekRows.filter(
    (r) => r.action === "insert" && CONCURRENT_SKIP_STARTS.has(r.start),
  );
  const inserts = weekRows.filter(
    (r) => r.action === "insert" && !CONCURRENT_SKIP_STARTS.has(r.start),
  );
  const updates = weekRows.filter((r) => r.action === "update");
  const conflicts = weekRows.filter((r) => r.action === "conflict");

  // 병행 작업 산출물 검증: 스킵 대상 8행이 실제로 합성 주차 형태(2025-summer·threshold 0)인지 확인
  for (const r of concurrentSkips) {
    const lw = liveByStart.get(r.start);
    if (!lw) drift.push(`concurrent-skip ${r.start}: 라이브 부재 (tester-summer-weeks 산출물 기대)`);
    else if (lw.season_key !== "2025-summer" || lw.check_threshold !== 0)
      drift.push(`concurrent-skip ${r.start}: 합성 주차 형태 아님 (season=${lw.season_key}, thr=${lw.check_threshold})`);
  }
  for (const r of inserts) {
    if (liveByStart.has(r.start)) drift.push(`insert ${r.start}: 라이브에 이미 주차 존재`);
    // 보호 구간 insert 금지 — 행이 사라졌더라도 본 plan 으로 재생성하면 publish 가 NULL 로 들어간다.
    if (PROTECTED_SUMMER_STARTS.has(r.start))
      drift.push(`insert ${r.start}: 2025-summer W5~8 보호 구간 — fix-summer-w5-8-publish-restore 로만 복구`);
  }
  for (const r of updates) {
    const lw = liveByStart.get(r.start);
    if (!lw) {
      drift.push(`update ${r.start}: 라이브 주차 부재`);
      continue;
    }
    for (const [col, d] of Object.entries(r.diff ?? {})) {
      if (!UPDATABLE.has(col)) {
        drift.push(`update ${r.start}: 비허용 diff 컬럼 ${col}`);
        continue;
      }
      const cur = (lw as unknown as Record<string, unknown>)[col] ?? null;
      if (cur !== (d.live ?? null)) {
        drift.push(`update ${r.start}.${col}: plan 기준 live=${JSON.stringify(d.live)} ↔ 현재=${JSON.stringify(cur)}`);
      }
    }
  }
  // 운영 확정 가드: 2026-winter 휴식 플래그 = W8 단 1건 (06-05 fix 무회귀)
  const winterRest = live.filter((w) => w.season_key === "2026-winter" && w.is_official_rest);
  if (winterRest.length !== 1 || winterRest[0].week_number !== 8) {
    drift.push(`2026-winter 휴식 가드 실패: 기대 [W8], 실제 ${JSON.stringify(winterRest.map((w) => w.week_number))}`);
  }
  // 본 적용이 W8 을 건드리지 않음을 구조적으로 확인
  if ([...inserts, ...updates].some((r) => r.start === "2026-02-16")) {
    drift.push("plan 이 W8(2026-02-16) 을 쓰기 대상으로 포함 — 계약 위반");
  }

  // seasons preflight — 이름 기준 존재 확인 (seasons 에 season_key 컬럼 없음)
  const { data: liveSeasons, error: sErr } = await sb
    .from("seasons")
    .select("id,name,season_index,started_at,ended_at");
  if (sErr) throw new Error(`seasons 조회 실패: ${sErr.message}`);
  const liveSeasonByName = new Map((liveSeasons ?? []).map((s) => [s.name as string, s]));
  const seasonInserts = seasonRows.filter((r) => r.action === "insert");
  for (const r of seasonInserts) {
    if (liveSeasonByName.has(r.name)) drift.push(`season insert '${r.name}': 이미 존재`);
  }
  for (const r of seasonRows.filter((x) => x.action === "noop")) {
    if (!liveSeasonByName.has(r.name)) drift.push(`season noop '${r.name}': 라이브 부재`);
  }

  console.log("══ B7 apply preflight ══");
  console.log(`plan: insert ${inserts.length} / update ${updates.length} / conflict(스킵) ${conflicts.length} / 병행작업스킵 ${concurrentSkips.length} / noop ${weekRows.filter((r) => r.action === "noop").length}`);
  console.log(`seasons: insert ${seasonInserts.length} / noop ${seasonRows.length - seasonInserts.length}`);
  console.log(`라이브 weeks ${live.length}행 → 적용 후 기대 ${live.length + inserts.length}행`);
  console.log(`conflict 스킵 (라이브 보존·수동 확정 큐): ${conflicts.map((c) => c.start).join(", ")}`);
  console.log(`병행작업 스킵 (tester-summer-weeks 보존, pms 속성은 이관 단계 재결정): ${concurrentSkips.map((c) => c.start).join(", ")}`);
  if (drift.length > 0) {
    console.error(`\n❌ drift ${drift.length}건 — 중단 (dry-run 재생성 필요):`);
    for (const d of drift) console.error("  - " + d);
    process.exit(1);
  }
  console.log("✅ drift 0 — plan 과 라이브 정합");

  // ── 적용 페이로드 구성 (result_published_at 키 자체가 없음 — 구조적 제외) ──
  const seasonIdByKey = new Map<string, string>();
  const newSeasons = [...seasonInserts]
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .map((r, i) => {
      const id = randomUUID();
      seasonIdByKey.set(r.season_key, id);
      return {
        id,
        season_index: 2 + i, // 기존 2026-spring=1 무접촉 — index 는 최후순위 tiebreaker 로만 소비됨
        name: r.name,
        started_at: tsOf(r.started_at),
        ended_at: tsOf(r.ended_at),
      };
    });

  const newWeeks = inserts.map((r) => {
    const seasonId = seasonIdByKey.get(r.season);
    if (!seasonId) throw new Error(`insert ${r.start}: season ${r.season} 의 신설 id 없음 (plan 불일치)`);
    const { isoYear, isoWeek } = isoWeekOf(r.start);
    return {
      id: randomUUID(),
      season_id: seasonId,
      season_key: r.season,
      week_number: r.week,
      week_index: isoWeek, // 라이브 컨벤션: week_index = iso_week
      start_date: r.start,
      end_date: r.end,
      started_at: tsOf(r.start),
      ended_at: tsOf(r.end),
      iso_year: isoYear,
      iso_week: isoWeek,
      is_official_rest: r.rest,
      holiday_name: r.holiday,
      check_threshold: r.threshold,
      // result_published_at 없음 — publish 는 기존 PATCH publish-result(409 비가역) 경로 전용
    };
  });

  const updatePlans = updates.flatMap((r) => {
    const lw = liveByStart.get(r.start)!;
    return Object.entries(r.diff ?? {}).map(([col, d]) => ({
      weekId: lw.id,
      start: r.start,
      col,
      prior: d.live ?? null,
      applied: d.plan ?? null,
    }));
  });

  if (!APPLY) {
    console.log("\n── PREVIEW (쓰기 0) ──");
    console.log(`seasons insert ${newSeasons.length}:`, newSeasons.map((s) => `${s.name}(idx${s.season_index})`).join(", "));
    console.log(`weeks insert ${newWeeks.length} (앞 3):`, JSON.stringify(newWeeks.slice(0, 3), null, 1));
    console.log(`weeks update ${updatePlans.length}건 (컬럼 단위):`);
    for (const u of updatePlans) console.log(`  ${u.start} ${u.col}: ${JSON.stringify(u.prior)} → ${JSON.stringify(u.applied)}`);
    const cm = await fetchCmUserIds();
    console.log(`\napply 시 snapshot 재계산 대상 (checks_migrated=true 보유): ${cm.length}명`);
    console.log("\nDRY-RUN — 변경 없음. 적용하려면 --apply.");
    return;
  }

  // ════════════════ APPLY ════════════════
  const runLog: Record<string, unknown> = {
    appliedAt: new Date().toISOString(),
    applied: true,
    planPath: PLAN_PATH,
    insertedSeasonIds: [] as string[],
    insertedWeekIds: [] as string[],
    updatedRows: [] as unknown[],
    conflictsSkipped: conflicts.map((c) => ({ start: c.start, diff: c.diff })),
    concurrentSkipped: concurrentSkips.map((c) => ({
      start: c.start,
      pmsExpected: { threshold: c.threshold, rest: c.rest, pmsIsPublic: (c as any).pmsIsPublic ?? null },
      liveKept: "tester-summer-weeks 합성 주차 (threshold 0·publish 유지) — 이관 단계 재결정",
    })),
  };
  const logPath = `claudedocs/b7-apply-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
  const saveLog = () => writeFileSync(logPath, JSON.stringify(runLog, null, 1));

  // 1. seasons insert
  if (newSeasons.length > 0) {
    const { data, error } = await sb.from("seasons").insert(newSeasons).select("id");
    if (error) throw new Error(`seasons insert 실패: ${error.message}`);
    (runLog.insertedSeasonIds as string[]).push(...(data ?? []).map((r) => r.id as string));
    saveLog();
    console.log(`[1] seasons insert ${(data ?? []).length}/${newSeasons.length}`);
  }

  // 2. weeks insert (50개 chunk)
  for (let i = 0; i < newWeeks.length; i += 50) {
    const part = newWeeks.slice(i, i + 50);
    const { data, error } = await sb.from("weeks").insert(part).select("id");
    if (error) {
      saveLog();
      throw new Error(`weeks insert 실패 (chunk ${i / 50}): ${error.message} — 부분 적용 상태, 롤백: --rollback ${logPath}`);
    }
    (runLog.insertedWeekIds as string[]).push(...(data ?? []).map((r) => r.id as string));
    saveLog();
  }
  console.log(`[2] weeks insert ${(runLog.insertedWeekIds as string[]).length}/${newWeeks.length}`);

  // 3. weeks update — prior 값 가드 + 행수 1 검증
  for (const u of updatePlans) {
    // 보호 구간 publish 쓰기 의도 차단 (UPDATABLE 집합상 구조적으로 불가하지만 이중 방어).
    assertProtectedPublishWrite({ start: u.start, col: u.col, value: u.applied });
    let q = sb.from("weeks").update({ [u.col]: u.applied }).eq("id", u.weekId);
    q = u.prior === null ? q.is(u.col, null) : q.eq(u.col, u.prior as never);
    const { data, error } = await q.select("id");
    if (error) {
      saveLog();
      throw new Error(`weeks update 실패 ${u.start} ${u.col}: ${error.message} — 롤백: --rollback ${logPath}`);
    }
    if ((data ?? []).length !== 1) {
      saveLog();
      throw new Error(`weeks update ${u.start} ${u.col}: 갱신 행수 ${(data ?? []).length} (기대 1) — drift, 롤백: --rollback ${logPath}`);
    }
    (runLog.updatedRows as unknown[]).push(u);
    saveLog();
  }
  console.log(`[3] weeks update ${updatePlans.length}건`);

  // 4. 사후 검증 (쓰기 결과)
  const after = await fetchAllWeeks();
  const expectedTotal = live.length + newWeeks.length;
  if (after.length !== expectedTotal) {
    throw new Error(`사후 검증 실패: weeks ${after.length}행 (기대 ${expectedTotal})`);
  }
  const afterByStart = new Map(after.map((w) => [w.start_date, w]));
  for (const u of updatePlans) {
    const cur = (afterByStart.get(u.start) as unknown as Record<string, unknown>)[u.col] ?? null;
    if (cur !== u.applied) throw new Error(`사후 검증 실패: ${u.start} ${u.col} = ${JSON.stringify(cur)} (기대 ${JSON.stringify(u.applied)})`);
  }
  const published = after.filter((w) => w.result_published_at != null).length;
  const publishedBefore = live.filter((w) => w.result_published_at != null).length;
  if (published !== publishedBefore) {
    throw new Error(`사후 검증 실패: result_published_at 보유 ${publishedBefore} → ${published} (변동 금지)`);
  }
  const winterRestAfter = after.filter((w) => w.season_key === "2026-winter" && w.is_official_rest);
  if (winterRestAfter.length !== 1 || winterRestAfter[0].week_number !== 8) {
    throw new Error("사후 검증 실패: 2026-winter 휴식 ≠ [W8]");
  }
  console.log(`[4] 사후 검증 통과 — weeks ${after.length}행 · publish 변동 0 · winter 휴식 [W8] 유지`);

  // 5. snapshot 재계산 (checks_migrated=true 행 보유 사용자)
  const cm = await fetchCmUserIds();
  const snap = await recomputeSnapshots(cm, "apply 후");
  runLog.snapshotRecompute = { users: cm.length, ok: snap.ok, failed: snap.failed };
  saveLog();

  console.log(`\n✅ B7 apply 완료 — run log: ${logPath} (롤백: --rollback ${logPath})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
