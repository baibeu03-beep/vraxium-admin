/**
 * 기간 정보 페이지 "공식 휴식 판정과 legacy 값이 어긋나는 주차 N건" 원인 조사 (read-only).
 *
 *  - direct: /api/admin/season-weeks GET 의 conflicts 생성 로직을 동일하게 재현하고
 *    각 충돌 주차의 원인 필드(weeks.is_official_rest, official_rest_weeks 매칭,
 *    season_rule, date_period, is_transition, holiday_name)를 분해해 출력.
 *  - http: 실제 HTTP API 응답의 conflicts 와 week_id 집합 일치 여부 대조.
 *
 *   사전조건: dev 서버 (http://localhost:3000).
 *   npx tsx --env-file=.env.local scripts/diag-season-weeks-conflicts.mts
 */
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchActiveRestPeriods } from "@/lib/officialRestPeriodsData";
import {
  matchOfficialRestPeriods,
  resolveOfficialRest,
} from "@/lib/officialRestPeriodsTypes";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

// ── route.ts 와 동일한 미수출 상수/함수 복제 (조사용) ─────────────────────────
const SEASON_WEEKS: Record<string, number> = {
  spring: 16,
  summer: 8,
  autumn: 16,
  winter: 8,
};

function calendarOfficialRest(
  seasonType: string | null,
  weekNumber: number | null,
): boolean | null {
  if (!seasonType || weekNumber == null) return null;
  const seasonWeeks = SEASON_WEEKS[seasonType];
  if (seasonWeeks == null) return null;
  if (weekNumber > seasonWeeks) return false;
  if (seasonType === "spring" || seasonType === "autumn") {
    if (weekNumber >= 6 && weekNumber <= 8) return true;
    if (weekNumber >= 14 && weekNumber <= 16) return true;
  }
  return false;
}

