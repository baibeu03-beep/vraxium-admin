"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { AdminDetailTitle } from "@/components/admin/AdminRouteTitleProvider";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import CrewWeekResultsDetailTable from "@/components/admin/CrewWeekResultsDetailTable";
import {
  useAdminOrgAccess,
  AdminNoOrgAccess,
} from "@/components/admin/AdminOrgAccessProvider";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import { buildAdminContextHref } from "@/lib/adminOrgContext";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";
import {
  ORGANIZATION_COLUMN,
  ORGANIZATION_TEXT_CLASS,
  organizationLabelKo,
  type OrganizationSlug,
} from "@/lib/organizations";
// ⚠ 서버 로더(crewWeeklyResultProjection)가 아니라 **브라우저 안전 모듈**에서 가져온다 —
//   전자를 import 하면 supabaseAdmin(node:async_hooks) 그래프가 클라이언트 번들로 끌려온다.
import {
  crewWeeklyCellKey,
  type CrewWeeklyResultsBundleDto,
  type CrewWeeklyResultCellDto,
} from "@/lib/crewWeeklyResultTypes";

// 클럽 정보 > 주차 결과(크루) — 통합 목록과 클럽 상세가 **공유하는 단일 화면 컴포넌트**.
//
//   · organizationSlug = null  → 통합: 허용 조직 전체가 열로 나온다(클럽 헤더에 [상세] 버튼).
//   · organizationSlug = slug  → 클럽 상세: 그 조직 1열만. 추후 [개별] 어드민의 주차 결과(크루)
//                                페이지가 **이 컴포넌트를 그대로** 재사용한다(별도 페이지 신설 금지).
//
//   두 모드가 같은 API(/api/admin/team-parts/info/crew-week-results)·같은 DTO 를 쓰고,
//   셀 표시값은 서버가 계산한 displayStatusLabel/activityKindLabel 을 **그대로 출력**한다.
//   ⚠ 이 파일에는 현재 시각으로 상태를 정하는 코드가 없다(있어서는 안 된다).

const PAGE_SIZE = 20;

const BASE_PATH = "/admin/team-parts/info/crew-week-results";

// 상태 배지 — 색은 공용 레지스트리(lib/statusBadge)가 라벨로 정한다("같은 라벨=같은 색").
//   라벨 문자열은 서버 DTO 값을 그대로 쓴다(프론트 매핑 테이블 재작성 금지).
function StatusCell({ cell }: { cell: CrewWeeklyResultCellDto }) {
  const isOfficialRest = cell.activityKind === "official_rest";

  return (
    <div
      // 셀 내용도 한 줄 유지 — 클럽 열을 좁혀도 "공식 활동 | 진행 중"이 두 줄로 갈라지지 않게.
      className="flex flex-nowrap items-center justify-center gap-1.5 whitespace-nowrap"
      data-cell-week={cell.weekId}
      data-cell-org={cell.organizationSlug}
      data-activity-kind={cell.activityKind}
      data-display-status={cell.displayStatus}
      data-lifecycle-status={cell.lifecycleStatus}
      data-review-status={cell.reviewStatus}
    >
      <span
        className={
          isOfficialRest
            ? "rounded-md border border-amber-300 bg-amber-100 px-2 py-1 text-sm font-bold text-amber-900 shadow-sm"
            : "text-sm font-semibold"
        }
      >
        {cell.activityKindLabel}
      </span>
      <span aria-hidden className="text-muted-foreground">
        |
      </span>
      <StatusBadge label={cell.displayStatusLabel} size="sm" />
    </div>
  );
}

