/**
 * weeks 테이블 백필 + 검증.
 * user_week_statuses에서 누락된 weeks row를 생성하고 season_key/공식휴식을 설정.
 *
 * weeks 원본 스키마:
 *   id (uuid PK), season_id (uuid NOT NULL FK→seasons), week_index,
 *   started_at, ended_at, created_at, updated_at
 *
 * 실행: npx tsx --env-file=.env.local scripts/apply-weeks-backfill.ts
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

async function main() {
  console.log("=== weeks 백필 시작 ===\n");

  // 0. 현재 상태
  const { count: weeksBefore } = await sb.from("weeks").select("*", { count: "exact", head: true });
  const { count: uwsCount } = await sb.from("user_week_statuses").select("*", { count: "exact", head: true });
  console.log(`현재 weeks: ${weeksBefore} rows, user_week_statuses: ${uwsCount} rows`);

  // 1. 기존 seasons 테이블에서 season_id 확보
  const { data: existingSeasons } = await sb.from("seasons").select("id").limit(1);
  let seasonId: string;

  if (existingSeasons && existingSeasons.length > 0) {
    seasonId = (existingSeasons[0] as { id: string }).id;
    console.log(`기존 seasons row 사용: ${seasonId}`);
  } else {
    console.log("seasons 테이블 비어있음 — 기본 시즌 생성");
    const { data: newSeason, error } = await sb
      .from("seasons")
      .insert({ season_index: 1, name: "Default Season" })
      .select("id")
      .single();
    if (error || !newSeason) {
      console.error("seasons 생성 실패:", error?.message);
      return;
    }
    seasonId = (newSeason as { id: string }).id;
  }

  // 2. 누락된 주차 찾기
  const { data: uwsDates } = await sb
    .from("user_week_statuses")
    .select("week_start_date")
    .not("week_start_date", "is", null);

  if (!uwsDates || uwsDates.length === 0) {
    console.log("user_week_statuses 데이터 없음");
    return;
  }

  const uniqueDates = [...new Set((uwsDates as { week_start_date: string }[]).map(r => r.week_start_date))].sort();
  console.log(`고유 week_start_date: ${uniqueDates.length}개`);

  const { data: existingWeeks } = await sb
    .from("weeks")
    .select("start_date")
    .in("start_date", uniqueDates);

  const existingDates = new Set((existingWeeks ?? []).map((w: Record<string, unknown>) => w.start_date as string));
  const missingDates = uniqueDates.filter(d => !existingDates.has(d));
  console.log(`이미 존재: ${existingDates.size}개, 누락: ${missingDates.length}개`);

  if (missingDates.length === 0) {
    console.log("\n누락 주차 없음 — INSERT 스킵\n");
  } else {
    // 3. 누락된 weeks row 생성 (season_id 포함)
    const newRows = missingDates.map(d => {
      const dt = new Date(d + "T00:00:00Z");
      const endDt = new Date(dt.getTime() + 6 * 86400000);
      const isoWeek = getISOWeek(dt);
      return {
        season_id: seasonId,
        week_index: isoWeek,
        started_at: dt.toISOString(),
        ended_at: endDt.toISOString(),
        start_date: d,
        end_date: endDt.toISOString().slice(0, 10),
        iso_year: getISOYear(dt),
        iso_week: isoWeek,
        is_official_rest: false,
      };
    });

    // batch insert (Supabase limit ~1000 rows)
    const BATCH = 100;
    let totalInserted = 0;
    for (let i = 0; i < newRows.length; i += BATCH) {
      const batch = newRows.slice(i, i + BATCH);
      const { data: ins, error: err } = await sb.from("weeks").insert(batch).select("id");
      if (err) {
        console.error(`INSERT 실패 (batch ${i}):`, err.message);
        return;
      }
      totalInserted += (ins?.length ?? 0);
    }
    console.log(`\n${totalInserted}개 weeks row 생성 완료`);
  }

  // 4. season_key 설정
  const { data: allWeeksNoSeason } = await sb
    .from("weeks")
    .select("id,start_date")
    .is("season_key", null)
    .not("start_date", "is", null);

  if (allWeeksNoSeason && allWeeksNoSeason.length > 0) {
    const { data: seasons } = await sb
      .from("season_definitions")
      .select("season_key,start_date,end_date")
      .order("start_date");

    if (seasons) {
      const defs = seasons as { season_key: string; start_date: string; end_date: string }[];
      let updated = 0;
      for (const w of allWeeksNoSeason as { id: string; start_date: string }[]) {
        const sd = defs.find(s => w.start_date >= s.start_date && w.start_date <= s.end_date);
        if (sd) {
          await sb.from("weeks").update({ season_key: sd.season_key }).eq("id", w.id);
          updated++;
        }
      }
      console.log(`season_key 설정: ${updated}개`);
    }
  } else {
    console.log("season_key 설정: 이미 모두 완료");
  }

  // 5. week_number 재계산 (시즌 내 주차)
  const { data: weeksWithSeason } = await sb
    .from("weeks")
    .select("id,start_date,season_key")
    .not("season_key", "is", null)
    .not("start_date", "is", null);

  if (weeksWithSeason) {
    const { data: sdAll } = await sb.from("season_definitions").select("season_key,start_date");
    const sdMap = new Map<string, string>();
    if (sdAll) {
      for (const s of sdAll as { season_key: string; start_date: string }[]) {
        sdMap.set(s.season_key, s.start_date);
      }
    }

    let wnUpdated = 0;
    for (const w of weeksWithSeason as { id: string; start_date: string; season_key: string }[]) {
      const sStart = sdMap.get(w.season_key);
      if (!sStart) continue;
      const diff = new Date(w.start_date + "T00:00:00Z").getTime() - new Date(sStart + "T00:00:00Z").getTime();
      const wn = Math.floor(diff / (7 * 86400000)) + 1;
      if (wn >= 1) {
        await sb.from("weeks").update({ week_number: wn }).eq("id", w.id);
        wnUpdated++;
      }
    }
    console.log(`week_number 설정: ${wnUpdated}개`);
  }

  // 6. 공식 휴식 판정
  const { data: springAutumn } = await sb
    .from("season_definitions")
    .select("season_key")
    .in("season_type", ["spring", "autumn"]);
  const saKeys = new Set((springAutumn ?? []).map((s: Record<string, unknown>) => s.season_key as string));

  // 공식 휴식 true 조건: 봄/가을 6~8, 14~16 + 설/구정/추석.
  // 전환 주차와 단일 공휴일은 공식 휴식이 아니다.
  const { data: allWeeks } = await sb
    .from("weeks")
    .select("id,week_number,season_key,is_official_rest,holiday_name")
    .not("week_number", "is", null)
    .not("season_key", "is", null);

  let calRest = 0;
  let resetWeeks = 0;
  if (allWeeks) {
    for (const w of allWeeks as { id: string; week_number: number; season_key: string; is_official_rest: boolean; holiday_name: string | null }[]) {
      const wn = w.week_number;
      const shouldBeCalendarRest =
        saKeys.has(w.season_key) &&
        ((wn >= 6 && wn <= 8) || (wn >= 14 && wn <= 16));

      if (shouldBeCalendarRest) {
        await sb.from("weeks").update({ is_official_rest: true, holiday_name: null }).eq("id", w.id);
        calRest++;
      } else if (w.is_official_rest || w.holiday_name) {
        await sb.from("weeks").update({ is_official_rest: false, holiday_name: null }).eq("id", w.id);
        resetWeeks++;
      }
    }
  }
  console.log(`공식 휴식(캘린더): ${calRest}개, 공식 휴식 해제: ${resetWeeks}개`);

  // 명절(설/구정, 추석)만 official_rest_weeks에서 반영
  const { data: holidays } = await sb.from("official_rest_weeks").select("year,week_number,reason");
  let holUpdated = 0;
  if (holidays) {
    for (const h of holidays as { year: number; week_number: number; reason: string | null }[]) {
      const reason = h.reason?.toLowerCase() ?? "";
      const isAllowedHoliday =
        reason.includes("설") ||
        reason.includes("구정") ||
        reason.includes("추석") ||
        reason.includes("lunar") ||
        reason.includes("chuseok");
      if (!isAllowedHoliday) continue;

      const { data: hw } = await sb
        .from("weeks")
        .select("id")
        .eq("iso_year", h.year)
        .eq("iso_week", h.week_number);
      if (hw) {
        for (const w of hw as { id: string }[]) {
          await sb.from("weeks").update({ is_official_rest: true, holiday_name: h.reason }).eq("id", w.id);
          holUpdated++;
        }
      }
    }
  }
  console.log(`명절 설정: ${holUpdated}개`);

  // 7. 최종 확인
  const { count: weeksAfter } = await sb.from("weeks").select("*", { count: "exact", head: true });
  console.log(`\n=== 완료: weeks ${weeksBefore} → ${weeksAfter} rows ===`);

  // 매칭 확인
  const nowMatched = (await sb.from("weeks").select("start_date").in("start_date", uniqueDates)).data?.length ?? 0;
  console.log(`user_week_statuses ↔ weeks 매칭: ${nowMatched} / ${uniqueDates.length}`);

  // 공식 휴식 목록
  const { data: restList } = await sb
    .from("weeks")
    .select("season_key,week_number,start_date,end_date,is_official_rest,holiday_name")
    .eq("is_official_rest", true)
    .order("start_date", { ascending: false })
    .limit(15);

  console.log(`\n공식 휴식 주차:`);
  if (restList && restList.length > 0) {
    for (const r of restList as Array<Record<string, unknown>>) {
      console.log(`  ${r.season_key} W${r.week_number}: ${r.start_date} ~ ${r.end_date} — ${r.holiday_name ?? "(캘린더 규칙)"}`);
    }
  } else {
    console.log("  (없음)");
  }
}

function getISOYear(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  return date.getUTCFullYear();
}

function getISOWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

main().catch(console.error);
