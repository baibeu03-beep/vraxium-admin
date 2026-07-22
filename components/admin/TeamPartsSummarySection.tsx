"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { readOrgParam } from "@/lib/adminOrgContext";
import { readScopeMode } from "@/lib/userScopeShared";
import {
  ORGANIZATIONS,
  organizationLabelKo,
  type OrganizationSlug,
} from "@/lib/organizations";

// ── [섹션.1] 상단 요약 — **현재 접속 시점(today) 전용** ──────────────────────────────
//   오늘 날짜·현재 주차 · 전체 클럽/팀/파트 수 · 클럽별 팀 배지(팀장명). 모두 현재 시점 기준.
//   ⚠ `해당 시기`(selectedHalf) 선택 UI 는 여기에 두지 않는다 — 그것은 상세 페이지 전용이다.
//     상위 페이지는 "현재 조직 현황"만 보여주며 selectedHalf 를 사용하지 않는다.
//   신규 클럽 현황 표(ClubSummaryList)도 현재 시점 기준으로 이 섹션 "아래"에 온다.

type TeamDto = {
  teamName: string;
  leaderName: string | null;
};

type SummaryDto = {
  currentDate: string;
  currentWeek: {
    year: number;
    seasonName: string;
    weekNumber: number | null;
    label: string;
  } | null;
  counts: { totalClubs: number; totalTeams: number; totalParts: number };
};

type InfoDto = {
  teams: TeamDto[];
  summary: SummaryDto;
};

// 클럽 표시명 = lib/organizations 단일 SoT(organizationLabelKo).
const CHIP_CLS: Record<OrganizationSlug, string> = {
  encre: "bg-red-500 text-white border-red-600",
  oranke: "bg-yellow-300 text-zinc-900 border-yellow-400",
  phalanx: "bg-green-500 text-white border-green-600",
};

function dash(v: string | number | null | undefined): string {
  return v === null || v === undefined || v === "" ? "-" : String(v);
}

export default function TeamPartsSummarySection() {
  const searchParams = useSearchParams();
  const orgFromUrl = readOrgParam(searchParams);
  const mode = readScopeMode(searchParams);
  // 개별 경로(?org={slug}) = URL org 1개, 통합(org 없음) = 전 조직 배지.
  const scopeOrgs = useMemo(
    () => (orgFromUrl ? [orgFromUrl] : [...ORGANIZATIONS]),
    [orgFromUrl],
  );

  const [byOrg, setByOrg] = useState<Record<string, TeamDto[]>>({});
  const [summary, setSummary] = useState<SummaryDto | null>(null);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);

  // 현재 시점 조회 — half 파라미터를 넘기지 않는다(서버가 현재 반기로 기본 선택).
  //   요약(날짜/주차/전체 수치)은 selectedHalf 와 무관한 현재 시점 값이고, 배지 목록은 현재 반기 팀이다.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const results = await Promise.all(
        scopeOrgs.map(async (org) => {
          const params = new URLSearchParams({ organization: org });
          if (mode === "test") params.set("mode", "test");
          const res = await fetch(
            `/api/admin/team-parts/info?${params.toString()}`,
            { cache: "no-store" },
          );
          const json = await res.json();
          if (!res.ok || !json.success) {
            throw new Error(json?.error ?? `조회 실패 (${res.status})`);
          }
          return json.data as InfoDto;
        }),
      );
      setSummary(results[0].summary);
      const map: Record<string, TeamDto[]> = {};
      scopeOrgs.forEach((org, i) => {
        map[org] = results[i].teams;
      });
      setByOrg(map);
    } catch {
      setByOrg({});
    } finally {
      setLoading(false);
    }
  }, [mode, scopeOrgs]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>팀 내역</CardTitle>
          <AdminHelp />
        </div>
      </CardHeader>
      <CardContent>
        {/* ── [섹션.1] 요약(현재 시점 전용) ─────────────────────────── */}
        <section className="rounded-lg border border-dashed border-red-300 p-4">
          {/* 좌: 오늘 날짜·현재 주차 / 우(맨 끝): 전체 클럽·팀·파트 수. ml-auto 로 카드 오른쪽 끝 고정. */}
          <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-3">
            <p className="min-w-0 whitespace-nowrap text-sm text-muted-foreground">
              오늘은{" "}
              <span
                className="text-base font-semibold text-foreground"
                data-current-date
              >
                {summary?.currentDate ?? "-"}
              </span>
              이고,{" "}
              <span
                className="text-base font-semibold text-foreground"
                data-current-week
              >
                {summary?.currentWeek?.label ?? "-"}
              </span>
              입니다.
            </p>
            <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-x-4 gap-y-1 lg:flex-nowrap">
              <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-sm">
                · 전체 클럽 수{" "}
                <strong id="team-parts-club-count" className="text-base">
                  {summary?.counts.totalClubs ?? 0}
                </strong>
                <AdminHelpIconButton
                  helpKey="admin.teamParts.info.summary.clubCount"
                  title="전체 클럽 수"
                />
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-sm">
                · 전체 팀 수{" "}
                <strong id="team-parts-total-team-count" className="text-base">
                  {summary?.counts.totalTeams ?? 0}
                </strong>
                <AdminHelpIconButton
                  helpKey="admin.teamParts.info.summary.totalTeams"
                  title="전체 팀 수"
                />
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-sm">
                · 전체 파트 수{" "}
                <strong id="team-parts-total-part-count" className="text-base">
                  {summary?.counts.totalParts ?? 0}
                </strong>
                <AdminHelpIconButton
                  helpKey="admin.teamParts.info.summary.totalParts"
                  title="전체 파트 수"
                />
              </span>
            </div>
          </div>

          {loading ? (
            <LoadingState active />
          ) : (
            <div className="space-y-4 rounded-md bg-sky-50 p-4">
              {scopeOrgs.map((org) => {
                const teams = byOrg[org] ?? [];
                return (
                  <div
                    key={org}
                    data-club-row={org}
                    className="flex items-start gap-4"
                  >
                    <div className="w-20 shrink-0 pt-1 text-sm font-bold">
                      {organizationLabelKo(org)}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-3">
                      {teams.length === 0 ? (
                        <span className="text-sm text-muted-foreground">
                          팀 없음
                        </span>
                      ) : (
                        teams.map((team) => (
                          <div
                            key={team.teamName}
                            className="flex flex-col items-center gap-1"
                          >
                            <span
                              className={
                                "rounded-md border px-3 py-1 text-sm font-bold " +
                                CHIP_CLS[org]
                              }
                            >
                              {team.teamName}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {dash(team.leaderName)}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
