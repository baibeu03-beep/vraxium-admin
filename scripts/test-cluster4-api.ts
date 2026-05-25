/**
 * Cluster4 실데이터 응답 검증 스크립트.
 * 실행: npx tsx scripts/test-cluster4-api.ts
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

// ─────────────────────────────────────────────────────────────────────
// 1. season_definitions 컬럼 확인
// ─────────────────────────────────────────────────────────────────────
async function checkSeasonDefinitions() {
  console.log("\n═══ 1. season_definitions 컬럼 확인 ═══");
  const { data, error } = await sb
    .from("season_definitions")
    .select("season_key,season_label,season_type,start_date,end_date,year")
    .order("start_date", { ascending: false })
    .limit(5);

  if (error) {
    console.error("  ERROR:", error.message);
    return;
  }
  console.log("  rows:", data?.length);
  if (data && data.length > 0) {
    console.log("  sample:", JSON.stringify(data[0], null, 2));
    const cols = Object.keys(data[0]);
    console.log("  columns:", cols.join(", "));
    console.log("  ✓ season_key:", "season_key" in data[0]);
    console.log("  ✓ season_label:", "season_label" in data[0]);
    console.log("  ✓ year:", "year" in data[0]);
    console.log("  ✗ name:", "name" in data[0], "(should be false)");
  }
}

// ─────────────────────────────────────────────────────────────────────
// 2. weeks 테이블 정규 컬럼 확인
// ─────────────────────────────────────────────────────────────────────
async function checkWeeks() {
  console.log("\n═══ 2. weeks 테이블 정규 컬럼 확인 ═══");
  const { data, error } = await sb
    .from("weeks")
    .select("id,week_number,start_date,end_date,season_key,is_official_rest,holiday_name,iso_year,iso_week")
    .order("start_date", { ascending: false })
    .limit(5);

  if (error) {
    console.error("  ERROR:", error.message);
    console.error("  (weeks 테이블 또는 정규 컬럼이 아직 마이그레이션되지 않았을 수 있음)");
    return;
  }
  console.log("  rows:", data?.length);
  if (data && data.length > 0) {
    console.log("  sample:", JSON.stringify(data[0], null, 2));
    const cols = Object.keys(data[0]);
    console.log("  columns:", cols.join(", "));
    console.log("  ✓ week_number:", "week_number" in data[0]);
    console.log("  ✓ start_date:", "start_date" in data[0]);
    console.log("  ✓ end_date:", "end_date" in data[0]);
    console.log("  ✓ season_key:", "season_key" in data[0]);
    console.log("  ✓ is_official_rest:", "is_official_rest" in data[0]);
    console.log("  ✓ holiday_name:", "holiday_name" in data[0]);
  }
}

// ─────────────────────────────────────────────────────────────────────
// 3. user_week_statuses 샘플 (첫 번째 활성 사용자)
// ─────────────────────────────────────────────────────────────────────
async function findTestUser(): Promise<string | null> {
  const { data } = await sb
    .from("user_week_statuses")
    .select("user_id")
    .limit(1);
  return (data as { user_id: string }[] | null)?.[0]?.user_id ?? null;
}

async function checkUserWeekStatuses(userId: string) {
  console.log(`\n═══ 3. user_week_statuses (user: ${userId.slice(0, 8)}...) ═══`);
  const { data, error } = await sb
    .from("user_week_statuses")
    .select("year,week_number,week_start_date,status,season_key")
    .eq("user_id", userId)
    .order("year", { ascending: false })
    .order("week_number", { ascending: false })
    .limit(5);

  if (error) {
    console.error("  ERROR:", error.message);
    return;
  }
  console.log("  rows:", data?.length);
  if (data && data.length > 0) {
    console.log("  sample:", JSON.stringify(data[0], null, 2));
    console.log("  statuses:", [...new Set((data as { status: string }[]).map(r => r.status))].join(", "));
  }
}

// ─────────────────────────────────────────────────────────────────────
// 4. weeks ↔ user_week_statuses 조인 검증
// ─────────────────────────────────────────────────────────────────────
async function checkWeeksJoin(userId: string) {
  console.log(`\n═══ 4. weeks ↔ user_week_statuses 조인 검증 ═══`);

  const { data: uws } = await sb
    .from("user_week_statuses")
    .select("week_start_date")
    .eq("user_id", userId)
    .limit(3);

  if (!uws || uws.length === 0) {
    console.log("  (user_week_statuses 데이터 없음)");
    return;
  }

  const dates = (uws as { week_start_date: string }[]).map(r => r.week_start_date);
  console.log("  week_start_dates:", dates);

  const { data: weeks, error } = await sb
    .from("weeks")
    .select("id,week_number,start_date,end_date,season_key,is_official_rest,holiday_name")
    .in("start_date", dates);

  if (error) {
    console.error("  weeks JOIN ERROR:", error.message);
    return;
  }

  console.log("  matched weeks:", weeks?.length, "/", dates.length);
  if (weeks && weeks.length > 0) {
    console.log("  joined sample:", JSON.stringify(weeks[0], null, 2));
  } else {
    console.log("  ⚠ weeks 테이블에 매칭되는 row 없음 — 마이그레이션 필요");
  }
}

// ─────────────────────────────────────────────────────────────────────
// 5. weekly_reputations / weekly_colleagues 카운트
// ─────────────────────────────────────────────────────────────────────
async function checkRelatedCounts(userId: string) {
  console.log(`\n═══ 5. 관련 테이블 카운트 ═══`);

  const checks = [
    { table: "user_weekly_points", filter: "user_id" },
    { table: "weekly_reputations", filter: "target_user_id" },
    { table: "weekly_colleagues", filter: "user_id" },
    { table: "user_activity_details", filter: "user_id" },
  ];

  for (const { table, filter } of checks) {
    const { count, error } = await sb
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq(filter, userId);

    if (error) {
      console.log(`  ${table}: ERROR — ${error.message}`);
    } else {
      console.log(`  ${table}: ${count ?? 0} rows`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// 6. 시뮬레이션: getWeeklyGrowth 핵심 로직 재현
// ─────────────────────────────────────────────────────────────────────
async function simulateWeeklyGrowthDto(userId: string) {
  console.log(`\n═══ 6. WeeklyGrowthDto 시뮬레이션 ═══`);

  // user_week_statuses
  const { data: uwsData } = await sb
    .from("user_week_statuses")
    .select("year,week_number,week_start_date,status,season_key")
    .eq("user_id", userId)
    .order("year", { ascending: false })
    .order("week_number", { ascending: false })
    .limit(3);

  const uwsRows = (uwsData ?? []) as Array<{
    year: number;
    week_number: number;
    week_start_date: string;
    status: string;
    season_key: string | null;
  }>;

  if (uwsRows.length === 0) {
    console.log("  (주차 데이터 없음)");
    return;
  }

  // season_definitions lookup
  const seasonKeys = [...new Set(uwsRows.map(r => r.season_key).filter(Boolean) as string[])];
  const { data: sdData } = await sb
    .from("season_definitions")
    .select("season_key,season_label,year")
    .in("season_key", seasonKeys);

  const sdMap = new Map<string, { season_key: string; season_label: string; year: number }>();
  if (sdData) {
    for (const sd of sdData as { season_key: string; season_label: string; year: number }[]) {
      sdMap.set(sd.season_key, sd);
    }
  }

  // weeks lookup
  const dates = uwsRows.map(r => r.week_start_date);
  const { data: weeksData } = await sb
    .from("weeks")
    .select("id,week_number,start_date,end_date,season_key,is_official_rest,holiday_name")
    .in("start_date", dates);

  const weeksByDate = new Map<string, Record<string, unknown>>();
  if (weeksData) {
    for (const w of weeksData as Array<Record<string, unknown>>) {
      weeksByDate.set(w.start_date as string, w);
    }
  }

  // points lookup
  const { data: ptsData } = await sb
    .from("user_weekly_points")
    .select("year,week_number,points,advantages,penalty")
    .eq("user_id", userId);

  const ptsMap = new Map<string, { points: number; advantages: number; penalty: number }>();
  if (ptsData) {
    for (const p of ptsData as Array<{ year: number; week_number: number; points: number; advantages: number; penalty: number }>) {
      ptsMap.set(`${p.year}-${p.week_number}`, p);
    }
  }

  console.log("  --- 최근 3주 카드 시뮬레이션 ---");
  const STATUS_LABELS: Record<string, string> = {
    success: "성장(성공)",
    fail: "성장(실패)",
    personal_rest: "휴식(개인)",
    official_rest: "휴식(공식)",
    running: "성장(진행 중)",
    tallying: "성장(집계 중)",
  };

  for (const uws of uwsRows) {
    const sk = uws.season_key;
    const sd = sk ? sdMap.get(sk) : null;
    const wk = weeksByDate.get(uws.week_start_date);
    const pts = ptsMap.get(`${uws.year}-${uws.week_number}`);

    const card = {
      seasonYear: sd?.year ?? uws.year,
      seasonName: sd?.season_label ?? (sk ? sk : "-"),
      seasonKey: sk,
      weekNumber: (wk?.week_number as number | null) ?? uws.week_number,
      startDate: (wk?.start_date as string | null) ?? uws.week_start_date,
      endDate: wk?.end_date ?? null,
      resultStatus: uws.status,
      resultLabel: STATUS_LABELS[uws.status] ?? uws.status,
      is_official_rest: wk?.is_official_rest ?? null,
      holiday_name: wk?.holiday_name ?? null,
      points: pts?.points ?? 0,
      advantages: pts?.advantages ?? 0,
      penalty: pts?.penalty ?? 0,
    };
    console.log(`\n  [W${card.weekNumber}]`, JSON.stringify(card, null, 4));
  }
}

// ─────────────────────────────────────────────────────────────────────
// 7. 공식 휴식 주차 확인
// ─────────────────────────────────────────────────────────────────────
async function checkOfficialRestWeeks() {
  console.log("\n═══ 7. 공식 휴식 주차 (weeks.is_official_rest) ═══");

  const { data, error } = await sb
    .from("weeks")
    .select("week_number,start_date,end_date,season_key,is_official_rest,holiday_name")
    .eq("is_official_rest", true)
    .order("start_date", { ascending: false })
    .limit(10);

  if (error) {
    console.error("  ERROR:", error.message);
    return;
  }

  console.log("  공식 휴식 주차:", data?.length, "건");
  if (data) {
    for (const r of data as Array<Record<string, unknown>>) {
      console.log(`    ${r.season_key} W${r.week_number}: ${r.start_date} ~ ${r.end_date} — ${r.holiday_name ?? "(캘린더 규칙)"}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Cluster4 실데이터 응답 검증 시작\n");
  console.log("Supabase URL:", url);

  await checkSeasonDefinitions();
  await checkWeeks();

  const testUserId = await findTestUser();
  if (!testUserId) {
    console.log("\n⚠ 테스트할 사용자가 없습니다 (user_week_statuses 비어있음)");
    return;
  }
  console.log(`\nTest user: ${testUserId}`);

  await checkUserWeekStatuses(testUserId);
  await checkWeeksJoin(testUserId);
  await checkRelatedCounts(testUserId);
  await simulateWeeklyGrowthDto(testUserId);
  await checkOfficialRestWeeks();

  console.log("\n═══ 검증 완료 ═══");
}

main().catch(console.error);
