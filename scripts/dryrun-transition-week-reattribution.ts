/**
 * READ-ONLY dry-run: 시즌 전환 주차 재귀속(다음 시즌 0주차) 영향 분석.
 *   - .select 만 사용. 어떤 UPDATE/INSERT/DELETE 도 하지 않는다.
 * 실행: npx tsx --env-file=.env.local scripts/dryrun-transition-week-reattribution.ts
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SEASON_WEEKS: Record<string, number> = {
  spring: 16,
  summer: 8,
  autumn: 16,
  winter: 8,
};
const CHAIN = ["winter", "spring", "summer", "autumn"] as const;

function nextSeasonKey(seasonKey: string): string {
  const [yearStr, type] = seasonKey.split("-");
  const year = Number(yearStr);
  const idx = CHAIN.indexOf(type as (typeof CHAIN)[number]);
  if (idx < 0) return "(unknown)";
  if (idx === CHAIN.length - 1) return `${year + 1}-${CHAIN[0]}`; // autumn → next winter
  return `${year}-${CHAIN[idx + 1]}`;
}

type WeekRow = {
  id: string;
  season_id: string | null;
  season_key: string | null;
  week_number: number | null;
  week_index: number | null;
  start_date: string | null;
  end_date: string | null;
  iso_year: number | null;
  iso_week: number | null;
  is_official_rest: boolean | null;
  holiday_name: string | null;
};

async function main() {
  console.log("=== 전환 주차 재귀속 dry-run (READ-ONLY) ===\n");

  // 1) 시즌 타입 맵 + 정의 날짜
  const { data: defs } = await sb
    .from("season_definitions")
    .select("season_key,season_type,season_label,start_date,end_date");
  const defByKey = new Map<
    string,
    { type: string | null; label: string | null; start: string | null; end: string | null }
  >();
  for (const d of (defs ?? []) as Array<Record<string, string | null>>) {
    defByKey.set(d.season_key as string, {
      type: d.season_type,
      label: d.season_label,
      start: d.start_date,
      end: d.end_date,
    });
  }

  // 2) 모든 weeks
  const { data: weeks } = await sb
    .from("weeks")
    .select(
      "id,season_id,season_key,week_number,week_index,start_date,end_date,iso_year,iso_week,is_official_rest,holiday_name",
    )
    .not("season_key", "is", null)
    .not("week_number", "is", null);
  const all = (weeks ?? []) as WeekRow[];

  // 3) 전환 주차 식별 (week_number > seasonWeeks)
  const transitions = all
    .filter((w) => {
      const t = defByKey.get(w.season_key!)?.type;
      const sw = t ? SEASON_WEEKS[t] : undefined;
      return sw != null && (w.week_number ?? 0) > sw;
    })
    .sort((a, b) => (a.start_date ?? "").localeCompare(b.start_date ?? ""));

  console.log(`[1] 전환 주차 ${transitions.length}건\n`);
  console.log(
    "weeks.id | 기간 | 기존시즌/주차 | → 다음시즌/0주차 | 다음정의존재 | 다음시즌_id일치",
  );
  console.log("-".repeat(110));

  for (const w of transitions) {
    const next = nextSeasonKey(w.season_key!);
    const nextDef = defByKey.get(next);
    const nextExists = nextDef ? "O" : "✗ 없음";

    // 다음 시즌의 seasons.id (name = season_label 매칭)
    let nextSeasonUuid: string | null = null;
    if (nextDef?.label) {
      const { data: srow } = await sb
        .from("seasons")
        .select("id")
        .eq("name", nextDef.label)
        .maybeSingle();
      nextSeasonUuid = (srow as { id: string } | null)?.id ?? null;
    }

    // 충돌: 다음 시즌에 이미 week 0 존재?
    const { data: w0 } = await sb
      .from("weeks")
      .select("id,start_date")
      .eq("season_key", next)
      .eq("week_number", 0);
    const w0Conflict =
      (w0 ?? []).length > 0
        ? `⚠W0존재(${(w0 as Array<{ start_date: string }>).map((r) => r.start_date).join(",")})`
        : "없음";

    console.log(
      `${w.id.slice(0, 8)} | ${w.start_date}~${w.end_date} | ${w.season_key}/W${w.week_number} | ${next}/W0 | ${nextExists} | seasons.id=${nextSeasonUuid ? nextSeasonUuid.slice(0, 8) : "✗"}`,
    );
    console.log(
      `         iso=(${w.iso_year},${w.iso_week}) is_official_rest=${w.is_official_rest} note=${w.holiday_name ?? "-"} | W0충돌=${w0Conflict}`,
    );
  }

  // 4) (season_key, week_number) 및 (iso_year, iso_week) 충돌 사전점검
  console.log(`\n[2] 유니크 충돌 점검`);
  for (const w of transitions) {
    const next = nextSeasonKey(w.season_key!);
    // (iso_year, iso_week) 는 값 자체가 안 바뀌므로 UPDATE 로도 충돌 없음(자기 자신).
    // (season_key, week_number) → (next, 0) 이 이미 있는지만 확인 (위 W0충돌과 동일)
    const { count } = await sb
      .from("weeks")
      .select("id", { count: "exact", head: true })
      .eq("season_key", next)
      .eq("week_number", 0);
    console.log(
      `   ${w.season_key}/W${w.week_number} → ${next}/W0 : 대상시즌 기존 W0 = ${count ?? 0}건`,
    );
  }

  // 5) 하위 참조 테이블 — 전환 weeks.id 참조 건수
  console.log(`\n[3] 하위 테이블 week_id 참조 건수 (전환 4주)`);
  const ids = transitions.map((w) => w.id);
  const childTables = [
    "cluster4_weekly_card_snapshots",
    "cluster4_lines",
    "cluster4_line_targets",
    "line_opening_windows",
    "process_check_windows",
    "process_check_statuses",
    "cluster4_week_opening_configs",
    "career_project_weeks",
    "user_week_statuses",
  ];
  for (const tbl of childTables) {
    for (const col of ["week_id", "week"]) {
      const { count, error } = await sb
        .from(tbl)
        .select("*", { count: "exact", head: true })
        .in(col, ids);
      if (!error) {
        console.log(`   ${tbl}.${col}: ${count ?? 0}`);
        break;
      }
    }
  }

  // 6) uws 는 week_id 가 아니라 week_start_date/season_key 로 연결 — 전환 주 start_date 기준
  console.log(`\n[4] user_week_statuses (week_start_date 기준, season_key 복제 컬럼)`);
  for (const w of transitions) {
    const { data: rows } = await sb
      .from("user_week_statuses")
      .select("season_key,status")
      .eq("week_start_date", w.start_date!);
    const byKey = new Map<string, number>();
    for (const r of (rows ?? []) as Array<{ season_key: string | null }>) {
      const k = r.season_key ?? "(null)";
      byKey.set(k, (byKey.get(k) ?? 0) + 1);
    }
    const next = nextSeasonKey(w.season_key!);
    console.log(
      `   ${w.start_date} (현재 ${w.season_key} → ${next}): ${[...byKey.entries()].map(([k, c]) => `${k}=${c}`).join(", ")}`,
    );
  }

  // 7) season_definitions 경계 (전환 주 인접 시즌들)
  console.log(`\n[5] season_definitions 경계 (전환 인접)`);
  const relevant = new Set<string>();
  for (const w of transitions) {
    relevant.add(w.season_key!);
    relevant.add(nextSeasonKey(w.season_key!));
  }
  for (const key of [...relevant].sort()) {
    const d = defByKey.get(key);
    console.log(`   ${key}: ${d?.start} ~ ${d?.end} (${d?.label})`);
  }
}

main().catch((e) => {
  console.error("dry-run 실패:", e?.message ?? e);
  process.exit(1);
});
