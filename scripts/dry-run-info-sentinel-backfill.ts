/**
 * dry-run-info-sentinel-backfill.ts  (READ-ONLY · DRY-RUN)
 *
 * B안 정책: 엑셀 임포트/백필로 생성된 0-target info 라인에도 zeroTargetOpen sentinel 을 보장하여
 *   고객 weekly-cards 에서 "개설됨 + 미배정 = 전체 강화 실패"로 노출되게 한다(admin is_active 와 SoT 통일).
 *
 * 이 스크립트는 절대 write 하지 않는다. 적용 전 영향 범위를 산정·보고한다:
 *   1) sentinel 백필 대상 라인 수 (activity_type 별, calendar 분리)
 *   2) 영향 주차 (휴식주차 = restWeek 게이트로 실패 미발생 → 분리 집계)
 *   3) 실패 코호트 = 그 주차의 실제 활동 대상자(user_week_statuses 보유) ∩ 라인 org 가시 유저.
 *      → 기존 synthetic-fail 코호트(Step2)와 동일 산정. 가입 전/활동 전 주차는 uws 부재로 자동 제외.
 *   4) 샘플 유저 direct weekly-cards "정보(info)" 강화 현황 (before) — 적용 후 비교 앵커.
 *
 * 실행: npx tsx --env-file=.env.local scripts/dry-run-info-sentinel-backfill.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveLineScopeFromValues, isLineScopeVisibleForOrg } from "@/lib/lineScope";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

type LineRow = {
  id: string;
  activity_type_id: string | null;
  line_code: string | null;
  week_id: string | null;
  source_file_name: string | null;
};
type TargetRow = {
  line_id: string;
  target_mode: string;
  target_rule: Record<string, unknown> | null;
};
type WeekRow = {
  id: string;
  start_date: string | null;
  week_number: number | null;
  season_key: string | null;
  is_official_rest: boolean | null;
};

async function fetchAll<T>(table: string, cols: string, apply: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  let from = 0;
  for (;;) {
    let q = supabaseAdmin.from(table).select(cols).order("id", { ascending: true });
    q = apply(q).range(from, from + page - 1);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < page) break;
    from += page;
  }
  return out;
}

async function main() {
  // 1) 활성 info 라인 + 타깃 집계 → 0-target(user=0 AND sentinel=0) 대상 선별.
  const lines = await fetchAll<LineRow>(
    "cluster4_lines",
    "id,activity_type_id,line_code,week_id,source_file_name",
    (q) => q.eq("part_type", "info").eq("is_active", true),
  );
  const lineIds = lines.map((l) => l.id);
  const targets: TargetRow[] = [];
  for (let i = 0; i < lineIds.length; i += 200) {
    const rows = await fetchAll<TargetRow>(
      "cluster4_line_targets",
      "line_id,target_mode,target_rule",
      (q) => q.in("line_id", lineIds.slice(i, i + 200)),
    );
    targets.push(...rows);
  }
  const agg = new Map<string, { user: number; sentinel: number }>();
  for (const t of targets) {
    const a = agg.get(t.line_id) ?? { user: 0, sentinel: 0 };
    if (t.target_mode === "user") a.user++;
    else if (t.target_mode === "rule" && (t.target_rule as any)?.zeroTargetOpen === true) a.sentinel++;
    agg.set(t.line_id, a);
  }
  const targetLines = lines.filter((l) => {
    const a = agg.get(l.id);
    return (!a || (a.user === 0 && a.sentinel === 0)) && l.week_id;
  });

  // 2) 대상 라인의 week 메타.
  const weekIds = Array.from(new Set(targetLines.map((l) => l.week_id!).filter(Boolean)));
  const weeks: WeekRow[] = [];
  for (let i = 0; i < weekIds.length; i += 200) {
    const { data, error } = await supabaseAdmin
      .from("weeks")
      .select("id,start_date,week_number,season_key,is_official_rest")
      .in("id", weekIds.slice(i, i + 200));
    if (error) throw new Error("weeks: " + error.message);
    weeks.push(...((data ?? []) as WeekRow[]));
  }
  const weekById = new Map(weeks.map((w) => [w.id, w]));

  // 3) org 가시성: info-OK-* = oranke 라인. 고객 카드 경로와 동일 SoT 로 유저 org 가시 판정.
  const okScope = resolveLineScopeFromValues({ partType: "info", lineCode: "info-OK-wisdom-2025w46" });

  // 4) 비휴식 대상 주차의 start_date 집합 → uws(활동 대상자) 조회.
  const startDateToLineWeeks = new Map<string, string[]>(); // start_date → [lineId...]
  let restLineCount = 0;
  let unmatchedWeekLineCount = 0;
  for (const l of targetLines) {
    const w = weekById.get(l.week_id!);
    if (!w || !w.start_date) {
      unmatchedWeekLineCount++;
      continue;
    }
    if (w.is_official_rest) {
      restLineCount++;
      continue;
    }
    const arr = startDateToLineWeeks.get(w.start_date) ?? [];
    arr.push(l.id);
    startDateToLineWeeks.set(w.start_date, arr);
  }
  const startDates = Array.from(startDateToLineWeeks.keys());

  // uws rows for those weeks (활동 대상자 = 그 주차 평가 대상).
  const uwsByStart = new Map<string, Set<string>>(); // start_date → set(user_id)
  const allUserIds = new Set<string>();
  for (let i = 0; i < startDates.length; i += 50) {
    const slice = startDates.slice(i, i + 50);
    const rows = await fetchAll<{ user_id: string; week_start_date: string }>(
      "user_week_statuses",
      "id,user_id,week_start_date",
      (q) => q.in("week_start_date", slice),
    );
    for (const r of rows) {
      let s = uwsByStart.get(r.week_start_date);
      if (!s) {
        s = new Set();
        uwsByStart.set(r.week_start_date, s);
      }
      s.add(r.user_id);
      allUserIds.add(r.user_id);
    }
  }

  // 5) 유저 org 가시 필터.
  const orgByUser = new Map<string, string | null>();
  const uidArr = Array.from(allUserIds);
  for (let i = 0; i < uidArr.length; i += 200) {
    const { data } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,organization_slug")
      .in("user_id", uidArr.slice(i, i + 200));
    for (const r of (data ?? []) as Array<{ user_id: string; organization_slug: string | null }>) {
      orgByUser.set(r.user_id, r.organization_slug);
    }
  }
  const visible = (uid: string) =>
    isLineScopeVisibleForOrg(okScope, (orgByUser.get(uid) as any) ?? null, { allowUnknown: false });

  // 6) activity_type 별 집계 + 코호트.
  type Acc = {
    lines: number;
    restLines: number;
    weeks: Set<string>;
    affectedUsers: Set<string>;
    projectedFails: number; // Σ (user × line)
  };
  const byAct = new Map<string, Acc>();
  const ensure = (k: string): Acc =>
    byAct.get(k) ??
    (byAct.set(k, { lines: 0, restLines: 0, weeks: new Set(), affectedUsers: new Set(), projectedFails: 0 }),
    byAct.get(k)!);

  for (const l of targetLines) {
    const act = l.activity_type_id ?? "(null)";
    const acc = ensure(act);
    const w = weekById.get(l.week_id!);
    if (!w || !w.start_date) continue;
    if (w.is_official_rest) {
      acc.restLines++;
      continue;
    }
    acc.lines++;
    acc.weeks.add(l.week_id!);
    const users = uwsByStart.get(w.start_date);
    if (users) {
      for (const u of users) {
        if (!visible(u)) continue;
        acc.affectedUsers.add(u);
        acc.projectedFails++;
      }
    }
  }

  const totalUsers = new Set<string>();
  let totalFails = 0;
  for (const acc of byAct.values()) {
    for (const u of acc.affectedUsers) totalUsers.add(u);
    totalFails += acc.projectedFails;
  }

  console.log(`════════ B안 sentinel 백필 DRY-RUN ════════`);
  console.log(`전체 활성 info 라인: ${lines.length}`);
  console.log(`백필 대상(0 user + 0 sentinel): ${targetLines.length} (휴식주차 ${restLineCount} · 미매칭주차 ${unmatchedWeekLineCount} 포함)`);
  console.log(`\n──── activity_type 별 ────`);
  console.log(`${"type".padEnd(18)}${"백필라인".padStart(8)}${"휴식라인".padStart(8)}${"영향주차".padStart(8)}${"영향유저".padStart(8)}${"예상실패(user×line)".padStart(20)}`);
  for (const [act, acc] of [...byAct.entries()].sort()) {
    console.log(
      `${act.padEnd(18)}${String(acc.lines).padStart(8)}${String(acc.restLines).padStart(8)}${String(acc.weeks.size).padStart(8)}${String(acc.affectedUsers.size).padStart(8)}${String(acc.projectedFails).padStart(20)}`,
    );
  }
  console.log(`\n전체 distinct 영향 유저: ${totalUsers.size}`);
  console.log(`전체 예상 신규 info 실패(user×line): ${totalFails}`);

  // 7) 샘플 유저 direct "정보(info)" before — 가장 많은 대상 주차를 가진 유저 5명.
  const userHitCount = new Map<string, number>();
  for (const [start, lids] of startDateToLineWeeks) {
    const users = uwsByStart.get(start);
    if (!users) continue;
    for (const u of users) {
      if (!visible(u)) continue;
      userHitCount.set(u, (userHitCount.get(u) ?? 0) + lids.length);
    }
  }
  const sampleUsers = [...userHitCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map((e) => e[0]);
  console.log(`\n──── 샘플 유저 direct 정보(info) before (적용 후 비교 앵커) ────`);
  for (const uid of sampleUsers) {
    const cards = await getCluster4WeeklyCardsForProfileUser(uid);
    let infoFail = 0, infoSuccess = 0, infoPending = 0, infoNA = 0, infoLines = 0;
    for (const c of cards) {
      for (const ln of (c as any).lines ?? []) {
        if (ln.partType !== "information") continue;
        infoLines++;
        if (ln.enhancementStatus === "fail") infoFail++;
        else if (ln.enhancementStatus === "success") infoSuccess++;
        else if (ln.enhancementStatus === "pending") infoPending++;
        else infoNA++;
      }
    }
    console.log(
      `  ${uid} org=${orgByUser.get(uid) ?? "—"} 카드=${cards.length} info칸=${infoLines} (fail=${infoFail} success=${infoSuccess} pending=${infoPending} na=${infoNA}) | 대상주차hit=${userHitCount.get(uid)}`,
    );
  }
  console.log(`\n[DRY-RUN] write 없음. 적용은 확인 후 별도 스크립트(--execute).`);
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
