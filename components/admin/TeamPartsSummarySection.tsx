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
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
import { parseHalfKey } from "@/lib/teamHalf";

// ── [섹션.1] 상단 요약 — 기존 팀 내역 요약을 그대로 유지(대체·삭제 금지) ──────────────
//   해당 시기 select · 오늘 날짜/현재 주차 · 전체 클럽/팀/파트 수 · 클럽별 팀 배지(팀장명).
//   신규 클럽 현황 표(ClubSummaryList)는 이 섹션 "아래"에 추가된다(별도 카드).
//   요약 수치 = 현재 접속 시점(서버 SoT), selectedHalf 무관. 배지 목록 = 선택 반기 팀.

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
  currentHalfKey: string | null;
  selectedHalfKey: string | null;
  teams: TeamDto[];
  summary: SummaryDto;
};

const CLUB_LABEL: Record<OrganizationSlug, string> = {
  encre: "엥크레",
  oranke: "오랑캐",
  phalanx: "팔랑크스",
};
const CHIP_CLS: Record<OrganizationSlug, string> = {
  encre: "bg-red-500 text-white border-red-600",
  oranke: "bg-yellow-300 text-zinc-900 border-yellow-400",
  phalanx: "bg-green-500 text-white border-green-600",
};

const SELECT_CLS =
  "rounded-md border border-input bg-background px-3 py-2 text-sm";

const HALF_OPTIONS = [
  "2022-H1",
  "2022-H2",
  "2023-H1",
  "2023-H2",
  "2024-H1",
  "2024-H2",
  "2025-H1",
  "2025-H2",
  "2026-H1",
  "2026-H2",
] as const;

function formatHalf(halfKey: string): string {
  const p = parseHalfKey(halfKey);
  if (!p) return halfKey;
  return `${p.year}년 ${p.period === "H1" ? "상반기" : "하반기"}`;
}
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

  const [half, setHalf] = useState<string | null>(null);
  const [currentHalfKey, setCurrentHalfKey] = useState<string | null>(null);
  const [byOrg, setByOrg] = useState<Record<string, TeamDto[]>>({});
  const [summary, setSummary] = useState<SummaryDto | null>(null);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);

  const load = useCallback(
    async (halfKey: string | null) => {
      setLoading(true);
      try {
        const results = await Promise.all(
          scopeOrgs.map(async (org) => {
            const params = new URLSearchParams({ organization: org });
            if (halfKey) params.set("half", halfKey);
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
        const base = results[0];
        setCurrentHalfKey(base.currentHalfKey);
        setHalf(base.selectedHalfKey);
        setSummary(base.summary);
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
    },
    [mode, scopeOrgs],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(null);
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
        {/* ── [섹션.1] 요약 ─────────────────────────────── */}
        <section className="rounded-lg border border-dashed border-red-300 p-4">
          <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-3">
            {/* 좌: 조회 조건(해당 시기) */}
            <div className="flex shrink-0 items-center gap-2 text-sm font-semibold">
              <span className="inline-flex items-center gap-1">
                <span>● 해당 시기</span>
                <AdminHelpIconButton
                  helpKey="admin.teamParts.info.filter.half"
                  title="해당 시기"
                />
              </span>
              <select
                id="team-parts-half-select"
                className={SELECT_CLS}
                value={half ?? ""}
                onChange={(e) => void load(e.target.value)}
                disabled={loading}
              >
                {HALF_OPTIONS.map((hk) => (
                  <option key={hk} value={hk}>
                    {formatHalf(hk)}
                    {hk === currentHalfKey ? " (현재)" : ""}
                  </option>
                ))}
              </select>
            </div>
            {/* 우: 현재 접속 시점 현황 — 오늘 날짜·주차 + 전체 클럽/팀/파트 수 */}
            <div className="flex min-w-0 flex-wrap items-center justify-start gap-x-4 gap-y-2 lg:flex-nowrap">
              <p className="whitespace-nowrap text-sm text-muted-foreground">
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
              <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 lg:flex-nowrap">
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
                      {CLUB_LABEL[org]}
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
