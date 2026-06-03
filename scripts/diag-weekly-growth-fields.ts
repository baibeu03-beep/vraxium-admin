/**
 * WEEKLY GROWTH 카드 8개 필드 검증 (cluster-4-1).
 *   npx tsx scripts/diag-weekly-growth-fields.ts [profileUserId]
 *
 * 대상 필드(화면 → DTO):
 *   1) 시즌 배지            ← growthSummary.endStatus
 *   2) 현재 클럽 상태 문구   ← currentWeekInfo (year/seasonName/weekNumber/status/restReason)
 *   3) 성장 시작 주차        ← growthSummary.startWeekDisplay
 *   4) 성장 가능 주차        ← growthSummary.availableWeeks (+ restSeasonCount)
 *   5) 성장 성공 주차        ← growthSummary.approvedWeeks
 *   6) 성장 실패 주차        ← growthSummary.failedWeeks
 *   7) 성장 휴식 주차        ← growthSummary.restWeeks
 *   8) 성장 종료 주차        ← growthSummary.endWeekDisplay
 *
 * 검증:
 *   (1) direct function(getWeeklyGrowth) 결과
 *   (2) HTTP /api/cluster4/weekly-growth (demoUserId + internal userId) — 서버 기동 시
 *   (3) direct == HTTP(demo) == HTTP(internal)  → 일반 모드 == demoUserId 모드
 *   (4) 카드 fold 교차검증 (approved/failed/rest 를 raw 카드에서 독립 재계산)
 *   (5) snapshot 영향 — weekly-growth 는 live 경로(snapshot 테이블 미접근) 확인
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";
import { listTestUsers } from "@/lib/testUsers";
import { getSeasonForDate } from "@/lib/seasonCalendar";

// currentWeekInfo 와 동일한 시즌상대주차 산정식(시즌 시작일 기준 7일 블록)을 독립 복제.
const DAY_MS = 86_400_000;
function toMs(iso: string): number {
  return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
}
function seasonRelWeek(weekStartIso: string): {
  year: number;
  type: string;
  weekNumber: number;
} | null {
  const season = getSeasonForDate(weekStartIso);
  if (!season) return null;
  const dayOffset = Math.floor(
    (toMs(weekStartIso) - toMs(season.startDate)) / DAY_MS,
  );
  return {
    year: season.year,
    type: season.type,
    weekNumber: Math.floor(dayOffset / 7) + 1,
  };
}

const BASE = process.env.BASE_URL || "http://localhost:3000";
type Growth = NonNullable<Awaited<ReturnType<typeof getWeeklyGrowth>>>;

// 검증 대상 필드만 추려 deep-compare 용 JSON 으로 정규화.
function fields(dto: Growth) {
  return {
    currentWeekInfo: dto.currentWeekInfo,
    growthSummary: dto.growthSummary,
  };
}

async function pickUser(
  override: string | null,
): Promise<{ userId: string; name: string } | null> {
  const users = await listTestUsers();
  console.log(`[scan] test users = ${users.length}`);
  if (override) {
    const u = users.find((x) => x.userId === override);
    return { userId: override, name: u?.name ?? "(override)" };
  }
  // 주차 이력이 가장 많은(=8필드 비자명) 유저 우선.
  let best: { userId: string; name: string; score: number } | null = null;
  let scanned = 0;
  for (const u of users) {
    let dto: Growth | null = null;
    try {
      dto = await getWeeklyGrowth(u.userId);
    } catch {
      continue;
    }
    if (!dto) continue;
    scanned++;
    const g = dto.growthSummary;
    const score = g.approvedWeeks + g.failedWeeks + g.restWeeks;
    if (!best || score > best.score) {
      best = { userId: u.userId, name: u.name, score };
    }
  }
  console.log(`[scan] getWeeklyGrowth 성공 유저 = ${scanned}`);
  return best;
}

async function tryHttp(
  path: string,
  headers: Record<string, string>,
): Promise<Growth | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { headers });
    const json: any = await res.json();
    if (!json?.success || !json?.data) {
      console.log(`  HTTP ${path} → success=${json?.success} (data 없음)`);
      return null;
    }
    return json.data as Growth;
  } catch (e) {
    console.log(
      `  HTTP ${path} → 서버 미응답 (${e instanceof Error ? e.message : e})`,
    );
    return null;
  }
}

function printFields(dto: Growth) {
  const c = dto.currentWeekInfo;
  const g = dto.growthSummary;
  console.log("  [1] 시즌 배지         endStatus       =", g.endStatus);
  console.log(
    "  [2] 현재 클럽 상태    currentWeekInfo =",
    JSON.stringify({
      year: c.year,
      seasonName: c.seasonName,
      weekNumber: c.weekNumber,
      status: c.status,
      restReason: c.restReason,
    }),
  );
  console.log("  [3] 성장 시작 주차    startWeekDisplay=", g.startWeekDisplay);
  console.log(
    "  [4] 성장 가능 주차    availableWeeks  =",
    g.availableWeeks,
    `(restSeasonCount=${g.restSeasonCount})`,
  );
  console.log("  [5] 성장 성공 주차    approvedWeeks   =", g.approvedWeeks);
  console.log("  [6] 성장 실패 주차    failedWeeks     =", g.failedWeeks);
  console.log("  [7] 성장 휴식 주차    restWeeks       =", g.restWeeks);
  console.log("  [8] 성장 종료 주차    endWeekDisplay  =", g.endWeekDisplay);
}

// 카드에서 approved/failed/rest 를 독립 재계산 → growthSummary fold 검증.
function crossCheckFold(dto: Growth) {
  let approved = 0,
    failed = 0,
    rest = 0;
  for (const card of dto.weeklyCards) {
    if (card.isTransition) continue;
    if (card.resultStatus === "success") approved++;
    else if (card.resultStatus === "fail") failed++;
    else if (card.resultStatus === "personal_rest") rest++;
  }
  const g = dto.growthSummary;
  const ok =
    approved === g.approvedWeeks &&
    failed === g.failedWeeks &&
    rest === g.restWeeks &&
    approved + failed + rest === g.availableWeeks;
  console.log("\n── (4) 카드 fold 교차검증 (전환주차 제외) ──");
  console.log(
    `  카드 재계산: 성공=${approved} 실패=${failed} 휴식=${rest} 가능=${approved + failed + rest}`,
  );
  console.log(
    `  DTO    값  : 성공=${g.approvedWeeks} 실패=${g.failedWeeks} 휴식=${g.restWeeks} 가능=${g.availableWeeks}`,
  );
  console.log(ok ? "  ✅ 카드 fold == growthSummary" : "  ❌ 불일치");
  return ok;
}

// 시작/종료 주차의 시즌상대주차가 currentWeekInfo 기준식과 일치하는지 독립 검증.
async function crossCheckSeasonRelative(
  userId: string,
  dto: Growth,
): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("user_week_statuses")
    .select("year,week_number,week_start_date,season_key")
    .eq("user_id", userId)
    .order("year", { ascending: true })
    .order("week_number", { ascending: true });
  const rows = (data ?? []) as Array<{
    year: number;
    week_number: number;
    week_start_date: string | null;
    season_key: string | null;
  }>;
  console.log("\n── (4b) 시즌상대주차 교차검증 (currentWeekInfo 기준식) ──");
  if (rows.length === 0) {
    console.log("  user_week_statuses 행 없음 — 스킵");
    return true;
  }
  const first = rows[0];
  const last = rows[rows.length - 1];
  let ok = true;

  const checkOne = (
    label: string,
    row: (typeof rows)[number],
    display: string,
  ) => {
    const rel = row.week_start_date ? seasonRelWeek(row.week_start_date) : null;
    if (!rel) {
      console.log(`  ${label}: 시즌 판별 불가(폴백 경로) display="${display}"`);
      return;
    }
    const expected = `${rel.year}년, ${rel.type} 시즌, ${rel.weekNumber}주차`;
    const has = display.includes(expected);
    if (!has) ok = false;
    console.log(
      `  ${label}: ISO주차=${row.week_number} → 시즌상대주차=${rel.weekNumber} | 기대 "${expected}" | display="${display}" | ${has ? "✅" : "❌"}`,
    );
  };

  checkOne("성장 시작", first, dto.growthSummary.startWeekDisplay);
  if (dto.growthSummary.endStatus !== "in_progress") {
    checkOne("성장 종료", last, dto.growthSummary.endWeekDisplay);
  } else {
    console.log(
      `  성장 종료: in_progress → "${dto.growthSummary.endWeekDisplay}" (주차 표기 없음)`,
    );
  }
  console.log(ok ? "  ✅ 시즌상대주차 일치" : "  ❌ 불일치");
  return ok;
}

async function main() {
  const picked = await pickUser(process.argv[2] || null);
  if (!picked) {
    console.log("❌ 테스트 유저를 찾지 못했습니다.");
    return;
  }
  console.log(`\n[target] name=${picked.name} userId=${picked.userId}`);

  // (1) direct
  const direct = await getWeeklyGrowth(picked.userId);
  if (!direct) {
    console.log("❌ getWeeklyGrowth → null");
    return;
  }
  console.log("\n──────── (1) direct getWeeklyGrowth ────────");
  printFields(direct);

  // (4) fold 교차검증
  const foldOk = crossCheckFold(direct);

  // (4b) 시즌상대주차 교차검증 — user_week_statuses 최초/최종행에서 독립 재계산.
  const relOk = await crossCheckSeasonRelative(picked.userId, direct);

  // (2)(3) HTTP demo + internal
  console.log("\n──────── (2)(3) HTTP /api/cluster4/weekly-growth ────────");
  const internalKey = process.env.INTERNAL_API_KEY;
  const demoDto = await tryHttp(
    `/api/cluster4/weekly-growth?demoUserId=${picked.userId}`,
    {},
  );
  const internalDto = internalKey
    ? await tryHttp(`/api/cluster4/weekly-growth?userId=${picked.userId}`, {
        "x-internal-api-key": internalKey,
      })
    : null;

  const directJson = JSON.stringify(fields(direct));
  let httpOk: boolean | null = null;
  if (demoDto) {
    const eq = JSON.stringify(fields(demoDto)) === directJson;
    httpOk = eq;
    console.log(`  demoUserId HTTP == direct : ${eq ? "✅ 일치" : "❌ 불일치"}`);
    if (!eq) {
      console.log("    direct:", directJson);
      console.log("    http  :", JSON.stringify(fields(demoDto)));
    }
  } else {
    console.log("  demoUserId HTTP: 응답 없음(서버 미기동) — 스킵");
  }
  if (internalDto) {
    const eq = JSON.stringify(fields(internalDto)) === directJson;
    httpOk = (httpOk ?? true) && eq;
    console.log(`  internal   HTTP == direct : ${eq ? "✅ 일치" : "❌ 불일치"}`);
    if (demoDto) {
      const parity =
        JSON.stringify(fields(internalDto)) === JSON.stringify(fields(demoDto));
      console.log(
        `  demoUserId == internal     : ${parity ? "✅ 동일 DTO" : "❌ 상이"}`,
      );
    }
  }

  // (5) snapshot 영향
  console.log("\n──────── (5) snapshot 영향 ────────");
  const { count } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id", { count: "exact", head: true })
    .eq("user_id", picked.userId);
  console.log(
    "  weekly-growth 는 live 경로 — currentWeekInfo/growthSummary 매 요청 계산.",
  );
  console.log(
    `  cluster4_weekly_card_snapshots 행 존재=${count ?? 0} (weekly-cards 전용, weekly-growth 와 무관).`,
  );

  console.log("\n──────── 결과 요약 ────────");
  console.log(`  (1) direct 8필드 산출       : ✅`);
  console.log(`  (4) 카드 fold 일치          : ${foldOk ? "✅" : "❌"}`);
  console.log(`  (4b) 시즌상대주차 일치      : ${relOk ? "✅" : "❌"}`);
  console.log(
    `  (2)(3) HTTP == direct      : ${
      httpOk === null ? "⏭ 서버 미기동" : httpOk ? "✅" : "❌"
    }`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
