"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronRight, X } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { AdminDetailTitle } from "@/components/admin/AdminRouteTitleProvider";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import { ORGANIZATION_LABEL_KO, type OrganizationSlug } from "@/lib/organizations";
import { buildAdminContextHref } from "@/lib/adminOrgContext";
import { useActionToast } from "@/lib/actionToast";
import {
  dash,
  toTeamBreadcrumbLabel,
  TeamLeaderProfileRow,
  TeamCurrentCrewStrip,
  TeamPartWeekMatrix,
  type TeamCrewLike,
  type PartWeekColumnLike,
  type PartWeekMatrixLike,
} from "@/components/admin/teamCardShared";

// ── 팀 상세(클럽 상세 → 팀 상세) ──────────────────────────────────────────────
//   두 시점 기준을 분리한다:
//     · 현재 접속 시점(상단): 날짜/주차 · 팀 기본정보/팀장 · 크루 수 · 생성 파트 목록 · 운용 파트 수.
//     · 선택 반기(하단): 파트×주차 존재표(반기 select 만 이걸 바꾼다). 현재 주차 운용 행은 강조.
//   데이터 원천/DTO 는 loadTeamPartsInfo 와 동일 SoT(팀 상세 API가 한 팀만 추출) — 진입 위치별 복제 없음.

type TeamLike = {
  teamHalfId: string;
  teamName: string;
  description: string | null;
  leaderName: string | null;
  leaderBirth6: string | null;
  leaderGender: string | null;
  leaderSchool: string | null;
  leaderMajor: string | null;
  leaderResidence: string | null;
  leaderClassLabel: string | null;
  leaderGradeLabel: string | null;
  partWeekMatrix: PartWeekMatrixLike | null;
};

type HalfOption = { halfKey: string; label: string; isCurrent: boolean; editable: boolean };

type TeamDetailData = {
  organization: string;
  teamName: string;
  currentHalfKey: string | null;
  selectedHalfKey: string | null;
  editable: boolean;
  halves: HalfOption[];
  currentDate: string;
  currentWeek: { label: string } | null;
  currentWeekStartDate: string | null;
  team: TeamLike | null;
  currentCrew: TeamCrewLike;
  generatedParts: string[];
  operatedPartCount: number;
  maxCreatedParts: number;
  selectedTeam: TeamLike | null;
  weekColumns: PartWeekColumnLike[];
};

const CHIP_CLS: Record<OrganizationSlug, string> = {
  encre: "bg-red-500 text-white border-red-600",
  oranke: "bg-yellow-300 text-zinc-900 border-yellow-400",
  phalanx: "bg-green-500 text-white border-green-600",
};

const MAX_PART_NAME = 12;

