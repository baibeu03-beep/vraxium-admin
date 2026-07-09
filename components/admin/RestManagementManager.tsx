"use client";

// /admin/rest-management — 크루 휴식 신청 관리(상단 요약).
//
//   [0] 클럽 탭(엥크레/오랑캐/팔랑크스) — ?org 전환. mode=test 보존.
//   [1] 시즌 드롭다운 — 현재(운영) 시즌 기본. 시즌 1개씩만 조회("전체 시즌" 없음).
//   [2~5] 요약 카드 — 전체 / 정상 / 긴급 / 크루(distinct user_id).
//   [6][7] 버튼([긴급 휴식 신청]/[전체 승인]) — 이번 작업은 배치만(다음 작업에서 구현).
//
// 신청 목록(Table)은 다음 작업. 집계는 실제 DB(vacation_requests) 기준.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { readOrgParam, orgHref } from "@/lib/adminOrgContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
import {
  getCurrentActivityDateIso,
  operationalSeasonDbKey,
} from "@/lib/seasonCalendar";
import { cn } from "@/lib/utils";
import type {
  RestManagementSeasonOption,
  RestManagementSummary,
} from "@/lib/adminRestManagementData";

const BASE_PATH = "/admin/rest-management";

const CLUB_LABEL_KO: Record<OrganizationSlug, string> = {
  encre: "엥크레",
  oranke: "오랑캐",
  phalanx: "팔랑크스",
};

// org 대표색(요약 영역 상단 액센트 · 클럽 표기 점). 팔레트는 조정 가능한 최소 기준값.
const ORG_ACCENT: Record<OrganizationSlug, { bar: string; dot: string }> = {
  encre: { bar: "bg-violet-500", dot: "bg-violet-500" },
  oranke: { bar: "bg-amber-500", dot: "bg-amber-500" },
  phalanx: { bar: "bg-emerald-500", dot: "bg-emerald-500" },
};

const EMPTY_SUMMARY: RestManagementSummary = {
  total: 0,
  normal: 0,
  urgent: 0,
  crews: 0,
};

const NEXT_TASK_MSG = "다음 작업에서 구현됩니다.";

// 요약 카드 1장. tone=urgent 면 숫자에 강조색(긴급).
function StatCard({
  label,
  value,
  suffix,
  tone = "default",
  loading,
}: {
  label: string;
  value: number;
  suffix?: string;
  tone?: "default" | "urgent";
  loading: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1.5 py-5">
        <span className="text-sm font-medium text-muted-foreground">
          {label}
        </span>
        <span
          className={cn(
            "text-4xl font-bold tracking-tight tabular-nums",
            tone === "urgent" ? "text-rose-600 dark:text-rose-400" : "text-foreground",
          )}
        >
          {loading ? "—" : value.toLocaleString()}
          {suffix ? (
            <span className="ml-1 text-lg font-semibold text-muted-foreground">
              {suffix}
            </span>
          ) : null}
        </span>
      </CardContent>
    </Card>
  );
}

