import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { truncateCardsForGrowthStop } from "@/lib/cluster4GrowthStopPolicy";
import { deriveEndStatus } from "@/lib/growthCore";
import { computeSeasonAreaProgress } from "@/lib/cluster4SeasonCircles";
import { classLabel } from "@/lib/adminMembersTypes";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

// ─────────────────────────────────────────────────────────────────────
// 클럽 결과(주차) 하단부 — 주차 결과 표(/admin/members 상세).
//
// 한 행 = 크루가 활동을 시작한 주부터 활동 중단/졸업까지의 한 주차. 전부 고객 위클리 그로스
//   weekly-card snapshot SoT 직결(프론트 재계산 금지):
//   · 성장 결과 = card.userWeekStatus(success/fail/personal_rest/official_rest/running/tallying) 매핑
//     + 활동 중단(suspended_week_id 주차 override). "진행/집계 중"의 시점 규칙은 카드 status 가 이미 반영.
//   · 누적 성장 성공 주차 = 성공 시 +1·그 외 유지·진행/집계 중 null(미확정).
//   · 팀/파트/클래스 = 카드의 주차별 단일 소속(teamName/partName/roleLabel).
//   · Po.A/B/C = user_weekly_points 주차값(raw points/advantages/penalty, 비누적·종합/시즌과 동일 축).
//   · 허브 강화율 4종 = computeSeasonAreaProgress([card], seasonKey)(area-7 동일·주차 단위).
//
// 정렬 = 오래된 주차 → 최신 주차(ASC). 페이지네이션(15/페이지·기본 마지막 페이지)은 프론트가 처리.
// 읽기 전용 — snapshot 무접촉(재계산 0). 카드 truncation 은 read-time(고객 truncateCardsForGrowthStop
// 와 동일) + 활동 중단(suspended_week_id) 이후 컷(어드민 표시 규칙: "활동 중단 행 이후 없음").
// ─────────────────────────────────────────────────────────────────────

const SEASON_TYPE_KO: Record<string, string> = {
  winter: "겨울",
  spring: "봄",
  summer: "여름",
  autumn: "가을",
  fall: "가을",
};

// card.userWeekStatus → 어드민 성장 결과 라벨(6종). 활동 중단은 호출부에서 override.
const STATUS_LABEL: Record<string, string> = {
  success: "성장 성공",
  fail: "성장 실패",
  personal_rest: "개인 휴식",
  official_rest: "공식 휴식",
  running: "진행 중",
  tallying: "집계 중",
};

// card.userWeekStatus(raw) → 어드민 성장 결과 라벨. 회원 상세 표·주차 상세 페이지가 동일 라벨을
//   쓰도록 단일 SoT 로 export(라벨 문자열은 StatusBadge 레지스트리 색 매핑 키이기도 하다).
export function adminWeekStatusLabel(status: string | null | undefined): string {
  return STATUS_LABEL[status ?? ""] ?? status ?? "-";
}

export type CrewWeeklyResultRow = {
  weekId: string | null;
  weekName: string; // "2026년, 봄 시즌, 13주차"
  // 카드 원본 상태 코드(success/fail/personal_rest/official_rest/running/tallying). 라벨이 아닌
  //   raw 코드 — 프론트가 isCrewWeekEditable(수정 잠금) 판정에 사용. 활동 중단 override 와 무관하게
  //   "그 주차 성장 결과의 확정 여부"는 이 코드로 판정한다.
  userWeekStatus: string;
  growthResultLabel: string; // 성장 성공/실패/개인 휴식/공식 휴식/진행 중/집계 중/활동 중단
  cumulativeSuccessWeeks: number | null; // 누적 성장 성공 주차(진행/집계 중 = null)
  teamName: string | null;
  partName: string | null;
  classLabel: string; // 주차 클래스(card.roleLabel)
  points: { poA: number; poB: number; poC: number }; // 주차 단위(비누적). poB=최종 B(adv−pen), poC=penalty
  hubRates: {
    info: number | null;
    experience: number | null;
    ability: number | null;
    career: number | null;
  };
};

// season_key + 시즌상대 week_number → "2026년, 봄 시즌, 13주차". 파싱 불가 null.
//   회원 상세 표·주차 상세 페이지·breadcrumb 가 동일 주차명을 쓰도록 export(단일 SoT).
export function formatWeekFull(seasonKey: string | null, weekNumber: number | null): string | null {
  if (!seasonKey || weekNumber == null) return null;
  const m = seasonKey.toLowerCase().match(/^(\d{4})-(winter|spring|summer|autumn|fall)$/);
  if (!m) return null;
  const ko = SEASON_TYPE_KO[m[2]];
  if (!ko) return null;
  return `${m[1]}년, ${ko} 시즌, ${weekNumber}주차`;
}

