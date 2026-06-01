/**
 * READ-ONLY 점검: 전환 주차가 user_week_statuses 에 official_rest 로 저장돼 있는지.
 *   - 전환 주차 = 시즌 정규 주수 초과분 (winter/summer week 9, spring/autumn week 17).
 *   - .select 만 사용. 어떤 UPDATE/INSERT/DELETE 도 하지 않는다.
 *
 * 실행: npx tsx --env-file=.env.local scripts/inspect-transition-official-rest.ts
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

const SEASON_WEEKS: Record<string, number> = {
  spring: 16,
  summer: 8,
  autumn: 16,
  winter: 8,
};

type SeasonDef = { season_key: string; season_type: string | null };
type WeekRow = {
  season_key: string | null;
  week_number: number | null;
  start_date: string | null;
  end_date: string | null;
};
type UwsRow = {
  season_key: string | null;
  week_start_date: string | null;
  week_number: number | null; // ISO 주차
  status: string | null;
};

async function main() {
  console.log("=== 전환 주차 ↔ user_week_statuses.status 점검 (READ-ONLY) ===\n");

  // 1) 시즌 타입 맵
  const { data: defs, error: defErr } = await sb
    .from("season_definitions")
    .select("season_key,season_type");
  if (defErr) throw defErr;
  const typeByKey = new Map<string, string | null>();
  for (const d of (defs ?? []) as SeasonDef[]) typeByKey.set(d.season_key, d.season_type);

  // 2) weeks 전체(번호 있는 것) → 전환 주차 식별
  const { data: weeks, error: wErr } = await sb
    .from("weeks")
    .select("season_key,week_number,start_date,end_date")
    .not("week_number", "is", null)
    .not("season_key", "is", null)
    .not("start_date", "is", null);
  if (wErr) throw wErr;

  type Transition = {
    season_key: string;
    season_type: string | null;
    season_weeks: number | null;
    week_number: number;
    start_date: string;
    end_date: string | null;
    isPolicyExact: boolean; // week_number === seasonWeeks+1
  };
  const transitions: Transition[] = [];
  for (const w of (weeks ?? []) as WeekRow[]) {
    if (!w.season_key || w.week_number == null || !w.start_date) continue;
    const stype = typeByKey.get(w.season_key) ?? null;
    const sw = stype ? SEASON_WEEKS[stype] ?? null : null;
    if (sw == null) continue;
    if (w.week_number > sw) {
      transitions.push({
        season_key: w.season_key,
        season_type: stype,
        season_weeks: sw,
        week_number: w.week_number,
        start_date: w.start_date,
        end_date: w.end_date,
        isPolicyExact: w.week_number === sw + 1,
      });
    }
  }
  transitions.sort((a, b) => a.start_date.localeCompare(b.start_date));

  console.log(`[1] 식별된 전환 주차(week_number > seasonWeeks): ${transitions.length}개`);
  for (const t of transitions) {
    const flag = t.isPolicyExact ? "" : "  ⚠초과(정책 9/17 아님)";
    console.log(
      `   ${t.season_key} (${t.season_type}) W${t.week_number}` +
        ` [seasonWeeks=${t.season_weeks}]  ${t.start_date}~${t.end_date}${flag}`,
    );
  }
  if (transitions.length === 0) {
    console.log("   (전환 주차로 식별되는 weeks row 없음 — 점검 종료)");
    return;
  }

  // 3) 전환 주차 start_date 들에 매칭되는 uws 조회
  const dates = Array.from(new Set(transitions.map((t) => t.start_date)));
  const startToTransition = new Map<string, Transition>();
  for (const t of transitions) startToTransition.set(t.start_date, t);

  const { data: uws, error: uErr } = await sb
    .from("user_week_statuses")
    .select("season_key,week_start_date,week_number,status")
    .in("week_start_date", dates);
  if (uErr) throw uErr;
  const rows = (uws ?? []) as UwsRow[];

  console.log(
    `\n[2] 해당 전환 주차에 매칭되는 user_week_statuses: ${rows.length} rows` +
      ` (대상 주 시작일 ${dates.length}개)`,
  );

  // 4) (weeks.season_key, week_start_date, 시즌상대주차, status) 집계
  type Agg = {
    weeksSeasonKey: string;
    seasonType: string | null;
    weekStart: string;
    seasonRelWeek: number;
    status: string;
    count: number;
    uwsSeasonKeys: Set<string>;
  };
  const aggMap = new Map<string, Agg>();
  const statusTotals = new Map<string, number>();

  for (const r of rows) {
    if (!r.week_start_date) continue;
    const t = startToTransition.get(r.week_start_date);
    if (!t) continue;
    const status = r.status ?? "(null)";
    statusTotals.set(status, (statusTotals.get(status) ?? 0) + 1);
    const k = `${t.season_key}|${r.week_start_date}|${t.week_number}|${status}`;
    const cur =
      aggMap.get(k) ??
      ({
        weeksSeasonKey: t.season_key,
        seasonType: t.season_type,
        weekStart: r.week_start_date,
        seasonRelWeek: t.week_number,
        status,
        count: 0,
        uwsSeasonKeys: new Set<string>(),
      } satisfies Agg);
    cur.count += 1;
    if (r.season_key) cur.uwsSeasonKeys.add(r.season_key);
    aggMap.set(k, cur);
  }

  console.log(`\n[3] 전환 주차 status 전체 분포:`);
  for (const [s, c] of Array.from(statusTotals.entries()).sort((a, b) => b[1] - a[1])) {
    const mark = s === "official_rest" ? "   ← ⚠ 과대계상 위험" : "";
    console.log(`   ${s.padEnd(16)} ${c}${mark}`);
  }

  console.log(
    `\n[4] (season_key, week_start_date, 시즌상대주차, status) 집계:`,
  );
  const aggList = Array.from(aggMap.values()).sort(
    (a, b) =>
      a.weekStart.localeCompare(b.weekStart) || a.status.localeCompare(b.status),
  );
  for (const a of aggList) {
    const uwsKeys = Array.from(a.uwsSeasonKeys).join(",") || "(null)";
    const mark = a.status === "official_rest" ? "  ← ⚠" : "";
    console.log(
      `   ${a.weeksSeasonKey} W${a.seasonRelWeek} (${a.seasonType})` +
        ` ${a.weekStart}  status=${a.status.padEnd(14)} count=${a.count}` +
        `  [uws.season_key=${uwsKeys}]${mark}`,
    );
  }

  // 5) official_rest 핵심 요약
  const officialRest = aggList.filter((a) => a.status === "official_rest");
  const totalOR = officialRest.reduce((s, a) => s + a.count, 0);
  console.log(`\n[5] 결론: 전환 주차에 status='official_rest' 인 uws row = ${totalOR} 건`);
  if (totalOR > 0) {
    console.log("   ⚠ 전환 주차가 공식 휴식으로 저장됨 → cluster3 d-count·시즌참여·주차인정 과대계상 가능.");
    for (const a of officialRest) {
      console.log(
        `     - ${a.weeksSeasonKey} W${a.seasonRelWeek} ${a.weekStart}: ${a.count}건`,
      );
    }
  } else {
    console.log("   ✅ 전환 주차에 official_rest 저장 없음 — 집계 과대계상 위험 없음.");
  }
}

main().catch((e) => {
  console.error("점검 실패:", e?.message ?? e);
  process.exit(1);
});