export default function RestManagementManager() {
  const searchParams = useSearchParams();
  const org = readOrgParam(searchParams);
  const mode = readScopeMode(searchParams);

  const [seasons, setSeasons] = useState<RestManagementSeasonOption[]>([]);
  // selectedSeason: 드롭다운 선택 시즌. 초기값 = 현재(운영) 시즌(seasonCalendar 는 browser-safe).
  //   서버가 반환하는 seasons 목록에 현재 시즌이 항상 포함되므로 옵션에 존재한다.
  const [selectedSeason, setSelectedSeason] = useState<string>(
    () => operationalSeasonDbKey(getCurrentActivityDateIso()) ?? "",
  );
  const [summary, setSummary] = useState<RestManagementSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState<boolean>(Boolean(org));
  const [error, setError] = useState<string | null>(null);
  useReportLoading(loading);

  const reqRef = useRef(0);

  // org / selectedSeason 기준 요약 조회. (드롭다운 표시값 selectedSeason 은 load 안에서 쓰지 않는다)
  const load = useCallback(async () => {
    if (!org) {
      setLoading(false);
      return;
    }
    const reqId = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ organization: org });
      if (selectedSeason) qs.set("season_key", selectedSeason);
      const res = await fetch(
        `/api/admin/rest-management/summary?${qs.toString()}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (reqId !== reqRef.current) return;
      if (!res.ok || !json?.success) {
        throw new Error(json?.error ?? "요약을 불러오지 못했습니다.");
      }
      setSeasons(json.seasons ?? []);
      setSummary(json.summary ?? EMPTY_SUMMARY);
    } catch (err) {
      if (reqId !== reqRef.current) return;
      setError(err instanceof Error ? err.message : "요약을 불러오지 못했습니다.");
      setSummary(EMPTY_SUMMARY);
    } finally {
      if (reqId === reqRef.current) setLoading(false);
    }
  }, [org, selectedSeason]);

  // org 변경 / 시즌 선택 변경 시 재조회. (effect 내 동기 setState 회피 — 마이크로태스크로 지연)
  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const tabs = ORGANIZATIONS.map((slug) => ({
    label: CLUB_LABEL_KO[slug],
    href: appendModeQuery(orgHref(BASE_PATH, slug), mode),
    active: org === slug,
  }));

  const accent = org ? ORG_ACCENT[org] : null;

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHeader title="휴식 관리" tabs={tabs} />

      {!org ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            상단 탭에서 클럽(엥크레 · 오랑캐 · 팔랑크스)을 선택하세요.
          </CardContent>
        </Card>
      ) : (
        <>
          {error ? (
            <Card>
              <CardContent className="py-4 text-sm text-destructive">
                {error}
              </CardContent>
            </Card>
          ) : null}

          {/* 요약 영역 */}
          <Card className="relative overflow-hidden">
            {accent ? (
              <span
                aria-hidden
                className={cn("absolute inset-x-0 top-0 h-1", accent.bar)}
              />
            ) : null}
            <CardContent className="flex flex-col gap-5 pt-6">
              {/* 시즌 선택(좌) + 액션 버튼(우) */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  {accent ? (
                    <span
                      aria-hidden
                      className={cn("h-2.5 w-2.5 rounded-full", accent.dot)}
                    />
                  ) : null}
                  <span className="text-base font-semibold text-foreground">
                    {CLUB_LABEL_KO[org]}
                  </span>
                  <Select
                    value={selectedSeason}
                    onValueChange={(v) => {
                      const next = v ?? "";
                      if (next) setSelectedSeason(next); // 표시 + 재조회 트리거
                    }}
                  >
                    {/* 폭 확대(≈248px, 최소 220~260 의도) · 모바일은 화면폭 초과 방지. */}
                    <SelectTrigger className="w-[248px] max-w-[calc(100vw-3rem)]">
                      <SelectValue placeholder="시즌 선택" />
                    </SelectTrigger>
                    <SelectContent>
                      {seasons.map((s) => (
                        <SelectItem key={s.season_key} value={s.season_key}>
                          {s.season_label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="destructive"
                    onClick={() => window.alert(NEXT_TASK_MSG)}
                  >
                    긴급 휴식 신청
                  </Button>
                  <Button onClick={() => window.alert(NEXT_TASK_MSG)}>
                    전체 승인
                  </Button>
                </div>
              </div>

              {/* 집계 카드 */}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <StatCard label="전체" value={summary.total} suffix="건" loading={loading} />
                <StatCard label="정상" value={summary.normal} suffix="건" loading={loading} />
                <StatCard
                  label="긴급"
                  value={summary.urgent}
                  suffix="건"
                  tone="urgent"
                  loading={loading}
                />
                <StatCard label="크루" value={summary.crews} suffix="명" loading={loading} />
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
