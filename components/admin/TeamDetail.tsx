"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { AdminDetailTitle } from "@/components/admin/AdminRouteTitleProvider";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { readScopeMode } from "@/lib/userScopeShared";
import { ORGANIZATION_LABEL_KO, type OrganizationSlug } from "@/lib/organizations";
import { parseHalfKey } from "@/lib/teamHalf";
import { buildAdminContextHref } from "@/lib/adminOrgContext";
import {
  dash,
  toTeamBreadcrumbLabel,
  TeamLeaderProfileRow,
  TeamPartsRow,
  TeamCurrentCrewStrip,
  TeamPartWeekMatrix,
  type TeamCrewLike,
  type PartWeekColumnLike,
  type PartWeekMatrixLike,
} from "@/components/admin/teamCardShared";

// ── 팀 상세(클럽 상세 → 팀 상세) — 단일 팀의 전체 상세 + 파트×주차 존재표 ──────────────
//   시점 기준 분리: 현재 시점(클러빙/정규/심화 크루 수) vs 선택 반기(파트 구성·파트×주차 표).
//   진입: /admin/team-parts/info/{org}/{teamHalfId}?half=YYYY-Hn (직접 진입=현재 반기).
//   데이터 원천/DTO 는 loadTeamPartsInfo 와 동일(팀 상세 API가 한 팀만 추출) — 진입 위치별 복제 없음.

type TeamDto = {
  teamHalfId: string;
  teamName: string;
  teamId: string | null;
  description: string | null;
  leaderName: string | null;
  leaderBirth6: string | null;
  leaderGender: string | null;
  leaderSchool: string | null;
  leaderMajor: string | null;
  leaderResidence: string | null;
  leaderClassLabel: string | null;
  leaderGradeLabel: string | null;
  partCount: number;
  partNames: string[];
  partWeekMatrix: PartWeekMatrixLike | null;
  currentCrew?: TeamCrewLike;
};

type HalfOption = {
  halfKey: string;
  label: string;
  isCurrent: boolean;
  editable: boolean;
};

type TeamDetailData = {
  organization: string;
  teamName: string;
  currentHalfKey: string | null;
  selectedHalfKey: string | null;
  editable: boolean;
  halves: HalfOption[];
  team: TeamDto | null;
  weekColumns: PartWeekColumnLike[];
  currentCrew: TeamCrewLike;
};

const CHIP_CLS: Record<OrganizationSlug, string> = {
  encre: "bg-red-500 text-white border-red-600",
  oranke: "bg-yellow-300 text-zinc-900 border-yellow-400",
  phalanx: "bg-green-500 text-white border-green-600",
};

const SELECT_CLS = "rounded-md border border-input bg-background px-3 py-2 text-sm";

const HALF_OPTIONS = [
  "2022-H1", "2022-H2", "2023-H1", "2023-H2", "2024-H1",
  "2024-H2", "2025-H1", "2025-H2", "2026-H1", "2026-H2",
] as const;

function formatHalf(halfKey: string): string {
  const p = parseHalfKey(halfKey);
  if (!p) return halfKey;
  return `${p.year}년 ${p.period === "H1" ? "상반기" : "하반기"}`;
}

