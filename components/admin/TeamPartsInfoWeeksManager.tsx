"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import { readOrgParam } from "@/lib/adminOrgContext";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
import type {
  TeamPartsInfoWeeksData,
  TeamPartsInfoWeekItem,
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
  const [data, setData] = useState<TeamPartsInfoWeeksData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useReportLoading(loading);

  // scoped 모드면 URL org 로 고정, 아니면 탭 상태를 사용한다.
  const effectiveTab: TabKey = scoped ? (scopedOrg ?? "encre") : activeTab;
  const isIntegrated = effectiveTab === "integrated";

  const load = useCallback(
    async (club: OrganizationSlug, pageNum: number) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          club,
          page: String(pageNum),
          pageSize: String(PAGE_SIZE),
        });
        if (mode === "test") params.set("mode", "test");
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
    // 탭/페이지 변경 시 외부(API)와 동기화하는 정석 effect — load 내부 setState 는 의도된 동작.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(effectiveTab as OrganizationSlug, page);
  }, [effectiveTab, page, isIntegrated, scopedMissing, load]);

  const onTabChange = (tab: TabKey) => {
    setActiveTab(tab);
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
          <CardTitle>주차 내역</CardTitle>
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
        {scoped ? (
          <span
            data-readonly-badge
            className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-semibold text-zinc-500"
          >
            조회 전용
          </span>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-5">
        {/* ── 클럽 탭 ─────────────────────────────── */}
        {/* scoped(개별 조직)는 자기 조직 탭만 고정 노출(비활성). 통합은 4개 탭. */}
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
              <span>
                오늘은,{" "}
                <strong data-cw-today className="text-base">
                  {currentWeek?.todayLabel ?? "-"}
                </strong>
              </span>
              <span className="rounded bg-sky-50 px-2 py-0.5 font-semibold text-sky-800">
                <span data-cw-season>{currentWeek?.seasonWeekName ?? "-"}</span>
                {currentWeek?.seasonWeekName ? "입니다." : null}
              </span>
              <span className="text-muted-foreground" data-cw-range>
                {currentWeek?.weekRangeLabel ?? "-"}
              </span>
              {currentWeek?.clubActivityStatus ? (
                <span
                  data-cw-status={currentWeek.clubActivityStatus}
                  className={
                    "ml-auto rounded-md px-3 py-1 text-sm font-bold " +
                    (currentWeek.clubActivityStatus === "official_rest"
                      ? "bg-zinc-200 text-zinc-700"
                      : "bg-fuchsia-200 text-fuchsia-900")
                  }
                >
                  {currentWeek.clubActivityStatus === "official_rest"
                    ? "공식 휴식"
                    : "공식 활동"}
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
                      <th className="border-b px-3 py-2 text-left font-semibold whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          주차명
                          <AdminHelpIconButton
                            helpKey="admin.teamParts.info.weeks.column.weekName"
                            title="주차명"
                          />
                        </span>
                      </th>
                      <th className="border-b px-3 py-2 text-center font-semibold whitespace-nowrap">
                        <span className="inline-flex items-center justify-center gap-1">
                          클럽 활동
                          <AdminHelpIconButton
                            helpKey="admin.teamParts.info.weeks.column.clubActivity"
                            title="클럽 활동"
                          />
                        </span>
                      </th>
                      <th className="border-b px-3 py-2 text-center font-semibold whitespace-nowrap">
                        <span className="inline-flex items-center justify-center gap-1">
                          활동 관리
                          <AdminHelpIconButton
                            helpKey="admin.teamParts.info.weeks.column.activityManage"
                            title="활동 관리"
                          />
                        </span>
                      </th>
                      <th className="border-b px-3 py-2 text-right font-semibold whitespace-nowrap">
                        <span className="inline-flex items-center justify-end gap-1">
                          액트 체크율
                          <AdminHelpIconButton
                            helpKey="admin.teamParts.info.weeks.column.actCheckRate"
                            title="액트 체크율"
                          />
                        </span>
                      </th>
                      <th className="border-b px-3 py-2 text-right font-semibold whitespace-nowrap">
                        <span className="inline-flex items-center justify-end gap-1">
                          전체 액트
                          <AdminHelpIconButton
                            helpKey="admin.teamParts.info.weeks.column.totalActs"
                            title="전체 액트"
                          />
                        </span>
                      </th>
                      <th className="border-b px-3 py-2 text-right font-semibold whitespace-nowrap">
                        <span className="inline-flex items-center justify-end gap-1">
                          가동 액트
                          <AdminHelpIconButton
                            helpKey="admin.teamParts.info.weeks.column.activeActs"
                            title="가동 액트"
                          />
                        </span>
                      </th>
                      <th className="border-b px-3 py-2 text-right font-semibold whitespace-nowrap">
                        <span className="inline-flex items-center justify-end gap-1">
                          라인칸 개설율
                          <AdminHelpIconButton
                            helpKey="admin.teamParts.info.weeks.column.lineOpenRate"
                            title="라인칸 개설율"
                          />
                        </span>
                      </th>
                      <th className="border-b px-3 py-2 text-right font-semibold whitespace-nowrap">
                        <span className="inline-flex items-center justify-end gap-1">
                          전체 라인
                          <AdminHelpIconButton
                            helpKey="admin.teamParts.info.weeks.column.totalLines"
                            title="전체 라인"
                          />
                        </span>
                      </th>
                      <th className="border-b px-3 py-2 text-right font-semibold whitespace-nowrap">
                        <span className="inline-flex items-center justify-end gap-1">
                          오픈 라인
                          <AdminHelpIconButton
                            helpKey="admin.teamParts.info.weeks.column.openLines"
                            title="오픈 라인"
                          />
                        </span>
                      </th>
                      <th className="border-b px-3 py-2 text-center font-semibold whitespace-nowrap">
                        <span className="inline-flex items-center justify-center gap-1">
                          주차 검수
                          <AdminHelpIconButton
                            helpKey="admin.teamParts.info.weeks.column.weekReview"
                            title="주차 검수"
                          />
                        </span>
                      </th>
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
                <span className="text-muted-foreground">
                  전체 {pagination.totalCount}개 · {pagination.page}/{totalPages}
                  페이지
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
