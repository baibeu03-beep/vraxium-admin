"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { buildAdminContextHref } from "@/lib/adminOrgContext";
import { StatusBadge } from "@/components/ui/status-badge";
import { adminDialog } from "@/components/ui/admin-dialog";
import { pushToast } from "@/components/ui/toast";
import { readScopeMode } from "@/lib/userScopeShared";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";
import {
  ORGANIZATION_ACCENT,
  ORGANIZATION_COLUMN,
  ORGANIZATION_TEXT_CLASS,
  type OrganizationSlug,
} from "@/lib/organizations";
import type { CrewWeeklyResultDisplayStatus } from "@/lib/crewWeeklyResultTypes";
import { growthStandardLabel, resolveGrowthStandardPoint } from "@/lib/orgPointMeta";

// [3] 예비 검수 · [4] 공표 / 공표 취소 — 세 동작을 **각각 다른 업무**로 구현한다.
//   · 예비 검수      = 서버 live 계산 결과를 화면 state 에만 보관. 저장 0 · 다른 화면 무영향.
//   · 예비 검수 취소 = 화면 state 만 비운다. 공표 결과·원천 무영향.
//   · 공표           = 서버가 원천을 재조회·재계산해 snapshot 저장(클라 숫자 미전송).
//   · 공표 모달의 "취소" = 모달만 닫는다(아무 상태도 바꾸지 않음).
//   · 공표 취소      = 이미 공표된 결과를 철회(reverted_at) → 집계 중으로 복귀.

type Metrics = {
  memberCount: number | null;
  seasonRestCount: number | null;
  personalRestCount: number | null;
  growthChallengeCount: number | null;
  growthSuccessCount: number | null;
  growthFailureCount: number | null;
  growthSuccessRatePercent: number | null;
  growthChallengeRatePercent: number | null;
  criterionPointA: number | null;
};

type CrewRow = {
  userId: string;
  crewDisplayName: string | null;
  crewCode: string | null;
  teamName: string | null;
  partName: string | null;
  result: "success" | "failure" | "rest" | "not_applicable" | "pending";
  reasonCode: string;
  earnedPointA: number | null;
  criterionPointA: number | null;
  // base row(예비 전에도 표시)
  schoolName: string | null;
  majorName: string | null;
  classLabel: string | null;
  grade: number | null;
  gradeLabel: string | null;
  // 결과 overlay(null = "-")
  rank: number | null;
  pointB: number | null;
  pointC: number | null;
  actCompletionRatePercent: number | null;
  actTotalCount: number | null;
  actSuccessCount: number | null;
  weeklyGrowthRatePercent: number | null;
  cumulativeSuccessWeeks: number | null;
};

type Readiness = Record<
  | "memberCount" | "seasonRestCount" | "personalRestCount" | "growthChallengeCount"
  | "growthSuccessCount" | "growthFailureCount" | "growthSuccessRatePercent"
  | "growthChallengeRatePercent",
  "ready" | "partial" | "unavailable"
>;

type TeamRow = {
  teamId: string | null;
  teamName: string;
  battleResult: "win" | "lose" | "draw" | null;
  leader: { displayName: string | null; schoolName: string | null; majorName: string | null };
  partCount: number;
  totalCrew: number;
  advancedCrew: number;
  regularCrew: number;
  challengeCrew: number | null;
  restCrew: number | null;
  successCrew: number | null;
  failCrew: number | null;
  winRatePercent: number | null;
};

type PreviewDto = Metrics & {
  crewResults: CrewRow[];
  teamResults: TeamRow[];
  calculatedAt: string;
  calculationVersion: number;
  metricsReadiness: Readiness;
};
type PublishedDto = PreviewDto & {
  runId: string;
  publishedAt: string;
  publishedBy: string | null;
  snapshotUnavailable: boolean;
};

// 서버가 확정해 준 공표 상태 요약(lib/crewWeekPublish.CrewWeekPublicationState).
//   화면은 이 사실만 보고 버튼·표시를 가른다 — 상태를 클라이언트에서 추측하지 않는다.
type PublicationState = {
  orgStatus: "aggregating" | "reviewing" | "published";
  orgStatusSource: "organization" | "legacy";
  hasActiveRun: boolean;
  hasActiveSnapshot: boolean;
  legacyCompletedWithoutSnapshot: boolean;
  activeRunId: string | null;
  weekEnded: boolean;
};

// null = 아직 계산 불가/미집계 → "-".  0 = 계산 완료 후 실제 0 → "0".
//   ⚠ `value ?? 0` 같은 폴백을 절대 쓰지 않는다(둘을 섞으면 미집계가 0으로 위장된다).
function formatMetric(value: number | null, unit: "명" | "%"): string {
  return value === null ? "-" : `${value}${unit}`;
}

function HelpLabel({
  children,
  helpKey,
}: {
  children: ReactNode;
  helpKey: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      {children}
      <AdminHelpIconButton helpKey={helpKey} title={typeof children === "string" ? children : undefined} />
    </span>
  );
}

// 지표 의미색 — 조직색(페이지 테마)과 **역할이 다르다**. 성공=green·실패=red·도전=blue·휴식=gray.
//   조직색은 아래 org 프롭으로 "소속 크루" 카드와 강조선에만 쓴다.
type Tone = "org" | "gray" | "blue" | "green" | "red";

const TONE_CLS: Record<Exclude<Tone, "org">, { card: string; value: string; bar: string }> = {
  gray: { card: "border-zinc-300 bg-zinc-50/70", value: "text-zinc-700", bar: "bg-zinc-400" },
  blue: { card: "border-sky-300 bg-sky-50/70", value: "text-sky-700", bar: "bg-sky-500" },
  green: { card: "border-emerald-300 bg-emerald-50/70", value: "text-emerald-700", bar: "bg-emerald-500" },
  red: { card: "border-rose-300 bg-rose-50/70", value: "text-rose-700", bar: "bg-rose-500" },
};

