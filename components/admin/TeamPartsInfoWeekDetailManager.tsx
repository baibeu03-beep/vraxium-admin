"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import { readOrgParam } from "@/lib/adminOrgContext";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import type {
  TeamPartsInfoWeekDetailData,
  ExperienceLineType,
} from "@/lib/adminTeamPartsInfoWeekDetailData";

const EXP_TYPE_LABEL: Record<ExperienceLineType, string> = {
  derive: "도출",
  analysis: "분석",
  research: "견문",
  management: "관리",
  expansion: "확장",
};
const EXP_TYPES: ExperienceLineType[] = [
  "derive",
  "analysis",
  "research",
  "management",
  "expansion",
];

type InfoChecked = Record<string, boolean>;
type ExpChecked = Record<string, Record<ExperienceLineType, boolean>>;

function statusBadge(status: "official_activity" | "official_rest" | null) {
  if (!status) return null;
  const isRest = status === "official_rest";
  return (
    <span
      className={
        "rounded-md px-3 py-1 text-sm font-bold " +
        (isRest ? "bg-zinc-200 text-zinc-700" : "bg-fuchsia-200 text-fuchsia-900")
      }
    >
      {isRest ? "공식 휴식" : "공식 활동"}
    </span>
  );
}

function CheckV() {
  return (
    <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-emerald-600 text-xs font-bold text-white">
      V
    </span>
  );
}

