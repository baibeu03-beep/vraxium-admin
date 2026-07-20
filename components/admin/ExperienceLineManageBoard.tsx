"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { readOrgParam } from "@/lib/adminOrgContext";
import { readScopeMode } from "@/lib/userScopeShared";
import { formatBannerPeriod, formatSeasonWeekLabel } from "@/lib/practicalInfoSection0Format";
import { formatClubDate, formatClubDateRange } from "@/lib/clubDate";
import LineOpeningCurrentSituationCard, {
  CurrentSituationWeekValue,
  type CurrentSituationItem,
} from "@/components/admin/LineOpeningCurrentSituationCard";
import { useLineManageWeekOptions } from "@/lib/lineManageWeekOptions";
import {
  formatTeamLeader,
  type ExperienceLineManageSummary,
  type LineManageCategoryStat,
  type LineManageTeam,
} from "@/lib/experienceLineManageTypes";

function weekPeriod(week: ExperienceLineManageSummary["targetWeek"]) {
  if (!week) return "-";
  return (
    <CurrentSituationWeekValue
      label={formatBannerPeriod(week)}
      range={formatClubDateRange(week.startDate, week.endDate, {
          separator: " ~ ",
      })}
    />
  );
}

function CurrentSituationCard({ data }: { data: ExperienceLineManageSummary }) {
  const items: CurrentSituationItem[] = [
    {
      label: "오늘 날짜",
      helpKey: "admin.lineOpening.currentSituation.info.today",
      value: formatClubDate(data.currentSituation.serverToday),
    },
    {
      label: "개설 필요 기간",
      helpKey: "admin.lineOpening.currentSituation.info.needPeriod",
      value: weekPeriod(data.currentSituation.openingRequiredWeek),
    },
    {
      label: "개설 이행 기간",
      helpKey: "admin.lineOpening.currentSituation.info.fulfilPeriod",
      value: weekPeriod(data.currentSituation.openingFulfilmentWeek),
    },
  ];

  return <LineOpeningCurrentSituationCard items={items} />;
}

const TEAM_ACCENTS = [
  {
    border: "border-l-red-500 dark:border-l-red-400",
    header: "bg-red-50/70 dark:bg-red-950/25",
    dot: "bg-red-500 dark:bg-red-400",
  },
  {
    border: "border-l-amber-500 dark:border-l-amber-400",
    header: "bg-amber-50/70 dark:bg-amber-950/25",
    dot: "bg-amber-500 dark:bg-amber-400",
  },
  {
    border: "border-l-emerald-500 dark:border-l-emerald-400",
    header: "bg-emerald-50/70 dark:bg-emerald-950/25",
    dot: "bg-emerald-500 dark:bg-emerald-400",
  },
  {
    border: "border-l-blue-500 dark:border-l-blue-400",
    header: "bg-blue-50/70 dark:bg-blue-950/25",
    dot: "bg-blue-500 dark:bg-blue-400",
  },
  {
    border: "border-l-orange-500 dark:border-l-orange-400",
    header: "bg-orange-50/70 dark:bg-orange-950/25",
    dot: "bg-orange-500 dark:bg-orange-400",
  },
  {
    border: "border-l-purple-500 dark:border-l-purple-400",
    header: "bg-purple-50/70 dark:bg-purple-950/25",
    dot: "bg-purple-500 dark:bg-purple-400",
  },
] as const;

// 실무 경험 [라인 관리] 탭 — 카드형 팀 요약 보드(표시 전용).
//   상단: 주차 드롭다운(weeks-options·practical-info 동일 SoT) + 팀 수/개설 완료/개설 필요 요약.
//   팀 카드: 팀명 + 개설 상태 + 파트 칸(한 행) · 팀 인원 요약 · 라인별 강화 결과(문장형) · 확장 게이트.
//   snapshot/DTO 무관 — read-only. API 변경 없이 line-manage 응답을 재사용한다(week_id optional).