async function makeAdminCookieHeader() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp) throw new Error(linkError?.message);
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session) throw new Error(verifyError?.message);
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) => {
        captured.push(...items.map((i) => ({ name: i.name, value: i.value })));
      },
    },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  // ── direct 재현 ────────────────────────────────────────────────────────
  const { data: seasonData, error: seasonError } = await supabaseAdmin
    .from("season_definitions")
    .select("season_key,season_label,season_type,start_date,end_date")
    .order("start_date", { ascending: true });
  if (seasonError) throw seasonError;
  const seasons = seasonData ?? [];
  const seasonByKey = new Map(seasons.map((s) => [s.season_key, s]));

  const { data: weekData, error: weekError } = await supabaseAdmin
    .from("weeks")
    .select(
      "id,season_key,week_number,start_date,end_date,is_official_rest,iso_year,iso_week,holiday_name",
    )
    .in("season_key", seasons.map((s) => s.season_key))
    .order("start_date", { ascending: true });
  if (weekError) throw weekError;
  const weeks = weekData ?? [];

  // legacy 표: official_rest_weeks (deprecated ISO 주차 기반)
  const years = Array.from(
    new Set(weeks.map((w) => w.iso_year).filter((y) => y != null)),
  );
  const { data: officialData, error: officialError } = await supabaseAdmin
    .from("official_rest_weeks")
    .select("year,week_number")
    .in("year", years);
  if (officialError) console.log("official_rest_weeks 조회 실패(무시):", officialError.message);
  const legacyIsoSet = new Set(
    (officialData ?? []).map((r) => `${r.year}::${r.week_number}`),
  );
  console.log(`official_rest_weeks 행 수(해당 연도): ${officialData?.length ?? 0}`);

  const activePeriods = await fetchActiveRestPeriods();
  console.log(
    `active official_rest_periods: ${activePeriods.length}건 — ` +
      activePeriods.map((p) => `${p.name}(${p.startDate}~${p.endDate})`).join(", "),
  );

  type Detail = {
    week_id: string;
    season_key: string;
    week_number: number | null;
    start_date: string | null;
    end_date: string | null;
    holiday_name: string | null;
    resolved: boolean;
    legacy: boolean;
    weeks_is_official_rest: boolean | null;
    legacy_iso_hit: boolean;
    season_rule: boolean;
    date_period_matches: string[];
    is_transition: boolean;
  };

  const conflicts: Detail[] = [];
  for (const week of weeks) {
    if (!week.season_key) continue;
    const season = seasonByKey.get(week.season_key);
    if (!season) continue;

    const isoKey =
      week.iso_year != null && week.iso_week != null
        ? `${week.iso_year}::${week.iso_week}`
        : null;
    const legacyIsoHit = isoKey != null && legacyIsoSet.has(isoKey);
    const legacyRest = week.is_official_rest === true || legacyIsoHit;
    const seasonRuleRest =
      calendarOfficialRest(season.season_type, week.week_number) === true;
    const matched =
      week.start_date && week.end_date
        ? matchOfficialRestPeriods(
            { startDate: week.start_date, endDate: week.end_date },
            activePeriods,
          )
        : [];
    const { isOfficialRest } = resolveOfficialRest({
      seasonRuleRest,
      matchedDatePeriods: matched.length,
      legacyRest,
    });
    const seasonWeeks =
      season.season_type != null ? SEASON_WEEKS[season.season_type] : null;
    const isTransition = Boolean(
      seasonWeeks != null && week.week_number != null && week.week_number > seasonWeeks,
    );

    if (legacyRest !== isOfficialRest) {
      conflicts.push({
        week_id: week.id,
        season_key: week.season_key,
        week_number: week.week_number,
        start_date: week.start_date,
        end_date: week.end_date,
        holiday_name: week.holiday_name,
        resolved: isOfficialRest,
        legacy: legacyRest,
        weeks_is_official_rest: week.is_official_rest,
        legacy_iso_hit: legacyIsoHit,
        season_rule: seasonRuleRest,
        date_period_matches: matched.map((p) => p.name),
        is_transition: isTransition,
      });
    }
  }

  console.log(`\ndirect 재현 conflicts: ${conflicts.length}건`);
  for (const c of conflicts) {
    console.log(
      [
        c.week_id,
        c.season_key,
        `W${c.week_number}`,
        `${c.start_date}~${c.end_date}`,
        `resolved=${c.resolved}`,
        `legacy=${c.legacy}`,
        `weeks.is_official_rest=${c.weeks_is_official_rest}`,
        `iso_hit=${c.legacy_iso_hit}`,
        `season_rule=${c.season_rule}`,
        `date_period=[${c.date_period_matches.join("|")}]`,
        `transition=${c.is_transition}`,
        `holiday=${c.holiday_name ?? ""}`,
      ].join(" | "),
    );
  }

  // ── HTTP API 대조 ─────────────────────────────────────────────────────
  const cookie = await makeAdminCookieHeader();
  const res = await fetch(`${baseUrl}/api/admin/season-weeks`, {
    headers: { cookie },
  });
  const json = await res.json();
  const httpConflicts = (json?.data?.conflicts ?? []) as Array<{
    week_id: string;
    season_key: string;
    week_number: number | null;
    week_start_date: string | null;
    resolved_is_official_rest: boolean;
    legacy_is_official_rest: boolean;
  }>;
  console.log(`\nHTTP API conflicts: ${httpConflicts.length}건`);

  const directIds = new Set(conflicts.map((c) => c.week_id));
  const httpIds = new Set(httpConflicts.map((c) => c.week_id));
  const same =
    directIds.size === httpIds.size &&
    [...directIds].every((id) => httpIds.has(id));
  console.log(`direct vs HTTP week_id 집합 일치: ${same}`);
  if (!same) {
    console.log("direct only:", [...directIds].filter((id) => !httpIds.has(id)));
    console.log("http only:", [...httpIds].filter((id) => !directIds.has(id)));
  }

  writeFileSync(
    "claudedocs/season-weeks-conflicts-diag-20260607.json",
    JSON.stringify({ direct: conflicts, http: httpConflicts, same }, null, 2),
    "utf-8",
  );
  console.log("\nsaved: claudedocs/season-weeks-conflicts-diag-20260607.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
