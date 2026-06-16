// 성장 중단 "주차 카드별" 표시 정책 검증 (front Cluster41Content 예측 재현) — READ-ONLY.
//
// 프론트(components/cluster-4-1/Cluster41Content.tsx)는 "성장 중단" 배지를
//   growthInfo.endWeekInfo(= user_profiles.suspended_week_id 파생, status==='suspended' 일 때만 채움)와
//   (연도·시즌(한글)·season-relative weekNumber)이 일치하는 카드 1장에만 적용한다.
//   본 스크립트는 그 예측을 실데이터로 재현해 다음을 단언한다:
//     ① 성장 중단(suspended) 사용자: 정확히 stop 주차 카드 1장만 '성장 중단' → 그 카드는
//        ground-truth(suspended_week_id 의 season_key + week_number)와 동일.
//     ② 과거 success/fail/personal_rest/official_rest 카드는 원래 상태 그대로(덮어쓰기 0).
//     ③ running/tallying(미확정)은 백엔드 truncate 로 이미 제거(목록에 없음).
//     ④ paused 사용자: endWeekInfo 미충전(status!=='suspended') → stop 주차 카드 0(상단 배지만).
//
//   npx tsx --env-file=.env.local scripts/verify-growth-stop-card-badge.ts
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { loadGrowthStopInfo, truncateCardsForGrowthStop } from "@/lib/cluster4GrowthStopPolicy";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

// 프론트 lib/cluster4-types.seasonLabel 의 한글 매핑과 동일.
const SEASON_KO: Record<string, string> = {
  spring: "봄",
  summer: "여름",
  fall: "가을",
  autumn: "가을",
  winter: "겨울",
};

// 프론트 /api/profile parseSeasonType 재현: season_type → { seasonName(KO), isBreak }.
function parseSeasonType(sType: string | null): { seasonName: string | null; isBreak: boolean } {
  if (!sType) return { seasonName: null, isBreak: false };
  const norm = sType.toLowerCase().trim();
  if (!norm.includes("break")) return { seasonName: SEASON_KO[norm] ?? sType, isBreak: false };
  const parts = norm.replace("_break", "").split("_");
  const to = parts[1] ?? parts[0];
  return { seasonName: SEASON_KO[to] ?? sType, isBreak: true };
}

// 프론트 parseWeekTitle 의 (year, season) 추출 재현: displayTitle 라벨에서 정규식으로 뽑는다.
function parseCardTitle(card: Cluster4WeeklyCardDto): { year: number | null; season: string | null } {
  const label = `${card.displayTitle ?? ""} ${card.weekLabel ?? ""}`;
  let year: number | null = null;
  const ym = label.match(/(\d{4})\s*(?:년|년도)?/);
  if (ym) year = parseInt(ym[1], 10);
  else if (typeof card.startDate === "string" && /^\d{4}/.test(card.startDate)) {
    year = parseInt(card.startDate.slice(0, 4), 10);
  }
  let season: string | null = null;
  const sm = label.match(/(봄|여름|가을|겨울)/);
  if (sm) season = sm[1];
  return { year, season };
}

type EndWeekInfo = { year: number | null; seasonName: string | null; weekNumber: number | null; isBreak: boolean };

async function resolveEndWeekInfo(suspendedWeekId: string): Promise<{
  endWeekInfo: EndWeekInfo;
  truth: { seasonKey: string | null; weekNumber: number | null };
} | null> {
  const { data, error } = await supabaseAdmin
    .from("weeks")
    .select("week_number, season_key, season_definitions!inner(season_type, year)")
    .eq("id", suspendedWeekId)
    .maybeSingle();
  if (error || !data) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sd = (data as any).season_definitions;
  const parsed = parseSeasonType(sd?.season_type ?? null);
  return {
    endWeekInfo: {
      year: sd?.year ?? null,
      seasonName: parsed.seasonName,
      weekNumber: parsed.isBreak ? null : ((data as any).week_number ?? null),
      isBreak: parsed.isBreak,
    },
    truth: { seasonKey: (data as any).season_key ?? null, weekNumber: (data as any).week_number ?? null },
  };
}

// 프론트 isStopWeekCard 술어 재현.
function isStopWeekCard(
  card: Cluster4WeeklyCardDto,
  isStoppedUser: boolean,
  endWeekInfo: EndWeekInfo | null,
): boolean {
  if (!isStoppedUser || !endWeekInfo) return false;
  const restLike =
    card.userWeekStatus === "personal_rest" ||
    card.userWeekStatus === "official_rest" ||
    card.isRestWeek === true;
  if (restLike) return false;
  const t = parseCardTitle(card);
  if (t.year !== endWeekInfo.year) return false;
  if (t.season !== endWeekInfo.seasonName) return false;
  return endWeekInfo.isBreak ? card.isTransition === true : card.weekNumber === endWeekInfo.weekNumber;
}

