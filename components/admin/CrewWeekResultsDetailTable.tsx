"use client";

import { useMemo } from "react";
import { PaginatedNativeTable } from "@/components/ui/table-pagination";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { SortableTh } from "@/components/admin/SortableTh";
import { useTableColumnSort } from "@/components/admin/useTableColumnSort";
import type { TableSortColumns } from "@/lib/adminTableSort";
import { StatusBadge } from "@/components/ui/status-badge";
import { useStickyColumns } from "@/components/ui/sticky-columns";
import { buildAdminContextHref } from "@/lib/adminOrgContext";
import type { OrganizationSlug } from "@/lib/organizations";
import { getProcessPointLabels } from "@/lib/pointLabels";
import {
  CREW_WEEKLY_DISPLAY_STATUS_RANK,
  type CrewWeeklyResultCellDto,
  type CrewWeeklyResultWeekDto,
} from "@/lib/crewWeeklyResultTypes";

// [주차별] 크루 활동 결과 - 목록표 (클럽 상세 전용 표).
//
//   주차 1개 = 1행. 컬럼 순서는 요구 스펙 고정:
//     상태 · 주차명 · 기간 · 클럽 활동 · 기준 포인트 A · 소속 크루 · 시즌 휴식 · 개인 휴식 ·
//     성장 도전 · 성장 성공 · 성장 실패 · 성장 성공률 · 성장 도전율
//
//   ⚠ 이 컴포넌트는 **표시만** 한다. 상태·지표·비율을 여기서 계산하지 않는다
//     (전부 서버 DTO 값 그대로 — 통합 목록 셀과 같은 projection 산출물이라 값이 구조적으로 동일).
//   ⚠ 조직색은 쓰지 않는다 — 상세는 단일 조직 화면이라 열 구분이 필요 없고,
//     조직색은 "열 구분 전용"이라는 역할 분리를 유지한다(상태 배지 색 의미 보존).

const BASE_PATH = "/admin/team-parts/info/crew-week-results";

// 숫자 셀 — null = 미확정 마스킹이므로 고객 앱과 동일하게 "N" 으로 표시한다.
//   ⚠ 0(실제 0명)과 반드시 구분된다. "-" 는 값이 아예 없는 항목(기준 포인트 A)에만 쓴다.
function NumCell({ value, suffix = "" }: { value: number | null; suffix?: string }) {
  return (
    <td
      className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums"
      data-masked={value == null ? "true" : "false"}
    >
      {value == null ? (
        <span className="text-muted-foreground" title="검수 완료 전에는 결과 지표를 표시하지 않습니다.">
          N
        </span>
      ) : (
        `${value}${suffix}`
      )}
    </td>
  );
}

