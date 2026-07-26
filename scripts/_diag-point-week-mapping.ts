// READ-ONLY 진단 — 주차별 포인트(A/B/C)의 week 매핑 회귀 조사.
//   축1: uwp.week_start_date (HEAD/eff3e43 이후 · 회귀 이전 원래 방식)
//   축2: process_point_awards(year,week_number) → weeks(iso_year,iso_week).start_date
//        (e180783~06453e1 회귀 구간의 resolvePointHistoryBatch 재현)
//   각 주차에 weeks.is_official_rest / season_key / week_number 를 붙여
//   "실제 활동 주차 vs 공식 휴식 주차" 어디로 매핑되는지 본다.
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type Num = number | null;

async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

type WeekRow = {
  id: string;
  season_key: string | null;
  week_number: Num;
  start_date: string | null;
  end_date: string | null;
  is_official_rest: boolean | null;
  iso_year: Num;
  iso_week: Num;
  holiday_name?: string | null;
};

async function main() {
  // ── 1) weeks 테이블 구조 진단 ────────────────────────────────────────
  const weeks = await pageAll<WeekRow>((f, t) =>
    supabaseAdmin
      .from("weeks")
      .select("id,season_key,week_number,start_date,end_date,is_official_rest,iso_year,iso_week,holiday_name")
      .order("start_date", { ascending: true })
      .range(f, t),
  );
  console.log(`\n=== [1] weeks 테이블 ===`);
  console.log(`총 ${weeks.length}행 (PostgREST 1000행 cap 초과 여부: ${weeks.length >= 1000 ? "예(주의)" : "아니오"})`);

  const byIso = new Map<string, WeekRow[]>();
  for (const w of weeks) {
    if (w.iso_year == null || w.iso_week == null) continue;
    const k = `${w.iso_year}::${w.iso_week}`;
    byIso.set(k, [...(byIso.get(k) ?? []), w]);
  }
  const dupIso = [...byIso.entries()].filter(([, v]) => v.length > 1);
  console.log(`iso(year,week) 중복 키: ${dupIso.length}건`);
  for (const [k, v] of dupIso.slice(0, 30)) {
    console.log(
      `  ${k} → ${v
        .map((w) => `${w.start_date}/${w.season_key} W${w.week_number}${w.is_official_rest ? " [공식휴식]" : ""}`)
        .join("  |  ")}`,
    );
  }
  const isoMissing = weeks.filter((w) => w.iso_year == null || w.iso_week == null);
  console.log(`iso_year/iso_week NULL 행: ${isoMissing.length}건`);
  const startMismatch = weeks.filter((w) => {
    if (!w.start_date || w.iso_year == null || w.iso_week == null) return false;
    const d = new Date(`${w.start_date}T00:00:00Z`);
    // ISO week of start_date
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y = t.getUTCFullYear();
    const yStart = new Date(Date.UTC(y, 0, 1));
    const wk = Math.ceil(((t.getTime() - yStart.getTime()) / 86400000 + 1) / 7);
    return y !== w.iso_year || wk !== w.iso_week;
  });
  console.log(`start_date 의 실제 ISO 주차 ≠ 저장된 iso_year/iso_week: ${startMismatch.length}건`);
  for (const w of startMismatch.slice(0, 20)) {
    console.log(`  ${w.start_date} ${w.season_key} W${w.week_number} 저장 iso=${w.iso_year}-${w.iso_week}`);
  }

  const restWeeks = weeks.filter((w) => w.is_official_rest);
  console.log(`is_official_rest=true 주차: ${restWeeks.length}건`);

  const weekByStart = new Map<string, WeekRow>();
  for (const w of weeks) if (w.start_date && !weekByStart.has(w.start_date)) weekByStart.set(w.start_date, w);
  // 회귀 구간 재현용: iso 키 → start_date (중복 시 마지막 승 = 코드와 동일하게 순회순 마지막)
  const startByIsoLastWins = new Map<string, string>();
  for (const w of weeks) {
    if (w.iso_year == null || w.iso_week == null || !w.start_date) continue;
    startByIsoLastWins.set(`${w.iso_year}::${w.iso_week}`, w.start_date);
  }

  // ── 2) 원장 로드 ────────────────────────────────────────────────────
  const uwp = await pageAll<{
    user_id: string; year: Num; week_number: Num; week_start_date: string | null;
    points: Num; advantages: Num; penalty: Num;
  }>((f, t) =>
    supabaseAdmin
      .from("user_weekly_points")
      .select("user_id,year,week_number,week_start_date,points,advantages,penalty")
      .order("id", { ascending: true })
      .range(f, t),
  );
  const ppa = await pageAll<{
    user_id: string; year: Num; week_number: Num;
    point_check: Num; point_advantage: Num; point_penalty: Num; cancelled_at: string | null;
  }>((f, t) =>
    supabaseAdmin
      .from("process_point_awards")
      .select("user_id,year,week_number,point_check,point_advantage,point_penalty,cancelled_at")
      .order("id", { ascending: true })
      .range(f, t),
  );
  console.log(`\n=== [2] 원장 ===`);
  console.log(`user_weekly_points ${uwp.length}행 · process_point_awards ${ppa.length}행(취소 ${ppa.filter((r) => r.cancelled_at).length})`);

  // uwp.week_start_date 가 (year,week_number) 의 weeks.start_date 와 어긋나는가?
  let uwpStartVsIso = 0;
  const uwpStartVsIsoSamples: string[] = [];
  for (const r of uwp) {
    if (r.year == null || r.week_number == null || !r.week_start_date) continue;
    const expect = startByIsoLastWins.get(`${r.year}::${r.week_number}`);
    if (expect && expect !== r.week_start_date) {
      uwpStartVsIso += 1;
      if (uwpStartVsIsoSamples.length < 15) {
        const wA = weekByStart.get(r.week_start_date);
        const wB = weekByStart.get(expect);
        uwpStartVsIsoSamples.push(
          `  uwp(${r.year}-W${r.week_number}) week_start_date=${r.week_start_date}` +
            `(${wA?.season_key} W${wA?.week_number}${wA?.is_official_rest ? " 공식휴식" : ""})` +
            ` ≠ weeks.iso 매핑 ${expect}(${wB?.season_key} W${wB?.week_number}${wB?.is_official_rest ? " 공식휴식" : ""})`,
        );
      }
    }
  }
  console.log(`uwp.week_start_date ≠ weeks(iso) 매핑 start_date : ${uwpStartVsIso}행`);
  uwpStartVsIsoSamples.forEach((s) => console.log(s));

  // uwp.week_start_date 가 weeks 에 아예 없는 경우
  const orphan = uwp.filter((r) => r.week_start_date && !weekByStart.has(r.week_start_date));
  const orphanStarts = new Map<string, number>();
  for (const r of orphan) orphanStarts.set(r.week_start_date!, (orphanStarts.get(r.week_start_date!) ?? 0) + 1);
  console.log(`uwp.week_start_date 가 weeks 에 없는 행: ${orphan.length} (고유 날짜 ${orphanStarts.size})`);
  [...orphanStarts.entries()].slice(0, 10).forEach(([d, n]) => console.log(`  ${d} × ${n}`));

  // ── 3) 공식 휴식 주차에 포인트가 있는가? ────────────────────────────
  console.log(`\n=== [3] 공식 휴식 주차 포인트 분포 ===`);
  const restStarts = new Set(restWeeks.map((w) => w.start_date!).filter(Boolean));
  const uwpOnRest = uwp.filter((r) => r.week_start_date && restStarts.has(r.week_start_date));
  const nonZeroOnRest = uwpOnRest.filter(
    (r) => (r.points ?? 0) !== 0 || (r.advantages ?? 0) !== 0 || (r.penalty ?? 0) !== 0,
  );
  console.log(`[축1 uwp.week_start_date] 공식휴식 주차 행 ${uwpOnRest.length} (0 아님 ${nonZeroOnRest.length})`);
  const restAgg = new Map<string, { rows: number; a: number; b: number; c: number }>();
  for (const r of nonZeroOnRest) {
    const k = r.week_start_date!;
    const e = restAgg.get(k) ?? { rows: 0, a: 0, b: 0, c: 0 };
    e.rows += 1; e.a += r.points ?? 0; e.b += r.advantages ?? 0; e.c += Math.abs(r.penalty ?? 0);
    restAgg.set(k, e);
  }
  [...restAgg.entries()].sort().forEach(([d, e]) => {
    const w = weekByStart.get(d);
    console.log(`  ${d} ${w?.season_key} W${w?.week_number} → ${e.rows}명 ΣA=${e.a} Σadv=${e.b} ΣC=${e.c}`);
  });

  // 축2(회귀 재현): awards → weeks iso 매핑
  const ppaActive = ppa.filter((r) => !r.cancelled_at);
  const ppaMapped = ppaActive.map((r) => ({
    ...r,
    mappedStart: r.year != null && r.week_number != null ? startByIsoLastWins.get(`${r.year}::${r.week_number}`) ?? null : null,
  }));
  const ppaUnmapped = ppaMapped.filter((r) => !r.mappedStart);
  console.log(
    `[축2 awards→weeks(iso)] 활성 ${ppaActive.length}행 중 매핑 실패(주차 소실) ${ppaUnmapped.length}행`,
  );
  const ppaOnRest = ppaMapped.filter((r) => r.mappedStart && restStarts.has(r.mappedStart));
  console.log(`[축2] 공식휴식 주차로 매핑된 awards: ${ppaOnRest.length}행`);
  const ppaRestAgg = new Map<string, number>();
  for (const r of ppaOnRest) ppaRestAgg.set(r.mappedStart!, (ppaRestAgg.get(r.mappedStart!) ?? 0) + 1);
  [...ppaRestAgg.entries()].sort().forEach(([d, n]) => {
    const w = weekByStart.get(d);
    console.log(`  ${d} ${w?.season_key} W${w?.week_number} × ${n}행`);
  });

  // 축1 vs 축2 주차키 차이 (동일 user 기준)
  console.log(`\n=== [4] 축1(uwp) vs 축2(awards→iso) 주차키 비교 ===`);
  const axis1 = new Map<string, Map<string, { a: number; b: number; c: number }>>();
  for (const r of uwp) {
    if (!r.week_start_date) continue;
    const m = axis1.get(r.user_id) ?? new Map();
    const e = m.get(r.week_start_date) ?? { a: 0, b: 0, c: 0 };
    e.a += r.points ?? 0; e.b += (r.advantages ?? 0) - Math.abs(r.penalty ?? 0); e.c += Math.abs(r.penalty ?? 0);
    m.set(r.week_start_date, e);
    axis1.set(r.user_id, m);
  }
  const axis2 = new Map<string, Map<string, { a: number; b: number; c: number }>>();
  for (const r of ppaMapped) {
    if (!r.mappedStart) continue;
    const m = axis2.get(r.user_id) ?? new Map();
    const e = m.get(r.mappedStart) ?? { a: 0, b: 0, c: 0 };
    e.a += r.point_check ?? 0;
    e.b += (r.point_advantage ?? 0) - Math.abs(r.point_penalty ?? 0);
    e.c += Math.abs(r.point_penalty ?? 0);
    m.set(r.mappedStart, e);
    axis2.set(r.user_id, m);
  }
  let usersAxisDiff = 0;
  const diffSamples: string[] = [];
  for (const [uid, m1] of axis1) {
    const m2 = axis2.get(uid) ?? new Map();
    const keys = new Set([...m1.keys(), ...m2.keys()]);
    const diffs: string[] = [];
    for (const k of [...keys].sort()) {
      const v1 = m1.get(k);
      const v2 = m2.get(k);
      const s1 = v1 ? `${v1.a}/${v1.b}/${v1.c}` : "-";
      const s2 = v2 ? `${v2.a}/${v2.b}/${v2.c}` : "-";
      if (s1 !== s2) {
        const w = weekByStart.get(k);
        diffs.push(`${k}(${w?.season_key ?? "?"} W${w?.week_number ?? "?"}${w?.is_official_rest ? " 공식휴식" : ""}) uwp=${s1} awards=${s2}`);
      }
    }
    if (diffs.length) {
      usersAxisDiff += 1;
      if (diffSamples.length < 8) diffSamples.push(`  [${uid}]\n     ${diffs.slice(0, 10).join("\n     ")}`);
    }
  }
  console.log(`주차키/값이 갈리는 사용자: ${usersAxisDiff}명 / uwp 보유 ${axis1.size}명`);
  diffSamples.forEach((s) => console.log(s));

  // ── 5) 카드(snapshot) startDate 와의 결합 — 화면 표시 주차 ───────────
  console.log(`\n=== [5] 주차 카드 startDate ↔ 포인트 키 결합 ===`);
  const targetIds = [
    "76a42307-f3b2-4c08-92ab-f339a20b7d38", // T윤서진
    "05ff6b96-b3e7-4050-97f1-080633f183d3", // T권희윤
    "00b75923-2109-4214-806a-37667d64ac5e", // T강민지
    "8eeb75ba-47c9-49fd-971b-ba3188b90ce4", // 윤채영
  ];
  const { data: snaps } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,payload")
    .in("user_id", targetIds);
  for (const s of (snaps ?? []) as Array<{ user_id: string; payload: unknown }>) {
    const payload = s.payload as { cards?: Array<Record<string, unknown>> } | null;
    const cards = Array.isArray(payload?.cards) ? payload!.cards! : [];
    const m1 = axis1.get(s.user_id) ?? new Map();
    const m2 = axis2.get(s.user_id) ?? new Map();
    console.log(`\n[${s.user_id}] 카드 ${cards.length}장`);
    for (const c of cards.slice().sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)))) {
      const sd = String(c.startDate ?? "");
      const w = weekByStart.get(sd);
      const v1 = m1.get(sd);
      const v2 = m2.get(sd);
      console.log(
        `   ${sd} ${String(c.seasonKey ?? "")} W${String(c.weekNumber ?? "")} status=${String(c.userWeekStatus ?? "")}` +
          `${w?.is_official_rest ? " [weeks.공식휴식]" : ""}` +
          `  uwp=${v1 ? `${v1.a}/${v1.b}/${v1.c}` : "없음"}  awards=${v2 ? `${v2.a}/${v2.b}/${v2.c}` : "없음"}`,
      );
    }
    const extra1 = [...m1.keys()].filter((k) => !cards.some((c) => String(c.startDate) === k));
    console.log(`   카드에 없는 uwp 주차: ${extra1.length}건 ${extra1.slice(0, 8).join(", ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
