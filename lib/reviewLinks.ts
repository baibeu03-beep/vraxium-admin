export const REVIEW_LINK_RESOURCE_KEY = "cluster2.review_links" as const;

export const REVIEW_LINK_WEEK_INDICES = [
  3, 6, 9, 12, 15, 18, 21, 24, 27, 30,
] as const;

export type ReviewLinkWeekIndex = (typeof REVIEW_LINK_WEEK_INDICES)[number];

export type ReviewLinkSlot = {
  weekIndex: ReviewLinkWeekIndex;
  label: string;
  storageKey: string;
  legacyKey?: "cluvingReviewLink";
};

export type ReviewLinkDto = ReviewLinkSlot & {
  url: string | null;
  isVisible: boolean;
  isLegacyBackfilled?: boolean;
};

export const REVIEW_LINK_SLOTS: readonly ReviewLinkSlot[] = [
  { weekIndex: 3, label: "3 weeks", storageKey: "reviewLink3w" },
  { weekIndex: 6, label: "6 weeks", storageKey: "reviewLink6w" },
  { weekIndex: 9, label: "9 weeks", storageKey: "reviewLink9w" },
  { weekIndex: 12, label: "12 weeks", storageKey: "reviewLink12w" },
  { weekIndex: 15, label: "15 weeks", storageKey: "reviewLink15w" },
  { weekIndex: 18, label: "18 weeks", storageKey: "reviewLink18w" },
  { weekIndex: 21, label: "21 weeks", storageKey: "reviewLink21w" },
  { weekIndex: 24, label: "24 weeks", storageKey: "reviewLink24w" },
  { weekIndex: 27, label: "27 weeks", storageKey: "reviewLink27w" },
  {
    weekIndex: 30,
    label: "Total Complete",
    storageKey: "cluvingReviewLink",
    legacyKey: "cluvingReviewLink",
  },
] as const;

export function isReviewLinkWeekIndex(value: unknown): value is ReviewLinkWeekIndex {
  return (
    typeof value === "number" &&
    REVIEW_LINK_WEEK_INDICES.includes(value as ReviewLinkWeekIndex)
  );
}

export function normalizeReviewLinkUrl(value: unknown): string | null {
  if (typeof value !== "string") return value == null ? null : String(value);
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

// ── 클럽 리뷰 링크 순차 작성 정책 (전사 공통, 2026-06-04) ──
// 클럽 리뷰는 3 → 6 → 9 → … → 27 → 30(Total Complete) 순서대로만 작성할 수 있다.
//   - 30(Total Complete)은 27주차까지 모두 작성된 뒤 맨 마지막에만 작성 가능.
//   - 앞 주차 비우기는 더 뒤 주차가 채워져 있으면 불가(뒤에서부터 비움).
// 검증 단위 = "이번 요청에서 변경되는 슬롯"만 — 레거시 백필 등으로 이미 순서가 깨진
// 기존 데이터(예: 30만 채워진 사용자)가 있어도 무관한 슬롯 저장은 막지 않는다.
// 데모/일반/어드민 모두 동일 적용.
// (front repo lib/reviewLinkOrder.ts 와 mirror — 정책 변경 시 양쪽 동시 수정.)
export const REVIEW_LINK_SEQUENCE = [3, 6, 9, 12, 15, 18, 21, 24, 27, 30] as const;

export function reviewLinkWeekLabel(week: number): string {
  return week === 30 ? "Total Complete" : `${week}주차`;
}

export type ReviewLinkOrderViolation =
  | {
      kind: "write_requires_previous";
      violatingWeek: number; // 작성하려던 주차
      expectedNext: number; // 먼저 작성해야 하는(가장 앞의 빈) 주차
    }
  | {
      kind: "clear_requires_later_empty";
      violatingWeek: number; // 비우려던 주차
      blockingWeek: number; // 채워져 있어 비울 수 없게 만드는 뒤 주차
    };

// 기존 저장 상태 + 이번 요청 슬롯(url, 비우기는 null)을 받아 순서 위반을 찾는다.
//   - 신규 작성/값 수정: 시퀀스상 앞 주차들이 모두(최종 상태 기준) 채워져 있어야 한다.
//   - 비우기: 시퀀스상 뒤 주차들이 모두(최종 상태 기준) 비어 있어야 한다.
//   - 변경 없는 슬롯(미전송 or 동일 값)은 검사하지 않는다.
// url 은 정규화(normalizeReviewLinkUrl)된 값으로 넘긴다. 위반 없으면 null.
export function findReviewLinkOrderViolation(
  existingByWeek: ReadonlyMap<number, string | null>,
  incomingByWeek: ReadonlyMap<number, string | null>,
): ReviewLinkOrderViolation | null {
  const finalFilled = new Map<number, boolean>();
  for (const week of REVIEW_LINK_SEQUENCE) {
    const value = incomingByWeek.has(week)
      ? incomingByWeek.get(week) ?? null
      : existingByWeek.get(week) ?? null;
    finalFilled.set(week, Boolean(value));
  }

  for (let i = 0; i < REVIEW_LINK_SEQUENCE.length; i++) {
    const week = REVIEW_LINK_SEQUENCE[i];
    if (!incomingByWeek.has(week)) continue;
    const sent = incomingByWeek.get(week) ?? null;
    const old = existingByWeek.get(week) ?? null;

    if (sent && (!old || sent !== old)) {
      // 신규 작성 또는 값 수정 — 앞 주차 전부(최종 상태) 채움 필요.
      for (let j = 0; j < i; j++) {
        if (!finalFilled.get(REVIEW_LINK_SEQUENCE[j])) {
          return {
            kind: "write_requires_previous",
            violatingWeek: week,
            expectedNext: REVIEW_LINK_SEQUENCE[j],
          };
        }
      }
    } else if (!sent && old) {
      // 비우기 — 뒤 주차 전부(최종 상태) 비움 필요.
      for (let j = REVIEW_LINK_SEQUENCE.length - 1; j > i; j--) {
        if (finalFilled.get(REVIEW_LINK_SEQUENCE[j])) {
          return {
            kind: "clear_requires_later_empty",
            violatingWeek: week,
            blockingWeek: REVIEW_LINK_SEQUENCE[j],
          };
        }
      }
    }
  }
  return null;
}

export function reviewLinkOrderErrorMessage(violation: ReviewLinkOrderViolation): string {
  if (violation.kind === "clear_requires_later_empty") {
    return `${reviewLinkWeekLabel(violation.blockingWeek)} 리뷰가 작성된 상태에서는 ${reviewLinkWeekLabel(violation.violatingWeek)} 리뷰를 비울 수 없습니다. 뒤 주차부터 비워주세요.`;
  }
  return `클럽 리뷰 링크는 순서대로 작성해야 합니다. ${reviewLinkWeekLabel(violation.expectedNext)}를 먼저 작성해주세요. (${reviewLinkWeekLabel(violation.violatingWeek)}는 아직 작성할 수 없습니다)`;
}