export async function getCrewWeeklyResults(userId: string): Promise<CrewWeeklyResultRow[]> {
  const [snap, profileRes, wpRes] = await Promise.all([
    readWeeklyCardsSnapshot(userId),
    supabaseAdmin
      .from("user_profiles")
      .select("growth_status,status,suspended_week_id,role")
      .eq("user_id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("user_weekly_points")
      .select("week_start_date,points,advantages,penalty")
      .eq("user_id", userId),
  ]);

  let cards: Cluster4WeeklyCardDto[] =
    snap.status === "hit" || snap.status === "stale" ? snap.cards : [];
  if (cards.length === 0) return [];

  const profile = (profileRes.data ?? null) as {
    growth_status: string | null;
    status: string | null;
    suspended_week_id: string | null;
    role: string | null;
  } | null;
  // 주차별 역할 이력 테이블 부재 → 현재 role + 주차 카드 등급(card.roleLabel)으로 5종 클래스 산정.
  const currentRole = profile?.role ?? null;
  const isSuspended = profile?.growth_status === "suspended";
  // 성장 중단(suspended/paused) → running/tallying 카드 제거(고객 truncateCardsForGrowthStop 동일).
  const isStopped = deriveEndStatus(profile?.growth_status ?? null) === "stopped";
  cards = truncateCardsForGrowthStop(cards, isStopped);

  // 오래된 주차 → 최신 주차(ASC). snapshot 은 최신 우선(DESC)이라 명시 정렬.
  cards = [...cards].sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));

  // 활동 중단: suspended_week_id 주차까지만(이후 주차 컷). "활동 중단 행 이후 데이터 없음".
  const suspendedWeekId = isSuspended ? profile?.suspended_week_id ?? null : null;
  if (suspendedWeekId) {
    const idx = cards.findIndex((c) => c.weekId === suspendedWeekId);
    if (idx >= 0) cards = cards.slice(0, idx + 1);
  }

  // 주차별 raw 포인트(week_start_date → points/advantages/penalty).
  const ptByStart = new Map<string, { points: number | null; advantages: number | null; penalty: number | null }>();
  for (const r of (wpRes.data ?? []) as Array<{
    week_start_date: string | null;
    points: number | null;
    advantages: number | null;
    penalty: number | null;
  }>) {
    if (r.week_start_date) ptByStart.set(r.week_start_date, r);
  }

  let cum = 0;
  const rows: CrewWeeklyResultRow[] = cards.map((card) => {
    const label =
      suspendedWeekId && card.weekId === suspendedWeekId
        ? "활동 중단"
        : STATUS_LABEL[card.userWeekStatus] ?? card.userWeekStatus;

    // 누적 성장 성공 주차 — 성공 +1·그 외 유지·진행/집계 중 null(미확정).
    let cumulativeSuccessWeeks: number | null;
    if (label === "진행 중" || label === "집계 중") {
      cumulativeSuccessWeeks = null;
    } else {
      if (label === "성장 성공") cum += 1;
      cumulativeSuccessWeeks = cum;
    }

    // 허브 강화율 — area-7 동일 산식(단일 카드). total 0 → null("-").
    const ap = computeSeasonAreaProgress([card], card.seasonKey);
    const byKey = new Map<string, (typeof ap)[number]>(ap.map((x) => [x.key as string, x]));
    const rate = (k: string): number | null => {
      const x = byKey.get(k);
      return x && x.total > 0 ? x.rate : null;
    };

    const pt = ptByStart.get(card.startDate);

    return {
      weekId: card.weekId,
      weekName: formatWeekFull(card.seasonKey, card.weekNumber) ?? card.weekLabel ?? "-",
      userWeekStatus: card.userWeekStatus,
      growthResultLabel: label,
      cumulativeSuccessWeeks,
      teamName: card.teamName,
      partName: card.partName,
      // 클래스 = 어드민 단일 SoT classLabel(role, level) — 5종. card.roleLabel(등급 raw "일반"/"심화")
      //   을 그대로 쓰지 않는다("일반"→"정규" 통일).
      classLabel: classLabel(currentRole, card.roleLabel),
      // Po.B = 최종 B(= advantages − penalty, 음수 가능). 주차 단위. (2026-07-13)
      points: { poA: pt?.points ?? 0, poB: (pt?.advantages ?? 0) - (pt?.penalty ?? 0), poC: pt?.penalty ?? 0 },
      hubRates: {
        info: rate("practical_info"),
        experience: rate("practical_experience"),
        ability: rate("practical_competency"),
        career: rate("practical_career"),
      },
    };
  });

  return rows;
}
