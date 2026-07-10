"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import AdminHelp from "@/components/admin/AdminHelp";
import { LoadingState } from "@/components/ui/loading-state";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import { readOrgParam } from "@/lib/adminOrgContext";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
import type {
  TeamPartsInfoWeeksData,
  TeamPartsInfoWeekItem,
  WeeksSort,
  WeeksSortKey,
} from "@/lib/adminTeamPartsInfoWeeksData";

const PAGE_SIZE = 20;

// 통합 + 3개 클럽 탭. 통합은 기획 미정 → 준비 중 안내.
type TabKey = "integrated" | OrganizationSlug;

const TAB_LABEL: Record<TabKey, string> = {
  integrated: "통합",
  encre: "엥크레",
  oranke: "오랑캐",
  phalanx: "팔랑크스",
};

// 활성 탭 색상(팀 내역 화면 CHIP_CLS 미러 + 통합 다크).
const TAB_ACTIVE_CLS: Record<TabKey, string> = {
  integrated: "bg-zinc-800 text-white border-zinc-900",
  encre: "bg-red-500 text-white border-red-600",
  oranke: "bg-yellow-300 text-zinc-900 border-yellow-400",
  phalanx: "bg-green-500 text-white border-green-600",
};

const TABS: TabKey[] = ["integrated", ...ORGANIZATIONS];

function statusBadge(status: TeamPartsInfoWeekItem["clubActivityStatus"]) {
  const isRest = status === "official_rest";
  return (
    <span
      className={
        "rounded-md px-2 py-0.5 text-xs font-medium " +
        (isRest
          ? "bg-zinc-100 text-zinc-500"
          : "bg-emerald-50 text-emerald-700")
      }
    >
      {isRest ? "공식 휴식" : "공식 활동"}
    </span>
  );
}

// 정렬 상태 아이콘 — 기본(중립) / 오름 / 내림.
function SortIcon({ dir }: { dir: "asc" | "desc" | null }) {
  if (dir === "asc") return <ChevronUp className="size-3.5" aria-hidden />;
  if (dir === "desc") return <ChevronDown className="size-3.5" aria-hidden />;
  return <ChevronsUpDown className="size-3.5 opacity-40" aria-hidden />;
}

type ColAlign = "left" | "center" | "right";

// 테이블 헤더 셀 — sortKey 있으면 3단계 정렬 버튼(오름→내림→기본), 없으면 라벨만.
//   정렬 버튼과 돋보기 도움말 버튼은 "형제"로 분리 → 도움말 클릭이 정렬을 실행하지 않는다.
function WeekTh({
  label,
  helpKey,
  align,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  helpKey: string;
  align: ColAlign;
  sortKey?: WeeksSortKey;
  sort: WeeksSort | null;
  onSort: (key: WeeksSortKey) => void;
}) {
  const justify =
    align === "left" ? "justify-start" : align === "right" ? "justify-end" : "justify-center";
  const textAlign =
    align === "left" ? "text-left" : align === "right" ? "text-right" : "text-center";
  const active = sortKey != null && sort?.key === sortKey;
  const ariaSort: "none" | "ascending" | "descending" = active
    ? sort!.dir === "asc"
      ? "ascending"
      : "descending"
    : "none";
  return (
    <th
      aria-sort={sortKey ? ariaSort : undefined}
      className={"border-b px-3 py-2 font-semibold whitespace-nowrap " + textAlign}
    >
      <span className={"inline-flex items-center gap-1 " + justify}>
        {sortKey ? (
          <button
            type="button"
            onClick={() => onSort(sortKey)}
            aria-label={`${label} 기준 정렬`}
            className="inline-flex items-center gap-1 rounded outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-sky-500/50"
          >
            <span className={active ? "font-bold text-foreground" : undefined}>{label}</span>
            <SortIcon dir={active ? sort!.dir : null} />
          </button>
        ) : (
          <span>{label}</span>
        )}
        <AdminHelpIconButton helpKey={helpKey} title={label} />
      </span>
    </th>
  );
}