function MetricCard({
  label,
  value,
  unit,
  readiness,
  tone,
  org,
  helpKey,
}: {
  label: string;
  value: number | null;
  unit: "명" | "%";
  readiness: "ready" | "partial" | "unavailable";
  tone: Tone;
  org: OrganizationSlug;
  helpKey: string;
}) {
  const cls =
    tone === "org"
      ? {
          card: `${ORGANIZATION_COLUMN[org].edge} ${ORGANIZATION_COLUMN[org].cell}`,
          value: ORGANIZATION_TEXT_CLASS[org],
          bar: "",
        }
      : TONE_CLS[tone];
  return (
    <div className={`rounded-lg border-2 px-3 py-4 text-center ${cls.card}`}>
      <div className="text-sm font-semibold text-muted-foreground">
        <HelpLabel helpKey={helpKey}>{label}</HelpLabel>
      </div>
      <div
        className={`mt-1 text-3xl font-extrabold tabular-nums ${cls.value}`}
        data-metric={label}
        data-readiness={readiness}
        title={value === null ? "아직 집계되지 않았습니다(계산 불가). 실제 0과 다릅니다." : undefined}
      >
        {formatMetric(value, unit)}
      </div>
    </div>
  );
}

// 비율 카드 — 큰 숫자 + progress bar. null 이면 bar 를 0 처럼 보이게 하지 않는다.
function RateCard({
  label,
  value,
  readiness,
  tone,
  helpKey,
}: {
  label: string;
  value: number | null;
  readiness: "ready" | "partial" | "unavailable";
  tone: "green" | "blue";
  helpKey: string;
}) {
  const cls = TONE_CLS[tone];
  const isNull = value === null;
  return (
    <div className={`rounded-xl border-2 px-5 py-5 ${cls.card}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-base font-bold text-muted-foreground">
          <HelpLabel helpKey={helpKey}>{label}</HelpLabel>
        </span>
        <span
          className={`text-4xl font-extrabold tabular-nums ${cls.value}`}
          data-metric={label}
          data-readiness={readiness}
          title={isNull ? "아직 집계되지 않았습니다(계산 불가). 실제 0과 다릅니다." : undefined}
        >
          {formatMetric(value, "%")}
        </span>
      </div>
      <div
        className="mt-3 h-3 w-full overflow-hidden rounded-full bg-white/70"
        role="progressbar"
        aria-label={label}
        // null 은 값 미정 — aria-valuenow 를 0 으로 지어내지 않는다.
        aria-valuenow={isNull ? undefined : value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={isNull ? "집계되지 않음" : `${value}%`}
        data-bar-empty={isNull ? "true" : "false"}
      >
        {isNull ? (
          <div className="h-full w-full bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,rgba(0,0,0,.06)_6px,rgba(0,0,0,.06)_12px)]" />
        ) : (
          <div className={`h-full ${cls.bar}`} style={{ width: `${value}%` }} />
        )}
      </div>
    </div>
  );
}

// [5] 주차 종합 결과 — 상단 비율 2열 + 하단 크루(3×2) | 팀(준비 중) 2그룹.
function SummaryIndex({
  m,
  readiness,
  org,
  teams,
}: {
  m: Metrics | null;
  readiness: Readiness | null;
  org: OrganizationSlug;
  /** 팀 행 — 상단 팀 지표는 이 배열의 집계다(고객 앱 Team Battle KPI 와 동일 정의). */
  teams: TeamRow[] | null;
}) {
  const v = (k: keyof Readiness) =>
    m ? ((m as unknown as Record<string, number | null>)[k] ?? null) : null;
  const r = (k: keyof Readiness) => readiness?.[k] ?? "unavailable";

  const crew: Array<[keyof Readiness, string, Tone]> = [
    ["memberCount", "소속 크루", "org"],
    ["seasonRestCount", "시즌 휴식", "gray"],
    ["personalRestCount", "개인 휴식", "gray"],
    ["growthChallengeCount", "성장 도전", "blue"],
    ["growthSuccessCount", "성장 성공", "green"],
    ["growthFailureCount", "성장 실패", "red"],
  ];

  return (
    <div className="space-y-6" data-metric-grid>
      {/* 상단 — 성장 성공률 | 성장 도전율 (1행 2열) */}
      <div className="grid gap-4 sm:grid-cols-2">
        <RateCard
          label="성장 성공률"
          helpKey="admin.teamParts.crewWeekResults.metric.growthSuccessRate"
          value={v("growthSuccessRatePercent")}
          readiness={r("growthSuccessRatePercent")}
          tone="green"
        />
        <RateCard
          label="성장 도전율"
          helpKey="admin.teamParts.crewWeekResults.metric.growthChallengeRate"
          value={v("growthChallengeRatePercent")}
          readiness={r("growthChallengeRatePercent")}
          tone="blue"
        />
      </div>

      {/* 하단 — 크루 활동 결과 | 팀 활동 결과 */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section data-group="crew">
          <h3 className="mb-2 text-lg font-bold">
            <HelpLabel helpKey="admin.teamParts.crewWeekResults.section.crewSummary">
              크루 활동 결과
            </HelpLabel>
          </h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {crew.map(([key, label, tone]) => (
              <MetricCard
                key={key}
                label={label}
                helpKey={`admin.teamParts.crewWeekResults.metric.${key}`}
                value={v(key)}
                unit="명"
                readiness={r(key)}
                tone={tone}
                org={org}
              />
            ))}
          </div>
        </section>

        <section data-group="team">
          <h3 className="mb-2 text-lg font-bold">
            <HelpLabel helpKey="admin.teamParts.crewWeekResults.section.teamSummary">
              팀 활동 결과
            </HelpLabel>
          </h3>
          {/* 상단 팀 지표 = 하단 팀 행의 집계. 고객 앱 Team Battle KPI 정의를 그대로 미러한다:
                참전 팀 = teams.length · 전체 파트 = Σ partCount(팀별 **합계**, distinct 아님) ·
                전적 = 승/패/무 팀 수. teams 가 없으면(결과 미도출) 전부 "-" — 0 폴백 금지. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {([
              ["팀 수", teams ? teams.length : null],
              ["파트 수", teams ? teams.reduce((a, t) => a + t.partCount, 0) : null],
            ] as Array<[string, number | null]>).map(([label, value]) => (
              <div key={label} className="rounded-lg border-2 border-zinc-200 bg-zinc-50/60 px-3 py-4 text-center">
                <div className="text-sm font-semibold text-muted-foreground">{label}</div>
                <div className="mt-1 text-3xl font-extrabold text-zinc-700" data-team-metric={label}>
                  {value === null ? <span className="text-zinc-400">-</span> : String(value)}
                </div>
              </div>
            ))}
            {/* 전적 — 2행을 세로로 차지 */}
            <div className="flex flex-col items-center justify-center rounded-lg border-2 border-zinc-200 bg-zinc-50/60 px-3 py-4 text-center sm:row-span-2">
              <div className="text-sm font-semibold text-muted-foreground">전적</div>
              <div className="mt-1 text-xl font-extrabold text-zinc-700" data-team-metric="전적">
                {teams === null ? (
                  <span className="text-zinc-400">-</span>
                ) : (
                  `${teams.filter((t) => t.battleResult === "win").length}승 ${teams.filter((t) => t.battleResult === "lose").length}패${teams.filter((t) => t.battleResult === "draw").length ? ` ${teams.filter((t) => t.battleResult === "draw").length}무` : ""}`
                )}
              </div>
            </div>
            {([
              ["승리 팀 수", teams ? teams.filter((t) => t.battleResult === "win").length : null],
              ["패배 팀 수", teams ? teams.filter((t) => t.battleResult === "lose").length : null],
            ] as Array<[string, number | null]>).map(([label, value]) => (
              <div key={label} className="rounded-lg border-2 border-zinc-200 bg-zinc-50/60 px-3 py-4 text-center">
                <div className="text-sm font-semibold text-muted-foreground">{label}</div>
                <div className="mt-1 text-3xl font-extrabold text-zinc-700" data-team-metric={label}>
                  {value === null ? <span className="text-zinc-400">-</span> : String(value)}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

type BattleResult = Exclude<TeamRow["battleResult"], null>;
const BATTLE_LABEL: Record<BattleResult, string> = { win: "승", lose: "패", draw: "무" };
const BATTLE_TONE: Record<BattleResult, "success" | "danger" | "neutral"> = {
  win: "success", lose: "danger", draw: "neutral",
};

// 팀 활동 결과 표 — 행 순서는 **팀명 ko-KR 가나다순**(고객 앱 display_order 와 별개, 값은 동일).
function TeamTable({
  rows,
  hasResult = true,
  teamHref,
}: {
  rows: TeamRow[];
  hasResult?: boolean;
  teamHref?: (teamId: string) => string;
}) {
  const sorted = useMemo(
    () => [...rows].sort((a, b) => a.teamName.localeCompare(b.teamName, "ko-KR")),
    [rows],
  );
  if (sorted.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground" data-team-empty>
        이 주차에는 팀 활동 결과가 없습니다.
      </p>
    );
  }
  const COLS = ["팀명","팀 결과","팀장","파트 수","소속 크루","심화 크루","정규 크루","성장 도전","성장 휴식","성장 성공","성장 실패","승률"];
  const COL_KEYS = ["name","result","leader","partCount","crewCount","advancedCrew","regularCrew","growthChallenge","growthRest","growthSuccess","growthFailure","winRate"];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1200px] border-separate border-spacing-0 text-sm" data-team-table>
        <thead>
          <tr>
            {COLS.map((h, index) => (
              <th key={h} className={`whitespace-nowrap border-b bg-muted/60 px-3 py-2 font-semibold ${h==="팀명"||h==="팀장"?"text-left":"text-center"}`}>
                <HelpLabel helpKey={`admin.teamParts.crewWeekResults.teamColumn.${COL_KEYS[index]}`}>
                  {h}
                </HelpLabel>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((t, i) => (
            <tr
              key={t.teamId ?? t.teamName}
              className={i % 2 === 1 ? "bg-muted/30" : ""}
              data-team-row={t.teamName}
              data-team-total={t.totalCrew}
              data-team-parts={t.partCount}
            >
              <td className="whitespace-nowrap border-b px-3 py-2 text-left font-bold">
                {t.teamId && teamHref ? (
                  <Link
                    href={teamHref(t.teamId)}
                    className="text-primary underline-offset-4 hover:underline"
                    data-team-detail-link={t.teamId}
                  >
                    {t.teamName}
                  </Link>
                ) : (
                  t.teamName
                )}
              </td>
              <td className="whitespace-nowrap border-b px-3 py-2 text-center">
                {hasResult && t.battleResult ? (
                  <StatusBadge label={BATTLE_LABEL[t.battleResult]} size="sm" tone={BATTLE_TONE[t.battleResult]} />
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </td>
              {/* 팀장 — 이름/학교/전공만. 연락처·학번 등은 표시하지 않는다. */}
              <td className="whitespace-nowrap border-b px-3 py-2 text-left">
                {t.leader.displayName ? (
                  <>
                    <div className="font-semibold">{t.leader.displayName}</div>
                    <div className="text-xs text-muted-foreground">
                      {[t.leader.schoolName, t.leader.majorName].filter(Boolean).join(" · ") || "-"}
                    </div>
                  </>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </td>
              {([t.partCount,t.totalCrew,t.advancedCrew,t.regularCrew,t.challengeCrew,t.restCrew,t.successCrew,t.failCrew] as Array<number | null>).map((v, k) => (
                <td key={k} className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums">
                  {v ?? <span className="text-muted-foreground">-</span>}
                </td>
              ))}
              <td className="whitespace-nowrap border-b px-3 py-2 text-center font-bold tabular-nums">
                {hasResult && t.winRatePercent != null ? `${t.winRatePercent}%` : <span className="text-muted-foreground">-</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 성장 결과 — 도메인 값을 그대로 구분한다. uws_missing 을 무조건 "성장 실패"로 바꾸지 않는다.
const RESULT_LABEL: Record<CrewRow["result"], string> = {
  success: "성장 성공",
  failure: "성장 실패",
  rest: "휴식",
  not_applicable: "해당 없음",
  pending: "집계 전",
};

// null = "-" · 0 = "0"/"0%". `?? 0` 폴백 금지.
const cell = (v: number | null, suffix = "") =>
  v === null ? <span className="text-muted-foreground">-</span> : `${v}${suffix}`;

const CREW_COLS = [
  "등수", "크루명", "학적", "성장 결과", "클래스", "소속 팀", "소속 파트", "품계",
  "액트 체크율", "주차 성장률", "포인트 A", "포인트 B", "포인트 C", "성장성공(주차)",
];
const CREW_COL_KEYS = [
  "rank", "name", "education", "growthResult", "class", "team", "part", "grade",
  "actCompletionRate", "weeklyGrowthRate", "pointA", "pointB", "pointC", "successWeeks",
];

function CrewTable({
  rows,
  hasResult,
  memberHref,
}: {
  rows: CrewRow[];
  hasResult: boolean;
  /** 크루명 → 회원 상세 href. 표에 이미 있는 userId 만 쓴다(추가 조회 없음). */
  memberHref: (userId: string) => string;
}) {
  // 정렬: 결과 있으면 등수→품계→성장률desc→이름→userId, 없으면 크루명 ko-KR(고객 앱 흉내 금지).
  const sorted = useMemo(() => {
    const arr = [...rows];
    if (!hasResult) {
      return arr.sort((a, b) =>
        (a.crewDisplayName ?? "").localeCompare(b.crewDisplayName ?? "", "ko-KR") ||
        a.userId.localeCompare(b.userId),
      );
    }
    return arr.sort(
      (a, b) =>
        (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) ||
        (a.grade ?? 10) - (b.grade ?? 10) ||
        (b.weeklyGrowthRatePercent ?? 0) - (a.weeklyGrowthRatePercent ?? 0) ||
        (a.crewDisplayName ?? "").localeCompare(b.crewDisplayName ?? "", "ko-KR") ||
        a.userId.localeCompare(b.userId),
    );
  }, [rows, hasResult]);

  if (sorted.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground" data-crew-empty>
        이 주차에는 크루 행이 없습니다.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1400px] border-separate border-spacing-0 text-sm" data-crew-table>
        <thead>
          <tr>
            {CREW_COLS.map((h, index) => (
              <th
                key={h}
                className={
                  "whitespace-nowrap border-b bg-muted/60 px-3 py-2 font-semibold " +
                  (h === "크루명" || h === "학적" ? "text-left" : "text-center") +
                  (h === "크루명" ? " sticky left-0 z-10 bg-muted" : "")
                }
              >
                <HelpLabel helpKey={`admin.teamParts.crewWeekResults.crewColumn.${CREW_COL_KEYS[index]}`}>
                  {h}
                </HelpLabel>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((c, i) => {
            const zebra = i % 2 === 1 ? "bg-muted/30" : "";
            return (
              <tr key={c.userId} className={zebra} data-crew-row={c.userId}>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center font-bold tabular-nums" data-col-rank>
                  {cell(c.rank)}
                </td>
                {/* 크루명 — 클릭 시 회원 상세로 이동(현재 탭). 어드민 컨텍스트(통합/개별 org·모드·
                    테스트 대행/데모)는 공통 유틸이 그대로 전달한다 — 수동 문자열 연결 금지. */}
                <td className={`whitespace-nowrap border-b px-3 py-2 text-left font-semibold sticky left-0 z-10 ${zebra || "bg-background"}`}>
                  <Link
                    href={memberHref(c.userId)}
                    data-crew-name-link={c.userId}
                    className="underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                  >
                    {c.crewDisplayName ?? c.crewCode ?? c.userId.slice(0, 8)}
                  </Link>
                </td>
                {/* 학적 = 학교·전공만(연락처·학번 미표시) */}
                <td className="whitespace-nowrap border-b px-3 py-2 text-left" data-col-edu>
                  {c.schoolName || c.majorName ? (
                    <>
                      <div>{c.schoolName ?? "-"}</div>
                      <div className="text-xs text-muted-foreground">{c.majorName ?? "-"}</div>
                    </>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center" data-col-result>
                  {hasResult ? (
                    <StatusBadge label={RESULT_LABEL[c.result]} size="sm" />
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center">{c.classLabel ?? <span className="text-muted-foreground">-</span>}</td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center" data-col-team>{c.teamName ?? <span className="text-muted-foreground">-</span>}</td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center" data-col-part>{c.partName ?? <span className="text-muted-foreground">-</span>}</td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center">{c.gradeLabel ?? <span className="text-muted-foreground">-</span>}</td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums" data-col-actrate>{cell(c.actCompletionRatePercent, "%")}</td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums">{cell(c.weeklyGrowthRatePercent, "%")}</td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums">{cell(c.earnedPointA)}</td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums">{cell(c.pointB)}</td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums">{cell(c.pointC)}</td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums" data-col-cumweeks>{cell(c.cumulativeSuccessWeeks, "주")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function CrewWeekPublishPanel({
  organizationSlug,
  weekId,
  halfKey,
  displayStatus,
  criterionPointA,
  weekEnded,
  onChanged,
}: {
  /** 주차 확정 기준 포인트 A(좌측 상태 열에 표시). */
  criterionPointA?: number | null;
  organizationSlug: OrganizationSlug;
  weekId: string;
  halfKey: string | null;
  displayStatus: CrewWeeklyResultDisplayStatus | null;
  /** 주차가 실제로 종료됐는가 — 진행 중 주차는 공표 금지(서버도 422로 차단). */
  weekEnded: boolean;
  onChanged?: () => void;
}) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const mode = readScopeMode(searchParams);
  const growthStandardPoint = resolveGrowthStandardPoint(organizationSlug);
  // 크루명 → 회원 상세. 표에 이미 있는 userId 를 그대로 쓴다(새 API·조회 없음).
  const memberHref = useCallback(
    (userId: string) =>
      buildAdminContextHref({
        targetPath: `/admin/members/${userId}`,
        pathname,
        searchParams,
      }),
    [pathname, searchParams],
  );
  const teamHref = useCallback(
    (teamId: string) => {
      const params = new URLSearchParams();
      if (halfKey) params.set("half", halfKey);
      params.set("weekId", weekId);
      return buildAdminContextHref({
        targetPath: `/admin/team-parts/info/${organizationSlug}/${teamId}?${params.toString()}`,
        pathname,
        searchParams,
      });
    },
    [halfKey, organizationSlug, pathname, searchParams, weekId],
  );
  const qs = mode === "test" ? "?mode=test" : "";
  const base = `/api/admin/team-parts/info/crew-week-results/${organizationSlug}/${weekId}`;

  const [preview, setPreview] = useState<PreviewDto | null>(null);
  // 같은 화면에서 공표를 취소할 때 직전 예비 검수 상태로 되돌리기 위한 스냅샷.
  // 서버 공표 snapshot과 별개인 UI 복원용이며, 새 예비 검수를 시작하면 폐기한다.
  const [prePublishPreview, setPrePublishPreview] = useState<PreviewDto | null>(null);
  const [published, setPublished] = useState<PublishedDto | null>(null);
  const [publication, setPublication] = useState<PublicationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | "preview" | "publish" | "unpublish">(null);
  // 기본 탭 = 크루 활동 결과. 탭 전환은 화면 표시만 바꾼다(쓰기·재계산 없음).
  const [tab, setTab] = useState<"crew" | "team">("crew");
  // 예비 전에도 보여야 하는 크루 전원 base row(결과 컬럼은 전부 null).
  const [baseRows, setBaseRows] = useState<CrewRow[] | null>(null);
  const [baseTeamRows, setBaseTeamRows] = useState<TeamRow[] | null>(null);
  // 공표/취소 후 서버 사실을 다시 읽기 위한 트리거.
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // [1] 진입 즉시 공표 snapshot 조회 — 검수 완료 주차는 **예비 검수 없이** 값이 채워져야 한다.
  //   순서가 중요하다: ① 공표 상태/스냅샷 → ② (스냅샷이 없을 때만) base row.
  //   활성 snapshot 이 있으면 그 표가 곧 화면이므로 base row 재계산을 아예 하지 않는다(무거운 live 계산 회피).
  useEffect(() => {
    let alive = true;
    // 외부(API)와 동기화하는 정석 effect — 공표 상태는 서버가 소유한다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    void (async () => {
      let pub: PublicationState | null = null;
      try {
        const res = await fetch(`${base}${qs}`, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !json.success) throw apiErrorFrom(res, json, `조회 실패 (${res.status})`);
        if (!alive) return;
        pub = (json.data?.publication as PublicationState | null) ?? null;
        setPublished((json.data?.published as PublishedDto | null) ?? null);
        setPublication(pub);
      } catch {
        if (!alive) return;
        setPublished(null);
        setPublication(null);
      } finally {
        if (alive) setLoading(false);
      }
      if (!alive || pub?.hasActiveSnapshot === true) return;
      // base row — 결과 계산 노출이 아니다. 서버가 결과 컬럼을 비워 보낸다(결과 컬럼 "-").
      try {
        const res = await fetch(`${base}${qs ? `${qs}&` : "?"}action=base`, { cache: "no-store" });
        const json = await res.json();
        if (alive && res.ok && json.success) {
          setBaseRows(json.data.baseRows as CrewRow[]);
          setBaseTeamRows(json.data.baseTeamRows as TeamRow[]);
        }
      } catch {
        if (alive) {
          setBaseRows(null);
          setBaseTeamRows(null);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [base, qs, refreshKey]);

  // [3] 예비 검수 — 매번 서버에서 최신 원천으로 재계산(캐시 금지).
  const onPreview = async () => {
    setBusy("preview");
    setPrePublishPreview(null);
    try {
      const res = await fetch(`${base}${qs ? `${qs}&` : "?"}action=preview`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) throw apiErrorFrom(res, json, `예비 검수 실패 (${res.status})`);
      setPreview(json.data.preview as PreviewDto);
      await adminDialog.alert({
        variant: "info",
        title: "예비 결과 도출",
        // 줄바꿈은 다이얼로그 본문의 whitespace-pre-line 이 그대로 렌더한다.
        description:
          "누적된 데이터를 기준하여, 결과를 도출했습니다.\n다른 페이지에는 공표되지 않았으며, ‘확인’ 용입니다.",
      });
    } catch (e) {
      pushToast("error", getApiErrorMessage(e, "예비 검수 실패"));
    } finally {
      setBusy(null);
    }
  };

  // 예비 결과만 화면에서 제거 — DB/공표 상태 무영향.
  const onCancelPreview = () => setPreview(null);

  // [4] 공표 — 확인 모달의 "취소"는 아무것도 하지 않는다.
  const onPublish = async () => {
    const ok = await adminDialog.confirm({
      variant: "warning",
      title: "활동 결과 확정",
      description:
        "해당 주차 활동 결과를 확정하시겠습니까? 확정하면 크루 페이지를 포함한 관련 화면에 공표됩니다.",
      confirmLabel: "확인",
      cancelLabel: "취소",
    });
    if (!ok) return; // 모달만 닫힘 — 상태 변경 없음
    setBusy("publish");
    try {
      // ⚠ 예비 숫자를 보내지 않는다. 서버가 최신 원천으로 다시 계산한다.
      const res = await fetch(`${base}${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "publish" }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw apiErrorFrom(res, json, `공표 실패 (${res.status})`);
      setPublished(json.data.published as PublishedDto);
      setPublication((json.data.publication as PublicationState | null) ?? null);
      // [5] 재공표 성공 = 새 snapshot 이 활성 · 이전 run 은 이력. 화면은 공표 결과 한 벌만 보여준다.
      setPrePublishPreview(preview);
      setPreview(null);
      pushToast("success", "공표되었습니다.");
      onChanged?.();
    } catch (e) {
      pushToast("error", getApiErrorMessage(e, "공표 실패"));
    } finally {
      setBusy(null);
    }
  };

  // [4] 공표 취소 — 모달 취소와 완전히 다른 업무 동작.
  const onUnpublish = async () => {
    const ok = await adminDialog.confirm({
      variant: "danger",
      title: "공표 취소",
      description:
        "해당 주차의 공표를 취소하시겠습니까? 취소하면 크루 페이지를 포함한 관련 화면에서 확정 결과가 더 이상 노출되지 않습니다.",
      confirmLabel: "공표 취소",
      cancelLabel: "돌아가기",
    });
    if (!ok) return;
    setBusy("unpublish");
    try {
      const res = await fetch(`${base}${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unpublish" }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw apiErrorFrom(res, json, `공표 취소 실패 (${res.status})`);
      // [4] 같은 화면에서 방금 공표한 경우에는 공표 직전 예비 검수 결과를 복원한다.
      //   새로 진입한 공표 화면처럼 보존된 예비 결과가 없으면, 취소 직전 공표 snapshot을
      //   예비 결과로 내려 받아 같은 수치를 계속 검토할 수 있게 한다.
      const restoredPreview = prePublishPreview ?? published;
      setPublished(null);
      setPreview(restoredPreview);
      setPrePublishPreview(null);
      setPublication((json.data.publication as PublicationState | null) ?? null);
      if (!restoredPreview) {
        setBaseRows(null);
        setBaseTeamRows(null);
        refresh(); // 복원할 결과가 없는 legacy 공표만 base row를 다시 조회한다.
      }
      pushToast("success", "공표가 취소되었습니다.");
      onChanged?.();
    } catch (e) {
      pushToast("error", getApiErrorMessage(e, "공표 취소 실패"));
    } finally {
      setBusy(null);
    }
  };

  // ── [2] 표시 우선순위 ───────────────────────────────────────────────────────
  //   ① 새 예비 결과 → ② 활성 공표 snapshot → ③ 둘 다 없으면 base row + 결과 컬럼 "-".
  //   ⚠ snapshot 이 없는 legacy 공표본(snapshotUnavailable)은 **표시 소스가 아니다** —
  //     live 결과로 조용히 폴백하지 않고 "표시할 수 없음"을 명시한다.
  const hasActiveSnapshot = publication?.hasActiveSnapshot === true;
  const publishedShown: PublishedDto | null =
    hasActiveSnapshot && published && !published.snapshotUnavailable ? published : null;
  const source: PreviewDto | PublishedDto | null = preview ?? publishedShown ?? null;

  // ── [6] legacy 검수 완료 주차 ───────────────────────────────────────────────
  //   org 상태는 published 인데 표시 가능한 공표 snapshot 이 없다. 일반 집계 중처럼 취급하지 않는다.
  const legacyCompleted = publication?.legacyCompletedWithoutSnapshot === true;
  // 이미 한 번 공표된 주차인가(= 공표 버튼 문구를 "재공표"로 구분).
  const alreadyPublished = hasActiveSnapshot || legacyCompleted;

  // ── [3] 버튼 상태표 ─────────────────────────────────────────────────────────
  //   예비 검수 : 항상 활성(검수 완료에서도 재실행 가능).
  //   공표      : 주차 종료 + **새 예비 결과가 있을 때만** 활성.
  //               → 검수 완료+snapshot(예비 없음)=비활성 · 검수 완료+새 예비=재공표 활성
  //               → 집계 중+예비 없음=비활성 · 집계 중+예비 있음=활성 · 진행 중=비활성(weekEnded=false)
  //   공표 취소 : **활성 공표(run)가 있을 때만 표시.** 집계 중/진행 중에서는 숨김.
  //   주차 종료 판정은 두 곳이 같은 SoT(활동 기준일)를 쓴다 — 상세 GET 이 먼저 오므로 그 값을 우선한다.
  const weekEndedNow = publication?.weekEnded ?? weekEnded;
  const canPreview = busy == null;
  const canPublish = weekEndedNow && preview != null && busy == null;
  const showUnpublish = publication?.hasActiveRun === true;
  const canUnpublish = showUnpublish && busy == null;

  // 상단 단계 표시 — 공표/취소 직후 부모 번들 재조회를 기다리지 않도록 서버가 준 org 상태를 우선한다.
  //   ⚠ 진행 중 vs 집계 중 구분은 시간 게이트라 부모 DTO 만 알고 있다 → 그 부분은 그대로 쓴다.
  const stepStatus: CrewWeeklyResultDisplayStatus | null =
    publication == null
      ? displayStatus
      : publication.orgStatus === "published"
        ? "completed"
        : displayStatus === "completed"
          ? "aggregating"
          : displayStatus;

  return (
    <div className="admin-section-stack-lg min-w-0" data-crew-week-publish>
      {/* [2]+[3][4] — 데스크톱에서 한 행 2열: 좌=진행 상태·기준 Po.A / 우=버튼 2행 1열. */}
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
          <nav aria-label="검수 진행 상태" className="flex flex-wrap items-center gap-2" data-review-steps>
            <AdminHelpIconButton
              helpKey="admin.teamParts.crewWeekResults.section.reviewStatus"
              title="검수 진행 상태"
              size="sm"
            />
            {(
              [
                ["in_progress", "진행 중"],
                ["aggregating", "집계 중"],
                ["completed", "검수 완료"],
              ] as const
            ).map(([key, label], i) => {
              const active = stepStatus === key;
              return (
                <span key={key} className="flex items-center gap-2">
                  {i > 0 ? <span aria-hidden className="text-muted-foreground">···</span> : null}
                  <span
                    aria-current={active ? "step" : undefined}
                    data-step={key}
                    data-active={active ? "true" : "false"}
                    className={
                      "rounded-lg border-2 px-3 py-2 text-base font-bold " +
                      (active
                        ? `${ORGANIZATION_ACCENT[organizationSlug].solid}`
                        : "border-input text-muted-foreground")
                    }
                  >
                    {/* 색만으로 상태를 표현하지 않는다 — 현재 단계에 텍스트 마커를 함께 준다. */}
                    {label}
                    {active ? <span className="ml-1 text-xs sm:text-sm">(현재)</span> : null}
                  </span>
                </span>
              );
            })}
          </nav>
          <div
            className={`flex min-h-[7.25rem] flex-wrap items-center gap-3 rounded-lg border-2 px-5 py-4 ${ORGANIZATION_COLUMN[organizationSlug].edge}`}
          >
            <span className="text-lg font-bold text-muted-foreground">
              {growthStandardLabel(growthStandardPoint.name)}
              <AdminHelpIconButton
                helpKey="admin.teamParts.crewWeekResults.field.growthCriterion"
                title={growthStandardLabel(growthStandardPoint.name)}
                size="sm"
                className="ml-1"
              />
            </span>
            <strong
              className={`text-4xl font-extrabold tabular-nums ${ORGANIZATION_TEXT_CLASS[organizationSlug]}`}
              data-criterion-point-a
            >
              {criterionPointA ?? "-"}
            </strong>
          </div>
          </div>
        </div>

        {/* 버튼 2행 1열 · 동일 너비 · 크게 */}
        <div className="grid min-w-0 content-start gap-3">
          <div className="flex items-center gap-1">
          <Button
            type="button"
            onClick={onPreview}
            disabled={!canPreview}
            data-action-preview
            className={`h-13 min-w-0 flex-1 py-3 text-base font-bold ${ORGANIZATION_ACCENT[organizationSlug].button}`}
          >
            {busy === "preview" ? "계산 중…" : "클럽 활동 검수(예비)"}
          </Button>
          <AdminHelpIconButton helpKey="admin.teamParts.crewWeekResults.action.preview" title="클럽 활동 검수(예비)" size="sm" />
          </div>
          {/* 공표 버튼은 **항상 렌더**한다(비활성 상태도 보여야 상태표와 일치한다).
              공표 취소는 대체가 아니라 아래에 **추가**된다 — 기존 버튼을 갈아치우지 않는다. */}
          <div className="flex items-center gap-1">
          <Button
            type="button"
            onClick={onPublish}
            disabled={!canPublish}
            data-action-publish
            data-publish-kind={alreadyPublished ? "republish" : "publish"}
            title={
              !weekEndedNow
                ? "진행 중인 주차는 공표할 수 없습니다."
                : preview == null
                  ? "먼저 [클럽 활동 검수(예비)] 를 실행해주세요."
                  : undefined
            }
            className={`h-13 min-w-0 flex-1 py-3 text-base font-bold ${ORGANIZATION_ACCENT[organizationSlug].button}`}
          >
            {busy === "publish"
              ? "공표 중…"
              : alreadyPublished
                ? "클럽 활동 검수(재공표)"
                : "클럽 활동 검수(공표)"}
          </Button>
          <AdminHelpIconButton helpKey="admin.teamParts.crewWeekResults.action.publish" title="클럽 활동 검수 공표" size="sm" />
          </div>
          {showUnpublish ? (
            <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="destructive"
              onClick={onUnpublish}
              disabled={!canUnpublish}
              data-action-unpublish
              className="h-13 min-w-0 flex-1 py-3 text-base font-bold"
            >
              {busy === "unpublish" ? "취소 중…" : "공표 취소"}
            </Button>
            <AdminHelpIconButton helpKey="admin.teamParts.crewWeekResults.action.unpublish" title="공표 취소" size="sm" />
            </div>
          ) : null}
          {preview ? (
            <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              onClick={onCancelPreview}
              disabled={busy != null}
              data-action-preview-cancel
              className="min-w-0 flex-1 text-base font-semibold"
            >
              예비 검수 취소
            </Button>
            <AdminHelpIconButton helpKey="admin.teamParts.crewWeekResults.action.cancelPreview" title="예비 검수 취소" size="sm" />
            </div>
          ) : null}
        </div>
      </div>

      {/* [6] legacy 검수 완료 주차 — 완료 상태는 유지한 채 "표시할 수 없음"을 명시한다.
          ⚠ 여기서 live 결과로 폴백하면 공표 당시 값과 다른 숫자를 확정처럼 보여주게 된다. 하지 않는다. */}
      {/* [5] 주차 종합 인덱스 — 항상 렌더한다(최초 진입 = 전부 "-").
          표시 우선순위: ① 새 예비 결과 → ② 활성 공표 snapshot → ③ 둘 다 없으면 "-".
          예비와 공표를 **절대 섞지 않는다** — 배지와 제목으로 출처를 명시한다. */}
      <section className="rounded-lg border p-4" data-summary-index>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <strong className="text-base">
            <HelpLabel helpKey="admin.teamParts.crewWeekResults.section.weekSummary">
              이번 주 크루 종합 결과
            </HelpLabel>
          </strong>
          {preview ? (
            <>
              <StatusBadge label="집계 중" size="sm" />
              <span data-summary-source="preview" className="text-sm font-semibold">
                새 예비 결과
              </span>
              <span className="text-xs text-muted-foreground">
                계산 시각 {new Date(preview.calculatedAt).toLocaleString("ko-KR")} · 아직 공표되지 않았습니다.
              </span>
            </>
          ) : publishedShown ? (
            <>
              <StatusBadge label="검수 완료" size="sm" />
              <span data-summary-source="published" className="text-sm font-semibold">
                현재 공표 결과
              </span>
              <span className="text-xs text-muted-foreground">
                공표 시각 {new Date(publishedShown.publishedAt).toLocaleString("ko-KR")} · 결과 버전{" "}
                {publishedShown.calculationVersion}
              </span>
            </>
          ) : (
            <span data-summary-source="none" className="text-xs text-muted-foreground">
              {loading
                ? "불러오는 중…"
                : legacyCompleted
                  ? "이 주차의 결과를 불러오지 못했습니다. 잠시 후 다시 확인해주세요."
                  : "[클럽 활동 검수(예비)] 를 실행하면 결과가 표시됩니다."}
            </span>
          )}
        </div>
        <SummaryIndex
          m={preview ?? publishedShown}
          readiness={(preview ?? publishedShown)?.metricsReadiness ?? null}
          org={organizationSlug}
          teams={(preview ?? publishedShown)?.teamResults ?? null}
        />
        {publishedShown && preview ? (
          <p className="mt-2 text-xs text-amber-800" data-summary-both>
            ⚠ 현재 공표 중인 결과와 새 예비 결과가 함께 존재합니다. 위 값은 <strong>새 예비 결과</strong>이며
            아직 공표되지 않았습니다. 공표 결과는 [클럽 활동 검수(재공표)] 전까지 그대로 유지됩니다.
          </p>
        ) : null}
      </section>

      {/* ── 구분선 + 하단 결과 탭 ──────────────────────────────────────────── */}
      <section data-week-result-details className="pt-2">
        <div className={`border-t-2 ${ORGANIZATION_COLUMN[organizationSlug].edge}`} />

        <div className="mt-6" role="tablist" aria-label="주차 결과 상세">
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                ["crew", "크루 활동 결과"],
                ["team", "팀 활동 결과"],
              ] as const
            ).map(([key, label]) => {
              const selected = tab === key;
              return (
                <div key={key} className="flex items-center gap-1">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    data-tab={key}
                    // 탭 전환은 표시만 바꾼다 — API 재호출·재계산 없음.
                    onClick={() => setTab(key)}
                    className={
                      "min-w-0 flex-1 rounded-lg border-2 py-4 text-xl font-bold transition-colors " +
                      (selected
                        ? ORGANIZATION_ACCENT[organizationSlug].solid
                        : `${ORGANIZATION_COLUMN[organizationSlug].edge} ${ORGANIZATION_COLUMN[organizationSlug].cell} hover:brightness-95`)
                    }
                  >
                    {label}
                  </button>
                  <AdminHelpIconButton
                    helpKey={`admin.teamParts.crewWeekResults.tab.${key}`}
                    title={label}
                    size="sm"
                  />
                </div>
              );
            })}
          </div>
        </div>

        <div role="tabpanel" className="mt-4" data-tabpanel={tab}>
          {source ? (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <StatusBadge label={preview ? "집계 중" : "검수 완료"} size="sm" />
                <strong>{preview ? "예비 결과" : "공표 결과"}</strong>
                <span className="text-xs text-muted-foreground">
                  {preview
                    ? `계산 시각 ${new Date(preview.calculatedAt).toLocaleString("ko-KR")} · 아직 공표되지 않음`
                    : `공표 시각 ${new Date(publishedShown!.publishedAt).toLocaleString("ko-KR")}`}
                </span>
              </div>
              {tab === "crew" ? (
                <CrewTable rows={source.crewResults} hasResult memberHref={memberHref} />
              ) : (
                <TeamTable rows={source.teamResults} teamHref={teamHref} />
              )}
            </>
          ) : tab === "crew" && baseRows ? (
            <>
              {/* [2]③ 결과가 없으면 base row + 결과 컬럼 "-". legacy 완료 주차도 여기로 온다
                  (live 결과를 결과 컬럼에 채우지 않는다 — 위 경고가 이유를 설명한다). */}
              <p className="mb-2 text-xs text-muted-foreground" data-details-base>
                {legacyCompleted
                  ? "이 주차의 결과를 불러오지 못했습니다. 잠시 후 다시 확인해주세요."
                  : "기본 정보만 표시 중입니다. [클럽 활동 검수(예비)] 를 실행하면 결과 컬럼이 채워집니다."}
              </p>
              <CrewTable rows={baseRows} hasResult={false} memberHref={memberHref} />
            </>
          ) : tab === "team" && baseTeamRows ? (
            <>
              <p className="mb-2 text-xs text-muted-foreground" data-details-base>
                기본 정보만 표시 중입니다. [클럽 활동 검수(예비)] 를 실행하면 결과 컬럼이 채워집니다.
              </p>
              <TeamTable rows={baseTeamRows} hasResult={false} teamHref={teamHref} />
            </>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground" data-details-empty>
              {loading
                ? "불러오는 중…"
                : legacyCompleted
                  ? "이 주차의 결과를 불러오지 못했습니다. 잠시 후 다시 확인해주세요."
                  : "예비 검수를 실행하면 이 주차의 결과가 표시됩니다."}
            </p>
          )}
        </div>
      </section>

      {!publishedShown && !preview && !legacyCompleted && !loading ? (
        <p className="text-sm text-muted-foreground">
          [클럽 활동 검수(예비)] 를 눌러 현재 누적 데이터 기준 결과를 확인할 수 있습니다.
          {stepStatus === "in_progress"
            ? " 진행 중인 주차는 공표할 수 없습니다."
            : null}
        </p>
      ) : null}
    </div>
  );
}