// 주차/요약 행의 카운트 badge(팀 수/개설 완료/개설 필요).
function CountBadge({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "success" | "warning";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-sm",
        tone === "success" && "border-green-200 bg-green-50 text-green-800",
        tone === "warning" && "border-amber-200 bg-amber-50 text-amber-800",
        tone === "default" && "border-border bg-muted text-foreground",
      )}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="font-bold">{value}</span>
    </span>
  );
}

// 개설 상태 이중 배지 — [개설 필요]·[개설 완료] 두 상태를 항상 동시에 노출하고, 현재 상태만
//   완전히 대비되는 색(활성)으로, 나머지는 회색(비활성)으로 표시한다(한눈에 현재 단계 인지).
//   "개설 기간 아님"은 개설되지 않은 상태(개설 필요)와 구분해 두 배지 모두 비활성 + 별도 중립 배지.
const STATUS_BADGE_BASE =
  "inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold border";
const STATUS_BADGE_INACTIVE =
  "border-transparent bg-muted text-muted-foreground/70";
function TeamStatusBadge({
  statusLabel,
}: {
  statusLabel: "개설 완료" | "개설 필요" | "개설 기간 아님";
}) {
  const needed = statusLabel === "개설 필요";
  const opened = statusLabel === "개설 완료";
  const notOpen = statusLabel === "개설 기간 아님";
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1"
      role="status"
      aria-label={`개설 상태: ${statusLabel}`}
    >
      {/* 활성 = 완전 대비색(솔리드), 비활성 = 회색. 색상 무의존 위해 현재 상태에 aria-label 병기. */}
      <span
        className={cn(
          STATUS_BADGE_BASE,
          needed
            ? "border-amber-500 bg-amber-500 text-white"
            : STATUS_BADGE_INACTIVE,
        )}
        aria-current={needed ? "true" : undefined}
      >
        개설 필요
      </span>
      <span
        className={cn(
          STATUS_BADGE_BASE,
          opened
            ? "border-emerald-600 bg-emerald-600 text-white"
            : STATUS_BADGE_INACTIVE,
        )}
        aria-current={opened ? "true" : undefined}
      >
        개설 완료
      </span>
      {notOpen && (
        <span
          className={cn(STATUS_BADGE_BASE, "border-dashed border-border bg-muted/40 text-muted-foreground")}
        >
          개설 기간 아님
        </span>
      )}
    </span>
  );
}

// 라인(카테고리)별 강화 결과 1줄(문장형).
//   <도출> : 전체 26명 중 강화 성공: 23 | 미이행: 1 | 평점 미비: 2
//   <확장> : 해당 기간 아님
function CategoryLine({ stat }: { stat: LineManageCategoryStat }) {
  return (
    <p className="text-sm">
      <span className="font-semibold">&lt;{stat.label}&gt;</span>
      <span className="text-muted-foreground"> : </span>
      {stat.applicable ? (
        <>
          전체 <span className="font-medium">{stat.total}명</span> 중 강화 성공:{" "}
          <span className="font-semibold text-green-700">{stat.success}</span>
          <span className="text-muted-foreground"> | </span>
          미이행:{" "}
          <span
            className={cn(
              "font-semibold",
              stat.unchecked > 0 ? "text-red-600" : "text-muted-foreground",
            )}
          >
            {stat.unchecked}
          </span>
          <span className="text-muted-foreground"> | </span>
          평점 미비:{" "}
          <span
            className={cn(
              "font-semibold",
              stat.lowScore > 0 ? "text-orange-600" : "text-muted-foreground",
            )}
          >
            {stat.lowScore}
          </span>
        </>
      ) : (
        <span className="text-muted-foreground">해당 기간 아님</span>
      )}
    </p>
  );
}

