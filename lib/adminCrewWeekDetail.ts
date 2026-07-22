import { getAdminCrewDtoByLegacyUserId } from "@/lib/adminCrewData";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { applyEnhancementOverridesToCards } from "@/lib/cluster4EnhancementOverride";
import { applySecondEntryOverridesToCards } from "@/lib/cluster4SecondEntryOverride";
import { breakdownFromLines, emptyBreakdown } from "@/lib/cluster4WeeklyCardsData";
import { weekClassLabel, classLabel } from "@/lib/adminMembersTypes";
import { roundGrowthRate } from "@/lib/lineAvailability";
import { adminWeekStatusLabel, formatWeekFull } from "@/lib/adminCrewWeeklyResults";
import { isCrewWeekEditable } from "@/shared/growth.contracts";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

// ─────────────────────────────────────────────────────────────────────
// 회원별 · 주차별 상세(관리) 페이지의 서버 DTO 단일 loader.
//   /admin/members/{userId}/weeks/{weekId} 가 소비한다.
//
// 핵심 불변식: "크루 페이지(/cluster-4-card)와 동일한 계산 SoT를 그대로 사용한다."
//   - 주차 카드 = weekly-card snapshot(readWeeklyCardsSnapshot) + 라인 강화 상태 수동 override
//     read-time overlay(applyEnhancementOverridesToCards) — 고객 조회(loadWeeklyCards)와 동일 경로.
//   - 별/방패/포인트C = card.points, 주차 성장률·허브별 강화율 = breakdownFromLines(card.lines).
//   - loader 는 userId(=user_profiles.user_id) 만으로 카드를 읽는다. mode=test/actAsTestUserId/
//     demoUserId 는 "어느 userId 를 넘길지"만 바꾸며(라우트 스코프 게이트), 이 계산은 mode 무관이다.
//     → 일반/테스트/데모 경로가 같은 카드·같은 DTO를 탄다(드리프트 0).
//
// 이 페이지는 "회원 개인의 그 주차 결과"만 다룬다 — 클럽/주차 공통 데이터(라인 오픈 여부 등)는
//   조회 근거로만 쓰고 이 DTO 로도, 어떤 write API 로도 변경하지 않는다.
// ─────────────────────────────────────────────────────────────────────

export type CrewWeekHubKey =
  | "practicalInfo"
  | "practicalExperience"
  | "practicalCompetency"
  | "practicalCareer";

export type CrewWeekHubSummary = {
  hub: CrewWeekHubKey;
  label: string; // "실무 정보" 등
  totalCount: number; // 가용 라인 칸 수(분모 A)
  successCount: number; // 강화 성공 칸 수(분자 B)
  rate: number; // round(B/A*100). total=0 → 0
};

export type CrewWeekDetailDto = {
  member: {
    // URL 식별자(레거시 user id — 링크/복귀에 그대로 사용). 실제 조회 키(user_profiles.user_id)는
    //   서버 내부에서만 쓰고 노출하지 않는다.
    userId: string;
    displayName: string | null;
    organizationSlug: string | null;
  };
  week: {
    weekId: string;
    label: string; // "2026년, 여름 시즌, 2주차"
    startDate: string;
    endDate: string;
    status: string; // raw userWeekStatus (success/fail/personal_rest/official_rest/running/tallying)
    statusLabel: string; // 어드민 라벨(성장 성공/진행 중 …) — 회원 상세 표와 동일 SoT
    isRestWeek: boolean;
    // 개인 데이터 수정 가능 여부(SoT=isCrewWeekEditable). running/tallying → false.
    editable: boolean;
    // 확정 여부(editable 과 동의어 축 — 미확정=진행/집계 중). 표시용 라벨 포함.
    confirmed: boolean;
    confirmationLabel: string; // "결과 확정" | "미확정(집계 전)"
    // 활동 주차 진행(예: "2 / 25 주차") — 카드 displayWeekProgressLabel 그대로.
    progressLabel: string;
    accumulatedApprovedWeeks: number;
    totalRequiredWeeks: number;
  };
  assignment: {
    teamName: string | null;
    partName: string | null;
    roleLabel: string | null; // = membershipLevel(카드 roleLabel raw "일반"/"심화")
    classLabel: string; // 5종 클래스(정규/운영진 …) — 회원 상세 표와 동일 SoT classLabel(role, level)
  };
  // 조직별 표시명 매핑(별/방패/…)은 프론트가 getProcessPointLabels(org)로 처리 — 여기선 값만.
  points: {
    star: number | null;
    shield: number | null;
    pointC: number | null;
  };
  // 주차 성장률 = 4허브 합산(강화 성공/전체 대상). breakdownFromLines 합과 동일(고객 카드 산식).
  growth: {
    successCount: number;
    totalCount: number;
    rate: number;
  };
  hubs: CrewWeekHubSummary[];
};

// 조회 결과 구분 — 라우트가 상태코드/에러 메시지로 변환한다.
export type CrewWeekDetailResult =
  | { ok: true; data: CrewWeekDetailDto }
  | { ok: false; reason: "member_not_found" | "week_not_found" };

