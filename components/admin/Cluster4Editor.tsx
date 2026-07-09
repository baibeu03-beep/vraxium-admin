"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Save, Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadingState } from "@/components/ui/loading-state";
import { cn } from "@/lib/utils";
import { formatClubDate } from "@/lib/clubDate";
import { CONFIRM, useConfirm } from "@/components/ui/confirm-dialog";
import {
  ORGANIZATION_LABEL,
  type OrganizationSlug,
} from "@/lib/organizations";
import { DebugSection } from "@/components/admin/fieldKit";
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";
import ActivityTab from "@/components/admin/cluster4/ActivityTab";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import type {
  Cluster4ApplySummary,
  Cluster4Bundle,
  Cluster4DeleteResource,
  Cluster4PatchBody,
  ReceivedSeasonReputationRow,
  ReputationKeywordRow,
  UserSeasonHistoryRow,
  WeekRow,
  WeeklyColleagueRow,
  WeeklyReputationRow,
} from "@/lib/adminCluster4Types";
import {
  formatRestReasonLabel,
  WEEK_STATUS_STYLE,
  WEEK_STATUS_LABEL,
  RESULT_OPTIONS,
  type WeeklyGrowthDto,
  type WeeklyCardDto,
  type WeekResultStatus,
} from "@/lib/cluster4WeeklyGrowthTypes";
import { getPointLabels } from "@/lib/pointLabels";
import {
  computeEditWindowStatus,
  computeQuickActionRange,
  statusLabel as editWindowStatusLabel,
  type EditWindowDto,
  type EditWindowStatus,
  type QuickActionKey,
} from "@/lib/adminEditWindowsTypes";

type TabKey =
  | "weekly_growth"
  | "season_review"
  | "season_reputation"
  | "weekly_reputation"
  | "weekly_review"
  | "weekly_colleague"
  | "activities"
  | "debug";

const TABS: { key: TabKey; label: string }[] = [
  { key: "weekly_growth", label: "주간 성장" },
  { key: "season_review", label: "시즌 리뷰" },
  { key: "season_reputation", label: "받은 시즌 평판" },
  { key: "weekly_reputation", label: "위클리 평판" },
  { key: "weekly_review", label: "위클리 리뷰" },
  { key: "weekly_colleague", label: "위클리 연계동료" },
  { key: "activities", label: "활동" },
  { key: "debug", label: "디버그" },
];

// ─────────────────────────────────────────────────────────────
// Form row types — bundle row 의 editable subset.
// ─────────────────────────────────────────────────────────────

type SeasonReviewFormRow = {
  id: string;
  seasonLabel: string;
  rating: string;
  review: string;
  editable: boolean;
};

type SeasonReputationFormRow = {
  id: string;
  reviewer_id: string;
  target_user_id: string;
  season_history_id: string | null;
  rating: string;
  content: string;
  keyword_1: string;
  keyword_2: string;
  keyword_3: string;
  created_at: string | null;
  updated_at: string | null;
  reviewer: ReceivedSeasonReputationRow["reviewer"];
};

type WeeklyReputationFormRow = {
  id: string;
  reviewer_id: string;
  target_user_id: string;
  week_card_id: string;
  rating: string;
  content: string;
  keyword: string;
  created_at: string | null;
  updated_at: string | null;
  reviewer: WeeklyReputationRow["reviewer"];
};

type WeeklyReviewFormRow = {
  id: string;
  user_id: string;
  week_card_id: string;
  rating: string;
  content: string;
  created_at: string | null;
  updated_at: string | null;
};

type WeeklyColleagueFormRow = {
  id: string;
  user_id: string;
  week_card_id: string;
  colleague_id: string;
  message: string;
  created_at: string | null;
  updated_at: string | null;
  colleague: WeeklyColleagueRow["colleague"];
};

type FormState = {
  seasonReviewRows: SeasonReviewFormRow[];
  seasonReputationRows: SeasonReputationFormRow[];
  weeklyReputationRows: WeeklyReputationFormRow[];
  weeklyReviewRows: WeeklyReviewFormRow[];
  weeklyColleagueRows: WeeklyColleagueFormRow[];
};

// ─────────────────────────────────────────────────────────────
// Bundle/form helpers
// ─────────────────────────────────────────────────────────────

function emptyBundle(legacyUserId: string): Cluster4Bundle {
  return {
    legacyUserId,
    userId: null,
    seasons: [],
    weeks: [],
    userSeasonHistories: [],
    receivedSeasonReputations: [],
    reputationKeywords: [],
    receivedWeeklyReputations: [],
    weeklyReviews: [],
    weeklyColleagues: [],
    userActivityDetails: [],
    careerRecords: [],
    activityTypesClusterMap: {},
    cluster4LineTargets: [],
    cluster4HubEditWindows: {
      "cluster4.work_info": null,
      "cluster4.work_ability": null,
      "cluster4.work_exp": null,
      "cluster4.work_career": null,
    },
    tablesAvailable: {
      seasons: false,
      weeks: false,
      userSeasonHistories: false,
      seasonReputations: false,
      reputationKeywords: false,
      weeklyReputations: false,
      weeklyReviews: false,
      weeklyColleagues: false,
      userActivityDetails: false,
      careerRecords: false,
      activityTypes: false,
      cluster4LineTargets: false,
      userEditWindows: false,
    },
  };
}

function emptyForm(): FormState {
  return {
    seasonReviewRows: [],
    seasonReputationRows: [],
    weeklyReputationRows: [],
    weeklyReviewRows: [],
    weeklyColleagueRows: [],
  };
}

