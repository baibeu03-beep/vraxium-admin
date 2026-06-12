"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, X, ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { readOrgParam } from "@/lib/adminOrgContext";
import {
  formatBannerPeriod,
  formatFullDateRangeKo,
} from "@/lib/practicalInfoSection0Format";
import LineOpeningStatusBoard from "@/components/admin/LineOpeningStatusBoard";
import CompetencyOpeningLogPanel from "@/components/admin/CompetencyOpeningLogPanel";
import CompetencyApplicantSection from "@/components/admin/CompetencyApplicantSection";

// 실무 역량 [라인 개설] 탭 — 운영 대시보드.
//   상태창(허브 전체 1문장) + 로그창 + [개설 주차 | 아웃풋 링크 1 | 설명 1] 입력행 + [개설 완료]/[개설 취소].
//   개설 완료 = 대상 주차 + org + part_type=competency 라인 is_active 토글(고객 반영) + 주차 공통 아웃풋
//   (링크/설명)을 모든 라인칸에 반영 + snapshot markStale. 개설 취소 = 비활성 + 아웃풋 원복.
//   파트장 신청/검수 단계 없음 — 허브 전체 1회. snapshot 생성/조회·기존 라인 생성 흐름 무변경.
//   ⚠ 아웃풋 이미지는 여기서 입력하지 않는다(이미지 UI 없음).

type Banner = { kind: "success" | "error"; message: string } | null;

type WeekOption = {
  id: string;
  seasonName: string;
  year: number;
  weekNumber: number;
  startDate: string;
  endDate: string;
  canOpen: boolean;
  isOpenTarget: boolean;
  isCurrent: boolean;
};

// 드롭다운 메인 표기 = "26년, 봄 시즌, 1주차" (상태창과 동일 공통 포맷).
function weekMainLabel(w: WeekOption): string {
  return formatBannerPeriod({
    year: w.year,
    seasonName: w.seasonName,
    weekNumber: w.weekNumber,
  });
}

