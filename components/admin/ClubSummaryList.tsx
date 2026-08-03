"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { readOrgParam, buildAdminContextHref } from "@/lib/adminOrgContext";
import { readScopeMode } from "@/lib/userScopeShared";
import { readPeriodParam } from "@/components/admin/HalfPeriodSelect";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";
import type { HalfPeriodMeta } from "@/lib/halfPeriod";

// ── 클럽 목록(상위 페이지) — 각 클럽을 한 행으로 표시하고, 클럽명을 누르면 상세 하위 페이지로 이동 ──
//   · 모든 값 = 선택 반기(?period=) 기준(2026-07-31 확장). 반기 select 자체는 상위
//     TeamPartsSummarySection 이 렌더링하고, 이 컴포넌트는 같은 URL 상태(period)만 읽는다.
//   · 일반/test/actAs/demo·전 org 동일 API·DTO(mode·period 는 조회 컨텍스트로만 전파).
//   · rosterSource/structureSource==="unavailable" 인 지표는 null → "기록 없음" 표시(0 과 구분).

type ClubRow = {
  clubId: string;
  clubSlug: string;
  clubName: string;
  staffCount: number | null;
  teamLeaderCount: number | null;
  ambassadorCount: number | null;
  clubbingCount: number | null;
  regularCrewCount: number | null;
  advancedCrewCount: number | null;
  partCount: number | null;
  partLeaderCount: number | null;
  agentCount: number | null;
};
type Totals = Omit<ClubRow, "clubId" | "clubSlug" | "clubName">;
type SummaryResponse = {
  asOf: string;
  currentWeekLabel: string;
  rows: ClubRow[];
  totals: Totals;
  period: HalfPeriodMeta;
};

// null=기록 없음(그 반기 원장 자체가 없음), 그 외엔 항상 숫자(0 포함) — 절대 섞어 보이지 않는다.
function fmtCell(v: number | null): string {
  return v == null ? "기록 없음" : String(v);
}

// 숫자 컬럼 정의(표시 순서 = 요구 순서). key = ClubRow/Totals 의 숫자 필드.
const NUM_COLUMNS: {
  key: keyof Totals;
  label: string;
  helpKey: string;
}[] = [
  { key: "staffCount", label: "운영진", helpKey: "admin.teamPartsInfoClubs.column.staff" },
  { key: "teamLeaderCount", label: "팀장 수", helpKey: "admin.teamPartsInfoClubs.column.team" },
  { key: "ambassadorCount", label: "앰배서더", helpKey: "admin.teamPartsInfoClubs.column.ambassador" },
  { key: "clubbingCount", label: "클러빙", helpKey: "admin.teamPartsInfoClubs.column.clubbing" },
  { key: "regularCrewCount", label: "정규 크루", helpKey: "admin.teamPartsInfoClubs.column.regular" },
  { key: "advancedCrewCount", label: "심화 크루", helpKey: "admin.teamPartsInfoClubs.column.advanced" },
  { key: "partCount", label: "파트 수", helpKey: "admin.teamPartsInfoClubs.column.part" },
  { key: "partLeaderCount", label: "파트장 수", helpKey: "admin.teamPartsInfoClubs.column.partLeader" },
  { key: "agentCount", label: "에이전트 수", helpKey: "admin.teamPartsInfoClubs.column.agent" },
];

const NUM_TH =
  "border-b border-l px-3 py-2 text-center font-semibold whitespace-nowrap bg-muted/60";
const NUM_TD = "border-b border-l px-3 py-2 text-center tabular-nums";

// 클럽별 텍스트 색 — 앱 공통 클럽 대표색(엥크레 red / 오랑캐 yellow / 팔랑크스 green)과 정합.
//   배지·이모지 없이 클럽명 글자색만으로 구분(흰 배경 가독성 확보 톤). 알 수 없는 clubId 는 기본색.
const CLUB_TEXT_COLOR: Record<string, string> = {
  encre: "text-red-600",
  oranke: "text-yellow-600",
  phalanx: "text-green-600",
};