export default function TeamDetail({
  orgSlug,
  teamHalfId,
}: {
  orgSlug: OrganizationSlug;
  teamHalfId: string;
}) {
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
  const t = useActionToast();

  // 파트 생성 다이얼로그.
  const [createOpen, setCreateOpen] = useState(false);
  const [partName, setPartName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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

  const clubHref = useMemo(
    () =>
      buildAdminContextHref({
        targetPath: `/admin/team-parts/info/${orgSlug}`,
        pathname,
        searchParams,
      }),
    [orgSlug, pathname, searchParams],
  );
  const teamLabel = data ? toTeamBreadcrumbLabel(data.teamName) : "팀 상세";

  const normalizedName = partName.trim();
  const openCreate = () => {
    setPartName("");
    setCreateError(null);
    setCreateOpen(true);
  };
  const submitCreate = async () => {
    if (normalizedName.length === 0 || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch(
        appendModeQuery(`/api/admin/team-parts/info/team-detail/parts`, mode),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organization: orgSlug, teamHalfId, name: normalizedName }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? `생성 실패 (${res.status})`);
      }
      t.success("create", "파트가 생성되었습니다.");
      setCreateOpen(false);
      setPartName("");
      await load(); // 서버 재조회 — 생성 파트 목록·표 행 반영(운용 파트 수는 불변).
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "생성 실패");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Card>
      <AdminDetailTitle
        items={[{ label: clubName, href: clubHref }, { label: teamLabel }]}
      />
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          {/* 상세 breadcrumb(4단계): 클럽 정보 > 팀 내역 > 클럽명 > 팀명. */}
          <nav aria-label="현재 위치" className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Link href="/admin/team-parts/info" className="truncate rounded-sm text-sm text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:text-base">
              클럽 정보
            </Link>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Link href="/admin/team-parts/info" className="truncate rounded-sm text-sm text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:text-base">
              팀 내역
            </Link>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Link href={clubHref} data-team-detail-club-link className="truncate rounded-sm text-sm text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:text-base">
              {clubName}
            </Link>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span data-team-detail-name aria-current="page" className="truncate text-sm font-semibold text-foreground sm:text-base">
              {teamLabel}
            </span>
          </nav>
          <AdminHelp />
        </div>
      </CardHeader>

      <CardContent className="admin-section-stack-lg">
        {error ? (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        ) : null}

        {notFound ? (
          <div data-team-detail-notfound className="rounded-md border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-muted-foreground">
            팀을 찾을 수 없습니다. 삭제되었거나 이 클럽에 속하지 않은 팀입니다.
            <div className="mt-3">
              <Link href={clubHref} className="rounded-sm font-medium text-foreground underline underline-offset-2">
                {clubName} 클럽 상세로 돌아가기
              </Link>
            </div>
          </div>
        ) : loading && !data ? (
          <LoadingState active />
        ) : data ? (
          <>
            {/* [1] 오늘 날짜 · 현재 주차 안내(접속 시점 기준·공통 SoT). */}
            <div
              data-team-detail-today
              className="rounded-md border border-orange-200 bg-orange-50 px-4 py-2.5 text-sm"
            >
              ✓ 오늘은 <strong className="text-foreground">{data.currentDate}</strong>이며, 이번
              주는{" "}
              <strong data-team-detail-week className="text-foreground">
                {data.currentWeek?.label ?? "-"}
              </strong>
              입니다.
            </div>

            {/* [2] 현재 시점 상태 구간 — 팀 기본정보·팀장·크루(현재 반기 기준·selectedHalf 무관).
                파트 관리 행은 아래 표 영역으로 이동(표 바로 위 주요 행). */}
            <section className="space-y-4 rounded-lg border-2 border-dashed border-emerald-300 p-4">
              <div className="text-base font-bold text-emerald-700">
                * 우리 팀의 &lsquo;현재&rsquo; 상태를 보여주는 구간입니다.
              </div>

              {/* 팀 기본 정보(팀 배지 + 개요) */}
              <div className="flex items-start gap-3">
                <span className={"shrink-0 rounded-md border px-3 py-1 text-sm font-bold " + CHIP_CLS[orgSlug]}>
                  {data.team?.teamName ?? data.teamName}
                </span>
                <span className="flex-1 rounded-md border border-input bg-muted/30 px-3 py-1.5 text-sm">
                  {dash(data.team?.description)}
                </span>
              </div>

              {/* 팀장 프로필 */}
              {data.team ? <TeamLeaderProfileRow team={data.team} /> : null}

              {/* 현재 시점 크루 수(전체 크루/정규/심화) — 문구만 "전체 크루"(집계·값 동일). */}
              <TeamCurrentCrewStrip
                teamHalfId={teamHalfId}
                crew={data.currentCrew}
                clubbingLabel="전체 크루"
              />
            </section>

            {/* 파트 관리 + 주차별 파트 운용 상태표.
                ① [파트 수 N │ 생성 파트 목록](좌) | [N / 6 · 파트 생성](우) → ② 표(제목·반기 select 없음). */}
            <section className="space-y-3">
              {/* ① 좌: 파트 수 N │ 생성 파트 배지 · 우: N / 6 · 파트 생성. 좁은 화면 자연 줄바꿈. */}
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                <div className="flex flex-wrap items-center gap-2" data-team-detail-generated-parts>
                  <span className="text-sm font-medium text-muted-foreground">
                    파트 수
                    <strong
                      data-team-detail-operated-part-count
                      className="ml-1 text-base text-foreground"
                    >
                      {data.operatedPartCount}
                    </strong>
                    <span className="mx-2 text-muted-foreground">|</span>
                  </span>
                  {data.generatedParts.length === 0 ? (
                    <span className="text-sm text-muted-foreground">생성된 파트 없음</span>
                  ) : (
                    data.generatedParts.map((p) => (
                      <span
                        key={p}
                        data-generated-part={p}
                        className="rounded-md border border-input bg-background px-2.5 py-1 text-sm font-medium"
                      >
                        {p}
                      </span>
                    ))
                  )}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-3">
                  <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                    <strong className="text-base text-foreground">{data.operatedPartCount}</strong>
                    <span>/ {data.maxCreatedParts}</span>
                    <AdminHelpIconButton
                      helpKey="admin.teamParts.info.summary.operatedPartCount"
                      title="파트 수"
                    />
                  </span>
                  <Button
                    type="button"
                    data-create-team-part-button
                    onClick={openCreate}
                    disabled={!data.editable}
                    title={!data.editable ? "현재·다음 반기에서만 파트를 생성할 수 있습니다." : undefined}
                  >
                    + 파트 생성
                  </Button>
                </div>
              </div>

              {/* ② 파트×주차 존재표 — 제목/반기 select 없이 바로 표 시작. 현재 주차 운용은 파트명 셀만 강조.
                  (선택 반기는 ?half 로만 결정 — UI select 는 제거됨. 기본=현재 반기.) */}
              <TeamPartWeekMatrix
                teamName={data.selectedTeam?.teamName ?? data.teamName}
                matrix={data.selectedTeam?.partWeekMatrix ?? null}
                weekColumns={data.weekColumns}
                currentWeekStartDate={data.currentWeekStartDate}
              />
            </section>
          </>
        ) : null}
      </CardContent>

      {/* ── 파트 생성 다이얼로그 ─────────────────────────────── */}
      {createOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !creating) setCreateOpen(false);
          }}
        >
          <div className="modal-w-sm w-full max-w-md rounded-xl bg-background p-6 shadow-xl ring-1 ring-foreground/10">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold">파트 생성</h2>
              <Button type="button" variant="ghost" size="icon" onClick={() => !creating && setCreateOpen(false)} aria-label="닫기">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-semibold">● 파트명</span>
              {/* 어느 클럽·팀의 파트를 만드는지 안내(입력란 위·현재 페이지 조회 실제 값). */}
              <span className="text-sm font-normal text-muted-foreground">
                {clubName} 클럽 &gt; {teamLabel}의{" "}
                <span className="font-semibold">&lsquo;파트&rsquo;</span>를 생성합니다.
              </span>
              <Input
                data-create-team-part-input
                value={partName}
                maxLength={MAX_PART_NAME}
                autoFocus
                placeholder="생성할 파트명을 입력하세요."
                onChange={(e) => setPartName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitCreate();
                  }
                }}
              />
              <span className="text-xs text-muted-foreground">
                {partName.length}/{MAX_PART_NAME}
              </span>
            </label>
            {createError ? (
              <div data-create-team-part-error className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {createError}
              </div>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => !creating && setCreateOpen(false)}>
                취소
              </Button>
              <Button
                type="button"
                data-create-team-part-submit
                onClick={submitCreate}
                disabled={creating || normalizedName.length === 0}
              >
                {creating ? "생성 중…" : "확인"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