export default function CrewWeekResultsBoard({
  organizationSlug = null,
}: {
  /** null = 통합(허용 조직 전체) · slug = 클럽 상세(1개 조직). */
  organizationSlug?: OrganizationSlug | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const mode = readScopeMode(searchParams);
  const { allowedOrgs } = useAdminOrgAccess();

  const [data, setData] = useState<CrewWeeklyResultsBundleDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  useReportLoading(loading);

  const isDetail = organizationSlug != null;
  // 허용 조직 0개 = 권한 없음 → 조회하지 않는다.
  const noAccess = allowedOrgs.length === 0;
  // 상세인데 그 조직 권한이 없음 → 조회하지 않고 안내(서버도 403 으로 fail-closed).
  const detailForbidden = isDetail && !allowedOrgs.includes(organizationSlug);

  const load = useCallback(
    async (pageNum: number) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          page: String(pageNum),
          pageSize: String(PAGE_SIZE),
        });
        // 통합은 organization 미지정(= 허용 조직 전체). 상세는 slug 1개.
        if (organizationSlug) params.set("organization", organizationSlug);
        if (mode === "test") params.set("mode", "test");
        const res = await fetch(`/api/admin/team-parts/info/crew-week-results?${params.toString()}`, {
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw apiErrorFrom(res, json, `조회 실패 (${res.status})`);
        }
        setData(json.data as CrewWeeklyResultsBundleDto);
      } catch (e) {
        setData(null);
        setError(getApiErrorMessage(e, "조회 실패"));
      } finally {
        setLoading(false);
      }
    },
    [mode, organizationSlug],
  );

  useEffect(() => {
    if (noAccess || detailForbidden) return;
    // 페이지/모드/조직 변경 시 외부(API)와 동기화하는 정석 effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(page);
  }, [page, load, noAccess, detailForbidden]);

  const organizations = data?.organizations ?? [];
  const weeks = data?.weeks ?? [];
  const pagination = data?.pagination ?? null;
  const totalPages = pagination?.totalPages ?? 1;

  // 셀 조회 맵 — key 규칙은 공통 SoT(crewWeeklyCellKey)를 쓴다.
  const cellByKey = useMemo(() => {
    const map = new Map<string, CrewWeeklyResultCellDto>();
    for (const c of data?.cells ?? []) {
      map.set(crewWeeklyCellKey(c.weekId, c.organizationSlug), c);
    }
    return map;
  }, [data]);

  // [상세] — 조직 slug(불변 식별자)로 이동. 표시명을 URL 에 쓰지 않는다.
  //   현재 화면의 어드민 컨텍스트(mode/org/actAsTestUserId/demoUserId)는 공통 헬퍼로 전달한다.
  const onOpenDetail = (org: OrganizationSlug) => {
    router.push(
      buildAdminContextHref({
        targetPath: `${BASE_PATH}/${org}`,
        pathname,
        searchParams,
      }),
    );
  };

  // 상세 제목은 스펙 고정 문구. 조직명은 breadcrumb·환경 배너가 이미 표시한다.
  const title = isDetail ? "[주차별] 크루 활동 결과 - 목록표" : "주차 결과(크루)";

  if (noAccess) {
    return <AdminNoOrgAccess title="주차 결과(크루)" />;
  }

  return (
    <>
      {/* 상세 페이지의 breadcrumb 마지막 칸을 실제 클럽명으로 교체(헤더 추가 조회 없음). */}
      {isDetail ? (
        <AdminDetailTitle title={organizationLabelKo(organizationSlug)} />
      ) : null}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-1">
            {title}
            <AdminHelpIconButton
              helpKey={
                isDetail
                  ? "admin.teamParts.crewWeekResults.section.organizationList"
                  : "admin.teamParts.crewWeekResults.section.overview"
              }
              title={title}
              size="sm"
            />
          </CardTitle>
          {isDetail ? (
            <span className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-back-to-list
              onClick={() =>
                router.push(
                  buildAdminContextHref({ targetPath: BASE_PATH, pathname, searchParams }),
                )
              }
            >
              목록으로
            </Button>
            <AdminHelpIconButton
              helpKey="admin.teamParts.crewWeekResults.action.backToOverview"
              title="통합 목록으로"
            />
            </span>
          ) : null}
        </CardHeader>
        <CardContent className="admin-section-stack-lg">
          {detailForbidden ? (
            <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              이 클럽에 접근할 권한이 없습니다.
            </div>
          ) : (
            <>
              {error ? (
                <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </div>
              ) : null}

              <LoadingState active={loading} />

              {isDetail ? (
                /* 클럽 상세 = [주차별] 크루 활동 결과 목록표(13컬럼).
                   통합 목록과 **같은 API·같은 DTO** 를 쓰고 표현만 다르다 — 상태/지표 재계산 없음. */
                <CrewWeekResultsDetailTable
                  organizationSlug={organizationSlug}
                  weeks={weeks}
                  cells={
                    new Map(
                      (data?.cells ?? [])
                        .filter((c) => c.organizationSlug === organizationSlug)
                        .map((c) => [c.weekId, c]),
                    )
                  }
                  loading={loading}
                />
              ) : (
              <div className="overflow-x-auto">
                {/* table-fixed + "주차 열만 폭 선언" = 남는 공간을 주차 열이 가져가지 않고
                    조직 열들이 **균등 분배**한다(선언 폭이 있는 열끼리는 비례 분배되므로,
                    조직 열에는 폭을 주지 않는 것이 핵심 — 종전 13rem 선언 시 주차 열이 320→380px 로 팽창했다).

                    주차 열 폭 = 실측 최소값. 렌더된 최장 문자열을 Range 로 측정(1440px, 어드민 확대 스케일):
                      주차명 "26 - 여름 - 4 주차"                    = 175px
                      기간   "26 - 03 - 30 (월) ~ 26 - 04 - 05 (일)" = 291px  ← 결정값
                    + 좌우 패딩 px-3(12+12) = 24px  →  315px  →  316px(19.75rem) 채택.
                    ⚠ 180~210px 로는 클럽 날짜 표기 SoT(formatClubDate: "26 - 03 - 30 (월)")를
                      줄바꿈·말줄임 없이 담을 수 없다. 폭을 더 줄이려면 날짜 표기 SoT 를 바꿔야 한다. */}
                <table className="w-full min-w-[46rem] table-fixed border-separate border-spacing-0 text-sm">
                  <colgroup>
                    <col className="w-[19.75rem]" />
                    {organizations.map((org) => (
                      <col key={org.organizationSlug} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr>
                      {/* 좌측 고정 영역 — 주차명 · 주차 기간 */}
                      <th
                        scope="col"
                        className="border-b bg-muted/60 px-3 py-2 text-left font-semibold"
                      >
                        <span className="inline-flex items-center gap-1">
                          주차
                          <AdminHelpIconButton
                            helpKey="admin.teamParts.crewWeekResults.column.week"
                            title="주차"
                          />
                        </span>
                      </th>
                      {organizations.map((org) => (
                        <th
                          key={org.organizationSlug}
                          scope="col"
                          data-club-header={org.organizationSlug}
                          // 조직색 = 열 구분 전용(lib/organizations ORGANIZATION_COLUMN SoT).
                          //   헤더는 본문보다 한 단계 진하게 + 좌우에 조직색 포인트 테두리.
                          className={`border-b border-l border-r px-3 py-2 text-center font-semibold ${ORGANIZATION_COLUMN[org.organizationSlug].header} ${ORGANIZATION_COLUMN[org.organizationSlug].edge}`}
                        >
                          <div className="flex flex-nowrap items-center justify-center gap-1.5 whitespace-nowrap">
                            <span
                              className={`text-base font-bold ${ORGANIZATION_TEXT_CLASS[org.organizationSlug]}`}
                            >
                              {org.organizationName}
                            </span>
                            <AdminHelpIconButton
                              helpKey="admin.teamParts.crewWeekResults.column.organizationResult"
                              title="조직별 주차 결과"
                            />
                            {/* 통합에서만 [상세] 진입 버튼. 상세 화면에는 자기 자신 링크를 두지 않는다. */}
                            {isDetail ? null : (
                              <>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                data-club-detail={org.organizationSlug}
                                onClick={() => onOpenDetail(org.organizationSlug)}
                              >
                                상세
                              </Button>
                              <AdminHelpIconButton
                                helpKey="admin.teamParts.crewWeekResults.action.openOrganization"
                                title="조직 상세"
                              />
                              </>
                            )}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {weeks.length === 0 ? (
                      <tr>
                        <td
                          colSpan={organizations.length + 1}
                          className="px-3 py-10 text-center text-muted-foreground"
                        >
                          {loading ? "불러오는 중" : "표시할 주차가 없습니다."}
                        </td>
                      </tr>
                    ) : (
                      weeks.map((week, rowIndex) => (
                        <tr
                          key={week.weekId}
                          data-week-row={week.weekId}
                          data-current-week={week.isCurrentWeek ? "true" : "false"}
                        >
                          {/* zebra 는 주차 열에만 — 행 전체에 깔면 조직 열의 옅은 조직색과 섞여
                              열 구분이 탁해진다(조직색은 열 전용). 주차 열엔 조직색을 쓰지 않는다. */}
                          <th
                            scope="row"
                            className={`border-b px-3 py-2 text-left align-middle font-normal ${
                              rowIndex % 2 === 1 ? "bg-muted/30" : ""
                            }`}
                          >
                            <div
                              className="whitespace-nowrap text-base font-bold"
                              data-week-name
                            >
                              {week.tableName} 주차
                            </div>
                            {/* 기간은 반드시 한 줄 — 날짜 중간 줄바꿈 금지(whitespace-nowrap). */}
                            <div
                              className="whitespace-nowrap text-xs text-muted-foreground"
                              data-week-period
                            >
                              {week.periodLabel}
                            </div>
                          </th>
                          {organizations.map((org) => {
                            const cell = cellByKey.get(
                              crewWeeklyCellKey(week.weekId, org.organizationSlug),
                            );
                            return (
                              <td
                                key={org.organizationSlug}
                                // 본문 셀 = 아주 옅은 조직색 + 좌우 조직색 경계선.
                                //   배지(상태·활동 유형)는 자기 배경을 가진 solid 라 이 옅은 톤에
                                //   흐려지지 않는다 — 조직색은 배지 색 의미에 관여하지 않는다.
                                className={`border-b border-l border-r px-3 py-2 text-center align-middle ${ORGANIZATION_COLUMN[org.organizationSlug].cell} ${ORGANIZATION_COLUMN[org.organizationSlug].edge}`}
                              >
                                {cell ? <StatusCell cell={cell} /> : "-"}
                              </td>
                            );
                          })}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              )}

              {pagination && pagination.totalCount > 0 ? (
                <div className="flex items-center justify-between text-sm">
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    전체 {pagination.totalCount}개 · {pagination.page}/{totalPages}페이지
                    <AdminHelpIconButton
                      helpKey="admin.teamParts.crewWeekResults.action.pagination"
                      title="페이지 이동"
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
    </>
  );
}

// mode 를 보존한 링크가 필요할 때(외부 호출자용) — 화면 내부는 buildAdminContextHref 를 쓴다.
export function crewWeekResultsDetailHref(
  org: OrganizationSlug,
  mode: "operating" | "test",
): string {
  return appendModeQuery(`${BASE_PATH}/${org}`, mode);
}