export default function TeamDetail({
  orgSlug,
  teamHalfId,
}: {
  orgSlug: OrganizationSlug;
  teamHalfId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const mode = readScopeMode(searchParams);
  const halfParam = searchParams.get("half");
  const clubName = ORGANIZATION_LABEL_KO[orgSlug];

  const [data, setData] = useState<TeamDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useReportLoading(loading);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const params = new URLSearchParams({ organization: orgSlug, teamHalfId });
      if (halfParam) params.set("half", halfParam);
      if (mode === "test") params.set("mode", "test");
      const res = await fetch(
        `/api/admin/team-parts/info/team-detail?${params.toString()}`,
        { cache: "no-store" },
      );
      if (res.status === 404) {
        setData(null);
        setNotFound(true);
        return;
      }
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? `조회 실패 (${res.status})`);
      }
      setData(json.data as TeamDetailData);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "조회 실패");
    } finally {
      setLoading(false);
    }
  }, [orgSlug, teamHalfId, halfParam, mode]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // 반기 변경 → URL ?half 갱신(새로고침·공유 대응) → 위 effect 가 재조회. 현재 크루 수는 API가 팀명
  //   기준 현재 시점으로 반환하므로 반기를 바꿔도 값이 동일하다(선택 반기는 파트·존재표에만 영향).
  const onHalfChange = (value: string) => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("half", value);
    router.replace(`${pathname}?${sp.toString()}`);
  };

  const clubHref = buildAdminContextHref({
    targetPath: `/admin/team-parts/info/${orgSlug}`,
    pathname,
    searchParams,
  });
  const teamLabel = data ? toTeamBreadcrumbLabel(data.teamName) : "팀 상세";
  const half = data?.selectedHalfKey ?? null;
  const currentHalfKey = data?.currentHalfKey ?? null;

  return (
    <Card>
      {/* 전역 헤더 breadcrumb 마지막 2칸을 실제 클럽명·팀명으로 교체(slug/UUID 미노출). */}
      <AdminDetailTitle
        items={[{ label: clubName, href: clubHref }, { label: teamLabel }]}
      />
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          {/* 상세 breadcrumb(4단계): 클럽 정보 > 팀 내역 > 클럽명 > 팀명. */}
          <nav
            aria-label="현재 위치"
            className="flex min-w-0 flex-wrap items-center gap-1.5"
          >
            <Link
              href="/admin/team-parts/info"
              className="truncate rounded-sm text-sm text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:text-base"
            >
              클럽 정보
            </Link>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Link
              href="/admin/team-parts/info"
              className="truncate rounded-sm text-sm text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:text-base"
            >
              팀 내역
            </Link>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Link
              href={clubHref}
              data-team-detail-club-link
              className="truncate rounded-sm text-sm text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:text-base"
            >
              {clubName}
            </Link>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span
              data-team-detail-name
              aria-current="page"
              className="truncate text-sm font-semibold text-foreground sm:text-base"
            >
              {teamLabel}
            </span>
          </nav>
          <AdminHelp />
        </div>
      </CardHeader>

      <CardContent className="admin-section-stack-lg">
        {error ? (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {notFound ? (
          <div
            data-team-detail-notfound
            className="rounded-md border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-muted-foreground"
          >
            팀을 찾을 수 없습니다. 삭제되었거나 이 클럽에 속하지 않은 팀입니다.
            <div className="mt-3">
              <Link
                href={clubHref}
                className="rounded-sm font-medium text-foreground underline underline-offset-2"
              >
                {clubName} 클럽 상세로 돌아가기
              </Link>
            </div>
          </div>
        ) : loading && !data ? (
          <LoadingState active />
        ) : data ? (
          <>
            {/* 상단 조회 조건(해당 시기). 반기 변경 시 파트·존재표만 재조회(크루 수는 현재 시점 고정). */}
            <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
              <div className="flex shrink-0 items-center gap-2 text-sm font-semibold">
                <span className="inline-flex items-center gap-1">
                  <span>● 해당 시기</span>
                  <AdminHelpIconButton
                    helpKey="admin.teamParts.info.filter.half"
                    title="해당 시기"
                  />
                </span>
                <select
                  id="team-detail-half-select"
                  className={SELECT_CLS}
                  value={half ?? ""}
                  onChange={(e) => onHalfChange(e.target.value)}
                >
                  {HALF_OPTIONS.map((hk) => (
                    <option key={hk} value={hk}>
                      {formatHalf(hk)}
                      {hk === currentHalfKey ? " (현재)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* 팀 기본 정보(팀 배지 + 개요) */}
            <div className="flex items-start gap-3">
              <span
                className={
                  "shrink-0 rounded-md border px-3 py-1 text-sm font-bold " +
                  CHIP_CLS[orgSlug]
                }
              >
                {data.team?.teamName ?? data.teamName}
              </span>
              <span className="flex-1 rounded-md border border-input bg-muted/30 px-3 py-1.5 text-sm">
                {dash(data.team?.description)}
              </span>
            </div>

            {/* 팀장 프로필 */}
            {data.team ? (
              <TeamLeaderProfileRow team={{ ...data.team }} />
            ) : null}

            {/* 파트 목록(선택 반기 기준) */}
            {data.team ? (
              <TeamPartsRow
                teamHalfId={data.team.teamHalfId}
                teamName={data.team.teamName}
                partCount={data.team.partCount}
                partNames={data.team.partNames}
              />
            ) : null}

            {/* 현재 시점 크루 수(반기 무관) */}
            <TeamCurrentCrewStrip teamHalfId={teamHalfId} crew={data.currentCrew} />

            {/* 파트 × 주차 존재표(선택 반기) — 클럽 상세에서 이관. */}
            <div className="space-y-1">
              <div className="text-sm font-semibold text-muted-foreground">
                파트 × 주차 존재표
              </div>
              <TeamPartWeekMatrix
                teamName={data.team?.teamName ?? data.teamName}
                matrix={data.team?.partWeekMatrix ?? null}
                weekColumns={data.weekColumns}
              />
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