function pickValue(
  row: Record<string, unknown> | null | undefined,
  keys: readonly string[],
): unknown {
  if (!row) return undefined;
  for (const key of keys) {
    if (!(key in row)) continue;
    const value = row[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function seasonIdOf(row: Record<string, unknown> | null | undefined): string | null {
  const value = pickValue(row, ["season_key", "season_id", "seasonId", "id"]);
  return value === undefined ? null : String(value);
}

function seasonLabelFromSeason(row: Record<string, unknown> | null | undefined): string {
  const value = pickValue(row, ["season_label", "season_type", "season_key", "id"]);
  return value === undefined ? "-" : String(value);
}

function buildSeasonLabelMap(seasons: Record<string, unknown>[]) {
  const map = new Map<string, string>();
  for (const season of seasons) {
    const id = seasonIdOf(season);
    if (!id) continue;
    map.set(id, seasonLabelFromSeason(season));
  }
  return map;
}

// weeks 는 schema 가 다양한 dialect 로 운영 DB 에 존재해 우선순위 기반으로
// "YYYY-MM-DD ~ YYYY-MM-DD" 또는 "Wxx" 같은 사람이 읽기 좋은 라벨을 만든다.
function weekLabelFromWeek(row: Record<string, unknown>): string {
  const number = pickValue(row, ["week_number", "weekNumber", "number"]);
  const start = pickValue(row, ["start_date", "startDate", "starts_at"]);
  const end = pickValue(row, ["end_date", "endDate", "ends_at"]);
  const holiday = pickValue(row, ["holiday_name", "holidayName"]);
  const parts: string[] = [];
  if (number !== undefined) parts.push(`W${number}`);
  if (start !== undefined && end !== undefined) {
    parts.push(`${start} ~ ${end}`);
  } else if (start !== undefined) {
    parts.push(String(start));
  }
  if (holiday !== undefined) parts.push(`(${holiday})`);
  if (parts.length === 0) {
    const id = pickValue(row, ["id"]);
    return id === undefined ? "-" : String(id);
  }
  return parts.join(" ");
}

function buildWeekLabelMap(weeks: WeekRow[]) {
  const map = new Map<string, string>();
  for (const week of weeks) {
    const id = pickValue(week as Record<string, unknown>, ["id"]);
    if (id === undefined || id === null) continue;
    map.set(String(id), weekLabelFromWeek(week as Record<string, unknown>));
  }
  return map;
}

function stringifyInput(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function syncFormFromBundle(bundle: Cluster4Bundle): FormState {
  const seasonLabels = buildSeasonLabelMap(bundle.seasons);

  return {
    seasonReviewRows: bundle.userSeasonHistories.map((row) => {
      const idValue = pickValue(row, ["id"]);
      const seasonId = seasonIdOf(row);
      return {
        id: idValue === undefined ? "" : String(idValue),
        seasonLabel: seasonId ? (seasonLabels.get(seasonId) ?? seasonId) : "-",
        rating: stringifyInput(pickValue(row, ["rating"])),
        review: stringifyInput(pickValue(row, ["review"])),
        editable: idValue !== undefined && idValue !== null && String(idValue).trim() !== "",
      };
    }),
    seasonReputationRows: bundle.receivedSeasonReputations.map((row) => ({
      id: row.id,
      reviewer_id: row.reviewer_id,
      target_user_id: row.target_user_id,
      season_history_id: row.season_history_id,
      rating: row.rating === null || row.rating === undefined ? "" : String(row.rating),
      content: row.content ?? "",
      keyword_1: row.keyword_1 ?? "",
      keyword_2: row.keyword_2 ?? "",
      keyword_3: row.keyword_3 ?? "",
      created_at: row.created_at,
      updated_at: row.updated_at,
      reviewer: row.reviewer,
    })),
    weeklyReputationRows: bundle.receivedWeeklyReputations.map((row) => ({
      id: row.id,
      reviewer_id: row.reviewer_id,
      target_user_id: row.target_user_id,
      week_card_id: row.week_card_id,
      rating: row.rating === null || row.rating === undefined ? "" : String(row.rating),
      content: row.content ?? "",
      keyword: row.keyword ?? "",
      created_at: row.created_at,
      updated_at: row.updated_at,
      reviewer: row.reviewer,
    })),
    weeklyReviewRows: bundle.weeklyReviews.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      week_card_id: row.week_card_id,
      rating: row.rating === null || row.rating === undefined ? "" : String(row.rating),
      content: row.content ?? "",
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    weeklyColleagueRows: bundle.weeklyColleagues.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      week_card_id: row.week_card_id,
      colleague_id: row.colleague_id,
      message: row.message ?? "",
      created_at: row.created_at,
      updated_at: row.updated_at,
      colleague: row.colleague,
    })),
  };
}

// ─────────────────────────────────────────────────────────────
// Validation — DB CHECK 와 동일 정책. 저장 직전 client-side 1차 차단.
// ─────────────────────────────────────────────────────────────

const SEASON_REVIEW_RATING_MESSAGE = "평점은 0~10 사이의 정수로 입력해주세요.";

function validateSeasonReviewForm(form: FormState): string | null {
  for (const row of form.seasonReviewRows) {
    if (!row.editable) continue;
    const raw = row.rating.trim();
    if (raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 10) {
      return SEASON_REVIEW_RATING_MESSAGE;
    }
  }
  return null;
}

const SEASON_REPUTATION_RATING_MESSAGE =
  "rating 은 1~10 사이 0.5 단위 숫자여야 합니다.";
const SEASON_REPUTATION_CONTENT_MESSAGE =
  "content 는 1~300 자여야 합니다.";
const SEASON_REPUTATION_KEYWORD_LENGTH_MESSAGE =
  "keyword_1/2/3 은 각각 1~10 자여야 합니다.";
const SEASON_REPUTATION_KEYWORD_DISTINCT_MESSAGE =
  "keyword_1/2/3 은 모두 서로 다른 값이어야 합니다.";

function validateSeasonReputationForm(form: FormState): string | null {
  for (const row of form.seasonReputationRows) {
    const rating = Number(row.rating);
    if (
      !Number.isFinite(rating) ||
      rating < 1 ||
      rating > 10 ||
      rating * 2 !== Math.floor(rating * 2)
    ) {
      return SEASON_REPUTATION_RATING_MESSAGE;
    }
    const content = row.content.trim();
    if (content.length < 1 || content.length > 300) {
      return SEASON_REPUTATION_CONTENT_MESSAGE;
    }
    const k1 = row.keyword_1.trim();
    const k2 = row.keyword_2.trim();
    const k3 = row.keyword_3.trim();
    if (
      k1.length < 1 || k1.length > 10 ||
      k2.length < 1 || k2.length > 10 ||
      k3.length < 1 || k3.length > 10
    ) {
      return SEASON_REPUTATION_KEYWORD_LENGTH_MESSAGE;
    }
    if (k1 === k2 || k2 === k3 || k1 === k3) {
      return SEASON_REPUTATION_KEYWORD_DISTINCT_MESSAGE;
    }
  }
  return null;
}

const WEEKLY_REPUTATION_RATING_MESSAGE =
  "rating 은 0~10 사이 0.5 단위 숫자여야 합니다.";
const WEEKLY_REPUTATION_CONTENT_MESSAGE = "content 는 1~100 자여야 합니다.";
const WEEKLY_REPUTATION_KEYWORD_MESSAGE = "keyword 는 1~30 자여야 합니다.";

function validateWeeklyReputationForm(form: FormState): string | null {
  for (const row of form.weeklyReputationRows) {
    const rating = Number(row.rating);
    if (
      !Number.isFinite(rating) ||
      rating < 0 ||
      rating > 10 ||
      rating * 2 !== Math.floor(rating * 2)
    ) {
      return WEEKLY_REPUTATION_RATING_MESSAGE;
    }
    const content = row.content.trim();
    if (content.length < 1 || content.length > 100) {
      return WEEKLY_REPUTATION_CONTENT_MESSAGE;
    }
    const k = row.keyword.trim();
    if (k.length < 1 || k.length > 30) {
      return WEEKLY_REPUTATION_KEYWORD_MESSAGE;
    }
  }
  return null;
}

const WEEKLY_REVIEW_RATING_MESSAGE = "평점은 1~10 사이의 정수로 입력해주세요.";
const WEEKLY_REVIEW_CONTENT_MESSAGE = "내용은 1~200 자여야 합니다.";

function validateWeeklyReviewForm(form: FormState): string | null {
  for (const row of form.weeklyReviewRows) {
    const rating = Number(row.rating);
    if (!Number.isFinite(rating) || !Number.isInteger(rating) || rating < 1 || rating > 10) {
      return WEEKLY_REVIEW_RATING_MESSAGE;
    }
    const content = row.content.trim();
    if (content.length < 1 || content.length > 200) {
      return WEEKLY_REVIEW_CONTENT_MESSAGE;
    }
  }
  return null;
}

const WEEKLY_COLLEAGUE_MESSAGE_MESSAGE =
  "한 줄 코멘트는 비워두거나 1~200 자여야 합니다.";

function validateWeeklyColleagueForm(form: FormState): string | null {
  for (const row of form.weeklyColleagueRows) {
    const trimmed = row.message.trim();
    if (trimmed.length > 200) {
      return WEEKLY_COLLEAGUE_MESSAGE_MESSAGE;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// PATCH body builders
// ─────────────────────────────────────────────────────────────

function buildSeasonReviewPatch(form: FormState): Cluster4PatchBody {
  return {
    userSeasonHistories: form.seasonReviewRows
      .filter((row) => row.editable)
      .map((row) => ({
        id: row.id,
        rating: row.rating.trim() === "" ? null : row.rating,
        review: row.review,
      })),
  };
}

function buildSeasonReputationPatch(form: FormState): Cluster4PatchBody {
  return {
    seasonReputations: form.seasonReputationRows.map((row) => ({
      id: row.id,
      rating: row.rating,
      content: row.content,
      keyword_1: row.keyword_1,
      keyword_2: row.keyword_2,
      keyword_3: row.keyword_3,
    })),
  };
}

function buildWeeklyReputationPatch(form: FormState): Cluster4PatchBody {
  return {
    weeklyReputations: form.weeklyReputationRows.map((row) => ({
      id: row.id,
      rating: row.rating,
      content: row.content,
      keyword: row.keyword,
    })),
  };
}

function buildWeeklyReviewPatch(form: FormState): Cluster4PatchBody {
  return {
    weeklyReviews: form.weeklyReviewRows.map((row) => ({
      id: row.id,
      rating: row.rating,
      content: row.content,
    })),
  };
}

function buildWeeklyColleaguePatch(form: FormState): Cluster4PatchBody {
  return {
    weeklyColleagues: form.weeklyColleagueRows.map((row) => ({
      id: row.id,
      message: row.message.trim() === "" ? null : row.message,
    })),
  };
}

// ─────────────────────────────────────────────────────────────
// Misc display helpers
// ─────────────────────────────────────────────────────────────

function formatTimestamp(value: string | null): string {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatReviewerOrganization(slug: string | null): string {
  if (!slug) return "-";
  const knownLabel = (ORGANIZATION_LABEL as Record<string, string | undefined>)[slug];
  return knownLabel ?? slug;
}

function formatReviewerName(
  reviewer: { display_name: string | null } | null,
  fallbackId: string,
): string {
  const name = reviewer?.display_name?.trim();
  if (name) return name;
  return fallbackId;
}

// ─────────────────────────────────────────────────────────────
// Reusable subcomponents
// ─────────────────────────────────────────────────────────────

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function TableNotAvailable({ table }: { table: string }) {
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <span className="font-mono text-xs">{table}</span> 테이블을 조회할 수 없습니다.
    </div>
  );
}

function IdMono({ value, label }: { value: string; label?: string }) {
  if (!value) return null;
  return (
    <span className="font-mono text-[10px] text-muted-foreground">
      {label ? `${label}: ` : ""}
      {value}
    </span>
  );
}

function RowCard({
  title,
  meta,
  onDelete,
  deleteDisabled,
  children,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  onDelete?: () => void;
  deleteDisabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
        <div className="flex flex-col gap-1">
          <div className="text-sm font-semibold text-foreground">{title}</div>
          {meta && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
              {meta}
            </div>
          )}
        </div>
        {onDelete && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDelete}
            disabled={deleteDisabled}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            삭제
          </Button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-2">
        {children}
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function CharCounter({ current, max }: { current: number; max: number }) {
  const tone =
    current >= max
      ? "font-semibold text-red-600"
      : current >= max - Math.max(10, Math.floor(max * 0.1))
        ? "font-medium text-amber-600"
        : "text-muted-foreground";
  return (
    <div className={cn("self-end text-[10px] tabular-nums", tone)}>
      {current}/{max}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 위클리 리뷰 주차별 제출 현황 + 작성 기간(열기/닫기) 카드.
// 작성 기간은 운영관리 > 작성 기간 관리와 동일한 user_edit_windows
// (resource_key = "cluster4.weekly_reviews") 를 주차별로 제어한다.
// ─────────────────────────────────────────────────────────────

type WeeklyReviewWeekStatusRow = {
  weekId: string;
  weekNumber: number;
  label: string;
  submitted: boolean;
  status: EditWindowStatus;
};

function weeklyReviewWindowBadgeClass(status: EditWindowStatus): string {
  switch (status) {
    case "open":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "closed":
      return "border-border bg-muted text-muted-foreground";
    case "expired":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "none":
      return "border-border bg-muted/40 text-muted-foreground";
  }
}

function WeeklyReviewWeekStatus({
  rows,
  busyWeekId,
  disabled,
  onWindowAction,
}: {
  rows: WeeklyReviewWeekStatusRow[];
  busyWeekId: string | null;
  disabled: boolean;
  onWindowAction: (weekId: string, action: QuickActionKey | "close") => void;
}) {
  return (
    <div className="rounded-lg border bg-muted/10">
      <div className="border-b px-4 py-2.5">
        <div className="text-sm font-semibold text-foreground">
          주차별 제출 현황 · 작성 기간
        </div>
        <p className="text-[11px] text-muted-foreground">
          주차별 위클리 리뷰 제출 여부와 수정 가능 여부를 확인하고, 작성 기간을
          열고 닫습니다. (자원{" "}
          <code className="font-mono">cluster4.weekly_reviews</code> · 운영관리
          &gt; 작성 기간 관리와 동일)
        </p>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
          주차 데이터가 없습니다.
        </div>
      ) : (
        <div className="max-h-72 divide-y overflow-y-auto">
          {rows.map((w) => {
            const busy = busyWeekId === w.weekId;
            const canClose = w.status === "open";
            return (
              <div
                key={w.weekId}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{w.label}</span>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px]",
                      w.submitted
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-border bg-muted/40 text-muted-foreground",
                    )}
                  >
                    {w.submitted ? "제출" : "미제출"}
                  </span>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px]",
                      weeklyReviewWindowBadgeClass(w.status),
                    )}
                  >
                    {editWindowStatusLabel(w.status)}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {(
                    [
                      ["open_24h", "24h"],
                      ["open_7d", "7d"],
                      ["open_until_midnight", "자정"],
                    ] as const
                  ).map(([action, label]) => (
                    <button
                      key={action}
                      type="button"
                      disabled={disabled || busy}
                      onClick={() => onWindowAction(w.weekId, action)}
                      className="rounded-md border px-2 py-1 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={disabled || busy || !canClose}
                    onClick={() => onWindowAction(w.weekId, "close")}
                    className={cn(
                      "rounded-md border px-2 py-1 text-[11px]",
                      canClose && !disabled
                        ? "hover:bg-muted"
                        : "cursor-not-allowed text-muted-foreground",
                    )}
                  >
                    닫기
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const RESULT_STATUS_STYLE = WEEK_STATUS_STYLE;

function WeeklyListCard({
  card: c,
  organization,
}: {
  card: WeeklyCardDto;
  organization: OrganizationSlug;
}) {
  const style = RESULT_STATUS_STYLE[c.resultStatus];
  const isRest =
    c.resultStatus === "personal_rest" || c.resultStatus === "official_rest";
  const isRuntime =
    c.resultStatus === "running" || c.resultStatus === "tallying";
  const pl = getPointLabels(organization);
  const [imgError, setImgError] = useState(false);

  return (
    <div className="rounded-lg border bg-card shadow-sm">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-3">
          {/* 주차 이미지 */}
          <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md border bg-muted/30">
            {imgError ? (
              <div
                className={cn(
                  "flex h-full w-full items-center justify-center text-[10px] font-bold",
                  style.text,
                )}
              >
                W{c.weekNumber}
              </div>
            ) : (
              <img
                src={c.weekImagePath}
                alt={`${c.seasonYear} ${c.seasonName} ${c.weekNumber}주차`}
                className="h-full w-full object-cover"
                onError={() => setImgError(true)}
              />
            )}
          </div>
          <div className="flex flex-col gap-0.5">
            <div className="text-sm font-semibold">
              {c.seasonYear} {c.seasonName}, {c.weekNumber}주차
            </div>
            <div className="text-xs text-muted-foreground">
              {`${formatClubDate(c.startDate)} ~ ${formatClubDate(c.endDate)}`}
            </div>
          </div>
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-0.5 text-xs font-medium",
            style.bg,
            style.text,
          )}
        >
          {c.resultLabel}
        </span>
      </div>

      {/* body */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 sm:grid-cols-3 lg:grid-cols-4">
        {/* 활동 누적 주차 */}
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            활동 누적 주차
          </div>
          <div className="mt-0.5 text-sm font-medium tabular-nums">
            {c.accumulatedApprovedWeeks}{" "}
            <span className="text-muted-foreground">/ {c.targetWeeks} 주차</span>
          </div>
        </div>

        {/* 활동 상태 */}
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            활동 상태
          </div>
          <div className="mt-0.5 text-sm font-medium">{c.activityStatus}</div>
        </div>

        {/* 활동 소속 */}
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            활동 소속
          </div>
          <div className="mt-0.5 text-sm font-medium">
            <span className="text-muted-foreground">[팀]</span> {c.teamLabel}{" "}
            <span className="text-muted-foreground">[파트]</span> {c.partLabel}
          </div>
        </div>

        {/* 포인트 (조직별 명칭) — 방패는 raw/net 병기.
            포인트 표시 정책(2026-06-04): 고객 카드 방패 = net(advantage − penalty),
            번개 = −penalty. raw 는 내부 검증용으로만 표시한다. */}
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {pl.points} · {pl.advantages}(raw → net) · {pl.penalty}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-sm font-medium tabular-nums">
            <span title={`${pl.points} = check`}>{c.points}개</span>
            <span className="text-muted-foreground">·</span>
            <span
              title={`raw ${c.advantages} − penalty ${c.penalty} = net ${
                c.advantages - c.penalty
              } — 크루 카드에는 net 만 표시됩니다.`}
            >
              <span className="text-muted-foreground">{c.advantages}</span>
              <span className="text-muted-foreground"> → </span>
              {c.advantages - c.penalty}개
            </span>
            <span className="text-muted-foreground">·</span>
            <span
              title={`크루 카드 표시: ${-c.penalty}`}
              className={c.penalty < 0 ? "text-red-600" : ""}
            >
              {c.penalty}개
            </span>
          </div>
        </div>

        {/* 주차 평판 */}
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            주차 평판
          </div>
          <div className="mt-0.5 text-sm font-medium tabular-nums">
            {c.weeklyReputationCount}개
            <span className="ml-1 text-muted-foreground">/ 4</span>
          </div>
        </div>

        {/* 명성도(FM) */}
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            명성도(FM)
          </div>
          <div className="mt-0.5 text-sm font-medium tabular-nums">
            {c.totalFmScore}
          </div>
        </div>

        {/* 위클리 연계동료 */}
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            위클리 연계동료
          </div>
          <div className="mt-0.5 text-sm font-medium tabular-nums">
            {c.linkedCrewCount}명
            <span className="ml-1 text-muted-foreground">/ 3</span>
          </div>
        </div>

        {/* 주차 성장률 */}
        <div className="col-span-2 sm:col-span-3 lg:col-span-4">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            주차 성장률
          </div>
          {isRest ? (
            <div className="mt-0.5 text-sm text-muted-foreground">
              휴식 주차 — 해당 없음
            </div>
          ) : (
            <div className="mt-1 flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2">
                <span className="text-lg font-bold tabular-nums">
                  {c.weeklyGrowth.rate}%
                </span>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {c.weeklyGrowth.completedLines} / {c.weeklyGrowth.availableLines}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                {(
                  [
                    ["실무 정보", c.lineBreakdown.info],
                    ["실무 역량", c.lineBreakdown.ability],
                    ["실무 경험", c.lineBreakdown.experience],
                    ["실무 경력", c.lineBreakdown.career],
                  ] as const
                ).map(([label, line]) => (
                  <div
                    key={label}
                    className="rounded-md border bg-muted/30 px-2 py-1"
                  >
                    <div className="text-[10px] text-muted-foreground">
                      {label}
                    </div>
                    <div className="text-xs font-medium tabular-nums">
                      {line.completed} / {line.available}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────

export default function Cluster4Editor({
  organization,
  legacyUserId,
  memberDisplayName,
}: {
  organization: OrganizationSlug;
  legacyUserId: string;
  memberDisplayName?: string | null;
}) {
  const devMode = useAdminDevMode();
  const confirm = useConfirm();
  const [activeTab, setActiveTab] = useState<TabKey>("weekly_growth");
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [saving, setSaving] = useState(false);
  const [weeklyGrowth, setWeeklyGrowth] = useState<WeeklyGrowthDto | null>(null);
  const [bundle, setBundle] = useState<Cluster4Bundle>(() =>
    emptyBundle(legacyUserId),
  );
  const [form, setForm] = useState<FormState>(emptyForm);
  const [banner, setBanner] = useState<
    { kind: "success" | "error"; message: string } | null
  >(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [lastApplied, setLastApplied] = useState<Cluster4ApplySummary | null>(null);

  const [wlSeason, setWlSeason] = useState("all");
  const [wlResult, setWlResult] = useState("all");
  const [wlPage, setWlPage] = useState(1);
  const WL_PAGE_SIZE = 4;

  const weeklyCards: WeeklyCardDto[] = weeklyGrowth?.weeklyCards ?? [];

  const seasonOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of weeklyCards) {
      const key = c.seasonKey ?? `${c.seasonYear}_${c.seasonName}`;
      if (!seen.has(key)) {
        seen.set(key, `${c.seasonYear} ${c.seasonName}`);
      }
    }
    return [
      { value: "all", label: "전체" },
      ...[...seen.entries()].map(([value, label]) => ({ value, label })),
    ];
  }, [weeklyCards]);

  const wlFiltered = useMemo(() => {
    let list = weeklyCards;
    if (wlSeason !== "all") {
      list = list.filter((c) => {
        const key = c.seasonKey ?? `${c.seasonYear}_${c.seasonName}`;
        return key === wlSeason;
      });
    }
    if (wlResult !== "all") {
      list = list.filter((c) => c.resultStatus === wlResult);
    }
    return list;
  }, [weeklyCards, wlSeason, wlResult]);

  const wlTotalPages = Math.max(1, Math.ceil(wlFiltered.length / WL_PAGE_SIZE));
  const wlPageClamped = Math.min(wlPage, wlTotalPages);
  const wlPaged = wlFiltered.slice(
    (wlPageClamped - 1) * WL_PAGE_SIZE,
    wlPageClamped * WL_PAGE_SIZE,
  );

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [response, growthRes] = await Promise.all([
        fetch(
          `/api/admin/crews/${encodeURIComponent(legacyUserId)}/cluster4`,
          { cache: "no-store" },
        ),
        fetch(
          `/api/admin/crews/${encodeURIComponent(legacyUserId)}/cluster4/weekly-growth`,
          { cache: "no-store" },
        ),
      ]);
      const [json, growthJson] = await Promise.all([
        response.json(),
        growthRes.json(),
      ]);
      if (!response.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to load cluster4.");
      }
      const nextBundle = json.data as Cluster4Bundle;
      setBundle(nextBundle);
      setForm(syncFormFromBundle(nextBundle));
      setWeeklyGrowth(
        growthRes.ok && growthJson?.success
          ? (growthJson.data as WeeklyGrowthDto)
          : null,
      );
      setLastLoadedAt(new Date().toISOString());
      setBanner(null);
    } catch (error) {
      setBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to load.",
      });
    } finally {
      setLoading(false);
    }
  }, [legacyUserId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadAll();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadAll]);

  useEffect(() => {
    if (!banner || banner.kind !== "success") return;
    const timer = window.setTimeout(() => setBanner(null), 4000);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const savedForm = useMemo(() => syncFormFromBundle(bundle), [bundle]);
  const weekLabels = useMemo(() => buildWeekLabelMap(bundle.weeks), [bundle.weeks]);
  const getWeekLabel = useCallback(
    (id: string | null | undefined) => {
      if (!id) return "-";
      return weekLabels.get(String(id)) ?? String(id);
    },
    [weekLabels],
  );

  // 위클리 리뷰 주차별 작성 기간(열기/닫기) 진행 중인 주차.
  const [windowBusyWeek, setWindowBusyWeek] = useState<string | null>(null);

  // 주차별 위클리 리뷰 제출 여부 + 작성 기간 상태. weeks 를 기준으로
  // bundle.weeklyReviews(제출) 와 bundle.weeklyReviewWindows(작성 기간) 를 조인.
  const weeklyReviewWeekRows = useMemo<WeeklyReviewWeekStatusRow[]>(() => {
    const submitted = new Set(
      bundle.weeklyReviews.map((r) => String(r.week_card_id)),
    );
    const windowByWeek = new Map(
      (bundle.weeklyReviewWindows ?? []).map((w) => [w.weekId, w]),
    );
    return [...bundle.weeks]
      .map((week) => {
        const row = week as Record<string, unknown>;
        const id = String(pickValue(row, ["id"]) ?? "");
        const weekNumber = Number(pickValue(row, ["week_number"]) ?? 0);
        const win = windowByWeek.get(id) ?? null;
        return {
          weekId: id,
          weekNumber: Number.isFinite(weekNumber) ? weekNumber : 0,
          label: getWeekLabel(id),
          submitted: submitted.has(id),
          status: computeEditWindowStatus(
            win
              ? ({
                  openedAt: win.openedAt,
                  expiresAt: win.expiresAt,
                } as unknown as EditWindowDto)
              : null,
          ),
        };
      })
      .filter((r) => r.weekId)
      .sort((a, b) => a.weekNumber - b.weekNumber);
  }, [bundle.weeklyReviews, bundle.weeklyReviewWindows, bundle.weeks, getWeekLabel]);

  // 위클리 리뷰 작성 기간 열기/닫기 — 운영관리 > 작성 기간 관리와 동일 API 재사용.
  const handleWeeklyReviewWindow = useCallback(
    async (weekId: string, action: QuickActionKey | "close") => {
      if (!bundle.userId) return;
      setWindowBusyWeek(weekId);
      try {
        const payload =
          action === "close"
            ? {
                resource_key: "cluster4.weekly_reviews",
                week_id: weekId,
                action: "close" as const,
              }
            : (() => {
                const { openedAt, expiresAt } = computeQuickActionRange(action);
                return {
                  resource_key: "cluster4.weekly_reviews",
                  week_id: weekId,
                  opened_at: openedAt.toISOString(),
                  expires_at: expiresAt.toISOString(),
                };
              })();
        const res = await fetch(
          `/api/admin/edit-windows/${encodeURIComponent(bundle.userId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "작성 기간 변경에 실패했습니다.");
        }
        setBanner({
          kind: "success",
          message:
            action === "close"
              ? "위클리 리뷰 작성 기간을 닫았습니다."
              : "위클리 리뷰 작성 기간을 열었습니다.",
        });
        await loadAll();
      } catch (error) {
        setBanner({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "작성 기간 변경에 실패했습니다.",
        });
      } finally {
        setWindowBusyWeek(null);
      }
    },
    [bundle.userId, loadAll],
  );

  const dirty = useMemo(() => {
    return {
      season_review:
        JSON.stringify(form.seasonReviewRows) !==
        JSON.stringify(savedForm.seasonReviewRows),
      season_reputation:
        JSON.stringify(form.seasonReputationRows) !==
        JSON.stringify(savedForm.seasonReputationRows),
      weekly_reputation:
        JSON.stringify(form.weeklyReputationRows) !==
        JSON.stringify(savedForm.weeklyReputationRows),
      weekly_review:
        JSON.stringify(form.weeklyReviewRows) !==
        JSON.stringify(savedForm.weeklyReviewRows),
      weekly_colleague:
        JSON.stringify(form.weeklyColleagueRows) !==
        JSON.stringify(savedForm.weeklyColleagueRows),
    } as const;
  }, [form, savedForm]);

  const isReadOnlyFallback = !bundle.userId;
  const saveDisabled = loading || saving || isReadOnlyFallback;

  // Tab → save handler. validation + body 빌더만 탭에 따라 분기.
  const buildAndValidate = (tab: TabKey): {
    body: Cluster4PatchBody | null;
    error: string | null;
  } => {
    if (tab === "season_review") {
      const error = validateSeasonReviewForm(form);
      if (error) return { body: null, error };
      return { body: buildSeasonReviewPatch(form), error: null };
    }
    if (tab === "season_reputation") {
      const error = validateSeasonReputationForm(form);
      if (error) return { body: null, error };
      return { body: buildSeasonReputationPatch(form), error: null };
    }
    if (tab === "weekly_reputation") {
      const error = validateWeeklyReputationForm(form);
      if (error) return { body: null, error };
      return { body: buildWeeklyReputationPatch(form), error: null };
    }
    if (tab === "weekly_review") {
      const error = validateWeeklyReviewForm(form);
      if (error) return { body: null, error };
      return { body: buildWeeklyReviewPatch(form), error: null };
    }
    if (tab === "weekly_colleague") {
      const error = validateWeeklyColleagueForm(form);
      if (error) return { body: null, error };
      return { body: buildWeeklyColleaguePatch(form), error: null };
    }
    return { body: null, error: null };
  };

  const handleSave = async () => {
    if (saveDisabled) return;

    const { body, error } = buildAndValidate(activeTab);
    if (error) {
      setBanner({ kind: "error", message: error });
      return;
    }
    if (!body) return;

    setSaving(true);
    setWarnings([]);

    try {
      const response = await fetch(
        `/api/admin/crews/${encodeURIComponent(legacyUserId)}/cluster4`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to save cluster4.");
      }

      const nextBundle = json.data as Cluster4Bundle;
      setBundle(nextBundle);
      setForm(syncFormFromBundle(nextBundle));
      setWarnings(Array.isArray(json.warnings) ? json.warnings : []);
      setLastApplied((json.applied ?? null) as Cluster4ApplySummary | null);
      setLastSavedAt(new Date().toISOString());
      setBanner({ kind: "success", message: "저장되었습니다." });
    } catch (error) {
      setBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to save.",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (
    resource: Cluster4DeleteResource,
    id: string,
    confirmMessage: string,
  ) => {
    if (saveDisabled) return;
    const ok = await confirm({
      ...CONFIRM.delete,
      description: `${confirmMessage}\n\nid: ${id}`,
    });
    if (!ok) return;

    const paramKeyMap: Record<Cluster4DeleteResource, string> = {
      seasonReputation: "seasonReputationId",
      weeklyReputation: "weeklyReputationId",
      userActivityDetail: "userActivityDetailId",
      careerRecord: "careerRecordId",
      weeklyReview: "weeklyReviewId",
      weeklyColleague: "weeklyColleagueId",
      cluster4LineSubmission: "cluster4LineSubmissionId",
    };
    const paramKey = paramKeyMap[resource];

    setSaving(true);
    setWarnings([]);

    try {
      const response = await fetch(
        `/api/admin/crews/${encodeURIComponent(legacyUserId)}/cluster4?${paramKey}=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to delete.");
      }
      const nextBundle = json.data as Cluster4Bundle;
      setBundle(nextBundle);
      setForm(syncFormFromBundle(nextBundle));
      setLastSavedAt(new Date().toISOString());
      setLastApplied(null);
      setBanner({ kind: "success", message: "삭제되었습니다." });
    } catch (error) {
      setBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to delete.",
      });
    } finally {
      setSaving(false);
    }
  };

  const setSeasonReviewRow = (
    index: number,
    patch: Partial<SeasonReviewFormRow>,
  ) =>
    setForm((current) => {
      const next = [...current.seasonReviewRows];
      next[index] = { ...next[index], ...patch };
      return { ...current, seasonReviewRows: next };
    });

  const setSeasonReputationRow = (
    index: number,
    patch: Partial<SeasonReputationFormRow>,
  ) =>
    setForm((current) => {
      const next = [...current.seasonReputationRows];
      next[index] = { ...next[index], ...patch };
      return { ...current, seasonReputationRows: next };
    });

  const setWeeklyReputationRow = (
    index: number,
    patch: Partial<WeeklyReputationFormRow>,
  ) =>
    setForm((current) => {
      const next = [...current.weeklyReputationRows];
      next[index] = { ...next[index], ...patch };
      return { ...current, weeklyReputationRows: next };
    });

  const setWeeklyReviewRow = (
    index: number,
    patch: Partial<WeeklyReviewFormRow>,
  ) =>
    setForm((current) => {
      const next = [...current.weeklyReviewRows];
      next[index] = { ...next[index], ...patch };
      return { ...current, weeklyReviewRows: next };
    });

  const setWeeklyColleagueRow = (
    index: number,
    patch: Partial<WeeklyColleagueFormRow>,
  ) =>
    setForm((current) => {
      const next = [...current.weeklyColleagueRows];
      next[index] = { ...next[index], ...patch };
      return { ...current, weeklyColleagueRows: next };
    });

  const tabHasSave = ![
    "weekly_growth",
    "activities",
    "debug",
  ].includes(activeTab);

  const tabHasRows = (() => {
    switch (activeTab) {
      case "season_review":
        return form.seasonReviewRows.some((r) => r.editable);
      case "season_reputation":
        return form.seasonReputationRows.length > 0;
      case "weekly_reputation":
        return form.weeklyReputationRows.length > 0;
      case "weekly_review":
        return form.weeklyReviewRows.length > 0;
      case "weekly_colleague":
        return form.weeklyColleagueRows.length > 0;
      default:
        return false;
    }
  })();

  const currentTabDirty = (() => {
    switch (activeTab) {
      case "season_review":
        return dirty.season_review;
      case "season_reputation":
        return dirty.season_reputation;
      case "weekly_reputation":
        return dirty.weekly_reputation;
      case "weekly_review":
        return dirty.weekly_review;
      case "weekly_colleague":
        return dirty.weekly_colleague;
      default:
        return false;
    }
  })();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-lg font-semibold">
            {devMode ? "Cluster 4 Editor" : "Cluster 4 관리"}
          </h1>
          <div className="text-xs text-muted-foreground">
            {ORGANIZATION_LABEL[organization]} ·{" "}
            <span className="font-medium text-foreground">
              {memberDisplayName ?? (devMode ? legacyUserId : "이름 미등록")}
            </span>
            {devMode && (
              <>
                {" "}· crew id: <code className="font-mono">{legacyUserId}</code>
              </>
            )}
            {devMode && bundle.userId && (
              <>
                {" "}· user_id: <code className="font-mono">{bundle.userId}</code>
              </>
            )}
            {devMode && lastLoadedAt && (
              <>
                {" "}· last loaded: <code className="font-mono">{lastLoadedAt}</code>
              </>
            )}
            {devMode && lastSavedAt && (
              <>
                {" "}· last saved: <code className="font-mono">{lastSavedAt}</code>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void loadAll()}
            disabled={loading || saving}
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            {devMode ? "Reload" : "새로고침"}
          </Button>
          {tabHasSave && (
            <Button
              type="button"
              size="sm"
              loading={saving}
              onClick={() => void handleSave()}
              disabled={saveDisabled || !tabHasRows}
            >
              <Save className="h-4 w-4" />
              {currentTabDirty
                ? devMode
                  ? "Save *"
                  : "저장 *"
                : devMode
                  ? "Save"
                  : "저장"}
            </Button>
          )}
        </div>
      </div>

      {isReadOnlyFallback && !loading && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {devMode ? (
            <>
              user_profiles lookup failed, so this page is in read-only fallback
              mode for <code className="font-mono">{legacyUserId}</code>.
            </>
          ) : (
            <>연결된 사용자 정보가 없어 읽기 전용 상태입니다.</>
          )}
        </div>
      )}

      {banner && (
        <div
          role="status"
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            banner.kind === "success"
              ? "border-emerald-300 bg-emerald-50 text-emerald-900"
              : "border-destructive/40 bg-destructive/10 text-destructive",
          )}
        >
          {banner.message}
        </div>
      )}

      {warnings.length > 0 && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <div className="mb-1 font-medium">Warnings</div>
          <ul className="list-disc pl-4">
            {warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1 border-b">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          const isDirty = (() => {
            switch (tab.key) {
              case "season_review":
                return dirty.season_review;
              case "season_reputation":
                return dirty.season_reputation;
              case "weekly_reputation":
                return dirty.weekly_reputation;
              case "weekly_review":
                return dirty.weekly_review;
              case "weekly_colleague":
                return dirty.weekly_colleague;
              default:
                return false;
            }
          })();
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                "relative -mb-px rounded-t-md border border-b-0 px-3 py-1.5 text-xs",
                isActive
                  ? "border-foreground bg-background font-semibold text-foreground"
                  : "border-transparent bg-muted/40 text-muted-foreground hover:bg-muted",
              )}
              aria-pressed={isActive}
            >
              {tab.label}
              {isDirty && <span className="ml-1 text-amber-600">*</span>}
            </button>
          );
        })}
      </div>

      {/* ───────────── 주간 성장 (WEEKLY GROWTH) ───────────── */}
      {activeTab === "weekly_growth" && (
        <>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {devMode ? "Weekly Growth" : "주간 성장"}
            </CardTitle>
            {devMode && (
              <p className="text-xs text-muted-foreground">
                user_week_statuses + season_definitions + official_rest_weeks
              </p>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {!weeklyGrowth ? (
              loading ? (
                <LoadingState active />
              ) : (
                <div className="rounded-md border border-dashed bg-muted/30 px-3 py-4 text-center text-sm text-muted-foreground">
                  주간 성장 데이터를 불러올 수 없습니다.
                </div>
              )
            ) : (
              <>
                {/* 현재 클럽 진행 문구 */}
                <div className="rounded-lg border bg-muted/20 px-4 py-3">
                  <p className="text-sm leading-relaxed">
                    {weeklyGrowth.currentWeekInfo.status === "running" ? (
                      <>
                        현재 클럽은,{" "}
                        <span className="font-semibold">
                          {weeklyGrowth.currentWeekInfo.year}년{" "}
                          {weeklyGrowth.currentWeekInfo.seasonName}
                        </span>
                        ,{" "}
                        <span className="font-semibold">
                          {weeklyGrowth.currentWeekInfo.weekNumber}주차
                        </span>{" "}
                        를 진행 중에 있습니다.
                      </>
                    ) : weeklyGrowth.currentWeekInfo.status === "transition" ? (
                      <>
                        현재 클럽은,{" "}
                        <span className="font-semibold">
                          {weeklyGrowth.currentWeekInfo.year}년{" "}
                          {weeklyGrowth.currentWeekInfo.seasonName}
                        </span>
                        에서,{" "}
                        <span className="font-semibold">
                          {weeklyGrowth.currentWeekInfo.year}년{" "}
                          {weeklyGrowth.currentWeekInfo.nextSeasonName ??
                            "다음 시즌"}
                        </span>
                        으로 전환하는, 휴식(전환 준비) 중에 있습니다.
                      </>
                    ) : (
                      <>
                        현재 클럽은,{" "}
                        <span className="font-semibold">
                          {weeklyGrowth.currentWeekInfo.year}년{" "}
                          {weeklyGrowth.currentWeekInfo.seasonName}
                        </span>
                        ,{" "}
                        <span className="font-semibold">
                          {weeklyGrowth.currentWeekInfo.weekNumber}주차
                        </span>{" "}
                        를 휴식(
                        {weeklyGrowth.currentWeekInfo.restReason
                          ? formatRestReasonLabel(
                              weeklyGrowth.currentWeekInfo.restReason,
                            )
                          : "공식 휴식"}
                        ) 중에 있습니다.
                      </>
                    )}
                  </p>
                  {devMode && (
                    <div className="mt-2 text-[10px] text-muted-foreground">
                      status: {weeklyGrowth.currentWeekInfo.status} ·
                      restReason: {String(weeklyGrowth.currentWeekInfo.restReason)} ·
                      period: {formatClubDate(weeklyGrowth.currentWeekInfo.startDate)} ~ {formatClubDate(weeklyGrowth.currentWeekInfo.endDate)}
                    </div>
                  )}
                </div>

                {/* Details 6개 항목 */}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {/* 1. 성장 시작 주차 */}
                  <div className="rounded-md border bg-muted/30 px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {devMode ? "1. 성장 시작 주차 (startWeekDisplay)" : "성장 시작 주차"}
                    </div>
                    <div className="mt-0.5 text-sm font-medium">
                      {weeklyGrowth.growthSummary.startWeekDisplay}
                    </div>
                  </div>

                  {/* 2. 성장 가능 주차 */}
                  <div className="rounded-md border bg-muted/30 px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {devMode
                        ? "2. 성장 가능 주차 (availableWeeks)"
                        : "성장 가능 주차"}
                    </div>
                    <div className="mt-0.5 text-sm font-medium tabular-nums">
                      {weeklyGrowth.growthSummary.availableWeeks}개 주차
                    </div>
                    {devMode && (
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        = 성공({weeklyGrowth.growthSummary.approvedWeeks}) + 실패(
                        {weeklyGrowth.growthSummary.failedWeeks}) + 휴식(
                        {weeklyGrowth.growthSummary.restWeeks})
                      </div>
                    )}
                  </div>

                  {/* 3. 성장 성공 주차 */}
                  <div className="rounded-md border bg-muted/30 px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {devMode
                        ? "3. 성장 성공 주차 (approvedWeeks)"
                        : "성장 성공 주차"}
                    </div>
                    <div className="mt-0.5 text-sm font-medium tabular-nums">
                      {weeklyGrowth.growthSummary.approvedWeeks}개 주차
                    </div>
                  </div>

                  {/* 4. 성장 실패 주차 */}
                  <div className="rounded-md border bg-muted/30 px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {devMode
                        ? "4. 성장 실패 주차 (failedWeeks)"
                        : "성장 실패 주차"}
                    </div>
                    <div className="mt-0.5 text-sm font-medium tabular-nums">
                      {weeklyGrowth.growthSummary.failedWeeks}개 주차
                    </div>
                  </div>

                  {/* 5. 성장 휴식 주차 */}
                  <div className="rounded-md border bg-muted/30 px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {devMode
                        ? "5. 성장 휴식 주차 (restWeeks)"
                        : "성장 휴식 주차"}
                    </div>
                    <div className="mt-0.5 text-sm font-medium tabular-nums">
                      {weeklyGrowth.growthSummary.restSeasonCount > 0
                        ? `${weeklyGrowth.growthSummary.restWeeks}(${weeklyGrowth.growthSummary.restSeasonCount})개 주차`
                        : `${weeklyGrowth.growthSummary.restWeeks}개 주차`}
                    </div>
                    {devMode &&
                      weeklyGrowth.growthSummary.restSeasonCount > 0 && (
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                          괄호 안 = 시즌 휴식 카운트 (restSeasonCount)
                        </div>
                      )}
                  </div>

                  {/* 6. 성장 종료 주차 */}
                  <div className="rounded-md border bg-muted/30 px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {devMode
                        ? "6. 성장 종료 주차 (endWeekDisplay)"
                        : "성장 종료 주차"}
                    </div>
                    <div
                      className={cn(
                        "mt-0.5 text-sm font-medium",
                        weeklyGrowth.growthSummary.endStatus === "in_progress" &&
                          "text-blue-600",
                        weeklyGrowth.growthSummary.endStatus === "completed" &&
                          "text-emerald-600",
                        weeklyGrowth.growthSummary.endStatus === "stopped" &&
                          "text-red-600",
                      )}
                    >
                      {weeklyGrowth.growthSummary.endWeekDisplay}
                    </div>
                    {devMode && (
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        endStatus: {weeklyGrowth.growthSummary.endStatus}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* ───────────── 주차 리스트 (WEEKLY LIST) ───────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {devMode ? "Weekly List" : "주차 리스트"}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* filter bar */}
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2.5">
              <button
                type="button"
                onClick={() => {
                  setWlSeason("all");
                  setWlResult("all");
                  setWlPage(1);
                }}
                className="rounded-md border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted"
              >
                Reset
              </button>

              <div className="flex items-center gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  역대 시즌
                </span>
                <select
                  value={wlSeason}
                  onChange={(e) => {
                    setWlSeason(e.target.value);
                    setWlPage(1);
                  }}
                  className="h-7 rounded-md border bg-background px-2 text-xs"
                >
                  {seasonOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  주차 결과
                </span>
                <select
                  value={wlResult}
                  onChange={(e) => {
                    setWlResult(e.target.value);
                    setWlPage(1);
                  }}
                  className="h-7 rounded-md border bg-background px-2 text-xs"
                >
                  {RESULT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                <span>
                  검색 결과{" "}
                  <span className="font-semibold text-foreground">
                    {wlFiltered.length}
                  </span>
                  건
                </span>
                <span>
                  전체 주차{" "}
                  <span className="font-semibold text-foreground">
                    {weeklyCards.length}
                  </span>
                  개
                </span>
              </div>
            </div>

            {/* cards */}
            {wlPaged.length > 0 ? (
              <div className="flex flex-col gap-3">
                {wlPaged.map((c) => (
                  <WeeklyListCard
                    key={`${c.seasonYear}-${c.seasonName}-${c.weekNumber}`}
                    card={c}
                    organization={organization}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-md border border-dashed bg-muted/30 px-3 py-4 text-center text-sm text-muted-foreground">
                현재 해당하는 주차가 없습니다.
              </div>
            )}

            {/* pagination */}
            {wlFiltered.length > WL_PAGE_SIZE && (
              <div className="flex items-center justify-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={wlPageClamped <= 1}
                  onClick={() => setWlPage((p) => Math.max(1, p - 1))}
                >
                  이전
                </Button>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {wlPageClamped} / {wlTotalPages}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={wlPageClamped >= wlTotalPages}
                  onClick={() => setWlPage((p) => Math.min(wlTotalPages, p + 1))}
                >
                  다음
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
        </>
      )}

      {/* ───────────── 시즌 리뷰 ───────────── */}
      {activeTab === "season_review" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">시즌 리뷰</CardTitle>
            <p className="text-xs text-muted-foreground">
              <code className="font-mono">user_season_histories.rating</code>{" "}
              (0~10 정수) · <code className="font-mono">review</code> 본인이 작성한 시즌 총평.
              운영자가 수정할 수 있습니다.
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {!bundle.tablesAvailable.userSeasonHistories ? (
              <TableNotAvailable table="user_season_histories" />
            ) : form.seasonReviewRows.length === 0 ? (
              <EmptyState>표시할 시즌 리뷰가 없습니다.</EmptyState>
            ) : (
              form.seasonReviewRows.map((row, index) => (
                <RowCard
                  key={row.id || `review-${index}`}
                  title={row.seasonLabel}
                  meta={
                    <>
                      <IdMono label="id" value={row.id} />
                      {!row.editable && (
                        <span className="text-amber-700">
                          id 누락으로 읽기 전용
                        </span>
                      )}
                    </>
                  }
                >
                  <div className="flex flex-col gap-1.5 sm:col-span-1">
                    <FieldLabel>평점 (0~10)</FieldLabel>
                    <Input
                      type="number"
                      min={0}
                      max={10}
                      step={1}
                      value={row.rating}
                      onChange={(event) =>
                        setSeasonReviewRow(index, { rating: event.target.value })
                      }
                      disabled={saveDisabled || !row.editable}
                      inputMode="numeric"
                      className="h-9"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <FieldLabel>총평</FieldLabel>
                    <textarea
                      value={row.review}
                      onChange={(event) =>
                        setSeasonReviewRow(index, { review: event.target.value })
                      }
                      disabled={saveDisabled || !row.editable}
                      rows={3}
                      className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                  </div>
                </RowCard>
              ))
            )}
          </CardContent>
        </Card>
      )}

      {/* ───────────── 받은 시즌 평판 ───────────── */}
      {activeTab === "season_reputation" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">받은 시즌 평판</CardTitle>
            <p className="text-xs text-muted-foreground">
              타인이 이 사용자(target_user_id)에 대해 남긴 시즌 평판. 운영자는 점수 / 본문 /
              키워드를 수정·삭제할 수 있습니다. 작성 기간 gate 는 적용되지 않습니다.
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {!bundle.tablesAvailable.seasonReputations ? (
              <TableNotAvailable table="season_reputations" />
            ) : form.seasonReputationRows.length === 0 ? (
              <EmptyState>받은 시즌 평판이 없습니다.</EmptyState>
            ) : (
              form.seasonReputationRows.map((row, index) => (
                <RowCard
                  key={row.id}
                  title={
                    <>
                      <span className="text-foreground">
                        {formatReviewerName(row.reviewer, row.reviewer_id)}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({formatReviewerOrganization(
                          row.reviewer?.organization_slug ?? null,
                        )})
                      </span>
                    </>
                  }
                  meta={
                    <>
                      <IdMono label="id" value={row.id} />
                      <span>작성 {formatTimestamp(row.created_at)}</span>
                      {row.updated_at && row.updated_at !== row.created_at && (
                        <span>수정 {formatTimestamp(row.updated_at)}</span>
                      )}
                      {row.season_history_id && (
                        <IdMono
                          label="season_history"
                          value={row.season_history_id}
                        />
                      )}
                    </>
                  }
                  onDelete={() =>
                    void handleDelete(
                      "seasonReputation",
                      row.id,
                      `${formatReviewerName(row.reviewer, row.reviewer_id)} 님이 작성한 시즌 평판을 삭제할까요?`,
                    )
                  }
                  deleteDisabled={saveDisabled}
                >
                  <div className="flex flex-col gap-1.5 sm:col-span-1">
                    <FieldLabel>평점 (1~10, 0.5 단위)</FieldLabel>
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      step={0.5}
                      value={row.rating}
                      onChange={(event) =>
                        setSeasonReputationRow(index, {
                          rating: event.target.value,
                        })
                      }
                      disabled={saveDisabled}
                      inputMode="decimal"
                      className="h-9"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <FieldLabel>본문 (1~300자)</FieldLabel>
                    <textarea
                      value={row.content}
                      onChange={(event) =>
                        setSeasonReputationRow(index, {
                          content: event.target.value,
                        })
                      }
                      disabled={saveDisabled}
                      rows={3}
                      maxLength={300}
                      className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <CharCounter current={row.content.trim().length} max={300} />
                  </div>
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <FieldLabel>키워드 1 / 2 / 3 (각 1~10자, 모두 달라야 함)</FieldLabel>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      <Input
                        value={row.keyword_1}
                        onChange={(event) =>
                          setSeasonReputationRow(index, {
                            keyword_1: event.target.value,
                          })
                        }
                        disabled={saveDisabled}
                        maxLength={10}
                        placeholder="키워드 1"
                        className="h-9"
                      />
                      <Input
                        value={row.keyword_2}
                        onChange={(event) =>
                          setSeasonReputationRow(index, {
                            keyword_2: event.target.value,
                          })
                        }
                        disabled={saveDisabled}
                        maxLength={10}
                        placeholder="키워드 2"
                        className="h-9"
                      />
                      <Input
                        value={row.keyword_3}
                        onChange={(event) =>
                          setSeasonReputationRow(index, {
                            keyword_3: event.target.value,
                          })
                        }
                        disabled={saveDisabled}
                        maxLength={10}
                        placeholder="키워드 3"
                        className="h-9"
                      />
                    </div>
                  </div>
                </RowCard>
              ))
            )}
          </CardContent>
        </Card>
      )}

      {/* ───────────── 위클리 평판 (받은) ───────────── */}
      {activeTab === "weekly_reputation" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">받은 위클리 평판</CardTitle>
            <p className="text-xs text-muted-foreground">
              타인이 이 사용자(target_user_id)에 대해 남긴 위클리 평판(peer-review row).
              운영자는 점수 / 본문 / 키워드를 수정·삭제할 수 있습니다.
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {!bundle.tablesAvailable.weeklyReputations ? (
              <TableNotAvailable table="weekly_reputations" />
            ) : form.weeklyReputationRows.length === 0 ? (
              <EmptyState>받은 위클리 평판이 없습니다.</EmptyState>
            ) : (
              form.weeklyReputationRows.map((row, index) => (
                <RowCard
                  key={row.id}
                  title={
                    <>
                      <span className="text-foreground">
                        {formatReviewerName(row.reviewer, row.reviewer_id)}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({formatReviewerOrganization(
                          row.reviewer?.organization_slug ?? null,
                        )})
                      </span>
                    </>
                  }
                  meta={
                    <>
                      <span className="font-medium text-foreground/80">
                        {getWeekLabel(row.week_card_id)}
                      </span>
                      <IdMono label="id" value={row.id} />
                      <span>작성 {formatTimestamp(row.created_at)}</span>
                      {row.updated_at && row.updated_at !== row.created_at && (
                        <span>수정 {formatTimestamp(row.updated_at)}</span>
                      )}
                    </>
                  }
                  onDelete={() =>
                    void handleDelete(
                      "weeklyReputation",
                      row.id,
                      `${formatReviewerName(row.reviewer, row.reviewer_id)} 님이 작성한 위클리 평판을 삭제할까요?`,
                    )
                  }
                  deleteDisabled={saveDisabled}
                >
                  <div className="flex flex-col gap-1.5 sm:col-span-1">
                    <FieldLabel>평점 (0~10, 0.5 단위)</FieldLabel>
                    <Input
                      type="number"
                      min={0}
                      max={10}
                      step={0.5}
                      value={row.rating}
                      onChange={(event) =>
                        setWeeklyReputationRow(index, {
                          rating: event.target.value,
                        })
                      }
                      disabled={saveDisabled}
                      inputMode="decimal"
                      className="h-9"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5 sm:col-span-1">
                    <FieldLabel>키워드 (1~30자)</FieldLabel>
                    <Input
                      value={row.keyword}
                      onChange={(event) =>
                        setWeeklyReputationRow(index, {
                          keyword: event.target.value,
                        })
                      }
                      disabled={saveDisabled}
                      maxLength={30}
                      className="h-9"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <FieldLabel>본문 (1~100자)</FieldLabel>
                    <textarea
                      value={row.content}
                      onChange={(event) =>
                        setWeeklyReputationRow(index, {
                          content: event.target.value,
                        })
                      }
                      disabled={saveDisabled}
                      rows={3}
                      maxLength={100}
                      className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <CharCounter current={row.content.trim().length} max={100} />
                  </div>
                </RowCard>
              ))
            )}
          </CardContent>
        </Card>
      )}

      {/* ───────────── 위클리 리뷰 (본인 회고) ───────────── */}
      {activeTab === "weekly_review" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">위클리 리뷰</CardTitle>
            <p className="text-xs text-muted-foreground">
              본인이 한 주차에 작성한 위클리 리뷰(<code className="font-mono">weekly_reviews</code>).
              운영자는 평점(1~10 정수) / 내용(1~200자)을 수정·삭제할 수 있습니다.
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <WeeklyReviewWeekStatus
              rows={weeklyReviewWeekRows}
              busyWeekId={windowBusyWeek}
              disabled={saveDisabled || !bundle.userId}
              onWindowAction={handleWeeklyReviewWindow}
            />
            {!bundle.tablesAvailable.weeklyReviews ? (
              <TableNotAvailable table="weekly_reviews" />
            ) : form.weeklyReviewRows.length === 0 ? (
              <EmptyState>작성된 위클리 리뷰가 없습니다.</EmptyState>
            ) : (
              form.weeklyReviewRows.map((row, index) => (
                <RowCard
                  key={row.id}
                  title={getWeekLabel(row.week_card_id)}
                  meta={
                    <>
                      <IdMono label="id" value={row.id} />
                      <span>작성 {formatTimestamp(row.created_at)}</span>
                      {row.updated_at && row.updated_at !== row.created_at && (
                        <span>수정 {formatTimestamp(row.updated_at)}</span>
                      )}
                    </>
                  }
                  onDelete={() =>
                    void handleDelete(
                      "weeklyReview",
                      row.id,
                      `${getWeekLabel(row.week_card_id)} 주차의 위클리 리뷰를 삭제할까요?`,
                    )
                  }
                  deleteDisabled={saveDisabled}
                >
                  <div className="flex flex-col gap-1.5 sm:col-span-1">
                    <FieldLabel>평점 (1~10 정수)</FieldLabel>
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      step={1}
                      value={row.rating}
                      onChange={(event) =>
                        setWeeklyReviewRow(index, { rating: event.target.value })
                      }
                      disabled={saveDisabled}
                      inputMode="numeric"
                      className="h-9"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <FieldLabel>위클리 리뷰 내용 (1~200자)</FieldLabel>
                    <textarea
                      value={row.content}
                      onChange={(event) =>
                        setWeeklyReviewRow(index, {
                          content: event.target.value,
                        })
                      }
                      disabled={saveDisabled}
                      rows={3}
                      maxLength={200}
                      className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <CharCounter current={row.content.trim().length} max={200} />
                  </div>
                </RowCard>
              ))
            )}
          </CardContent>
        </Card>
      )}

      {/* ───────────── 위클리 연계동료 ───────────── */}
      {activeTab === "weekly_colleague" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">위클리 연계동료</CardTitle>
            <p className="text-xs text-muted-foreground">
              한 주차에 함께한 동료(<code className="font-mono">weekly_colleagues</code>).
              운영자는 한 줄 코멘트를 수정·삭제할 수 있습니다. 동료 변경은 삭제 후 사용자
              화면에서 다시 등록해야 합니다. 목록은 rank(내부 정렬 키) 오름차순으로 표시됩니다.
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {!bundle.tablesAvailable.weeklyColleagues ? (
              <TableNotAvailable table="weekly_colleagues" />
            ) : form.weeklyColleagueRows.length === 0 ? (
              <EmptyState>등록된 위클리 연계동료가 없습니다.</EmptyState>
            ) : (
              form.weeklyColleagueRows.map((row, index) => (
                <RowCard
                  key={row.id}
                  title={
                    <>
                      <span className="text-foreground">
                        {formatReviewerName(row.colleague, row.colleague_id)}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({formatReviewerOrganization(
                          row.colleague?.organization_slug ?? null,
                        )})
                      </span>
                    </>
                  }
                  meta={
                    <>
                      <span className="font-medium text-foreground/80">
                        {getWeekLabel(row.week_card_id)}
                      </span>
                      <IdMono label="id" value={row.id} />
                      <IdMono label="colleague_id" value={row.colleague_id} />
                    </>
                  }
                  onDelete={() =>
                    void handleDelete(
                      "weeklyColleague",
                      row.id,
                      `${getWeekLabel(row.week_card_id)} - ${formatReviewerName(row.colleague, row.colleague_id)} 위클리 연계동료를 삭제할까요?`,
                    )
                  }
                  deleteDisabled={saveDisabled}
                >
                  <div className="flex flex-col gap-1.5 sm:col-span-2">
                    <FieldLabel>한 줄 코멘트 (선택, 1~200자)</FieldLabel>
                    <textarea
                      value={row.message}
                      onChange={(event) =>
                        setWeeklyColleagueRow(index, {
                          message: event.target.value,
                        })
                      }
                      disabled={saveDisabled}
                      rows={2}
                      maxLength={200}
                      className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <CharCounter current={row.message.trim().length} max={200} />
                  </div>
                </RowCard>
              ))
            )}
          </CardContent>
        </Card>
      )}

      {/* ───────────── 활동 (Work Info / Ability / Exp / Career) ───────────── */}
      {activeTab === "activities" && (
        <ActivityTab
          bundle={bundle}
          legacyUserId={legacyUserId}
          weekLabels={weekLabels}
          saveDisabled={saveDisabled}
          onBundleUpdate={(next) => {
            setBundle(next);
            setForm(syncFormFromBundle(next));
            setLastSavedAt(new Date().toISOString());
          }}
          onBanner={(next) => setBanner(next)}
          devMode={devMode}
        />
      )}

      {/* ───────────── 디버그 ───────────── */}
      {activeTab === "debug" && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle className="text-base">디버그</CardTitle>
              <p className="text-xs text-muted-foreground">
                GET/PATCH 상태를 읽기 전용으로 표시합니다.
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDebugOpen((value) => !value)}
            >
              {debugOpen ? "Hide" : "Show"}
            </Button>
          </CardHeader>
          {debugOpen && (
            <CardContent className="text-xs">
              <DebugSection title="savedForm" data={savedForm} />
              <DebugSection title="form" data={form} />
              <DebugSection title="dirty flags" data={dirty} />
              <DebugSection title="lastApplied" data={lastApplied} />
              <DebugSection title="warnings" data={warnings} />
              <DebugSection
                title="next season review PATCH body"
                data={buildSeasonReviewPatch(form)}
              />
              <DebugSection
                title="next season reputation PATCH body"
                data={buildSeasonReputationPatch(form)}
              />
              <DebugSection
                title="next weekly reputation PATCH body"
                data={buildWeeklyReputationPatch(form)}
              />
              <DebugSection
                title="next weekly review PATCH body"
                data={buildWeeklyReviewPatch(form)}
              />
              <DebugSection
                title="next weekly colleague PATCH body"
                data={buildWeeklyColleaguePatch(form)}
              />
              <DebugSection title="weeks" data={bundle.weeks as WeekRow[]} />
              <DebugSection
                title="user_season_histories"
                data={bundle.userSeasonHistories as UserSeasonHistoryRow[]}
              />
              <DebugSection
                title="received season reputations"
                data={bundle.receivedSeasonReputations}
              />
              <DebugSection
                title="received weekly reputations"
                data={bundle.receivedWeeklyReputations}
              />
              <DebugSection title="weekly_reviews" data={bundle.weeklyReviews} />
              <DebugSection
                title="weekly_colleagues"
                data={bundle.weeklyColleagues}
              />
              <DebugSection
                title="user_activity_details"
                data={bundle.userActivityDetails}
              />
              <DebugSection
                title="career_records"
                data={bundle.careerRecords}
              />
              <DebugSection
                title="reputation_keywords"
                data={bundle.reputationKeywords as ReputationKeywordRow[]}
              />
              <DebugSection title="bundle" data={bundle} />
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}