export default function TeamPartsInfoWeeksManager({
  scoped = false,
  detailBasePath = "/admin/team-parts/info/weeks",
}: {
  // scoped=true(클럽 진행 · 개별 조직 운영진): URL ?org 로 조직 1개에 고정하고
  //   통합 탭을 숨긴다(조회 전용). 통합 어드민(/admin/team-parts/info/weeks)은 scoped=false
  //   기본값으로 기존 동작이 그대로 유지된다.
  // detailBasePath: [활동 관리] 이동 및 상세 back-link 의 기준 경로.
  scoped?: boolean;
  detailBasePath?: string;
} = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const mode = readScopeMode(searchParams);
  // scoped 모드에서는 URL ?org 로 조직을 고정한다. 미지정/무효면 안내만 표시.
  const scopedOrg = scoped ? readOrgParam(searchParams) : null;
  const scopedMissing = scoped && !scopedOrg;

  const [activeTab, setActiveTab] = useState<TabKey>("encre");
  const [page, setPage] = useState(1);
  // 서버사이드 정렬 상태(전체 목록 기준). null = 기본순(최신 주차 최상단).
  const [sort, setSort] = useState<WeeksSort | null>(null);
  const [data, setData] = useState<TeamPartsInfoWeeksData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useReportLoading(loading);

  // scoped 모드면 URL org 로 고정, 아니면 탭 상태를 사용한다.
  const effectiveTab: TabKey = scoped ? (scopedOrg ?? "encre") : activeTab;
  const isIntegrated = effectiveTab === "integrated";

  const load = useCallback(
    async (club: OrganizationSlug, pageNum: number, sortState: WeeksSort | null) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          club,
          page: String(pageNum),
          pageSize: String(PAGE_SIZE),
        });
        if (mode === "test") params.set("mode", "test");
        // 서버사이드 정렬 — semantic 키/방향만 전달(DB 컬럼명 아님). null=기본순.
        if (sortState) {
          params.set("sort", sortState.key);
          params.set("dir", sortState.dir);
        }
        const res = await fetch(
          `/api/admin/team-parts/info/weeks?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? `조회 실패 (${res.status})`);
        }
        setData(json.data as TeamPartsInfoWeeksData);
      } catch (e) {
        setData(null);
        setError(e instanceof Error ? e.message : "조회 실패");
      } finally {
        setLoading(false);
      }
    },
    [mode],
  );

  useEffect(() => {
    // 통합 탭은 준비 중(자체 안내 블록 렌더) → API 호출/상태 갱신 없음.
    //   이전 클럽 데이터는 state 에 남아 있어도 통합 화면에선 렌더되지 않는다.
    if (isIntegrated || scopedMissing) return;
    // 탭/페이지/정렬 변경 시 외부(API)와 동기화하는 정석 effect — load 내부 setState 는 의도된 동작.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(effectiveTab as OrganizationSlug, page, sort);
  }, [effectiveTab, page, sort, isIntegrated, scopedMissing, load]);

  const onTabChange = (tab: TabKey) => {
    setActiveTab(tab);
    setPage(1);
  };

  // 컬럼 헤더 3단계 정렬 순환: 오름 → 내림 → 기본(원본 순서). 다른 컬럼이면 그 컬럼 오름차순.
  //   정렬은 서버사이드(전체 목록 기준) → 변경 시 1페이지로 이동.
  const onSort = (key: WeeksSortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null; // 3번째 클릭 → 기본 순서 복귀
    });
    setPage(1);
  };

  // [활동 관리] — 공식 휴식이면 이동 금지 + 안내, 공식 활동이면 상세 페이지 A 로 이동(라우팅만 준비).
  const onManageActivity = (item: TeamPartsInfoWeekItem, club: OrganizationSlug) => {
    if (item.clubActivityStatus === "official_rest") {
      window.alert(
        "[공식 휴식] 주차로서, 아무런 라인과 그에 수반되는 액트가 체크되지 않습니다.",
      );
      return;
    }
    // scoped(클럽 진행)는 ?org, 통합 어드민은 기존 ?club 컨텍스트를 유지한다.
    const detailHref = scoped
      ? `${detailBasePath}/${item.weekId}?org=${club}`
      : `${detailBasePath}/${item.weekId}?club=${club}`;
    router.push(appendModeQuery(detailHref, mode));
  };

  const pagination = data?.pagination ?? null;
  const totalPages = pagination?.totalPages ?? 1;
  const currentWeek = data?.currentWeek ?? null;

  // scoped 모드에서 URL org 가 없거나 무효면 안내만 표시(조회 전용 · 데이터 로드 없음).
  if (scopedMissing) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>주차 내역</CardTitle>
            <AdminHelp />
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            유효한 org 파라미터가 필요합니다. (사이드바에서 조직을 선택해 진입해 주세요.)
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>주차 내역</CardTitle>
        <div className="flex items-center gap-2">
          {scoped ? (
            <span
              data-readonly-badge
              className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-500"
            >
              조회 전용
            </span>
          ) : null}
          <AdminHelp />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* ── 클럽 탭(유일한 상단 필터) ─────────────────────────────── */}
        {/* scoped(개별 조직)는 자기 조직 탭만 고정 노출(비활성). 통합은 4개 탭. */}
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <span className="inline-flex items-center gap-1 text-sm font-semibold">
            <span>클럽</span>
            <AdminHelpIconButton
              helpKey="admin.teamPartsInfoWeeks.filter.club"
              title="클럽"
            />
          </span>
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="클럽 선택">
            {(scoped ? [effectiveTab] : TABS).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={effectiveTab === tab}
              data-club-tab={tab}
              disabled={scoped}
              onClick={() => onTabChange(tab)}
              className={
                "rounded-md border px-4 py-1.5 text-sm font-bold transition-colors " +
                (effectiveTab === tab
                  ? TAB_ACTIVE_CLS[tab]
                  : "border-input bg-background text-muted-foreground hover:bg-muted") +
                (scoped ? " cursor-default" : "")
              }
            >
              {TAB_LABEL[tab]}
            </button>
            ))}
          </div>
        </div>

        {/* ── 통합 탭: 준비 중 ─────────────────────── */}
        {isIntegrated ? (
          <div
            data-integrated-pending
            className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 px-4 py-10 text-center text-sm text-muted-foreground"
          >
            통합 탭은 준비 중입니다.
          </div>
        ) : (
          <>
            {/* ── 현재 주차 정보 배너 ── */}
            <section
              data-current-week
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-dashed border-red-300 px-4 py-3 text-sm"
            >
              <span className="inline-flex items-center gap-1">
                <span>
                  오늘은,{" "}
                  <strong data-cw-today className="text-base">
                    {currentWeek?.todayLabel ?? "-"}
                  </strong>
                </span>
                <AdminHelpIconButton
                  helpKey="admin.teamPartsInfoWeeks.summary.currentWeek"
                  title="현재 주차 안내"
                />
              </span>
              <span className="rounded bg-sky-50 px-2 py-0.5 font-semibold text-sky-800">
                <span data-cw-season>{currentWeek?.seasonWeekName ?? "-"}</span>
                {currentWeek?.seasonWeekName ? "입니다." : null}
              </span>
              <span className="text-muted-foreground" data-cw-range>
                {currentWeek?.weekRangeLabel ?? "-"}
              </span>
              {currentWeek?.clubActivityStatus ? (
                <span className="ml-auto inline-flex items-center gap-1">
                  <span
                    data-cw-status={currentWeek.clubActivityStatus}
                    className={
                      "rounded-md px-3 py-1 text-sm font-bold " +
                      (currentWeek.clubActivityStatus === "official_rest"
                        ? "bg-zinc-200 text-zinc-700"
                        : "bg-fuchsia-200 text-fuchsia-900")
                    }
                  >
                    {currentWeek.clubActivityStatus === "official_rest"
                      ? "공식 휴식"
                      : "공식 활동"}
                  </span>
                  <AdminHelpIconButton
                    helpKey="admin.teamPartsInfoWeeks.status.clubActivity"
                    title="클럽 활동 상태"
                  />
                </span>
              ) : null}
            </section>

            {error ? (
              <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            ) : null}

            {/* ── 주차별 표 ── */}
            {loading ? (
              <LoadingState active />
            ) : (
              <div className="overflow-x-auto rounded-lg border border-zinc-200">
                <table className="w-full border-collapse text-sm" data-weeks-table>
                  <thead>
                    <tr className="bg-zinc-50 text-xs text-muted-foreground">
                      <WeekTh
                        label="주차명"
                        helpKey="admin.teamPartsInfoWeeks.column.weekName"
                        align="left"
                        sortKey="weekName"
                        sort={sort}
                        onSort={onSort}
                      />
                      <WeekTh
                        label="클럽 활동"
                        helpKey="admin.teamPartsInfoWeeks.column.clubActivity"
                        align="center"
                        sortKey="clubActivityStatus"
                        sort={sort}
                        onSort={onSort}
                      />
                      {/* 활동 관리 = 액션 버튼 전용 컬럼 → 정렬 제외(정렬 의미 없음). */}
                      <WeekTh
                        label="활동 관리"
                        helpKey="admin.teamPartsInfoWeeks.column.activityManage"
                        align="center"
                        sort={sort}
                        onSort={onSort}
                      />
                      <WeekTh
                        label="액트 체크율"
                        helpKey="admin.teamPartsInfoWeeks.column.actCheckRate"
                        align="right"
                        sortKey="actCheckRate"
                        sort={sort}
                        onSort={onSort}
                      />
                      {/* 전체 액트 = 전 주차 동일(액트 카탈로그 크기) → 정렬 제외(재정렬 무의미). */}
                      <WeekTh
                        label="전체 액트"
                        helpKey="admin.teamPartsInfoWeeks.column.totalActs"
                        align="right"
                        sort={sort}
                        onSort={onSort}
                      />
                      {/* 가동 액트 = 전 주차 동일(체크 대상 액트 수) → 정렬 제외. */}
                      <WeekTh
                        label="가동 액트"
                        helpKey="admin.teamPartsInfoWeeks.column.activeActs"
                        align="right"
                        sort={sort}
                        onSort={onSort}
                      />
                      <WeekTh
                        label="라인칸 개설율"
                        helpKey="admin.teamPartsInfoWeeks.column.lineOpenRate"
                        align="right"
                        sortKey="lineOpenRate"
                        sort={sort}
                        onSort={onSort}
                      />
                      {/* 전체 라인 = 조직별 카탈로그 크기(전 주차 동일) → 정렬 제외. */}
                      <WeekTh
                        label="전체 라인"
                        helpKey="admin.teamPartsInfoWeeks.column.totalLines"
                        align="right"
                        sort={sort}
                        onSort={onSort}
                      />
                      <WeekTh
                        label="오픈 라인"
                        helpKey="admin.teamPartsInfoWeeks.column.openLines"
                        align="right"
                        sortKey="openLines"
                        sort={sort}
                        onSort={onSort}
                      />
                      <WeekTh
                        label="주차 검수"
                        helpKey="admin.teamPartsInfoWeeks.column.weekReview"
                        align="center"
                        sortKey="weekReviewed"
                        sort={sort}
                        onSort={onSort}
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.items ?? []).length === 0 ? (
                      <tr>
                        <td
                          colSpan={10}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          표시할 주차가 없습니다.
                        </td>
                      </tr>
                    ) : (
                      (data?.items ?? []).map((item) => (
                        <tr
                          key={item.weekId}
                          data-week-row={item.weekId}
                          className={
                            "border-b last:border-b-0 " +
                            (item.isCurrentWeek ? "bg-sky-50/50" : "")
                          }
                        >
                          <td className="px-3 py-2 whitespace-nowrap font-medium">
                            <span data-week-name>{item.weekName}</span>
                          </td>
                          <td className="px-3 py-2 text-center">
                            {statusBadge(item.clubActivityStatus)}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              data-manage-activity={item.weekId}
                              onClick={() =>
                                onManageActivity(item, effectiveTab as OrganizationSlug)
                              }
                            >
                              활동 관리
                            </Button>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums" data-act-rate>
                            {item.actCheckRate}%
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {item.totalActs}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {item.activeActs}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums" data-line-rate>
                            {item.lineOpenRate}%
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {item.totalLines}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {item.openLines}
                          </td>
                          <td className="px-3 py-2 text-center">
                            {item.weekReviewed ? (
                              <span
                                data-week-reviewed="true"
                                className="inline-flex h-6 w-6 items-center justify-center rounded bg-emerald-600 text-xs font-bold text-white"
                                title="검수 완료"
                              >
                                V
                              </span>
                            ) : (
                              <span
                                data-week-reviewed="false"
                                className="text-xs text-muted-foreground"
                              >
                                -
                              </span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {/* ── 페이지네이션 ── */}
            {pagination && pagination.totalCount > 0 ? (
              <div className="flex items-center justify-between text-sm">
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <span>
                    전체 {pagination.totalCount}개 · {pagination.page}/{totalPages}
                    페이지
                  </span>
                  <AdminHelpIconButton
                    helpKey="admin.teamPartsInfoWeeks.action.pagination"
                    title="페이지 이동 · 결과 건수"
                  />
                </span>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-page-prev
                    disabled={loading || pagination.page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    이전
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-page-next
                    disabled={loading || pagination.page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    다음
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