export default function CrewWeekResultsDetailTable({
  organizationSlug,
  weeks,
  cells,
  loading,
}: {
  organizationSlug: OrganizationSlug;
  weeks: CrewWeeklyResultWeekDto[];
  /** 이 조직의 셀만(주차 순서는 weeks 와 동일). */
  cells: Map<string, CrewWeeklyResultCellDto>;
  loading: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const pointLabels = getProcessPointLabels(organizationSlug);
  // 좌측 식별 열 고정 — 상태(col1) + 주차명(col2).
  const sticky = useStickyColumns({ headerSticky: true });

  // 주차 세부 페이지 링크 — 불변 식별자(organizationSlug/weekId)만 URL 에 쓴다.
  //   표시 문자열·배열 인덱스 사용 금지. 어드민 컨텍스트(mode 등)는 공통 헬퍼로 승계.
  const weekHref = (weekId: string) =>
    buildAdminContextHref({
      targetPath: `${BASE_PATH}/${organizationSlug}/${weekId}`,
      pathname,
      searchParams,
    });

  const COLS = [
    ["상태", "status"],
    ["주차명", "week"],
    ["기간", "period"],
    ["클럽 활동", "activity"],
    [`기준 ${pointLabels.a}`, "criterionPoint"],
    ["소속 크루", "crewCount"],
    ["시즌 휴식", "seasonRest"],
    ["개인 휴식", "personalRest"],
    ["성장 도전", "growthChallenge"],
    ["성장 성공", "growthSuccess"],
    ["성장 실패", "growthFailure"],
    ["성장 성공률", "growthSuccessRate"],
    ["성장 도전율", "growthChallengeRate"],
  ];

  // 컬럼 정렬(전 컬럼) — 공통 SoT(lib/adminTableSort) 규칙. 값은 **DTO 원본**으로 비교한다:
  //   · 상태      = 진행 단계 순위(진행 중 → 집계 중 → 검수 완료). 라벨 가나다순 아님.
  //   · 주차명/기간 = 주차 시작일(원본 ISO) 시간순. 화면 표기("26 - 07 - 20 (월)") 재파싱 금지.
  //   · 클럽 활동  = 표시 라벨 문자열.
  //   · 기준 포인트 A·인원·비율 = 전부 **숫자**(퍼센트도 0~100 수치). "N"/"-"(null)은 방향 무관 최하단.
  const sortColumns = useMemo<TableSortColumns<CrewWeeklyResultWeekDto, string>>(() => {
    const cellOf = (w: CrewWeeklyResultWeekDto) => cells.get(w.weekId) ?? null;
    const num = (
      pick: (c: CrewWeeklyResultCellDto) => number | null,
    ): TableSortColumns<CrewWeeklyResultWeekDto, string>[string] => ({
      type: "number",
      value: (w) => {
        const c = cellOf(w);
        return c ? pick(c) : null;
      },
    });
    return {
      status: {
        type: "number",
        value: (w) => {
          const c = cellOf(w);
          return c ? CREW_WEEKLY_DISPLAY_STATUS_RANK[c.displayStatus] : null;
        },
      },
      week: { type: "date", value: (w) => w.startDate },
      period: { type: "date", value: (w) => w.startDate },
      activity: {
        type: "text",
        value: (w) => cellOf(w)?.activityKindLabel ?? w.activityKindLabel,
      },
      criterionPoint: num((c) => c.criterionPointA),
      crewCount: num((c) => c.memberCount),
      seasonRest: num((c) => c.seasonRestCount),
      personalRest: num((c) => c.personalRestCount),
      growthChallenge: num((c) => c.growthChallengeCount),
      growthSuccess: num((c) => c.growthSuccessCount),
      growthFailure: num((c) => c.growthFailureCount),
      growthSuccessRate: num((c) => c.growthSuccessRatePercent),
      growthChallengeRate: num((c) => c.growthChallengeRatePercent),
    };
  }, [cells]);

  const { dirOf, onSort, sortedRows: sortedWeeks } = useTableColumnSort(weeks, sortColumns);

  return (
    <div
      ref={sticky.ref}
      className={"overflow-x-auto" + (sticky.regionClassName ? " " + sticky.regionClassName : "")}
    >
      <PaginatedNativeTable>
      <table
        className="w-full min-w-[64rem] border-separate border-spacing-0 text-sm"
        data-crew-week-results-detail={organizationSlug}
      >
        <thead>
          <tr>
            {COLS.map(([label, key], colIndex) => {
              const stickyProps =
                colIndex === 0 ? sticky.col(1) : colIndex === 1 ? sticky.col(2) : undefined;
              return (
                <SortableTh
                  key={key}
                  label={label}
                  align={label === "주차명" || label === "기간" ? "left" : "center"}
                  dir={dirOf(key)}
                  onSort={() => onSort(key)}
                  sticky={stickyProps}
                  className="whitespace-nowrap border-b bg-muted/60 px-3 py-2 font-semibold"
                  help={
                    <AdminHelpIconButton
                      helpKey={`admin.teamParts.crewWeekResults.column.${key}`}
                      title={label}
                    />
                  }
                />
              );
            })}
          </tr>
        </thead>
        <tbody>
          {weeks.length === 0 ? (
            <tr>
              <td
                colSpan={COLS.length}
                className="px-3 py-10 text-center text-muted-foreground"
              >
                {loading ? "불러오는 중" : "표시할 주차가 없습니다."}
              </td>
            </tr>
          ) : (
            sortedWeeks.map((week, rowIndex) => {
              const cell = cells.get(week.weekId);
              const zebra = rowIndex % 2 === 1 ? "bg-muted/30" : "";
              if (!cell) {
                return (
                  <tr key={week.weekId} data-week-row={week.weekId}>
                    <td colSpan={COLS.length} className={`border-b px-3 py-2 ${zebra}`}>
                      -
                    </td>
                  </tr>
                );
              }
              return (
                <tr
                  key={week.weekId}
                  data-week-row={week.weekId}
                  data-metrics-available={cell.metricsAvailable ? "true" : "false"}
                  data-metrics-override={cell.metricsFromAdminOverride ? "true" : "false"}
                  className={zebra}
                >
                  {/* 1 상태 — 통합 목록과 동일한 서버 displayStatus/Label 을 그대로 출력. */}
                  <td
                    data-sticky-col={sticky.col(1)["data-sticky-col"]}
                    className={"whitespace-nowrap border-b px-3 py-2 text-center " + sticky.col(1).className}
                    data-display-status={cell.displayStatus}
                    data-lifecycle-status={cell.lifecycleStatus}
                    data-review-status={cell.reviewStatus}
                  >
                    <StatusBadge label={cell.displayStatusLabel} size="sm" />
                  </td>

                  {/* 2 주차명 — 클릭 시 주차 세부 페이지(다음 단계에서 내용 추가). */}
                  <td
                    data-sticky-col={sticky.col(2)["data-sticky-col"]}
                    className={"whitespace-nowrap border-b px-3 py-2 text-left " + sticky.col(2).className}
                    data-week-name
                  >
                    <Link
                      href={weekHref(week.weekId)}
                      data-week-link={week.weekId}
                      className="font-semibold underline-offset-4 hover:underline"
                    >
                      {week.displayName}
                    </Link>
                  </td>

                  {/* 3 기간 — weekRangeLabel 그대로, 한 줄. */}
                  <td
                    className="whitespace-nowrap border-b px-3 py-2 text-left text-muted-foreground"
                    data-week-period
                  >
                    {week.periodLabel}
                  </td>

                  {/* 4 클럽 활동 — 주차 전역 SoT(is_official_rest) 파생값. */}
                  <td
                    className="whitespace-nowrap border-b px-3 py-2 text-center"
                    data-activity-kind={cell.activityKind}
                  >
                    <StatusBadge
                      label={cell.activityKindLabel}
                      size="sm"
                      appearance={cell.activityKind === "official_rest" ? "solid" : "soft"}
                      tone={cell.activityKind === "official_rest" ? "warning" : undefined}
                      className={
                        cell.activityKind === "official_rest"
                          ? "border border-amber-300 shadow-sm"
                          : undefined
                      }
                    />
                  </td>

                  {/* 5 기준 포인트 A — 없으면 "-"(30 폴백 금지). */}
                  <td
                    className="whitespace-nowrap border-b px-3 py-2 text-center tabular-nums"
                    data-criterion-point-a={cell.criterionPointA ?? ""}
                    title={
                      cell.criterionPointA == null
                        ? "이 주차·조직에는 확정된 기준 포인트 A가 없습니다(오픈 확인 전 또는 정책 적용 이전)."
                        : `A(최소자) ${cell.criterionMinPointsA ?? "-"} · B(성실자) ${cell.criterionExecPointsB ?? "-"}`
                    }
                  >
                    {cell.criterionPointA == null ? (
                      <span className="text-muted-foreground">-</span>
                    ) : (
                      cell.criterionPointA
                    )}
                  </td>

                  {/* 6~11 인원 지표 */}
                  <NumCell value={cell.memberCount} />
                  <NumCell value={cell.seasonRestCount} />
                  <NumCell value={cell.personalRestCount} />
                  <NumCell value={cell.growthChallengeCount} />
                  <NumCell value={cell.growthSuccessCount} />
                  <NumCell value={cell.growthFailureCount} />

                  {/* 12~13 비율 — 0~100 정수 퍼센트(고객 앱과 동일: 분모 0이면 0%). */}
                  <NumCell value={cell.growthSuccessRatePercent} suffix="%" />
                  <NumCell value={cell.growthChallengeRatePercent} suffix="%" />
                </tr>
              );
            })
          )}
        </tbody>
      </table>
      </PaginatedNativeTable>
    </div>
  );
}