export default function TeamPartsInfoWeekDetailManager({
  weekId,
}: {
  weekId: string;
}) {
  const searchParams = useSearchParams();
  const mode = readScopeMode(searchParams);
  const clubParam = searchParams.get("club");
  const club: OrganizationSlug | null = isOrganizationSlug(clubParam)
    ? clubParam
    : isOrganizationSlug(readOrgParam(searchParams))
      ? (readOrgParam(searchParams) as OrganizationSlug)
      : null;

  const [data, setData] = useState<TeamPartsInfoWeekDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useReportLoading(loading);

  // 편집 가능한 체크 상태(로드 시 DTO 로 초기화).
  const [infoChecked, setInfoChecked] = useState<InfoChecked>({});
  const [expChecked, setExpChecked] = useState<ExpChecked>({});
  const [compChecked, setCompChecked] = useState(true);

  const [reviewed, setReviewed] = useState(false);
  const [openConfirmed, setOpenConfirmed] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [banner, setBanner] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const [activeTab, setActiveTab] = useState<"act" | "line">("act");

  const listHref = appendModeQuery(
    club ? `/admin/team-parts/info/weeks?org=${club}` : "/admin/team-parts/info/weeks",
    mode,
  );

  // 마운트/파라미터 변경 시 외부(API)와 동기화 — DTO 로 편집 상태를 초기화한다.
  useEffect(() => {
    if (!club) {
      // club 없이 진입한 경우 — 안내만 표시(외부 동기화 effect 의 정상 경로).
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setError("club 파라미터가 필요합니다. (주차 내역에서 진입해 주세요.)");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const params = new URLSearchParams({ club });
        if (mode === "test") params.set("mode", "test");
        const res = await fetch(
          `/api/admin/team-parts/info/weeks/${weekId}?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json?.error ?? `조회 실패 (${res.status})`);
        if (cancelled) return;
        const dto = json.data as TeamPartsInfoWeekDetailData;
        setData(dto);
        setInfoChecked(
          Object.fromEntries(dto.openingConfig.practicalInfo.map((l) => [l.lineId, l.checked])),
        );
        setExpChecked(
          Object.fromEntries(
            dto.openingConfig.practicalExperience.map((t) => [
              t.teamId,
              Object.fromEntries(t.lines.map((l) => [l.type, l.checked])) as Record<
                ExperienceLineType,
                boolean
              >,
            ]),
          ),
        );
        setCompChecked(dto.openingConfig.practicalCompetency.checked);
        setReviewed(dto.managedWeek.reviewed);
        setOpenConfirmed(dto.managedWeek.openConfirmed);
      } catch (e) {
        if (cancelled) return;
        setData(null);
        setError(e instanceof Error ? e.message : "조회 실패");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [club, mode, weekId]);

  const buildConfig = () => ({
    practicalInfo: infoChecked,
    practicalExperience: expChecked,
    practicalCompetency: { checked: compChecked },
  });

  const onOpenConfirm = async () => {
    if (!club) return;
    setConfirming(true);
    setBanner(null);
    try {
      const res = await fetch(
        appendModeQuery(`/api/admin/team-parts/info/weeks/${weekId}/open-confirm?club=${club}`, mode),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config: buildConfig() }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json?.error ?? `저장 실패 (${res.status})`);
      setOpenConfirmed(true);
      setBanner({ kind: "success", message: "오픈 설정이 저장되었습니다." });
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : "오픈 확인 실패" });
    } finally {
      setConfirming(false);
    }
  };

  const onReview = async () => {
    if (!club) return;
    setReviewing(true);
    setBanner(null);
    try {
      const res = await fetch(
        appendModeQuery(`/api/admin/team-parts/info/weeks/${weekId}/review?club=${club}`, mode),
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json?.error ?? `검수 실패 (${res.status})`);
      setReviewed(true);
      setBanner({ kind: "success", message: "주차 검수가 완료되었습니다." });
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : "주차 검수 실패" });
    } finally {
      setReviewing(false);
    }
  };

  const toggleInfo = (lineId: string) =>
    setInfoChecked((p) => ({ ...p, [lineId]: !p[lineId] }));
  const toggleExp = (teamId: string, type: ExperienceLineType) =>
    setExpChecked((p) => ({
      ...p,
      [teamId]: { ...p[teamId], [type]: !p[teamId]?.[type] },
    }));

  const currentWeek = data?.currentWeek ?? null;
  const managedWeek = data?.managedWeek ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>활동 관리</CardTitle>
        <Link
          href={listHref}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          ← 주차 내역
        </Link>
      </CardHeader>
      <CardContent className="space-y-5">
        {banner ? (
          <div
            className={
              "rounded-md px-3 py-2 text-sm " +
              (banner.kind === "success" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700")
            }
          >
            {banner.message}
          </div>
        ) : null}

        {error ? (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        ) : loading ? (
          <LoadingState active />
        ) : data ? (
          <>
            {/* [1] 현재 주차 배너 */}
            <section
              data-current-week
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-dashed border-red-300 px-4 py-3 text-sm"
            >
              <span>
                오늘은, <strong className="text-base">{currentWeek?.todayLabel ?? "-"}</strong>
              </span>
              <span className="rounded bg-sky-50 px-2 py-0.5 font-semibold text-sky-800">
                {currentWeek?.seasonWeekName ?? "-"}
                {currentWeek?.seasonWeekName ? "입니다." : null}
              </span>
              <span className="text-muted-foreground">{currentWeek?.weekRangeLabel ?? "-"}</span>
              <span className="ml-auto">{statusBadge(currentWeek?.activityStatus ?? null)}</span>
            </section>

            {/* [2] 관리 주차 카드 + [3] 주차 검수 */}
            <section
              data-managed-week
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-sky-50/60 px-4 py-3 text-sm"
            >
              <span className="font-semibold">▷ 관리 주차</span>
              <span
                data-managed-week-name
                className="rounded-md bg-fuchsia-100 px-3 py-1 font-bold text-fuchsia-900"
              >
                {managedWeek?.weekName}
              </span>
              <span className="text-muted-foreground">{managedWeek?.weekRangeLabel}</span>
              {statusBadge(managedWeek?.activityStatus ?? null)}
              <div className="ml-auto flex items-center gap-2">
                <Button
                  type="button"
                  data-review-button
                  onClick={onReview}
                  disabled={reviewing || reviewed}
                  className="bg-slate-800 text-white hover:bg-slate-700"
                >
                  {reviewed ? "검수 완료" : reviewing ? "검수 중…" : "주차 검수"}
                </Button>
                {reviewed ? <span data-reviewed="true"><CheckV /></span> : null}
              </div>
            </section>

            {/* [4] 허브/라인 오픈 설정 + [9] 오픈 확인 */}
            <section className="space-y-3 rounded-lg border border-dashed border-red-300 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="rounded bg-cyan-100 px-1 text-lg font-bold"># 이번 주 클럽에서 활동하는 허브와 라인</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    * 여기서 체크된 허브 &amp; 라인 들이, 아래 액트 체크와 라인 개설 여부에 반영됩니다.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    data-open-confirm-button
                    onClick={onOpenConfirm}
                    disabled={confirming}
                    className="bg-slate-800 text-white hover:bg-slate-700"
                  >
                    {confirming ? "저장 중…" : "오픈 확인"}
                  </Button>
                  {openConfirmed ? <span data-open-confirmed="true"><CheckV /></span> : null}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(220px,1fr)_minmax(320px,1.4fr)_minmax(160px,0.7fr)_minmax(180px,0.8fr)]">
                {/* [5] 실무 정보 */}
                <div data-hub="info" className="rounded-md border border-sky-200 bg-sky-50/50 p-3">
                  <p className="mb-2 font-bold">[실무 정보]</p>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                    {data.openingConfig.practicalInfo.map((l) => (
                      <label key={l.lineId} className="flex items-center gap-2 text-sm" data-info-line={l.lineId}>
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={infoChecked[l.lineId] ?? false}
                          onChange={() => toggleInfo(l.lineId)}
                        />
                        <span className="truncate">{l.lineName}</span>
                      </label>
                    ))}
                    {data.openingConfig.practicalInfo.length === 0 ? (
                      <span className="text-xs text-muted-foreground">라인 없음</span>
                    ) : null}
                  </div>
                </div>

                {/* [6] 실무 경험 */}
                <div data-hub="experience" className="overflow-x-auto rounded-md border border-sky-200 bg-sky-50/50 p-3">
                  <p className="mb-2 font-bold">[실무 경험]</p>
                  {data.openingConfig.practicalExperience.length === 0 ? (
                    <span className="text-xs text-muted-foreground">팀 없음</span>
                  ) : (
                    <table className="text-sm">
                      <thead>
                        <tr className="text-xs text-muted-foreground">
                          <th className="px-2 py-1 text-left">팀</th>
                          {EXP_TYPES.map((t) => (
                            <th key={t} className="px-2 py-1 text-center font-medium">
                              {EXP_TYPE_LABEL[t]}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.openingConfig.practicalExperience.map((team) => (
                          <tr key={team.teamId} data-exp-team={team.teamId}>
                            <td className="whitespace-nowrap px-2 py-1 font-medium">{team.teamName}</td>
                            {EXP_TYPES.map((type) => (
                              <td key={type} className="px-2 py-1 text-center">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4"
                                  data-exp-cell={`${team.teamId}:${type}`}
                                  checked={expChecked[team.teamId]?.[type] ?? false}
                                  onChange={() => toggleExp(team.teamId, type)}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* [7] 실무 역량 */}
                <div data-hub="competency" className="rounded-md border border-sky-200 bg-sky-50/50 p-3">
                  <p className="mb-2 font-bold">[실무 역량]</p>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      data-competency-checkbox
                      checked={compChecked}
                      onChange={() => setCompChecked((v) => !v)}
                    />
                    <span>정상 진행</span>
                  </label>
                </div>

                {/* [8] 실무 경력 */}
                <div data-hub="career" className="rounded-md border border-sky-200 bg-sky-50/50 p-3">
                  <p className="mb-2 font-bold">[실무 경력]</p>
                  <p className="text-xs text-muted-foreground">
                    [실무 경력] 산하 라인들은 별도 페이지에서 관리합니다.
                  </p>
                </div>
              </div>
            </section>

            {/* [10] 하단 탭 — 버튼만(컨텐츠 placeholder) */}
            <section className="space-y-0">
              <div className="grid grid-cols-2 overflow-hidden rounded-t-md border border-b-0">
                {(["act", "line"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    data-tab={tab}
                    onClick={() => setActiveTab(tab)}
                    className={
                      "px-4 py-2 text-sm font-bold transition-colors " +
                      (activeTab === tab
                        ? "bg-emerald-500 text-white"
                        : "bg-emerald-50 text-emerald-800 hover:bg-emerald-100")
                    }
                  >
                    {tab === "act" ? "액트 체크 관리" : "라인 개설 관리"}
                  </button>
                ))}
              </div>
              <div
                data-tab-content
                className="min-h-[120px] rounded-b-md border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground"
              >
                {activeTab === "act" ? "액트 체크 관리" : "라인 개설 관리"} 영역은 추후 구현 예정입니다.
              </div>
            </section>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