export default function ClubSummaryList() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const orgFromUrl = readOrgParam(searchParams);
  const mode = readScopeMode(searchParams);
  const period = readPeriodParam(searchParams);

  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useReportLoading(loading);
  // 오래된 응답이 최신 선택을 덮지 않도록 단조 증가 seq 로 폐기(요구 15).
  const reqSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    setError(null);
    // 로딩 중에는 이전 org/mode/period 값이 잔상으로 남지 않도록 비운다(skeleton 표시).
    setData(null);
    try {
      const params = new URLSearchParams({ period });
      if (orgFromUrl) params.set("organization", orgFromUrl);
      if (mode === "test") params.set("mode", "test");
      const res = await fetch(
        `/api/admin/team-parts/info/summary?${params.toString()}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw apiErrorFrom(res, json, `조회 실패 (${res.status})`);
      }
      if (seq !== reqSeqRef.current) return; // 이 응답이 도착하기 전에 반기가 또 바뀜 — 폐기
      setData(json.data as SummaryResponse);
    } catch (e) {
      if (seq !== reqSeqRef.current) return;
      setData(null);
      setError(getApiErrorMessage(e, "조회 실패"));
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, [orgFromUrl, mode, period]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // 상세 페이지 링크(현재 컨텍스트 mode/org 보존). 목적지 path 로 clubId 인코딩.
  const detailHref = useMemo(
    () => (clubId: string) =>
      buildAdminContextHref({
        targetPath: `/admin/team-parts/info/${clubId}`,
        pathname,
        searchParams,
      }),
    [pathname, searchParams],
  );

  const rows = data?.rows ?? [];
  const totals = data?.totals ?? null;
  const showTotals = rows.length > 1 && totals != null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>클럽 현황</CardTitle>
            {data ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {data.period.isCurrentHalf
                  ? "현재 접속 시점("
                  : data.period.asOfDate
                    ? `${data.period.periodLabel} 마지막 유효 시점(`
                    : `${data.period.periodLabel} — 해당 시기 기록이 없습니다(`}
                <span data-club-summary-asof>{data.period.asOfDate ?? "-"}</span>) 기준 ·{" "}
                <span data-club-summary-week>{data.period.weekLabel ?? "-"}</span> · 클럽명을
                누르면 상세 페이지로 이동합니다.
              </p>
            ) : null}
          </div>
          <AdminHelp />
        </div>
      </CardHeader>
      <CardContent className="admin-section-stack-lg">
        {error ? (
          <div
            data-club-summary-error
            className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {error} — 값을 표시할 수 없습니다.
          </div>
        ) : null}

        {loading ? (
          <LoadingState active />
        ) : !error && data ? (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full min-w-[1100px] border-collapse text-sm">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 border-b bg-muted/60 px-3 py-2 text-left font-semibold whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      클럽
                      <AdminHelpIconButton
                        helpKey="admin.teamPartsInfoClubs.column.club"
                        title="클럽"
                      />
                    </span>
                  </th>
                  {NUM_COLUMNS.map((c) => (
                    <th key={c.key} className={NUM_TH}>
                      <span className="inline-flex items-center gap-1">
                        {c.label}
                        <AdminHelpIconButton helpKey={c.helpKey} title={c.label} />
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={NUM_COLUMNS.length + 1}
                      className="px-3 py-6 text-center text-sm text-muted-foreground"
                    >
                      표시할 클럽이 없습니다.
                    </td>
                  </tr>
                ) : (
                  rows.map((club) => (
                    <tr key={club.clubId} data-club-table-row={club.clubId}>
                      <td className="sticky left-0 z-10 border-b bg-background px-3 py-2 text-left whitespace-nowrap">
                        <Link
                          href={detailHref(club.clubId)}
                          data-club-link={club.clubId}
                          className={
                            "rounded-sm font-bold underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring " +
                            (CLUB_TEXT_COLOR[club.clubId] ?? "text-foreground")
                          }
                        >
                          {club.clubName}
                        </Link>
                      </td>
                      {NUM_COLUMNS.map((c) => (
                        <td
                          key={c.key}
                          data-club-cell={c.key}
                          className={
                            NUM_TD + (club[c.key] == null ? " text-muted-foreground" : "")
                          }
                        >
                          {fmtCell(club[c.key])}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
              {showTotals ? (
                <tfoot>
                  <tr data-club-total-row className="bg-muted/60 font-semibold">
                    <td className="sticky left-0 z-10 border-t bg-muted/60 px-3 py-2 text-left whitespace-nowrap">
                      합계
                    </td>
                    {NUM_COLUMNS.map((c) => (
                      <td
                        key={c.key}
                        data-club-total={c.key}
                        className="border-t border-l px-3 py-2 text-center tabular-nums"
                      >
                        {fmtCell(totals![c.key])}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
