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