async function loadOverlaidCards(userId: string): Promise<Cluster4WeeklyCardDto[]> {
  const snap = await readWeeklyCardsSnapshot(userId);
  const raw =
    snap.status === "hit" || snap.status === "stale"
      ? snap.cards
      : await recomputeAndStoreWeeklyCardsSnapshot(userId);
  // 고객 조회와 동일하게 read-time override overlay 적용(overlay 실패는 raw 폴백).
  //   ① 강화 상태 overlay → ② 2차 기입 편집권 overlay. 고객 weekly-cards 경로와 동일 순서.
  try {
    const afterEnh = await applyEnhancementOverridesToCards(userId, raw);
    return await applySecondEntryOverridesToCards(userId, afterEnh);
  } catch {
    return raw;
  }
}

type ResolvedCrew = NonNullable<Awaited<ReturnType<typeof getAdminCrewDtoByLegacyUserId>>>;

// 회원별·주차별 상세의 "카드 1건" 단일 해석기 — 액트/라인 탭 등 모든 하위 loader 가 공유한다(드리프트 0).
//   member_not_found: legacyUserId 로 크루를 못 찾음. week_not_found: 그 크루 스냅샷 카드에 weekId 없음
//   (= 그 회원에게 귀속되지 않은 주차/오입력). URL weekId 를 그대로 신뢰하지 않고 소유를 검증한다.
export type CrewWeekCardResolution =
  | { ok: true; crew: ResolvedCrew; card: Cluster4WeeklyCardDto & { weekId: string } }
  | { ok: false; reason: "member_not_found" | "week_not_found" };

export async function resolveCrewWeekCard(
  legacyUserId: string,
  weekId: string,
): Promise<CrewWeekCardResolution> {
  const crew = await getAdminCrewDtoByLegacyUserId(legacyUserId);
  if (!crew) return { ok: false, reason: "member_not_found" };

  const cards = await loadOverlaidCards(crew.userId);
  const card = cards.find((c) => c.weekId === weekId);
  if (!card || !card.weekId) return { ok: false, reason: "week_not_found" };

  return { ok: true, crew, card: card as Cluster4WeeklyCardDto & { weekId: string } };
}

/**
 * 회원(legacyUserId)의 특정 주차(weekId) 상세 DTO를 조립한다.
 *   - member_not_found / week_not_found → 라우트 404. 조직 격리는 상위 라우트의 requireAdmin +
 *     스코프 게이트가 담당한다. 카드 해석은 resolveCrewWeekCard(공유 SoT) 위임.
 */
export async function getCrewWeekDetail(
  legacyUserId: string,
  weekId: string,
): Promise<CrewWeekDetailResult> {
  const resolved = await resolveCrewWeekCard(legacyUserId, weekId);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const { crew, card } = resolved;

  const rest = card.isRestWeek;
  const b = rest ? emptyBreakdown() : breakdownFromLines(card.lines);
  const hub = (
    hubKey: CrewWeekHubKey,
    label: string,
    d: { completed: number; available: number },
  ): CrewWeekHubSummary => ({
    hub: hubKey,
    label,
    totalCount: d.available,
    successCount: d.completed,
    rate: roundGrowthRate(d.completed, d.available),
  });
  const hubs: CrewWeekHubSummary[] = [
    hub("practicalInfo", "실무 정보", b.info),
    hub("practicalExperience", "실무 경험", b.experience),
    hub("practicalCompetency", "실무 역량", b.ability),
    hub("practicalCareer", "실무 경력", b.career),
  ];
  const successCount =
    b.info.completed + b.ability.completed + b.experience.completed + b.career.completed;
  const totalCount =
    b.info.available + b.ability.available + b.experience.available + b.career.available;

  const editable = isCrewWeekEditable(card.userWeekStatus);

  return {
    ok: true,
    data: {
      member: {
        userId: legacyUserId,
        displayName: crew.displayName || null,
        organizationSlug: crew.organizationSlug,
      },
      week: {
        weekId: card.weekId,
        label: formatWeekFull(card.seasonKey, card.weekNumber) ?? card.weekLabel ?? "-",
        startDate: card.startDate,
        endDate: card.endDate,
        status: card.userWeekStatus,
        statusLabel: adminWeekStatusLabel(card.userWeekStatus),
        isRestWeek: rest,
        editable,
        confirmed: editable,
        confirmationLabel: editable ? "결과 확정" : "미확정(집계 전)",
        progressLabel: card.displayWeekProgressLabel,
        accumulatedApprovedWeeks: card.accumulatedApprovedWeeks,
        totalRequiredWeeks: card.totalRequiredWeeks,
      },
      assignment: {
        teamName: card.teamName,
        partName: card.partName,
        roleLabel: card.roleLabel,
        // 주차 화면 — 그 주차 effective position_code 기준. 현재 role 을 섞지 않는다(이력 훼손 방지).
        classLabel: weekClassLabel(card.crewClassPositionCode, card.roleLabel),
      },
      points: {
        star: card.points.star,
        shield: card.points.shield,
        pointC: card.points.pointC,
      },
      growth: {
        successCount,
        totalCount,
        rate: roundGrowthRate(successCount, totalCount),
      },
      hubs,
    },
  };
}
