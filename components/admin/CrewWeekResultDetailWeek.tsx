"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AdminDetailTitle } from "@/components/admin/AdminRouteTitleProvider";
import { buildAdminContextHref } from "@/lib/adminOrgContext";
import { readScopeMode } from "@/lib/userScopeShared";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";
import CrewWeekPublishPanel from "@/components/admin/CrewWeekPublishPanel";
import { organizationLabelKo, type OrganizationSlug } from "@/lib/organizations";
import type { CrewWeeklyResultsBundleDto } from "@/lib/crewWeeklyResultTypes";
import { seasonKeyToHalfKey } from "@/lib/teamHalf";

// 주차 세부 페이지(골격) — 이번 단계는 "경로·breadcrumb·주차 식별" 까지만.
//   ⚠ 표시용 주차명은 **공용 API 의 DTO** 에서 가져온다(문자열을 URL/화면에서 재조합하지 않음).
//     상세 목록표와 같은 API·같은 DTO 를 쓰므로 주차명/상태가 목록과 항상 일치한다.
//   breadcrumb = 클럽 정보 > 주차 결과(크루) > {클럽명} > {주차명} (AdminDetailTitle items 로 확장).
const BASE_PATH = "/admin/team-parts/info/crew-week-results";

export default function CrewWeekResultDetailWeek({
  organizationSlug,
  weekId,
}: {
  organizationSlug: OrganizationSlug;
  weekId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const mode = readScopeMode(searchParams);

  const [bundle, setBundle] = useState<CrewWeeklyResultsBundleDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 공표/취소 후 상태 배지를 갱신하기 위해 번들을 다시 읽는다.
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const params = new URLSearchParams({
          organization: organizationSlug,
          page: "1",
          pageSize: "200",
        });
        if (mode === "test") params.set("mode", "test");
        const res = await fetch(
          `/api/admin/team-parts/info/crew-week-results?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) throw apiErrorFrom(res, json, `조회 실패 (${res.status})`);
        if (alive) setBundle(json.data as CrewWeeklyResultsBundleDto);
      } catch (e) {
        if (alive) setError(getApiErrorMessage(e, "조회 실패"));
      }
    })();
    return () => {
      alive = false;
    };
  }, [organizationSlug, mode, reloadKey]);

  const week = bundle?.weeks.find((w) => w.weekId === weekId) ?? null;
  const cell = bundle?.cells.find((c) => c.weekId === weekId) ?? null;
  const halfKey = week?.seasonKey ? seasonKeyToHalfKey(week.seasonKey) : null;
  // 주차 종료 여부 — 서버가 준 활동 기준일과 주차 종료일로 판정(클라이언트 시계 사용 금지).
  const weekEnded =
    !!bundle && !!week?.endDate && bundle.activityDate > week.endDate;
  // 번들은 로더 단계에서 이미 미래 주차를 제외한다 → 로드 완료 후에도 못 찾으면
  //   "아직 시작하지 않은 주차" 또는 존재하지 않는 주차다. **결과 페이지로 노출하지 않는다.**
  const notAvailable = bundle != null && week == null;
  const orgKo = organizationLabelKo(organizationSlug);

  return (
    <>
      {/* breadcrumb 끝 2칸 교체: {클럽명}(클럽 상세로 링크) > {주차명}. 로딩 중엔 UUID 미노출. */}
      <AdminDetailTitle
        items={[
          {
            label: orgKo,
            href: buildAdminContextHref({
              targetPath: `${BASE_PATH}/${organizationSlug}`,
              pathname,
              searchParams,
            }),
          },
          { label: week?.displayName ?? (notAvailable ? "조회 불가" : "불러오는 중") },
        ]}
      />
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle data-week-detail-title>
            {week ? `${week.displayName} · ${orgKo}` : notAvailable ? "조회할 수 없는 주차" : "불러오는 중"}
          </CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-back-to-detail
            onClick={() =>
              router.push(
                buildAdminContextHref({
                  targetPath: `${BASE_PATH}/${organizationSlug}`,
                  pathname,
                  searchParams,
                }),
              )
            }
          >
            목록으로
          </Button>
        </CardHeader>
        <CardContent className="admin-section-stack-lg">
          {error ? (
            <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          ) : null}
          {notAvailable ? (
            <div
              data-week-not-available
              className="rounded-lg border border-dashed border-amber-300 bg-amber-50 px-4 py-10 text-center text-sm text-amber-800"
            >
              아직 시작하지 않았거나 조회할 수 없는 주차입니다. 목록에서 다시 선택해주세요.
            </div>
          ) : (
            <>
              {week ? (
                <div className="text-sm text-muted-foreground" data-week-detail-period>
                  {week.periodLabel}
                </div>
              ) : null}
              {/* [3][4] 예비 검수 · 공표 · 공표 취소 */}
              <CrewWeekPublishPanel
                organizationSlug={organizationSlug}
                weekId={weekId}
                halfKey={halfKey}
                displayStatus={cell?.displayStatus ?? null}
                criterionPointA={cell?.criterionPointA ?? null}
                weekEnded={weekEnded}
                onChanged={() => void reload()}
              />

              {/* 팀 활동 결과 — SoT 미확인이라 가짜 숫자를 넣지 않는다. */}
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
