// 이력서 seasonRecords 전수 진단 — raw(user_week_statuses) vs direct(getCluster1Resume).
// 증상: ① 참여한 26겨울 시즌이 record 에 없음 ② raw success>=1 인데 approvedWeeks=0.
// 의심: season_key null/orphan, 전환 주차 필터(isTransitionWeekStart 공식 달력)와
//        season_definitions 실제 날짜의 어긋남.
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { isTransitionWeekStart, getSeasonForDate, getSeasonCalendar } =
    await import("../lib/seasonCalendar");
  const { getCluster1Resume } = await import("../lib/cluster1ResumeData");

  // ── 0) season_definitions vs 공식 달력 정렬 확인 ──────────────────
  const { data: defs } = await sb
    .from("season_definitions")
    .select("season_key,season_label,season_type,start_date,end_date")
    .order("start_date", { ascending: true });
  console.log("=== season_definitions vs 공식달력(seasonCalendar) ===");
  for (const d of (defs ?? []) as any[]) {
    const cal = getSeasonForDate(String(d.start_date).slice(0, 10));
    console.log(
      `${d.season_key} (${d.season_type}) db=${String(d.start_date).slice(0, 10)}~${String(d.end_date).slice(0, 10)}` +
        ` | cal=${cal ? `${cal.year}-${cal.type} ${cal.startDate}~${cal.endDate} (${cal.seasonWeeks}w)` : "달력매칭실패"}`,
    );
  }
  for (const y of [2025, 2026]) {
    for (const s of getSeasonCalendar(y)) {
      console.log(`  [공식달력] ${y} ${s.type} ${s.startDate}~${s.endDate} ${s.seasonWeeks}w`);
    }
  }

  // ── 1) uws 전수 페이지네이션 로드 (PostgREST 1000 cap 회피) ────────
  type Uws = {
    user_id: string;
    season_key: string | null;
    week_start_date: string | null;
    status: string;
    year: number;
    week_number: number;
  };
  const all: Uws[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("user_week_statuses")
      .select("user_id,season_key,week_start_date,status,year,week_number")
      .order("user_id", { ascending: true })
      .order("week_start_date", { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    const rows = (data ?? []) as Uws[];
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  console.log(`\n=== user_week_statuses 전수: ${all.length}행 ===`);

  const nullKey = all.filter((r) => !r.season_key);
  console.log(`season_key NULL 행: ${nullKey.length}`);
  const defKeys = new Set(((defs ?? []) as any[]).map((d) => d.season_key));
  const orphanKeys = new Map<string, number>();
  for (const r of all) {
    if (r.season_key && !defKeys.has(r.season_key)) {
      orphanKeys.set(r.season_key, (orphanKeys.get(r.season_key) ?? 0) + 1);
    }
  }
  console.log(`orphan season_key:`, orphanKeys.size ? [...orphanKeys] : "없음");

  // 전환 필터가 잡아먹는 행 분포 (시즌별)
  const transBySeason = new Map<string, { n: number; success: number; dates: Set<string> }>();
  for (const r of all) {
    if (r.week_start_date && isTransitionWeekStart(r.week_start_date)) {
      const k = r.season_key ?? "(null)";
      const e = transBySeason.get(k) ?? { n: 0, success: 0, dates: new Set<string>() };
      e.n++;
      if (r.status === "success") e.success++;
      e.dates.add(r.week_start_date);
      transBySeason.set(k, e);
    }
  }
  console.log("\n=== isTransitionWeekStart=true 로 필터되는 행 (시즌별) ===");
  for (const [k, e] of transBySeason) {
    console.log(`${k}: ${e.n}행 (success ${e.success}) | week_start: ${[...e.dates].sort().join(", ")}`);
  }

  // ── 2) 사용자별 raw 시즌 집계 vs direct seasonRecords 대조 ─────────
  const { data: mk } = await sb.from("test_user_markers").select("user_id");
  const testSet = new Set(((mk ?? []) as any[]).map((m) => m.user_id));
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id, display_name");
  const nameOf = new Map(((profs ?? []) as any[]).map((p) => [p.user_id, p.display_name]));

  const byUser = new Map<string, Uws[]>();
  for (const r of all) {
    const arr = byUser.get(r.user_id) ?? [];
    arr.push(r);
    byUser.set(r.user_id, arr);
  }

  // 시즌명 한글 매핑 (record 대조용)
  const labelOf = new Map(
    ((defs ?? []) as any[]).map((d) => [
      d.season_key,
      `${String(d.season_key).slice(2, 4)} ${{ spring: "봄 시즌", summer: "여름 시즌", autumn: "가을 시즌", winter: "겨울 시즌" }[d.season_type as string] ?? d.season_label}`,
    ]),
  );

  let missingSeason = 0;
  let zeroApproved = 0;
  let checkedUsers = 0;
  const anomalies: string[] = [];

  for (const [uid, rows] of byUser) {
    const name = nameOf.get(uid) ?? uid.slice(0, 8);
    const kind = testSet.has(uid) ? "tester" : "REAL";
    // raw 시즌 집계 (전환 포함/제외 양쪽)
    const rawBySeason = new Map<string, { total: number; success: number; transTotal: number; transSuccess: number }>();
    for (const r of rows) {
      if (!r.season_key) continue;
      const e = rawBySeason.get(r.season_key) ?? { total: 0, success: 0, transTotal: 0, transSuccess: 0 };
      const isTrans = !!(r.week_start_date && isTransitionWeekStart(r.week_start_date));
      if (isTrans) {
        e.transTotal++;
        if (r.status === "success") e.transSuccess++;
      } else {
        e.total++;
        if (r.status === "success") e.success++;
      }
      rawBySeason.set(r.season_key, e);
    }

    const dto = await getCluster1Resume(uid);
    const recs = dto?.seasonRecords ?? [];
    checkedUsers++;

    for (const [sk, e] of rawBySeason) {
      const label = labelOf.get(sk);
      const rec = recs.find((r: any) => `${r.year} ${r.seasonName}` === label);
      // A. 시즌 누락: raw 비전환 행이 있는데 record 없음 / 또는 전환행만 있어 skip
      if (!rec) {
        missingSeason++;
        anomalies.push(
          `[A:시즌누락] ${kind} ${name} | ${sk}(${label ?? "?"}) raw 비전환 ${e.total}행(success ${e.success}) + 전환 ${e.transTotal}행(success ${e.transSuccess}) → record 없음`,
        );
        continue;
      }
      // B. approved 불일치: raw 비전환 success vs record.approvedWeeks
      if (rec.approvedWeeks !== e.success) {
        zeroApproved++;
        anomalies.push(
          `[B:approved불일치] ${kind} ${name} | ${sk} raw 비전환 success=${e.success} (전환 success=${e.transSuccess}) → record approvedWeeks=${rec.approvedWeeks}/${rec.totalWeeks} (${rec.progressStatus})`,
        );
      }
    }
    // record 에는 있는데 raw 에 없는 역방향(이상치)도 확인
    for (const rec of recs as any[]) {
      const sk = [...labelOf.entries()].find(([, v]) => v === `${rec.year} ${rec.seasonName}`)?.[0];
      if (sk && !rawBySeason.has(sk)) {
        anomalies.push(`[C:raw없는 record] ${kind} ${name} | ${rec.year} ${rec.seasonName}`);
      }
    }
  }

  console.log(`\n=== 사용자별 raw vs direct 대조: ${checkedUsers}명 ===`);
  console.log(`시즌 누락(A): ${missingSeason}건 | approved 불일치(B): ${zeroApproved}건`);
  for (const a of anomalies) console.log(a);
  if (anomalies.length === 0) console.log("이상 없음");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
