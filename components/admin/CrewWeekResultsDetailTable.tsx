"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { StatusBadge } from "@/components/ui/status-badge";
import { buildAdminContextHref } from "@/lib/adminOrgContext";
import type { OrganizationSlug } from "@/lib/organizations";
import type {
  CrewWeeklyResultCellDto,
  CrewWeeklyResultWeekDto,
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

  // 주차 세부 페이지 링크 — 불변 식별자(organizationSlug/weekId)만 URL 에 쓴다.
  //   표시 문자열·배열 인덱스 사용 금지. 어드민 컨텍스트(mode 등)는 공통 헬퍼로 승계.
  const weekHref = (weekId: string) =>
    buildAdminContextHref({
      targetPath: `${BASE_PATH}/${organizationSlug}/${weekId}`,
      pathname,
      searchParams,
    });

  const COLS = [
    "상태",
    "주차명",
    "기간",
    "클럽 활동",
    "기준 포인트 A",
    "소속 크루",
    "시즌 휴식",
    "개인 휴식",
    "성장 도전",
    "성장 성공",
    "성장 실패",
    "성장 성공률",
    "성장 도전율",
  ];

  return (
    <div className="overflow-x-auto">
      <table
        className="w-full min-w-[64rem] border-separate border-spacing-0 text-sm"
        data-crew-week-results-detail={organizationSlug}
      >
        <thead>
          <tr>
            {COLS.map((label) => (
              <th
                key={label}
                scope="col"
                className={`whitespace-nowrap border-b bg-muted/60 px-3 py-2 font-semibold ${
                  label === "주차명" || label === "기간" ? "text-left" : "text-center"
                }`}
              >
                {label}
              </th>
            ))}
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
            weeks.map((week, rowIndex) => {
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
                    className="whitespace-nowrap border-b px-3 py-2 text-center"
                    data-display-status={cell.displayStatus}
                    data-lifecycle-status={cell.lifecycleStatus}
                    data-review-status={cell.reviewStatus}
                  >
                    <StatusBadge label={cell.displayStatusLabel} size="sm" />
                  </td>

                  {/* 2 주차명 — 클릭 시 주차 세부 페이지(다음 단계에서 내용 추가). */}
                  <td className="whitespace-nowrap border-b px-3 py-2 text-left" data-week-name>
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
                    <StatusBadge label={cell.activityKindLabel} size="sm" appearance="soft" />
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
    </div>
  );
}
