"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { readOrgParam } from "@/lib/adminOrgContext";
import { formatBannerPeriod } from "@/lib/practicalInfoSection0Format";
import {
  formatTeamLeader,
  type ExperienceLineManageSummary,
  type LineManageCategoryStat,
  type LineManageTeam,
} from "@/lib/experienceLineManageTypes";

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
        tone === "default" && "border-gray-200 bg-gray-50 text-gray-800",
      )}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="font-bold">{value}</span>
    </span>
  );
}

function TeamStatusBadge({ opened }: { opened: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-semibold",
        opened
          ? "bg-emerald-100 text-emerald-800"
          : "bg-amber-100 text-amber-800",
      )}
    >
      {opened ? "개설 완료" : "개설 필요"}
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
      <p className="font-semibold">전체 {h.total}명</p>
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

function TeamCard({ team }: { team: LineManageTeam }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        {/* 첫 줄: 팀명 + 개설 상태 + 파트 칸(이어서). 공간 부족 시 파트 칸만 wrap. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex shrink-0 items-center gap-2">
            <CardTitle className="text-base">{team.teamName}</CardTitle>
            <TeamStatusBadge opened={team.opened} />
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

  const [data, setData] = useState<ExperienceLineManageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 주차 드롭다운 — 옵션(weeks-options) + 선택 주차. 기본값 = openable(개설 대상) 주차.
  const [weekOptions, setWeekOptions] = useState<WeekOption[]>([]);
  const [selectedWeekId, setSelectedWeekId] = useState<string>("");
  // 옵션 로드 시도 완료 신호 — 기본 주차 확정 후에만 보드를 조회(중복 fetch 방지).
  const [weeksReady, setWeeksReady] = useState(false);

  // 주차 옵션 부트스트랩(실무 정보 라인 관리와 동일 — weeks-options?limit=3).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/cluster4/weeks-options?limit=3");
        const json = await res.json();
        if (cancelled) return;
        const opts: WeekOption[] = json?.success ? json.data?.weeks ?? [] : [];
        setWeekOptions(opts);
        // 기본 선택 = openable(개설 대상) → 현재 → 첫 옵션.
        const def =
          opts.find((o) => o.isOpenTarget) ??
          opts.find((o) => o.isCurrent) ??
          opts[0];
        setSelectedWeekId((prev) => prev || (def?.id ?? ""));
      } catch {
        /* 옵션 조회 실패 — week_id 없이 openable 기본 경로로 폴백. */
      } finally {
        if (!cancelled) setWeeksReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 보드 조회 — org + (옵션 준비 완료) 일 때. 선택 주차가 있으면 week_id 로 해당 주차 집계.
  useEffect(() => {
    if (!org) {
      setLoading(false);
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
        if (selectedWeekId) qs.set("week_id", selectedWeekId);
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
  }, [org, selectedWeekId, weeksReady, refreshKey]);

  if (!org) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-sm text-muted-foreground">
            조직 분기 모드(?org)에서만 표시됩니다.
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
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 불러오는 중…
            </p>
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
          {/* 주차/요약 행 — 왼쪽: 선택 주차 드롭다운 / 오른쪽: 팀 수·개설 완료·개설 필요. */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
            {weekOptions.length > 0 ? (
              <select
                className="rounded-md border border-input bg-background px-3 py-2 text-base font-semibold"
                value={selectedWeekId}
                onChange={(e) => setSelectedWeekId(e.target.value)}
                aria-label="주차 선택"
              >
                {weekOptions.map((w) => (
                  <option key={w.id} value={w.id}>
                    {formatBannerPeriod({
                      year: w.year,
                      seasonName: w.seasonName,
                      weekNumber: w.weekNumber,
                    })}
                    {w.isOpenTarget ? " · 개설대상" : ""}
                    {!w.canOpen ? " · 휴식" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-base font-semibold">
                {weekLabel ?? "주차 정보 없음"}
              </span>
            )}
            <div className="flex flex-wrap gap-2">
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
            </div>
          </div>

          {/* 팀별 카드. */}
          {data.teams.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              이 조직에 등록된 팀이 없습니다.
            </p>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {data.teams.map((team) => (
                <TeamCard key={team.teamId} team={team} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// 주차 드롭다운 옵션 — weeks-options 응답(실무 정보 라인 관리 드롭다운과 동일 기준/SoT).
type WeekOption = {
  id: string;
  year: number;
  seasonName: string;
  weekNumber: number;
  canOpen: boolean;
  isCurrent: boolean;
  isOpenTarget: boolean;
};
