// ===================================================================
// 크루 상세 HTTP 검증 — GET /api/admin/members/[user_id] 응답이 direct(getCrewDetailDto)와 동일한지.
//   실행: dev server(:3000) 가동 후
//         npx tsx --env-file=.env.local scripts/verify-crew-detail-http.ts
//   read-only. 인증 = magiclink 세션 쿠키(브라우저 검증과 동일). DB write 없음.
// ===================================================================
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCrewDetailDto } from "@/lib/adminCrewDetailData";
import { getCluster1Resume } from "@/lib/cluster1ResumeData";
import { getGrowthRosterBatchFast, getGrowthIndicators } from "@/lib/cluster3GrowthData";
import { sumPointsForUsers } from "@/lib/adminMembersData";
import { classLabel } from "@/lib/adminMembersTypes";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { truncateCardsForGrowthStop } from "@/lib/cluster4GrowthStopPolicy";
import { deriveEndStatus } from "@/lib/growthCore";
import { computeSeasonAreaProgress } from "@/lib/cluster4SeasonCircles";

const BASE = "http://localhost:3000";
const EMAIL = "vanuatu.golden@gmail.com";

const env = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
const get = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim() ?? "";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");

let fail = 0;
const ck = (label: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${d ? ` — ${d}` : ""}`);
  if (!ok) fail += 1;
};

async function buildCookie(): Promise<string> {
  const brow = createClient(URL_, ANON);
  const { data: link, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email: EMAIL,
  });
  if (error) throw new Error(error.message);
  const otp = (link as { properties?: { email_otp?: string } }).properties?.email_otp;
  const { data: v, error: vErr } = await brow.auth.verifyOtp({
    email: EMAIL,
    token: otp!,
    type: "magiclink",
  });
  if (vErr || !v.session) throw new Error(vErr?.message ?? "세션 생성 실패");
  const cap: { name: string; value: string }[] = [];
  const srv = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (items) => cap.push(...items) },
  });
  await srv.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

// ── 고객 시즌 그로스 Details 공식 독립 재현(admin lib 미사용) ──
//   counts = user_season_statuses(rest=f, 그 외=g, 가능=f+g) — /api/profile growthPeriodStats 동일.
//   start  = activity_started_at 포함 주차의 시즌(season_definitions join — admin season_key 파싱과 교차확인).
//   end    = raw growth_status/status 분기(suspended=suspended_week_id 주차 · graduated=ush 최신).
//   current= 어드민 표시 규칙(엘리트/활동중단=- · 현재 시즌 rest=휴식 중 · 그 외=진행 중).
const KO: Record<string, string> = {
  winter: "겨울", spring: "봄", summer: "여름", autumn: "가을", fall: "가을",
};
function labelFromKey(seasonKey: string | null): string | null {
  if (!seasonKey) return null;
  const m = seasonKey.toLowerCase().match(/^(\d{4})-(winter|spring|summer|autumn|fall)$/);
  return m && KO[m[2]] ? `${m[1]}년, ${KO[m[2]]} 시즌` : null;
}
function labelFromDef(seasonType: string | null, year: number | null): string | null {
  if (year == null || !seasonType || !KO[seasonType.toLowerCase()]) return null;
  return `${year}년, ${KO[seasonType.toLowerCase()]} 시즌`;
}
// seasons.name("2026년도 봄시즌") → "2026년, 봄 시즌"(졸업 종료 시즌 SoT).
function labelFromName(name: string | null): string | null {
  if (!name) return null;
  const m = name.match(/(\d{4})년도\s*(겨울|봄|여름|가을)\s*시즌/);
  return m ? `${m[1]}년, ${m[2]} 시즌` : null;
}
// season_definitions 가 배열/객체 어느 쪽으로 와도 흡수.
function pickDef(raw: unknown): { season_type: string | null; year: number | null } | null {
  const d = Array.isArray(raw) ? raw[0] : raw;
  return (d as { season_type: string | null; year: number | null }) ?? null;
}

async function expectedSeasonSummary(userId: string) {
  const [{ data: profile }, { data: ssRows }] = await Promise.all([
    supabaseAdmin.from("user_profiles")
      .select("activity_started_at,growth_status,status,suspended_week_id")
      .eq("user_id", userId).maybeSingle(),
    supabaseAdmin.from("user_season_statuses").select("status,season_key").eq("user_id", userId),
  ]);
  const rows = (ssRows ?? []) as { status: string; season_key: string | null }[];
  let rest = 0, success = 0;
  for (const r of rows) { if (r.status === "rest") rest++; else success++; }
  const p = profile as any;

  // 시작 시즌 — activity_started_at 포함 주차의 season_definitions(year/type).
  let startSeason = "-";
  const actStart = p?.activity_started_at ? String(p.activity_started_at).slice(0, 10) : null;
  if (actStart) {
    const { data: sw } = await supabaseAdmin.from("weeks")
      .select("season_key,season_definitions!inner(season_type,year)")
      .lte("start_date", actStart).gte("end_date", actStart).maybeSingle();
    if (sw) {
      const def = pickDef((sw as any).season_definitions);
      startSeason = labelFromDef(def?.season_type ?? null, def?.year ?? null)
        ?? labelFromKey((sw as any).season_key) ?? "-";
    }
  }

  // 종료 시즌 — raw 분기.
  const isGraduated = p?.status === "graduated" || p?.growth_status === "graduated";
  const isSuspended = p?.growth_status === "suspended";
  const IN_PROGRESS = "~ing (성장 진행 중)";
  let endSeason = IN_PROGRESS;
  if (isSuspended && p?.suspended_week_id) {
    const { data: w } = await supabaseAdmin.from("weeks")
      .select("season_key,season_definitions!inner(season_type,year)").eq("id", p.suspended_week_id).maybeSingle();
    const def = pickDef((w as any)?.season_definitions);
    endSeason = labelFromDef(def?.season_type ?? null, def?.year ?? null)
      ?? labelFromKey((w as any)?.season_key ?? null) ?? IN_PROGRESS;
  } else if (isGraduated) {
    // 졸업 종료 시즌 SoT = user_season_histories.season_id→seasons.name(고객 season_definitions 조인은 깨짐).
    const { data: h } = await supabaseAdmin.from("user_season_histories")
      .select("created_at,seasons!inner(name)")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const raw = (h as any)?.seasons;
    const s = Array.isArray(raw) ? raw[0] : raw;
    endSeason = labelFromName(s?.name ?? null) ?? IN_PROGRESS;
  }
  return {
    availableSeasons: rest + success, successSeasons: success, restSeasons: rest,
    startSeason, endSeason, isGraduated, isSuspended,
  };
}

// 시즌별 Po.A/B/C 독립 재합산(getCrewSeasonResults 미사용) — user_weekly_points → 정규 season_key.
const CANON = /^(\d{4})-(winter|spring|summer|autumn)$/;
async function expectedSeasonPoints(userId: string) {
  const { data: wp } = await supabaseAdmin
    .from("user_weekly_points").select("week_start_date,points,advantages,penalty").eq("user_id", userId);
  const rows = (wp ?? []) as Array<{ week_start_date: string | null; points: number | null; advantages: number | null; penalty: number | null }>;
  const dates = [...new Set(rows.map((r) => r.week_start_date).filter(Boolean) as string[])];
  const map = new Map<string, { poA: number; poB: number; poC: number }>();
  if (dates.length === 0) return map;
  const { data: dw } = await supabaseAdmin.from("weeks").select("start_date,season_key").in("start_date", dates);
  const keyByStart = new Map<string, string>();
  for (const w of (dw ?? []) as Array<{ start_date: string | null; season_key: string | null }>) {
    if (w.start_date && w.season_key && CANON.test(w.season_key)) keyByStart.set(w.start_date, w.season_key);
  }
  for (const r of rows) {
    const key = r.week_start_date ? keyByStart.get(r.week_start_date) : undefined;
    if (!key) continue;
    const a = map.get(key) ?? { poA: 0, poB: 0, poC: 0 };
    a.poA += r.points ?? 0; a.poB += r.advantages ?? 0; a.poC += r.penalty ?? 0;
    map.set(key, a);
  }
  return map;
}

async function snapCount(): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("*", { count: "exact", head: true });
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function main() {
  const cookie = await buildCookie();
  const snapBefore = await snapCount();

  // 샘플: org별 + 졸업/중단.
  const ids = new Set<string>();
  for (const org of ["encre", "oranke", "phalanx"]) {
    const { data } = await supabaseAdmin
      .from("user_profiles").select("user_id")
      .eq("organization_slug", org).not("activity_started_at", "is", null).limit(1);
    for (const r of (data ?? []) as { user_id: string }[]) ids.add(r.user_id);
  }
  for (const gs of ["graduated", "suspended"]) {
    const { data } = await supabaseAdmin
      .from("user_profiles").select("user_id").eq("growth_status", gs).limit(1);
    for (const r of (data ?? []) as { user_id: string }[]) ids.add(r.user_id);
  }

  const FIELDS = [
    "userId", "displayName", "organizationSlug", "profilePhotoUrl", "gender",
    "birthDate", "age", "address", "contactPhone", "contactEmail", "schoolName",
    "departmentName", "admissionPeriod", "crewCode", "statusLabel",
    "activityStartDate", "activityStartWeek", "activityEndDate", "activityEndWeek",
    "classLabel", "teamName", "partName",
  ] as const;

  for (const userId of ids) {
    const direct = await getCrewDetailDto(userId);
    const res = await fetch(`${BASE}/api/admin/members/${userId}`, {
      headers: { cookie },
      cache: "no-store",
    });
    const json = await res.json();
    console.log(`▶ ${direct?.displayName} (${userId})`);
    ck("HTTP 200 + success", res.ok && json.success === true, `status=${res.status}`);
    if (!json.success) continue;
    const http = json.data;
    let same = true;
    const diffs: string[] = [];
    for (const f of FIELDS) {
      if ((direct as any)?.[f] !== http[f]) {
        same = false;
        diffs.push(`${f}: direct=${JSON.stringify((direct as any)?.[f])} http=${JSON.stringify(http[f])}`);
      }
    }
    ck("direct == HTTP (전 필드)", same, diffs.join(" | "));
    ck("note 포함", typeof http.note === "object" && http.note !== null);

    // ── 클럽 결과(종합) — direct == HTTP 깊은 비교 + 고객 SoT 동일성 ──
    const SUMMARY_KEYS = [
      "successWeeks", "poA", "poB", "poC", "scheduleReliability",
      "activityCompletion", "infoCount", "experienceCount",
      "abilityUnitCount", "careerProjectCount",
    ] as const;
    const ds = (direct as any)?.clubSummary ?? {};
    const hs = http.clubSummary ?? {};
    const sumDiffs: string[] = [];
    let sumSame = true;
    for (const k of SUMMARY_KEYS) {
      if (ds[k] !== hs[k]) {
        sumSame = false;
        sumDiffs.push(`${k}: direct=${JSON.stringify(ds[k])} http=${JSON.stringify(hs[k])}`);
      }
    }
    ck("clubSummary direct == HTTP", sumSame, sumDiffs.join(" | "));

    // 고객 SoT 대조: 이력서 카드 skill-num(practicalStats) + 일정/활동(cluster.1) + 표 A(성장/포인트).
    const [resume, growthRows, pointsMap] = await Promise.all([
      getCluster1Resume(userId),
      getGrowthRosterBatchFast([userId]),
      sumPointsForUsers([userId]),
    ]);
    const ps = resume?.practicalStats;
    const g = growthRows[0];
    const pt = pointsMap.get(userId);
    // 4) 이력서 카드 skill-num == 상세 클럽 결과(실무 4종).
    ck(
      "실무 4종 == 이력서 카드 skill-num(practicalStats)",
      ds.infoCount === (ps?.infoCount ?? 0) &&
        ds.experienceCount === (ps?.experienceCount ?? 0) &&
        ds.abilityUnitCount === (ps?.abilityUnitCount ?? 0) &&
        ds.careerProjectCount === (ps?.careerProjectCount ?? 0),
      `info=${ds.infoCount}/${ps?.infoCount} exp=${ds.experienceCount}/${ps?.experienceCount} abil=${ds.abilityUnitCount}/${ps?.abilityUnitCount} car=${ds.careerProjectCount}/${ps?.careerProjectCount}`,
    );
    // 고객 cluster.1 일정 신뢰도 / 활동 완료율 동일.
    ck(
      "일정 신뢰도/활동 완료율 == 고객 cluster.1(resume rate)",
      ds.scheduleReliability === (resume?.scheduleReliability.rate ?? null) &&
        ds.activityCompletion === (resume?.activityCompletion.rate ?? null),
      `sched=${ds.scheduleReliability}/${resume?.scheduleReliability.rate} act=${ds.activityCompletion}/${resume?.activityCompletion.rate}`,
    );
    // 표 A 성장 성공 주차 / 포인트 A·B·C 동일.
    ck(
      "성장 성공/포인트 A·B·C == 표 A SoT",
      ds.successWeeks === (g?.successWeeks ?? null) &&
        ds.poA === (pt?.checkPoints ?? 0) &&
        ds.poB === (pt?.advantagePoints ?? 0) &&
        ds.poC === (pt?.penaltyPoints ?? 0),
      `succ=${ds.successWeeks}/${g?.successWeeks} A=${ds.poA}/${pt?.checkPoints} B=${ds.poB}/${pt?.advantagePoints} C=${ds.poC}/${pt?.penaltyPoints}`,
    );

    // ── 클럽 결과(시즌) — direct == HTTP + 고객 시즌 그로스 Details 공식 동일 ──
    const SEASON_KEYS = [
      "startSeason", "endSeason", "currentSeason",
      "availableSeasons", "successSeasons", "restSeasons",
    ] as const;
    const dss = (direct as any)?.seasonSummary ?? {};
    const hss = http.seasonSummary ?? {};
    const seaDiffs: string[] = [];
    let seaSame = true;
    for (const k of SEASON_KEYS) {
      if (dss[k] !== hss[k]) {
        seaSame = false;
        seaDiffs.push(`${k}: direct=${JSON.stringify(dss[k])} http=${JSON.stringify(hss[k])}`);
      }
    }
    ck("seasonSummary direct == HTTP", seaSame, seaDiffs.join(" | "));

    const exp = await expectedSeasonSummary(userId);
    // 4) 시즌 카운트(가능/성공/휴식) == 고객 growthPeriodStats 공식.
    ck(
      "시즌 카운트(가능/성공/휴식) == 고객 growthPeriodStats",
      dss.availableSeasons === exp.availableSeasons &&
        dss.successSeasons === exp.successSeasons &&
        dss.restSeasons === exp.restSeasons,
      `가능=${dss.availableSeasons}/${exp.availableSeasons} 성공=${dss.successSeasons}/${exp.successSeasons} 휴식=${dss.restSeasons}/${exp.restSeasons}`,
    );
    // 가능 = 성공 + 휴식 invariant.
    ck("가능 == 성공 + 휴식", dss.availableSeasons === dss.successSeasons + dss.restSeasons,
      `${dss.availableSeasons} == ${dss.successSeasons}+${dss.restSeasons}`);
    // 성장 시작 시즌 == season_definitions 재현(season_key 파싱 교차확인).
    ck("성장 시작 시즌 == 고객 startWeekInfo(시즌)", dss.startSeason === exp.startSeason,
      `direct=${dss.startSeason} expect=${exp.startSeason}`);
    // 성장 종료 시즌 == raw 분기 재현.
    ck("성장 종료 시즌 == 고객 endWeekInfo(시즌)", dss.endSeason === exp.endSeason,
      `direct=${dss.endSeason} expect=${exp.endSeason}`);
    // 추가: 엘리트/활동 중단 → 현재 시즌 "-".
    if (exp.isGraduated || direct?.statusLabel === "엘리트") {
      ck("엘리트/졸업 → 현재 시즌 '-'", dss.currentSeason === "-", dss.currentSeason);
    }
    if (exp.isSuspended || direct?.statusLabel === "활동 중단") {
      ck("활동 중단 → 현재 시즌 '-'", dss.currentSeason === "-", dss.currentSeason);
    }
    // 진행 중/엘리트 외 → 종료 시즌은 ~ing 또는 시즌 라벨.
    ck("성장 종료 시즌 형식(~ing 또는 시즌)",
      dss.endSeason === "~ing (성장 진행 중)" || /^\d{4}년, (겨울|봄|여름|가을) 시즌$/.test(dss.endSeason),
      dss.endSeason);
    // 현재 시즌 형식: "-" 또는 "YYYY년, X 시즌 - 진행 중/휴식 중".
    ck("현재 시즌 형식",
      dss.currentSeason === "-" || /^\d{4}년, (겨울|봄|여름|가을) 시즌 - (진행 중|휴식 중)$/.test(dss.currentSeason),
      dss.currentSeason);

    // ── 클럽 결과(시즌) 하단부 — 시즌별 결과 표 ──
    const dRows = (direct as any)?.seasonResults ?? [];
    const hRows = http.seasonResults ?? [];
    ck("seasonResults direct == HTTP", JSON.stringify(dRows) === JSON.stringify(hRows),
      `direct ${dRows.length}행 / http ${hRows.length}행`);

    // 결과 라벨 4종만.
    const LABELS = new Set(["진행 중", "시즌 성공", "시즌 휴식", "시즌 중단"]);
    ck("시즌 결과 라벨 4종만", dRows.every((r: any) => LABELS.has(r.seasonResultLabel)),
      dRows.map((r: any) => r.seasonResultLabel).join(","));

    // 현재 시즌(진행 중) 있으면 맨 위.
    const firstInProgress = dRows.findIndex((r: any) => r.seasonResultLabel === "진행 중");
    ck("진행 중 행은 맨 위(있으면)", firstInProgress === -1 || firstInProgress === 0,
      `진행중 index=${firstInProgress}`);

    // 시즌명 형식 "YY-계절".
    ck("시즌명 형식 'YY-계절'", dRows.every((r: any) => /^\d{2}-(겨울|봄|여름|가을)$/.test(r.seasonNameShort)),
      dRows.map((r: any) => r.seasonNameShort).join(","));

    // 허브 강화율 4종: null 또는 0~100 정수.
    const rateOk = (v: any) => v === null || (Number.isInteger(v) && v >= 0 && v <= 100);
    ck("허브 강화율 4종 형식(null|0~100)",
      dRows.every((r: any) => rateOk(r.hubRates.info) && rateOk(r.hubRates.experience) && rateOk(r.hubRates.ability) && rateOk(r.hubRates.career)),
      "");

    // 5) 포인트가 시즌 단위(비누적) — user_weekly_points 를 시즌별로 독립 재합산해 대조.
    const expPts = await expectedSeasonPoints(userId);
    let ptsSame = true; const ptsDiffs: string[] = [];
    for (const r of dRows as any[]) {
      const e = expPts.get(r.seasonKey) ?? { poA: 0, poB: 0, poC: 0 };
      if (r.poA !== e.poA || r.poB !== e.poB || r.poC !== e.poC) {
        ptsSame = false;
        ptsDiffs.push(`${r.seasonNameShort}: dto(${r.poA}/${r.poB}/${r.poC}) vs raw(${e.poA}/${e.poB}/${e.poC})`);
      }
    }
    ck("시즌 Po.A/B/C == 시즌 단위 raw 합(비누적)", ptsSame, ptsDiffs.join(" | "));

    // 소속&클래스: 배열(복수 가능). 각 항목 classLabel 문자열.
    ck("소속&클래스 구조(teamName/partName/classLabel)",
      dRows.every((r: any) => Array.isArray(r.memberships) &&
        r.memberships.every((m: any) => "teamName" in m && "partName" in m && typeof m.classLabel === "string")),
      "");

    // ── 클럽 결과(주차) 상단부 — direct == HTTP + 고객 위클리 그로스 Details 공식 동일 ──
    const WEEK_KEYS = [
      "startWeek", "endWeek", "currentWeek",
      "availableWeeks", "successWeeks", "failWeeks", "restWeeks",
    ] as const;
    const dws = (direct as any)?.weekSummary ?? {};
    const hws = http.weekSummary ?? {};
    const weekDiffs: string[] = [];
    let weekSame = true;
    for (const k of WEEK_KEYS) {
      if (dws[k] !== hws[k]) { weekSame = false; weekDiffs.push(`${k}: ${JSON.stringify(dws[k])} vs ${JSON.stringify(hws[k])}`); }
    }
    ck("weekSummary direct == HTTP", weekSame, weekDiffs.join(" | "));

    // 4) 주차 카운트 == 고객 statsCards.period(= getGrowthIndicators period a/b/c/e).
    const ind = await getGrowthIndicators(userId);
    const pd = ind?.period;
    ck("주차 카운트(가능/성공/실패/휴식) == 고객 statsCards.period",
      dws.availableWeeks === pd?.e && dws.successWeeks === pd?.a && dws.failWeeks === pd?.b && dws.restWeeks === pd?.c,
      `가능=${dws.availableWeeks}/${pd?.e} 성공=${dws.successWeeks}/${pd?.a} 실패=${dws.failWeeks}/${pd?.b} 휴식=${dws.restWeeks}/${pd?.c}`);
    // 가능 = 성공 + 실패 + 휴식 invariant.
    ck("가능 == 성공 + 실패 + 휴식",
      dws.availableWeeks === dws.successWeeks + dws.failWeeks + dws.restWeeks,
      `${dws.availableWeeks} == ${dws.successWeeks}+${dws.failWeeks}+${dws.restWeeks}`);
    // 일관성: 주차 성공(a) == 클럽 결과(종합) 성장 성공 주차.
    ck("주차 성공 == 종합 성장 성공 주차", dws.successWeeks === ds.successWeeks,
      `${dws.successWeeks}/${ds.successWeeks}`);
    // 엘리트/활동 중단 → 현재 주차 "-".
    if (exp.isGraduated || direct?.statusLabel === "엘리트") ck("엘리트/졸업 → 현재 주차 '-'", dws.currentWeek === "-", dws.currentWeek);
    if (exp.isSuspended || direct?.statusLabel === "활동 중단") ck("활동 중단 → 현재 주차 '-'", dws.currentWeek === "-", dws.currentWeek);
    // 시작 주차 형식 "YYYY년, X 시즌, n주차" 또는 "-".
    ck("성장 시작 주차 형식",
      dws.startWeek === "-" || /^\d{4}년, (겨울|봄|여름|가을) 시즌, \d+주차$/.test(dws.startWeek), dws.startWeek);
    // 종료 주차 형식: ~ing / "…시즌, n주차"(활동중단) / "…시즌"(졸업).
    ck("성장 종료 주차 형식",
      dws.endWeek === "~ing (성장 진행 중)" || /^\d{4}년, (겨울|봄|여름|가을) 시즌(, \d+주차)?$/.test(dws.endWeek), dws.endWeek);
    // 현재 주차 형식: "-" 또는 "…주차 - 성장 진행 중/개인 휴식 중/공식 휴식 중".
    ck("현재 주차 형식",
      dws.currentWeek === "-" || /^\d{4}년, (겨울|봄|여름|가을) 시즌, \d+주차 - (성장 진행 중|개인 휴식 중|공식 휴식 중)$/.test(dws.currentWeek), dws.currentWeek);

    // ── 클럽 결과(주차) 하단부 — 주차 결과 표 ──
    const dwr = (direct as any)?.weeklyResults ?? [];
    const hwr = http.weeklyResults ?? [];
    ck("weeklyResults direct == HTTP", JSON.stringify(dwr) === JSON.stringify(hwr), `direct ${dwr.length}행 / http ${hwr.length}행`);

    // 성장 결과 라벨 7종만.
    const WLABELS = new Set(["성장 성공", "성장 실패", "개인 휴식", "공식 휴식", "진행 중", "집계 중", "활동 중단"]);
    ck("성장 결과 라벨 7종만", dwr.every((r: any) => WLABELS.has(r.growthResultLabel)), "");

    // 9) 누적 성장 성공 주차 규칙 — 성공+1·진행/집계 중 null·그 외 유지.
    let cum = 0, cumOk = true;
    for (const r of dwr as any[]) {
      if (r.growthResultLabel === "진행 중" || r.growthResultLabel === "집계 중") {
        if (r.cumulativeSuccessWeeks !== null) { cumOk = false; break; }
      } else {
        if (r.growthResultLabel === "성장 성공") cum += 1;
        if (r.cumulativeSuccessWeeks !== cum) { cumOk = false; break; }
      }
    }
    ck("누적 성장 성공 주차 규칙(성공+1·진행/집계 null·그 외 유지)", cumOk, `최종 누적=${cum}`);

    // 10) 활동 중단 행은 마지막(이후 주차 없음).
    const susIdx = dwr.findIndex((r: any) => r.growthResultLabel === "활동 중단");
    ck("활동 중단 행 이후 주차 없음", susIdx === -1 || susIdx === dwr.length - 1, `활동중단 index=${susIdx}/${dwr.length}`);

    // 정렬: 오래된→최신(weekName 연도/주차 비교는 생략, 스냅샷 카드 순서 대조로 갈음).
    // 4~7) 고객 weekly-card 동일 — 스냅샷 카드 재현(truncate+suspension) 후 행별 SoT 대조.
    const snap = await readWeeklyCardsSnapshot(userId);
    let scards: any[] = snap.status === "hit" || snap.status === "stale" ? (snap as any).cards : [];
    const { data: prof } = await supabaseAdmin.from("user_profiles").select("growth_status,suspended_week_id,role").eq("user_id", userId).maybeSingle();
    const profRole = (prof as any)?.role ?? null;
    const isStopped = deriveEndStatus((prof as any)?.growth_status ?? null) === "stopped";
    scards = truncateCardsForGrowthStop(scards, isStopped);
    scards = [...scards].sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
    const susWeekId = (prof as any)?.growth_status === "suspended" ? (prof as any)?.suspended_week_id ?? null : null;
    if (susWeekId) { const i = scards.findIndex((c) => c.weekId === susWeekId); if (i >= 0) scards = scards.slice(0, i + 1); }
    const { data: wp } = await supabaseAdmin.from("user_weekly_points").select("week_start_date,points,advantages,penalty").eq("user_id", userId);
    const ptByStart = new Map<string, any>(((wp ?? []) as any[]).filter((x) => x.week_start_date).map((x) => [x.week_start_date, x]));
    const SLABEL: Record<string, string> = { success: "성장 성공", fail: "성장 실패", personal_rest: "개인 휴식", official_rest: "공식 휴식", running: "진행 중", tallying: "집계 중" };

    ck("행 수 == 스냅샷 truncate 카드 수", dwr.length === scards.length, `dto=${dwr.length} cards=${scards.length}`);
    let rowSoTOk = true; const rowDiffs: string[] = [];
    for (let i = 0; i < Math.min(dwr.length, scards.length); i++) {
      const r = dwr[i], c = scards[i];
      const expLabel = susWeekId && c.weekId === susWeekId ? "활동 중단" : (SLABEL[c.userWeekStatus] ?? c.userWeekStatus);
      const ap = computeSeasonAreaProgress([c], c.seasonKey);
      const bk = new Map(ap.map((x: any) => [x.key, x]));
      const hr = (k: string) => { const x: any = bk.get(k); return x && x.total > 0 ? x.rate : null; };
      const pt = ptByStart.get(c.startDate);
      const okWeekId = r.weekId === c.weekId;
      const okLabel = r.growthResultLabel === expLabel;
      // 클래스 = 어드민 SoT classLabel(role, card.roleLabel) — raw "일반"/"심화" 아님.
      const okTeam = r.teamName === c.teamName && r.partName === c.partName && r.classLabel === classLabel(profRole, c.roleLabel);
      const okPts = r.points.poA === (pt?.points ?? 0) && r.points.poB === (pt?.advantages ?? 0) && r.points.poC === (pt?.penalty ?? 0);
      const okHub = r.hubRates.info === hr("practical_info") && r.hubRates.experience === hr("practical_experience") && r.hubRates.ability === hr("practical_competency") && r.hubRates.career === hr("practical_career");
      if (!(okWeekId && okLabel && okTeam && okPts && okHub)) {
        rowSoTOk = false;
        if (rowDiffs.length < 3) rowDiffs.push(`[${i}] id=${okWeekId} label=${okLabel}(${r.growthResultLabel}/${expLabel}) team=${okTeam} pts=${okPts} hub=${okHub}`);
      }
    }
    ck("행별 SoT == 스냅샷 카드(라벨/팀파트클래스/포인트/허브)", rowSoTOk, rowDiffs.join(" | "));

    // 클래스 표기 SoT 통일 — 클럽소속/시즌/주차 모든 클래스가 어드민 5종만("일반" 금지).
    const CLS5 = new Set(["정규", "심화(파트장)", "심화(에이전트)", "운영진(앰배서더)", "운영진(팀장)"]);
    const allCls = [
      direct?.classLabel,
      ...dRows.flatMap((r: any) => r.memberships.map((m: any) => m.classLabel)),
      ...dwr.map((r: any) => r.classLabel),
    ].filter((x: any) => typeof x === "string");
    const badCls = [...new Set(allCls.filter((c: string) => !CLS5.has(c)))];
    ck("클래스 5종만(클럽소속/시즌/주차·'일반' 없음)", badCls.length === 0, badCls.join(",") || `샘플=${[...new Set(allCls)].join(",")}`);
  }

  // 5/6) snapshot 무영향(읽기 전용 — 재계산/write 없음).
  const snapAfter = await snapCount();
  ck("snapshot row 수 불변(읽기 전용·재계산 불필요)", snapBefore === snapAfter, `${snapBefore} → ${snapAfter}`);

  console.log("─".repeat(50));
  console.log(fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
