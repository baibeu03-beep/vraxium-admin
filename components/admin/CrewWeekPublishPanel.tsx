"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
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
  battleResult: "win" | "lose" | "draw";
  leader: { displayName: string | null; schoolName: string | null; majorName: string | null };
  partCount: number;
  totalCrew: number;
  advancedCrew: number;
  regularCrew: number;
  challengeCrew: number;
  restCrew: number;
  successCrew: number;
  failCrew: number;
  winRatePercent: number;
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

// null = 아직 계산 불가/미집계 → "-".  0 = 계산 완료 후 실제 0 → "0".
//   ⚠ `value ?? 0` 같은 폴백을 절대 쓰지 않는다(둘을 섞으면 미집계가 0으로 위장된다).
function formatMetric(value: number | null, unit: "명" | "%"): string {
  return value === null ? "-" : `${value}${unit}`;
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
}: {
  label: string;
  value: number | null;
  unit: "명" | "%";
  readiness: "ready" | "partial" | "unavailable";
  tone: Tone;
  org: OrganizationSlug;
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
      <div className="text-sm font-semibold text-muted-foreground">{label}</div>
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
}: {
  label: string;
  value: number | null;
  readiness: "ready" | "partial" | "unavailable";
  tone: "green" | "blue";
}) {
  const cls = TONE_CLS[tone];
  const isNull = value === null;
  return (
    <div className={`rounded-xl border-2 px-5 py-5 ${cls.card}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-base font-bold text-muted-foreground">{label}</span>
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
          value={v("growthSuccessRatePercent")}
          readiness={r("growthSuccessRatePercent")}
          tone="green"
        />
        <RateCard
          label="성장 도전율"
          value={v("growthChallengeRatePercent")}
          readiness={r("growthChallengeRatePercent")}
          tone="blue"
        />
      </div>

      {/* 하단 — 크루 활동 결과 | 팀 활동 결과 */}
      <div className="grid gap-6 lg:grid-cols-2">
        <section data-group="crew">
          <h3 className="mb-2 text-lg font-bold">크루 활동 결과</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {crew.map(([key, label, tone]) => (
              <MetricCard
                key={key}
                label={label}
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
          <h3 className="mb-2 text-lg font-bold">팀 활동 결과</h3>
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

const BATTLE_LABEL: Record<TeamRow["battleResult"], string> = { win: "승", lose: "패", draw: "무" };
const BATTLE_TONE: Record<TeamRow["battleResult"], "success" | "danger" | "neutral"> = {
  win: "success", lose: "danger", draw: "neutral",
};

// 팀 활동 결과 표 — 행 순서는 **팀명 ko-KR 가나다순**(고객 앱 display_order 와 별개, 값은 동일).
function TeamTable({ rows }: { rows: TeamRow[] }) {
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
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1200px] border-separate border-spacing-0 text-sm" data-team-table>
        <thead>
          <tr>
            {COLS.map((h) => (
              <th key={h} className={`whitespace-nowrap border-b bg-muted/60 px-3 py-2 font-semibold ${h==="팀명"||h==="팀장"?"text-left":"text-center"}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((t, i) => (
            <tr key={t.teamId ?? t.teamName} className={i % 2 === 1 ? "bg-muted/30" : ""} data-team-row={t.teamName}>
              <td className="whitespace-nowrap border-b px-3 py-2 text-left font-bold">{t.teamName}</td>
              <td className="whitespace-nowrap border-b px-3 py-2 text-center">
                <StatusBadge label={BATTLE_LABEL[t.battleResult]} size="sm" tone={BATTLE_TONE[t.battleResult]} />
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
              {([t.partCount,t.totalCrew,t.advancedCrew,t.regularCrew,t.challengeCrew,t.restCrew,t.successCrew,t.failCrew] as number[]).map((v, k) => (
                <td key={k} className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums">{v}</td>
              ))}
              <td className="whitespace-nowrap border-b px-3 py-2 text-center font-bold tabular-nums">{t.winRatePercent}%</td>
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

function CrewTable({ rows, hasResult }: { rows: CrewRow[]; hasResult: boolean }) {
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
            {CREW_COLS.map((h) => (
              <th
                key={h}
                className={
                  "whitespace-nowrap border-b bg-muted/60 px-3 py-2 font-semibold " +
                  (h === "크루명" || h === "학적" ? "text-left" : "text-center") +
                  (h === "크루명" ? " sticky left-0 z-10 bg-muted" : "")
                }
              >
                {h}
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
                <td className={`whitespace-nowrap border-b px-3 py-2 text-left font-semibold sticky left-0 z-10 ${zebra || "bg-background"}`}>
                  {c.crewDisplayName ?? c.crewCode ?? c.userId.slice(0, 8)}
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
                <td className="whitespace-nowrap border-b px-3 py-2 text-center">{c.teamName ?? <span className="text-muted-foreground">-</span>}</td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center">{c.partName ?? <span className="text-muted-foreground">-</span>}</td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center">{c.gradeLabel ?? <span className="text-muted-foreground">-</span>}</td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums" data-col-actrate>{cell(c.actCompletionRatePercent, "%")}</td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums">{cell(c.weeklyGrowthRatePercent, "%")}</td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums">{cell(c.earnedPointA)}</td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums">{cell(c.pointB)}</td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums">{cell(c.pointC)}</td>
                <td className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums">{cell(c.cumulativeSuccessWeeks, "주")}</td>
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
  displayStatus,
  criterionPointA,
  weekEnded,
  onChanged,
}: {
  /** 주차 확정 기준 포인트 A(좌측 상태 열에 표시). */
  criterionPointA?: number | null;
  organizationSlug: OrganizationSlug;
  weekId: string;
  displayStatus: CrewWeeklyResultDisplayStatus | null;
  /** 주차가 실제로 종료됐는가 — 진행 중 주차는 공표 금지(서버도 422로 차단). */
  weekEnded: boolean;
  onChanged?: () => void;
}) {
  const searchParams = useSearchParams();
  const mode = readScopeMode(searchParams);
  const qs = mode === "test" ? "?mode=test" : "";
  const base = `/api/admin/team-parts/info/crew-week-results/${organizationSlug}/${weekId}`;

  const [preview, setPreview] = useState<PreviewDto | null>(null);
  const [published, setPublished] = useState<PublishedDto | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "publish" | "unpublish">(null);
  // 기본 탭 = 크루 활동 결과. 탭 전환은 화면 표시만 바꾼다(쓰기·재계산 없음).
  const [tab, setTab] = useState<"crew" | "team">("crew");
  // 예비 전에도 보여야 하는 크루 전원 base row(결과 컬럼은 전부 null).
  const [baseRows, setBaseRows] = useState<CrewRow[] | null>(null);

  const loadPublished = useCallback(async () => {
    try {
      const res = await fetch(`${base}${qs}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) throw apiErrorFrom(res, json, `조회 실패 (${res.status})`);
      setPublished((json.data?.published as PublishedDto | null) ?? null);
    } catch {
      setPublished(null);
    }
  }, [base, qs]);

  useEffect(() => {
    // 외부(API)와 동기화하는 정석 effect — 공표 상태는 서버가 소유한다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPublished();
    // base row 는 진입 즉시 로드한다(결과 계산 노출 아님 — 서버가 결과 컬럼을 비워 보낸다).
    void (async () => {
      try {
        const res = await fetch(`${base}${qs ? `${qs}&` : "?"}action=base`, { cache: "no-store" });
        const json = await res.json();
        if (res.ok && json.success) setBaseRows(json.data.baseRows as CrewRow[]);
      } catch {
        setBaseRows(null);
      }
    })();
  }, [loadPublished, base, qs]);

  // [3] 예비 검수 — 매번 서버에서 최신 원천으로 재계산(캐시 금지).
  const onPreview = async () => {
    setBusy("preview");
    try {
      const res = await fetch(`${base}${qs ? `${qs}&` : "?"}action=preview`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) throw apiErrorFrom(res, json, `예비 검수 실패 (${res.status})`);
      setPreview(json.data.preview as PreviewDto);
      await adminDialog.alert({
        variant: "info",
        title: "예비 결과 도출",
        description:
          "누적된 데이터를 기준으로 예비 결과를 도출했습니다. 이 결과는 확인용이며, 다른 페이지에는 공표되지 않았습니다.",
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
      setPublished(null);
      pushToast("success", "공표가 취소되었습니다.");
      onChanged?.();
    } catch (e) {
      pushToast("error", getApiErrorMessage(e, "공표 취소 실패"));
    } finally {
      setBusy(null);
    }
  };

  // 버튼 상태표 — 진행 중에는 예비만 허용(공표는 서버도 422). 검수 완료면 공표 취소 가능.
  // 하단 표의 결과 소스 — [5] 와 동일 우선순위(새 예비 > 활성 공표 snapshot > 없음).
  const source: PreviewDto | PublishedDto | null = preview ?? published ?? null;

  const canPublish = weekEnded && (preview != null || published != null) && busy == null;
  const canUnpublish = published != null && busy == null;

  return (
    <div className="admin-section-stack-lg min-w-0" data-crew-week-publish>
      {/* [2]+[3][4] — 데스크톱에서 한 행 2열: 좌=진행 상태·기준 Po.A / 우=버튼 2행 1열. */}
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-3">
          <nav aria-label="검수 진행 상태" className="flex flex-wrap items-center gap-2" data-review-steps>
            {(
              [
                ["in_progress", "진행 중"],
                ["aggregating", "집계 중"],
                ["completed", "검수 완료"],
              ] as const
            ).map(([key, label], i) => {
              const active = displayStatus === key;
              return (
                <span key={key} className="flex items-center gap-2">
                  {i > 0 ? <span aria-hidden className="text-muted-foreground">···</span> : null}
                  <span
                    aria-current={active ? "step" : undefined}
                    data-step={key}
                    data-active={active ? "true" : "false"}
                    className={
                      "rounded-lg border-2 px-3 py-2 text-base font-bold sm:px-5 sm:py-3 sm:text-lg " +
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
          <div className="flex flex-wrap items-center gap-3 rounded-lg border-2 px-4 py-3 sm:inline-flex sm:px-5">
            <span className="text-sm font-semibold text-muted-foreground sm:text-base">
              주차 &lt;성장 성공&gt; 단감 기준
            </span>
            <strong className="text-3xl font-extrabold tabular-nums" data-criterion-point-a>
              {criterionPointA ?? "-"}
            </strong>
          </div>
        </div>

        {/* 버튼 2행 1열 · 동일 너비 · 크게 */}
        <div className="grid min-w-0 content-start gap-3">
          <Button
            type="button"
            onClick={onPreview}
            disabled={busy != null}
            data-action-preview
            className={`h-13 w-full py-3 text-base font-bold ${ORGANIZATION_ACCENT[organizationSlug].button}`}
          >
            {busy === "preview" ? "계산 중…" : "클럽 활동 검수(예비)"}
          </Button>
          {canUnpublish ? (
            <Button
              type="button"
              variant="destructive"
              onClick={onUnpublish}
              data-action-unpublish
              className="h-13 w-full py-3 text-base font-bold"
            >
              공표 취소
            </Button>
          ) : (
            <Button
              type="button"
              onClick={onPublish}
              disabled={!canPublish}
              data-action-publish
              title={weekEnded ? undefined : "진행 중인 주차는 공표할 수 없습니다."}
              className={`h-13 w-full py-3 text-base font-bold ${ORGANIZATION_ACCENT[organizationSlug].button}`}
            >
              {published ? "클럽 활동 검수(재공표)" : "클럽 활동 검수(공표)"}
            </Button>
          )}
          {preview ? (
            <Button
              type="button"
              variant="outline"
              onClick={onCancelPreview}
              data-action-preview-cancel
              className="w-full text-base font-semibold"
            >
              예비 검수 취소
            </Button>
          ) : null}
          {canUnpublish && (preview != null || published != null) && weekEnded ? (
            <Button
              type="button"
              variant="outline"
              onClick={onPublish}
              disabled={!canPublish}
              data-action-publish
              className="w-full text-base font-semibold"
            >
              재공표
            </Button>
          ) : null}
        </div>
      </div>

      {/* [5] 주차 종합 인덱스 — 항상 렌더한다(최초 진입 = 전부 "-").
          표시 우선순위: ① 새 예비 결과 → ② 활성 공표 snapshot → ③ 둘 다 없으면 "-".
          예비와 공표를 **절대 섞지 않는다** — 배지와 제목으로 출처를 명시한다. */}
      <section className="rounded-lg border p-4" data-summary-index>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <strong className="text-base">이번 주 크루 종합 결과</strong>
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
          ) : published ? (
            <>
              <StatusBadge label="검수 완료" size="sm" />
              <span data-summary-source="published" className="text-sm font-semibold">
                현재 공표 결과
              </span>
              <span className="text-xs text-muted-foreground">
                공표 시각 {new Date(published.publishedAt).toLocaleString("ko-KR")} · 결과 버전{" "}
                {published.calculationVersion} · run {published.runId.slice(0, 8)}
              </span>
            </>
          ) : (
            <span data-summary-source="none" className="text-xs text-muted-foreground">
              [클럽 활동 검수(예비)] 를 실행하면 결과가 표시됩니다.
            </span>
          )}
        </div>
        <SummaryIndex
          m={preview ?? published}
          readiness={(preview ?? published)?.metricsReadiness ?? null}
          org={organizationSlug}
          teams={(preview ?? published)?.teamResults ?? null}
        />
        {published && preview ? (
          <p className="mt-2 text-xs text-amber-800" data-summary-both>
            ⚠ 현재 공표 중인 결과와 새 예비 결과가 함께 존재합니다. 위 값은 <strong>새 예비 결과</strong>이며
            아직 공표되지 않았습니다. 공표 결과는 아래에서 확인하세요.
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
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  data-tab={key}
                  // 탭 전환은 표시만 바꾼다 — API 재호출·재계산 없음.
                  onClick={() => setTab(key)}
                  className={
                    "rounded-lg border-2 py-4 text-xl font-bold transition-colors " +
                    (selected
                      ? ORGANIZATION_ACCENT[organizationSlug].solid
                      : `${ORGANIZATION_COLUMN[organizationSlug].edge} ${ORGANIZATION_COLUMN[organizationSlug].cell} hover:brightness-95`)
                  }
                >
                  {label}
                </button>
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
                    : `공표 시각 ${new Date(published!.publishedAt).toLocaleString("ko-KR")} · run ${published!.runId.slice(0, 8)}`}
                </span>
              </div>
              {published?.snapshotUnavailable ? (
                <p className="py-8 text-center text-sm text-amber-800">
                  이 공표본은 snapshot 이전에 생성되어 상세 결과를 표시할 수 없습니다(legacy).
                </p>
              ) : tab === "crew" ? (
                <CrewTable rows={source.crewResults} hasResult />
              ) : (
                <TeamTable rows={source.teamResults} />
              )}
            </>
          ) : tab === "crew" && baseRows ? (
            <>
              <p className="mb-2 text-xs text-muted-foreground" data-details-base>
                기본 정보만 표시 중입니다. [클럽 활동 검수(예비)] 를 실행하면 결과 컬럼이 채워집니다.
              </p>
              <CrewTable rows={baseRows} hasResult={false} />
            </>
          ) : (
            <p className="py-10 text-center text-sm text-muted-foreground" data-details-empty>
              예비 검수를 실행하면 이 주차의 결과가 표시됩니다.
            </p>
          )}
        </div>
      </section>

      {!published && !preview ? (
        <p className="text-sm text-muted-foreground">
          [클럽 활동 검수(예비)] 를 눌러 현재 누적 데이터 기준 결과를 확인할 수 있습니다.
          {displayStatus === "in_progress"
            ? " 진행 중인 주차는 공표할 수 없습니다."
            : null}
        </p>
      ) : null}
    </div>
  );
}