// 팀 인원 요약(라인별 결과 위) — 전체 / 활동·휴식·중단 / 일반·파트장·에이전트.
function HeadcountSummary({ team }: { team: LineManageTeam }) {
  const h = team.headcount;
  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <p className="inline-flex items-center gap-1 font-semibold">
        전체 {h.total}명
        <AdminHelpIconButton
          helpKey="admin.experience.lineBoard.metric.teamHeadcount"
          title="팀 인원 요약"
        />
      </p>
      <p className="text-muted-foreground">
        =) 활동 <span className="font-medium text-foreground">{h.active}</span> | 휴식{" "}
        <span className="font-medium text-foreground">{h.rest}</span> | 중단{" "}
        <span className="font-medium text-foreground">{h.suspended}</span>
      </p>
      <p className="text-muted-foreground">
        =) 일반 <span className="font-medium text-foreground">{h.normal}</span> | 파트장{" "}
        <span className="font-medium text-foreground">{h.partLeader}</span> | 에이전트{" "}
        <span className="font-medium text-foreground">{h.agent}</span>
      </p>
    </div>
  );
}

function TeamCard({
  team,
  accentIndex,
}: {
  team: LineManageTeam;
  accentIndex: number;
}) {
  const accent = TEAM_ACCENTS[accentIndex % TEAM_ACCENTS.length];
  return (
    <Card className={cn("overflow-hidden border-l-4", accent.border)}>
      <CardHeader className={cn("pb-3", accent.header)}>
        {/* 첫 줄: 팀명 + 개설 상태 + 파트 칸(이어서). 공간 부족 시 파트 칸만 wrap. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex shrink-0 items-center gap-2">
            {/* ① 팀명 뒤 '팀' 접미 — 이 항목이 '팀'임을 즉시 인지(예: "비주얼랩(T) 팀"). */}
            <span
              className={cn("size-2.5 shrink-0 rounded-full", accent.dot)}
              aria-hidden="true"
            />
            <CardTitle className="text-base">{team.teamName} 팀</CardTitle>
            <TeamStatusBadge statusLabel={team.statusLabel} />
            <AdminHelpIconButton
              helpKey="admin.experience.lineBoard.badge.openStatus"
              title="개설 상태 배지"
            />
          </div>
          {/* 파트별 신청 상태(색 칸 = 신청 완료 / 흰 칸 = 미신청). */}
          {team.parts.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              평가 대상 파트 없음
            </span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {team.parts.map((p) => (
                <span
                  key={p.partName}
                  className={cn(
                    "inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium",
                    p.submitted
                      ? "border-sky-300 bg-sky-100 text-sky-800"
                      : "border-input bg-background text-muted-foreground",
                  )}
                  title={p.submitted ? "개설 신청 완료" : "개설 신청 전"}
                >
                  {p.partName}
                </span>
              ))}
            </div>
          )}
          {/* 팀장 이름 + 학적 — 우측 정렬(ml-auto). 공간 부족 시 두 번째 줄로 wrap. */}
          <span className="ml-auto text-right text-xs text-muted-foreground">
            {formatTeamLeader(team.teamLeader)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* 팀 인원 요약(라인별 결과 위). */}
        <HeadcountSummary team={team} />
        {/* 라인별 강화 결과(문장형). */}
        <div className="space-y-1.5">
          {team.categories.map((stat) => (
            <CategoryLine key={stat.category} stat={stat} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function ExperienceLineManageBoard({
  refreshKey,
}: {
  // 값이 바뀌면 재조회(개설 완료/취소·신청/취소 직후 요약 갱신).
  refreshKey?: number;
}) {
  const searchParams = useSearchParams();
  const org = readOrgParam(searchParams);
  // 모집단 모드(operating 기본 / ?mode=test). 운영 화면은 mode 미부착이라 기존 동작 불변.
  const mode = readScopeMode(searchParams);

  const [data, setData] = useState<ExperienceLineManageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);

  // 주차 드롭다운 — 실무 정보 라인 관리와 동일 SoT(season-weeks 전 주차). 공용 hook 사용.
  //   "라인 관리"는 조회/관리용이므로 최근 N주로 제한하지 않는다(개설 정책은 별개·불변).
  const { options: weekOptions, defaultWeekId, ready: weeksReady } =
    useLineManageWeekOptions();
  const [selectedWeekId, setSelectedWeekId] = useState<string>("");
  // 기본 선택은 별도 effect로 복사하지 않고 공용 hook 값을 직접 사용한다.
  const effectiveWeekId = selectedWeekId || defaultWeekId || "";

  // 보드 조회 — org + (옵션 준비 완료) 일 때. 선택 주차가 있으면 week_id 로 해당 주차 집계.
  useEffect(() => {
    if (!org) {
      return;
    }
    if (!weeksReady) return;
    let cancelled = false;
    // setState 는 async 콜백 안에서만 호출(동기 cascading 렌더 방지) — 다른 상태창과 동일 패턴.
    void (async () => {
      if (!cancelled) {
        setLoading(true);
        setError(null);
      }
      try {
        const qs = new URLSearchParams({ organization: org });
        if (effectiveWeekId) qs.set("week_id", effectiveWeekId);
        if (mode === "test") qs.set("mode", "test");
        const res = await fetch(
          `/api/admin/cluster4/experience/line-manage?${qs.toString()}`,
        );
        const json = await res.json();
        if (cancelled) return;
        if (json?.success) setData(json.data as ExperienceLineManageSummary);
        else setError(json?.error ?? "라인 관리 요약을 불러오지 못했습니다");
      } catch {
        if (!cancelled) setError("라인 관리 요약을 불러오지 못했습니다");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org, mode, effectiveWeekId, weeksReady, refreshKey]);

  if (!org) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-sm text-muted-foreground">
            클럽 분기 모드(?org)에서만 표시됩니다.
          </p>
        </CardContent>
      </Card>
    );
  }

  const weekLabel = data?.targetWeek
    ? formatBannerPeriod({
        year: data.targetWeek.year,
        seasonName: data.targetWeek.seasonName,
        weekNumber: data.targetWeek.weekNumber,
      })
    : null;
  return (
    <div className="space-y-4">
      {loading ? (
        <Card>
          <CardContent className="py-6">
            <LoadingState active variant="inline" />
          </CardContent>
        </Card>
      ) : error ? (
        <Card>
          <CardContent className="py-6">
            <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
              {error}
            </p>
          </CardContent>
        </Card>
      ) : !data ? null : (
        <>
          {/* 상단 현재 상황과 아래 주차 선택/요약 사이만 기존보다 한 단계 더 띄운다. */}
          <div className="pb-4">
            <CurrentSituationCard data={data} />
          </div>

          {/* 주차/요약 행 — 왼쪽: 선택 주차 드롭다운 / 오른쪽: 팀 수·개설 완료·개설 필요. */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
            <div className="flex items-center gap-2">
              {weekOptions.length > 0 ? (
                <select
                  className="rounded-md border border-input bg-background px-3 py-2 text-base font-semibold"
                  value={effectiveWeekId}
                  onChange={(e) => setSelectedWeekId(e.target.value)}
                  aria-label="주차 선택"
                >
                  {weekOptions.map((w) => (
                    <option key={w.id} value={w.id}>
                      {formatSeasonWeekLabel({
                        year: w.year,
                        seasonName: w.seasonName,
                        weekNumber: w.weekNumber,
                        isOpenTarget: w.isOpenTarget,
                        isRest: !w.canOpen,
                      })}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-base font-semibold">
                  {weekLabel ?? "주차 정보 없음"}
                </span>
              )}
              <AdminHelpIconButton
                helpKey="admin.lineOpening.experience.filter.week"
                title="주차 선택"
                size="xs"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <CountBadge label="팀 수" value={data.totals.teamCount} />
              <CountBadge
                label="개설 완료"
                value={data.totals.openedCount}
                tone="success"
              />
              <CountBadge
                label="개설 필요"
                value={data.totals.neededCount}
                tone="warning"
              />
              {data.totals.notOpenCount > 0 && (
                <CountBadge
                  label="개설 기간 아님"
                  value={data.totals.notOpenCount}
                />
              )}
              <AdminHelpIconButton
                helpKey="admin.experience.lineBoard.metric.openSummary"
                title="라인 개설 요약"
              />
            </div>
          </div>

          {/* 팀별 카드. */}
          {data.teams.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              이 클럽에 등록된 팀이 없습니다.
            </p>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {data.teams.map((team, index) => (
                <TeamCard
                  key={team.teamId}
                  team={team}
                  accentIndex={index}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
