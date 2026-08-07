"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import HalfPeriodSelect, { readPeriodParam } from "@/components/admin/HalfPeriodSelect";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { readOrgParam } from "@/lib/adminOrgContext";
import { readScopeMode } from "@/lib/userScopeShared";
import {
  ORGANIZATIONS,
  organizationLabelKo,
  type OrganizationSlug,
} from "@/lib/organizations";

// ── [섹션.1] 상단 요약 ────────────────────────────────────────────────────────────
//   "오늘은 …" 문구(날짜·주차)는 **항상 실제 오늘** — 선택 반기와 무관(2026-07-31 사용자 확정).
//   전체 클럽/팀/파트 수·클럽별 팀 배지(팀장명)는 **선택 반기(?period=)** 기준으로 바뀐다.
//   `해당 시기` select 는 "오늘은 …" 문구 왼쪽에 둔다 — 클럽 상세·팀 상세와 같은 컴포넌트
//   (HalfPeriodSelect) 를 공유하고, URL 이 유일한 상태다(로컬 half state 없음).

type TeamDto = {
  teamName: string;
  leaderName: string | null;
  isActive: boolean;
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
  const period = readPeriodParam(searchParams);
  // 개별 경로(?org={slug}) = URL org 1개, 통합(org 없음) = 전 조직 배지.
  const scopeOrgs = useMemo(
    () => (orgFromUrl ? [orgFromUrl] : [...ORGANIZATIONS]),
    [orgFromUrl],
  );

  const [byOrg, setByOrg] = useState<Record<string, TeamDto[]>>({});
  const [summary, setSummary] = useState<SummaryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useReportLoading(loading);
  // 오래된 응답이 최신 선택을 덮지 않도록 단조 증가 seq 로 폐기(요구 15).
  const reqSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError(false);
    // 반기 전환 시 이전 반기 데이터가 새 제목 아래 잠시 보이지 않도록 비운다.
    setByOrg({});
    setSummary(null);
    try {
      const results = await Promise.all(
        scopeOrgs.map(async (org) => {
          const params = new URLSearchParams({ organization: org, period });
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
      if (seq !== reqSeqRef.current) return; // 이 응답이 도착하기 전에 반기가 또 바뀜 — 폐기
      setSummary(results[0].summary);
      // ⚠ "● 해당 시기" 요약은 관리 원장과 달리 **그 시기에 실제 존재하는 팀만** 보여야 한다
      //   (2026-08-08). API 응답(data.teams)은 관리 원장과 공유하는 계약이라 삭제된 팀도 함께
      //   내려온다 — 여기서만 isActive 로 걸러서 렌더한다(원장 쪽은 그대로 전부 보여줘야 하므로
      //   서버에서 미리 자르지 않는다).
      const map: Record<string, TeamDto[]> = {};
      scopeOrgs.forEach((org, i) => {
        map[org] = results[i].teams.filter((t) => t.isActive);
      });
      setByOrg(map);
    } catch {
      if (seq !== reqSeqRef.current) return;
      // 오류 시 기존 데이터를 비운 채 오류만 표시(잘못된 반기처럼 0 을 보여주지 않는다).
      setError(true);
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, [mode, period, scopeOrgs]);

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
        {/* ── [섹션.1] 요약 ────────────────────────────────────────── */}
        <section className="rounded-lg border border-dashed border-red-300 p-4">
          {/* 좌: 해당 시기 select + 오늘 날짜·현재 주차 / 우(맨 끝): 전체 클럽·팀·파트 수(선택 반기 기준).
              ml-auto 로 카드 오른쪽 끝 고정. 좁은 화면은 자연 줄바꿈, select 내부 문구만 nowrap. */}
          <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-3">
            <HalfPeriodSelect />
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

          {error ? (
            <div
              data-team-parts-summary-error
              className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              조회 실패 — 값을 표시할 수 없습니다.
            </div>
          ) : null}

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