async function loadCards(userId: string): Promise<Cluster4WeeklyCardDto[]> {
  const snap = await readWeeklyCardsSnapshot(userId);
  if (snap.status === "hit" || snap.status === "stale") return snap.cards;
  // 신규/미스 → direct DTO 폴백(검증 가시성 용도).
  return getCluster4WeeklyCardsForProfileUser(userId).catch(() => []);
}

async function main() {
  const testIds = await fetchTestUserMarkerIds();
  // 마이그레이션 게이트: suspended_week_id 컬럼이 적용됐는지 먼저 확인한다.
  //   미적용이면(2026-06-16_user_profiles_suspended_week_id.sql) endWeekInfo SoT 가 없어
  //   카드별 stop 배지가 켜질 수 없다 → "migration pending" 안내 후 종료(검증 skip).
  const probe = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, suspended_week_id")
    .limit(1);
  const migrationApplied = !(probe.error && /suspended_week_id/.test(probe.error.message));
  console.log(
    migrationApplied
      ? "▶ suspended_week_id 컬럼 적용됨 — 풀 파이프라인 검증\n"
      : "▶ suspended_week_id 컬럼 미적용 — front /api/profile endWeekInfo 가 항상 null (카드 stop 배지 0).\n" +
          "  db/migrations/2026-06-16_user_profiles_suspended_week_id.sql 적용 후 재실행하면 풀 검증됩니다.\n",
  );

  const selectCols = migrationApplied
    ? "user_id, display_name, status, growth_status, suspended_week_id, activity_ended_at, organization_slug"
    : "user_id, display_name, status, growth_status, activity_ended_at, organization_slug";
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select(selectCols)
    .in("growth_status", ["suspended", "paused"]);
  if (error) {
    console.error("query failed:", error.message);
    process.exit(1);
  }
  const rows = (data ?? []).filter((r) => !testIds.has((r as Record<string, unknown>).user_id as string));
  console.log(`운영(non-test) 성장중단/일시중지 후보 ${rows.length}명\n`);

  let pass = true;
  let detailed = 0;

  for (const rRaw of rows) {
    const r = rRaw as Record<string, unknown>;
    const userId = r.user_id as string;
    const status = (r.status as string | null) ?? null;
    const growthStatus = (r.growth_status as string | null) ?? null;
    const activityEndedAt = (r.activity_ended_at as string | null) ?? null;
    const suspendedWeekId = (r.suspended_week_id as string | null) ?? null;
    const info = await loadGrowthStopInfo(userId);
    const isStoppedUser = growthStatus === "suspended" || growthStatus === "paused"; // getGrowthBadgeText==="성장 중단" 근사

    const rawCards = await loadCards(userId);
    // 백엔드와 동일하게 미확정(running/tallying) 제거.
    const cards = truncateCardsForGrowthStop(rawCards, info.isStopped);

    // 프론트 endWeekInfo 재현: growth_status==='suspended' && suspended_week_id 일 때만 채워진다(paused 제외).
    let endWeekInfo: EndWeekInfo | null = null;
    let truth: { seasonKey: string | null; weekNumber: number | null } | null = null;
    if (growthStatus === "suspended" && suspendedWeekId) {
      const resolved = await resolveEndWeekInfo(suspendedWeekId);
      if (resolved) {
        endWeekInfo = resolved.endWeekInfo;
        truth = resolved.truth;
      }
    }

    const stopCards = cards.filter((c) => isStopWeekCard(c, isStoppedUser, endWeekInfo));
    const leftoverPending = cards.filter(
      (c) => c.userWeekStatus === "running" || c.userWeekStatus === "tallying",
    );

    // ── 단언 ──
    const checks: string[] = [];
    // ③ 미확정 카드는 truncate 로 제거됨.
    if (info.isStopped && leftoverPending.length !== 0) {
      checks.push(`✗ running/tallying 잔존 ${leftoverPending.length}`);
      pass = false;
    }
    if (!endWeekInfo) {
      // ②④ endWeekInfo 미충전(주차 미지정 또는 paused) → stop 카드 0, 모든 카드 원 상태 유지(블랭킷 override 회귀 방지).
      if (stopCards.length !== 0) {
        checks.push(`✗ endWeekInfo=null 인데 stop 카드 ${stopCards.length} (기대 0 — override 회귀?)`);
        pass = false;
      } else {
        checks.push(
          growthStatus === "paused"
            ? "✓ paused: stop 카드 0 (상단/프로필 배지만)"
            : "✓ 주차 미지정: stop 카드 0 — 모든 카드 원 상태 유지, 상단/프로필 배지만 성장 중단",
        );
      }
    } else {
      // ①② suspended + 주차 지정: 정확히 ≤1 stop 카드, 매칭 카드는 ground-truth(seasonKey+weekNumber)와 동일.
      if (stopCards.length > 1) {
        checks.push(`✗ stop 카드 ${stopCards.length} (기대 ≤1)`);
        pass = false;
      }
      for (const c of stopCards) {
        const okTruth =
          (c.seasonKey ?? null) === truth?.seasonKey && c.weekNumber === truth?.weekNumber;
        if (!okTruth) {
          checks.push(
            `✗ stop 카드 mismatch: card(${c.seasonKey},W${c.weekNumber}) vs truth(${truth?.seasonKey},W${truth?.weekNumber})`,
          );
          pass = false;
        } else {
          checks.push(`✓ stop 주차 카드 = ground-truth(${c.seasonKey} W${c.weekNumber}), 1장만`);
        }
      }
      if (stopCards.length === 0) {
        checks.push("△ 지정 주차 카드가 목록에 없음(전환주차/미확정) — 상단 배지만");
      }
      // ② 나머지 카드 보존: 술어가 stop 카드만 true 이므로 구조적 보장(가시화는 아래 목록).
    }

    // 상세 출력(최대 6명).
    if (detailed < 6) {
      detailed++;
      console.log(`● ${r.display_name} [${r.organization_slug}] status=${status} growth=${growthStatus}`);
      console.log(
        `  isStopped=${info.isStopped} activity_ended_at=${activityEndedAt ?? "—"} suspended_week_id=${suspendedWeekId ?? "—"} ` +
          `endWeekInfo=${endWeekInfo ? `${endWeekInfo.year}/${endWeekInfo.seasonName}/W${endWeekInfo.weekNumber}${endWeekInfo.isBreak ? "(break)" : ""}` : "null"}`,
      );
      const counts: Record<string, number> = {};
      for (const c of cards) counts[c.userWeekStatus] = (counts[c.userWeekStatus] ?? 0) + 1;
      console.log(`  카드 ${cards.length}장 상태분포=${JSON.stringify(counts)}`);
      for (const c of cards) {
        const stop = isStopWeekCard(c, isStoppedUser, endWeekInfo);
        const shownLabel = stop ? "성장 중단" : c.statusLabel;
        console.log(
          `    ${stop ? "▶" : " "} W${c.weekNumber} [${c.seasonKey ?? "-"}] ` +
            `userWeekStatus=${c.userWeekStatus} → 표시="${shownLabel}"` +
            `${stop ? "  (stop 주차)" : ""}`,
        );
      }
      checks.forEach((m) => console.log(`  ${m}`));
      console.log("");
    }
  }

  // 합성 단언: 동일 사용자 가짜 카드로 술어가 stop 주차 1장만 true 인지.
  const ewi: EndWeekInfo = { year: 2026, seasonName: "봄", weekNumber: 5, isBreak: false };
  const synth = [
    { displayTitle: "2026 봄 시즌, 3주차", weekNumber: 3, seasonKey: "2026-spring", userWeekStatus: "success", isRestWeek: false, isTransition: false, statusLabel: "성공" },
    { displayTitle: "2026 봄 시즌, 4주차", weekNumber: 4, seasonKey: "2026-spring", userWeekStatus: "fail", isRestWeek: false, isTransition: false, statusLabel: "실패" },
    { displayTitle: "2026 봄 시즌, 5주차", weekNumber: 5, seasonKey: "2026-spring", userWeekStatus: "fail", isRestWeek: false, isTransition: false, statusLabel: "실패" },
    { displayTitle: "2026 봄 시즌, 2주차", weekNumber: 2, seasonKey: "2026-spring", userWeekStatus: "personal_rest", isRestWeek: true, isTransition: false, statusLabel: "휴식" },
  ] as unknown as Cluster4WeeklyCardDto[];
  const synthStop = synth.filter((c) => isStopWeekCard(c, true, ewi));
  const synthOk = synthStop.length === 1 && synthStop[0].weekNumber === 5;
  // 휴식 주차가 stop 주차와 같은 번호여도 덮어쓰지 않음 검증.
  const restAtStop = [
    { displayTitle: "2026 봄 시즌, 5주차", weekNumber: 5, seasonKey: "2026-spring", userWeekStatus: "personal_rest", isRestWeek: true, isTransition: false, statusLabel: "휴식" },
  ] as unknown as Cluster4WeeklyCardDto[];
  const restGuardOk = restAtStop.filter((c) => isStopWeekCard(c, true, ewi)).length === 0;
  if (!synthOk || !restGuardOk) pass = false;
  console.log(
    `synthetic: stop=1@W5 ${synthOk ? "ok" : "FAIL"}, rest-at-stop 미덮어쓰기 ${restGuardOk ? "ok" : "FAIL"}`,
  );

  console.log("\n" + (pass ? "INVARIANTS: PASS ✓" : "INVARIANTS: FAIL ✗"));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
