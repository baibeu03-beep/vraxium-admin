/**
 * 특정 유저의 "주차별 방패"와 "누적 방패" 불일치 진단 (READ-ONLY).
 *
 *   USER_ID=<uuid> npx tsx --env-file=.env.local scripts/diag-user-shields-weekly-vs-cumulative.ts
 *   npx tsx --env-file=.env.local scripts/diag-user-shields-weekly-vs-cumulative.ts <uuid>
 *
 * DB(user_weekly_points) 직접합산 ↔ 주차 카드 DTO(HTTP 동일경로) 를 나란히 비교한다.
 * ⚠ DB 수정 없음. select 만 수행.
 *
 * 배경 필드 (shared/cluster4.contracts.ts):
 *   card.points.shield      = 그 주차 user_weekly_points.advantages (raw, 주차값)
 *   card.cumulativeInjeolmi = sum(advantages) 누적 (raw, 시작~해당주차)
 *   card.fameScore/fmScore  = 가중 누적 Σ(points + adv*3 - penalty*5)
 *   누적 net 방패           = Σadvantages - |Σpenalty|  (이력서/Growth 표시 방패)
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { getUsersLegacyUserIdByUserId } from "@/lib/adminCrewData";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

type WeeklyRow = {
  year: number | null;
  week_number: number | null;
  week_start_date: string | null;
  points: number | null;
  advantages: number | null;
  penalty: number | null;
  created_at: string | null;
  updated_at: string | null;
};

function resolveUserId(): string {
  const fromEnv = (process.env.USER_ID ?? "").trim();
  const fromArg = (process.argv[2] ?? "").trim();
  const id = fromEnv || fromArg;
  if (!id) {
    throw new Error(
      "USER_ID 미지정. 예) USER_ID=<uuid> npx tsx --env-file=.env.local scripts/diag-user-shields-weekly-vs-cumulative.ts",
    );
  }
  return id;
}

async function fetchAllWeekly(userId: string): Promise<WeeklyRow[]> {
  const rows: WeeklyRow[] = [];
  const page = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("user_weekly_points")
      .select("year,week_number,week_start_date,points,advantages,penalty,created_at,updated_at")
      .eq("user_id", userId)
      .order("week_start_date", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(`user_weekly_points: ${error.message}`);
    const batch = (data ?? []) as WeeklyRow[];
    rows.push(...batch);
    if (batch.length < page) break;
    from += page;
  }
  return rows;
}

async function main() {
  const userId = resolveUserId();

  // ── 1. 기본 정보 ─────────────────────────────────────────────
  const [{ data: profile }, legacyUserId] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name,organization_slug")
      .eq("user_id", userId)
      .maybeSingle(),
    getUsersLegacyUserIdByUserId(userId).catch(() => null),
  ]);
  const prof = (profile ?? null) as {
    user_id: string;
    display_name: string | null;
    organization_slug: string | null;
  } | null;

  console.log("\n════════ 대상 유저 ════════");
  console.table([
    {
      user_id: userId,
      name: prof?.display_name ?? "(unknown)",
      legacy_user_id: legacyUserId ?? "(none)",
      organization: prof?.organization_slug ?? "(none)",
    },
  ]);

  // ── 2. user_weekly_points 전기간 직접합산 ────────────────────
  const weekly = await fetchAllWeekly(userId);
  let sumPoints = 0,
    sumAdvRaw = 0,
    sumPenalty = 0;
  const distinctWeeks = new Set<string>();
  for (const r of weekly) {
    sumPoints += r.points ?? 0;
    sumAdvRaw += r.advantages ?? 0;
    sumPenalty += r.penalty ?? 0;
    distinctWeeks.add(`${r.year}-${r.week_number}`);
  }
  const cumNetShields = sumAdvRaw - Math.abs(sumPenalty);

  console.log("\n════════ user_weekly_points 전기간 직접합산 ════════");
  console.table([
    {
      "Σ points(별)": sumPoints,
      "Σ advantages raw(방패raw)": sumAdvRaw,
      "Σ penalty": sumPenalty,
      "net shields(=Σadv-|Σpen|)": cumNetShields,
      rows: weekly.length,
      distinct_weeks: distinctWeeks.size,
    },
  ]);

  // ── 4. 주차 카드 DTO (HTTP 동일경로) ─────────────────────────
  let cards: Cluster4WeeklyCardDto[] = [];
  let cardErr: string | null = null;
  try {
    cards = await getCluster4WeeklyCardsForProfileUser(userId);
  } catch (e) {
    cardErr = (e as Error).message;
  }
  // startDate 기준 매칭 (user_weekly_points.week_start_date == card.startDate, ISO Monday).
  const cardByStart = new Map<string, Cluster4WeeklyCardDto>();
  for (const c of cards) cardByStart.set(c.startDate, c);

  // ── 3 + 4 병합: 주차별 상세 (DB ↔ DTO) ──────────────────────
  // user_weekly_points 행 + 매칭되는 카드. 카드만 있고 DB 없는 주차도 표기.
  const allStarts = new Set<string>();
  for (const r of weekly) if (r.week_start_date) allStarts.add(r.week_start_date);
  for (const c of cards) allStarts.add(c.startDate);
  const orderedStarts = [...allStarts].sort();

  const weeklyByStart = new Map<string, WeeklyRow>();
  for (const r of weekly) if (r.week_start_date) weeklyByStart.set(r.week_start_date, r);

  const detail: Array<Record<string, unknown>> = [];
  let maxWeeklyDisplayedShield = Number.NEGATIVE_INFINITY;

  for (const start of orderedStarts) {
    const r = weeklyByStart.get(start) ?? null;
    const c = cardByStart.get(start) ?? null;

    const dbAdvRaw = r?.advantages ?? null;
    const dbPenalty = r?.penalty ?? null;
    const dbNet =
      dbAdvRaw == null && dbPenalty == null
        ? null
        : (dbAdvRaw ?? 0) - Math.abs(dbPenalty ?? 0);

    // DTO 표시 방패 후보들.
    const dtoWeekShield = c?.points?.shield ?? null; // 주차 raw
    const dtoCumInjeolmi = c?.cumulativeInjeolmi ?? null; // 누적 raw
    const dtoFame = c?.fameScore ?? null; // 가중 누적

    if (typeof dtoWeekShield === "number")
      maxWeeklyDisplayedShield = Math.max(maxWeeklyDisplayedShield, dtoWeekShield);
    if (typeof dtoCumInjeolmi === "number")
      maxWeeklyDisplayedShield = Math.max(maxWeeklyDisplayedShield, dtoCumInjeolmi);

    // ── 5. 이상치 플래그 ──
    const flags: string[] = [];
    // 주차 카드 표시 방패(누적 injeolmi 또는 주차 shield)가 100 이상.
    if ((dtoCumInjeolmi ?? 0) >= 100 || (dtoWeekShield ?? 0) >= 100) flags.push("⚠≥100");
    // raw 방패 ≠ net 방패 (해당 주차).
    if (dbAdvRaw != null && dbNet != null && dbAdvRaw !== dbNet) flags.push("raw≠net");
    // 단일 주차 표시 방패(누적 injeolmi)가 누적 net 방패보다 큼.
    if ((dtoCumInjeolmi ?? Number.NEGATIVE_INFINITY) > cumNetShields)
      flags.push("inj>cumNet");
    // DTO 주차 shield 가 DB advantages(raw)와 다름 → 매핑/snapshot 의심.
    if (
      r != null &&
      c != null &&
      dtoWeekShield != null &&
      dbAdvRaw != null &&
      dtoWeekShield !== dbAdvRaw
    )
      flags.push("DTO≠DB");
    // 한쪽만 존재.
    if (r == null && c != null) flags.push("DTO-only(no DB)");
    if (r != null && c == null) flags.push("DB-only(no DTO)");

    detail.push({
      week: c?.weekNumber ?? `${r?.year}w${r?.week_number}`,
      season: c?.seasonKey ?? "-",
      start,
      status: c?.userWeekStatus ?? "-",
      db_points: r?.points ?? null,
      db_adv_raw: dbAdvRaw,
      db_penalty: dbPenalty,
      db_net: dbNet,
      "DTO points.shield(주차raw)": dtoWeekShield,
      "DTO cumInjeolmi(누적raw)": dtoCumInjeolmi,
      "DTO fameScore(가중)": dtoFame,
      created_at: r?.created_at ?? null,
      updated_at: r?.updated_at ?? null,
      flags: flags.join(",") || "",
    });
  }

  console.log("\n════════ 주차별 상세 (DB ↔ 주차카드 DTO) ════════");
  if (cardErr) console.log(`  ⚠ 카드 DTO 조회 실패: ${cardErr}`);
  console.table(detail);

  // 최신 카드(=현재 누적) 표시 방패.
  const latestCard = cards.length ? cards[0] : null; // getCluster4WeeklyCardsForProfileUser = 최신순
  const displayedCumInjeolmi = latestCard?.cumulativeInjeolmi ?? null;
  const displayedFame = latestCard?.fameScore ?? null;

  // ── 6. 요약 + 원인 추정 ─────────────────────────────────────
  console.log("\n════════ 요약 ════════");
  console.table([
    {
      "direct cumulative RAW shields": sumAdvRaw,
      "direct cumulative NET shields": cumNetShields,
      "displayed cumulative shields(cumInjeolmi 최신)": displayedCumInjeolmi,
      "displayed fameScore(가중,최신)": displayedFame,
      "max weekly displayed shields": Number.isFinite(maxWeeklyDisplayedShield)
        ? maxWeeklyDisplayedShield
        : null,
    },
  ]);

  console.log("\n──────── mismatch 원인 추정 ────────");
  const causes: string[] = [];
  if (displayedCumInjeolmi != null && displayedCumInjeolmi === sumAdvRaw) {
    causes.push(
      "A. 주차 카드가 RAW 누적(cumulativeInjeolmi=Σadvantages)을 표시 → 'net 방패(Σadv-|Σpen|)'와 다름(penalty 미차감).",
    );
  }
  if (
    Number.isFinite(maxWeeklyDisplayedShield) &&
    maxWeeklyDisplayedShield > cumNetShields
  ) {
    causes.push(
      "B. 단일 주차 표시 방패(누적 injeolmi)가 누적 NET 방패보다 큼 → '주차값'이 아니라 '누적값'이 주차칸에 노출 중.",
    );
  }
  if (sumAdvRaw !== cumNetShields) {
    causes.push(
      `C. penalty 차감 방식 차이: RAW(${sumAdvRaw}) vs NET(${cumNetShields}), |Σpenalty|=${Math.abs(sumPenalty)} 차감 여부에 따라 값이 갈림.`,
    );
  }
  const dtoMismatchRows = detail.filter((d) => String(d.flags).includes("DTO≠DB"));
  if (dtoMismatchRows.length) {
    causes.push(
      `D. DTO 필드 매핑 오류 의심: points.shield ≠ user_weekly_points.advantages 인 주차 ${dtoMismatchRows.length}건.`,
    );
  }
  if (displayedFame != null && displayedFame === sumPoints + sumAdvRaw * 3 - sumPenalty * 5) {
    causes.push(
      "참고: fameScore 는 가중누적 Σ(points+adv*3-penalty*5)으로 방패 합계와 무관(혼동 주의).",
    );
  }
  // snapshot stale / 매핑 누락: DB행은 있는데 카드 없음(DB-only) = 진짜 누락,
  // 또는 채점완료(success/fail) 주차인데 DB행이 없음(DTO-only) = 매핑 누락.
  // tallying/official_rest/personal_rest/running 의 DTO-only 는 채점 전이라 정상.
  const scoredDtoOnly = detail.filter(
    (d) =>
      String(d.flags).includes("DTO-only") &&
      (d.status === "success" || d.status === "fail"),
  );
  const dbOnly = detail.filter((d) => String(d.flags).includes("DB-only"));
  if (dbOnly.length || scoredDtoOnly.length) {
    causes.push(
      `E. snapshot/cache stale 또는 주차 매핑 누락 의심: DB-only ${dbOnly.length}건, 채점완료인데 DB행 없는 주차 ${scoredDtoOnly.length}건.`,
    );
  }
  if (causes.length === 0) {
    console.log("  (자동 추정 없음 — 표시값과 직접합산이 모두 정합적으로 보임)");
  } else {
    for (const c of causes) console.log("  • " + c);
  }

  console.log("\n[done] READ-ONLY 진단 종료. DB 변경 없음.\n");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