export default function CompetencyOpeningDashboard() {
  const searchParams = useSearchParams();
  const org = readOrgParam(searchParams);

  const [opened, setOpened] = useState<boolean | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [acting, setActing] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  // 상태창·로그창 재조회 신호 — 개설 완료/취소 직후 증가.
  const [refreshKey, setRefreshKey] = useState(0);

  // 개설 주차 드롭다운(주차 목록 표시, 실제 선택 가능=개설 대상 주차만).
  const [weekOptions, setWeekOptions] = useState<WeekOption[]>([]);
  // 아웃풋 링크 1 / 설명 1 — 해당 주차 모든 역량 라인칸 공통 적용.
  const [linkUrl, setLinkUrl] = useState("");
  const [linkDesc, setLinkDesc] = useState("");
  // 초기화 기준값(폼 로드 시점의 prefill). [초기화] = DB 통신 없이 이 값으로 복원.
  const [initialLink, setInitialLink] = useState("");
  const [initialDesc, setInitialDesc] = useState("");

  // 개설 주차 커스텀 드롭다운 열림 상태(메인 표기 + 날짜 도움말 2줄 옵션을 위해 native select 대신 사용).
  const [weekMenuOpen, setWeekMenuOpen] = useState(false);
  const weekMenuRef = useRef<HTMLDivElement>(null);

  // 개설 대상 주차(금요일 경계 = isOpenTarget). practical-info 의 개설할 주차 로직과 동일 SoT.
  const openTargetWeek =
    weekOptions.find((w) => w.isOpenTarget) ?? weekOptions.find((w) => w.isCurrent) ?? null;

  const fetchStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const qs = org ? `?organization=${encodeURIComponent(org)}` : "";
      const res = await fetch(`/api/admin/cluster4/competency/opening-status${qs}`);
      const json = await res.json();
      if (json?.success) {
        setOpened(Boolean(json.data?.opened));
        // 현재 적용된 공통 아웃풋으로 입력칸 prefill(개설 완료/취소 직후 동기화).
        const link = json.data?.outputLink1 ?? "";
        const desc = json.data?.outputDescription ?? "";
        setLinkUrl(link);
        setLinkDesc(desc);
        // [초기화] 기준값 = 로드 시점 prefill.
        setInitialLink(link);
        setInitialDesc(desc);
      } else {
        setOpened(null);
      }
    } catch {
      setOpened(null);
    } finally {
      setLoadingStatus(false);
    }
  }, [org]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // 개설 주차 드롭다운 옵션(최근 주차 목록). 개설 대상 주차만 enabled.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/cluster4/weeks-options?limit=8");
        const json = await res.json();
        if (cancelled) return;
        setWeekOptions(json?.success ? (json.data?.weeks ?? []) : []);
      } catch {
        if (!cancelled) setWeekOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 개설 주차 드롭다운 바깥 클릭 시 닫기.
  useEffect(() => {
    if (!weekMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (weekMenuRef.current && !weekMenuRef.current.contains(e.target as Node)) {
        setWeekMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [weekMenuOpen]);

  // [초기화] — DB 통신 없이 현재 프론트 입력값만 로드 시점(prefill)으로 복원.
  //   (실무 역량 대시보드에는 크루/카페 검수·승인 체크 영역이 없어 링크/설명 입력만 복원한다.)
  const handleReset = useCallback(() => {
    setLinkUrl(initialLink);
    setLinkDesc(initialDesc);
    setWeekMenuOpen(false);
    setBanner(null);
  }, [initialLink, initialDesc]);

  const runAction = useCallback(
    async (action: "open" | "cancel") => {
      if (!org) {
        setBanner({ kind: "error", message: "조직(?org)이 지정되지 않았습니다" });
        return;
      }
      if (
        action === "open" &&
        !confirm("실무 역량 허브 전체 라인을 개설 완료(고객 반영)하시겠습니까?")
      )
        return;
      if (
        action === "cancel" &&
        !confirm("실무 역량 허브 전체 개설을 취소(고객 반영 원복)하시겠습니까?")
      )
        return;
      setActing(true);
      setBanner(null);
      try {
        const body: Record<string, unknown> = { action, organization: org };
        if (action === "open") {
          body.output_link_1 = linkUrl.trim();
          body.output_description = linkDesc.trim();
        }
        const res = await fetch("/api/admin/cluster4/competency/opening", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!json.success) {
          setBanner({ kind: "error", message: json.error ?? "처리에 실패했습니다" });
          return;
        }
        const d = json.data ?? {};
        setBanner({
          kind: "success",
          message:
            action === "open"
              ? `개설 완료 — 역량 라인 ${d.linesChanged ?? 0}/${d.linesTotal ?? 0}개 반영`
              : `개설 취소 — 역량 라인 ${d.linesChanged ?? 0}/${d.linesTotal ?? 0}개 원복`,
        });
        setRefreshKey((k) => k + 1);
        await fetchStatus();
      } catch {
        setBanner({ kind: "error", message: "처리 중 오류가 발생했습니다" });
      } finally {
        setActing(false);
      }
    },
    [org, linkUrl, linkDesc, fetchStatus],
  );

  return (
    <div className="space-y-4">
      {banner && (
        <div
          className={cn(
            "rounded-md border px-4 py-3 text-sm",
            banner.kind === "success"
              ? "border-green-300 bg-green-50 text-green-800"
              : "border-red-300 bg-red-50 text-red-800",
          )}
        >
          {banner.message}
          <button className="float-right" onClick={() => setBanner(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <LineOpeningStatusBoard hub="competency" refreshKey={refreshKey} />
        <CompetencyOpeningLogPanel refreshKey={refreshKey} />
      </div>

      {/* 라인 개설 — 개설 주차 + 주차 공통 아웃풋(링크/설명) 입력 + 개설 완료/취소.
          overflow-visible: 개설 주차 커스텀 드롭다운(absolute)이 Card 의 기본 overflow-hidden 에
          잘리지 않도록 이 카드만 해제(이미지 없음 → 안전). */}
      <Card className="overflow-visible">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">라인 개설</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 버튼 — 글자 길이에 맞춘 content width(좌우 padding만), 한 줄에 [개설] [초기화] [개설 취소]. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => runAction("open")}
              disabled={acting || loadingStatus || !org}
            >
              {acting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              개설
            </Button>
            <Button variant="outline" onClick={handleReset} disabled={acting}>
              초기화
            </Button>
            <Button
              variant="outline"
              className="border-red-300 text-red-700 hover:bg-red-50"
              onClick={() => runAction("cancel")}
              // 기본적으로 개설 완료(opened) 상태일 때만 enabled.
              disabled={acting || loadingStatus || !org || opened !== true}
            >
              {acting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              개설 취소
            </Button>
          </div>
          {!org && (
            <p className="text-sm text-muted-foreground">
              조직(?org)이 지정되어야 개설/취소할 수 있습니다.
            </p>
          )}

          {/* [개설 주차] | [아웃풋 링크 1] | [설명 1] — 한 행 */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                개설 주차 <span className="text-red-500">*</span>
              </Label>
              {/* 커스텀 드롭다운 — 선택값=메인 표기만, 옵션 목록=메인 + 날짜 도움말 2줄.
                  선택 로직 불변(개설 대상 주차 isOpenTarget 만 선택 가능, 나머지 disabled). */}
              <div className="relative" ref={weekMenuRef}>
                <button
                  type="button"
                  aria-label="개설 주차"
                  onClick={() => setWeekMenuOpen((o) => !o)}
                  className="flex w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-left text-sm"
                >
                  <span className={cn(!openTargetWeek && "text-muted-foreground")}>
                    {openTargetWeek
                      ? weekMainLabel(openTargetWeek)
                      : "개설 대상 주차를 계산할 수 없습니다"}
                  </span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
                {weekMenuOpen && weekOptions.length > 0 && (
                  <div className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-background py-1 shadow-md">
                    {weekOptions.map((w) => {
                      const selectable = w.isOpenTarget;
                      const selected = openTargetWeek?.id === w.id;
                      return (
                        <button
                          key={w.id}
                          type="button"
                          disabled={!selectable}
                          onClick={() => setWeekMenuOpen(false)}
                          className={cn(
                            "block w-full px-3 py-1.5 text-left",
                            selectable
                              ? "hover:bg-muted"
                              : "cursor-not-allowed opacity-50",
                            selected && "bg-muted",
                          )}
                        >
                          <div className="text-sm">
                            {weekMainLabel(w)}
                            {w.isOpenTarget ? " · 개설대상" : ""}
                            {w.isCurrent ? " · 현재" : ""}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatFullDateRangeKo(w.startDate, w.endDate)}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                오늘 기준 개설 대상 주차로 자동 고정 · 다른 주차 선택 불가
              </p>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">아웃풋 링크 1</Label>
              <Input
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                placeholder="카페 공표 게시물 링크 (https://...)"
                aria-label="아웃풋 링크 1"
                disabled={acting}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">설명 1</Label>
              <Input
                value={linkDesc}
                onChange={(e) => setLinkDesc(e.target.value)}
                placeholder="아웃풋 링크 1 설명"
                aria-label="설명 1"
                disabled={acting}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* [해당 크루] — 신청/승인 명단(요약 + 수동 추가 + 테이블 + 반려 사유). 개설 완료/취소 시 refreshKey 로 갱신. */}
      <CompetencyApplicantSection refreshKey={refreshKey} />
    </div>
  );
}
