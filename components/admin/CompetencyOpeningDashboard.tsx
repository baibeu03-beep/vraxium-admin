"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { adminDialog } from "@/components/ui/admin-dialog";
import { cn } from "@/lib/utils";
import { CUSTOM_DROPDOWN_POPUP_CLASS } from "@/lib/customDropdownStyles";
import { readOrgParam } from "@/lib/adminOrgContext";
import { readScopeMode } from "@/lib/userScopeShared";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import {
  formatBannerPeriod,
  formatFullDateRangeKo,
} from "@/lib/practicalInfoSection0Format";
import LineOpeningStatusBoard from "@/components/admin/LineOpeningStatusBoard";
import { LineOpeningSectionDivider } from "@/components/admin/lineOpeningStatusUi";
import CompetencyOpeningLogPanel from "@/components/admin/CompetencyOpeningLogPanel";
import CompetencyApplicantSection from "@/components/admin/CompetencyApplicantSection";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { useToast } from "@/components/ui/toast";
import { useActionToast } from "@/lib/actionToast";
import { LINE_OPENING_RESULT } from "@/lib/lineOpeningResultMessages";
import {
  validateCompetencyOutput,
  COMPETENCY_OUTPUT_MESSAGE,
} from "@/lib/competencyOutputValidation";
import {
  OPENING_INVALID_HIGHLIGHT,
  OPENING_INVALID_HIGHLIGHT_MS,
  scrollFocusInvalidTarget,
} from "@/lib/openingInvalidHighlight";

// 실무 역량 [라인 개설] 탭 — 운영 대시보드.
//   상태창(허브 전체 1문장) + 로그창 + [개설 주차 | 아웃풋 링크 1 | 설명 1] 입력행 + [개설 완료]/[개설 취소].
//   개설 완료 = 대상 주차 + org + part_type=competency 라인 is_active 토글(고객 반영) + 주차 공통 아웃풋
//   (링크/설명)을 모든 라인칸에 반영 + snapshot markStale. 개설 취소 = 비활성 + 아웃풋 원복.
//   파트장 신청/검수 단계 없음 — 허브 전체 1회. snapshot 생성/조회·기존 라인 생성 흐름 무변경.
//   ⚠ 아웃풋 이미지는 여기서 입력하지 않는다(이미지 UI 없음).

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
  // /admin/settings/line-opening-windows 에서 허용한 "해당 주차 전체" 예외 주차.
  //   정규 개설 대상(isOpenTarget)이 아니어도 선택·개설 가능.
  hasOpeningException: boolean;
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
  const router = useRouter();
  const pathname = usePathname();
  const org = readOrgParam(searchParams);
  // 운영/테스트 모드 — 읽기(상태창/신청/개설상태)와 동일 모드를 쓰기(개설/취소)에도 전달한다.
  const mode = readScopeMode(searchParams);
  const { toast } = useToast();
  const t = useActionToast();
  // 운영/테스트 모드 — 개설 완료 시 라인 타깃 생성 가드(서버)와 같은 모드로 판정되도록 보존.

  const [opened, setOpened] = useState<boolean | null>(null);
  // 개설 가능 여부(그 주차 실무 역량 정상 진행 설정) — 프로세스 체크와 동일 SoT. false 면 "미오픈"(개설 차단).
  const [canOpen, setCanOpen] = useState<boolean>(false);
  const [loadingStatus, setLoadingStatus] = useState(true);
  useReportLoading(loadingStatus);
  const [acting, setActing] = useState(false);
  // 상태창·로그창 재조회 신호 — 개설 완료/취소 직후 증가.
  const [refreshKey, setRefreshKey] = useState(0);

  // 개설 주차 드롭다운(주차 목록 표시, 실제 선택 가능=개설 대상 주차만).
  const [weekOptions, setWeekOptions] = useState<WeekOption[]>([]);
  // 아웃풋 링크 1 / 설명 1 — 해당 주차 모든 역량 라인칸 공통 적용(필수 입력).
  const [linkUrl, setLinkUrl] = useState("");
  const [linkDesc, setLinkDesc] = useState("");
  // 필수 입력 누락 시 팝업 확인 후 첫 누락 항목으로 스크롤·포커스하기 위한 ref.
  //   포커스 대상 = Input, 강조/스크롤 대상 = 필드 wrapper(box). practical-info 와 동일 UX 재사용.
  const linkInputRef = useRef<HTMLInputElement>(null);
  const descInputRef = useRef<HTMLInputElement>(null);
  const linkBoxRef = useRef<HTMLDivElement>(null);
  const descBoxRef = useRef<HTMLDivElement>(null);
  // 누락 강조(일시) — 붉은 ring+깜빡임(OPENING_INVALID_HIGHLIGHT)을 입힐 필드. null=강조 없음.
  const [invalidKey, setInvalidKey] = useState<"link" | "desc" | null>(null);
  const invalidTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 누락 강조 즉시 해제(타이머 정리 포함) — 입력 편집·언마운트 시 호출.
  const clearInvalidHighlight = useCallback(() => {
    if (invalidTimerRef.current) {
      clearTimeout(invalidTimerRef.current);
      invalidTimerRef.current = null;
    }
    setInvalidKey((k) => (k === null ? k : null));
  }, []);
  useEffect(
    () => () => {
      if (invalidTimerRef.current) clearTimeout(invalidTimerRef.current);
    },
    [],
  );
  // 초기화 기준값(폼 로드 시점의 prefill). [초기화] = DB 통신 없이 이 값으로 복원.
  const [initialLink, setInitialLink] = useState("");
  const [initialDesc, setInitialDesc] = useState("");
  // 서버가 판정한 개설 대상 주차 시작일(YYYY-MM-DD). 테스트 모드 W13 예외가 반영된 권위값 —
  // 드롭다운 표기를 이 주차로 맞춰 "상태창/실제 개설 대상"과 일치시킨다(운영 모드는 정규 주차).
  const [targetStartDate, setTargetStartDate] = useState<string | null>(null);
  // 사용자가 드롭다운에서 고른 개설 주차(정규 대상 또는 허용 예외 주차). 미선택=정규 대상.
  //   URL(?week)에 보존 — 새로고침 후에도 유지되고, 로그창(CompetencyOpeningLogPanel)이 같은 주차를
  //   조회하도록 SoT 를 URL 로 통일한다(실무 경험과 동일 구조). 초기값 = URL 의 ?week(있으면).
  const [selectedWeekId, setSelectedWeekId] = useState<string | null>(
    () => searchParams?.get("week")?.trim() || null,
  );

  // 주차 변경 — 상태 + URL(?week) 동기화. URL 을 SoT 로 삼아 (a) 새로고침 후 선택 주차 유지,
  //   (b) 형제 로그창이 같은 주차의 개설 로그를 조회하게 한다(개설 대상 밖 예외 주차 포함).
  const onSelectWeek = useCallback(
    (weekId: string) => {
      setSelectedWeekId(weekId);
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (weekId) params.set("week", weekId);
      else params.delete("week");
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [searchParams, pathname, router],
  );

  // 개설 주차 커스텀 드롭다운 열림 상태(메인 표기 + 날짜 도움말 2줄 옵션을 위해 native select 대신 사용).
  const [weekMenuOpen, setWeekMenuOpen] = useState(false);
  const weekMenuRef = useRef<HTMLDivElement>(null);

  // 개설 대상 주차 — 사용자가 고른 주차(selectedWeekId) 우선, 없으면 서버 판정값
  //   (targetStartDate, 테스트 모드 W13 예외 반영) → 정규 금요일 경계(isOpenTarget) → 현재.
  const openTargetWeek =
    (selectedWeekId ? weekOptions.find((w) => w.id === selectedWeekId) : undefined) ??
    (targetStartDate
      ? weekOptions.find((w) => w.startDate === targetStartDate)
      : undefined) ??
    weekOptions.find((w) => w.isOpenTarget) ??
    weekOptions.find((w) => w.isCurrent) ??
    null;
  // 선택 가능 = 정규 개설 대상 OR 허용 예외 주차.
  const isSelectableWeek = (w: WeekOption) => w.isOpenTarget || w.hasOpeningException;

  // 최초 진입: 기본 개설 대상 주차(openTargetWeek)를 URL(?week)에 확정 → 형제 상태창
  //   (LineOpeningStatusBoard, 선택 주차 기준 판정)·로그창이 진입 직후부터 대시보드와 같은 주차를 본다.
  //   URL 만 갱신(상태 setState 없음 — 개설 폼/POST 는 openTargetWeek 파생값이라 URL 만으로 충분).
  //   사용자가 이미 고른 주차(?week seed=selectedWeekId)가 있거나 이미 URL 에 반영됐으면 덮지 않는다.
  //   기본값은 서버 개설 대상과 동일 주차라 resolveEffectiveWeek 가 base 로 귀결(회귀 0) — 예외 주차 선택
  //   시에만 그 주차로 갈린다.
  useEffect(() => {
    if (!openTargetWeek) return;
    const urlWeek = searchParams?.get("week")?.trim() || "";
    if (selectedWeekId || urlWeek === openTargetWeek.id) return;
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("week", openTargetWeek.id);
    router.replace(`${pathname}?${params.toString()}`);
  }, [openTargetWeek, selectedWeekId, searchParams, pathname, router]);

  const fetchStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const params = new URLSearchParams();
      if (org) params.set("organization", org);
      // 선택 주차(허용 예외 포함)가 있으면 그 주차 기준 opened/prefill 조회.
      if (selectedWeekId) params.set("week_id", selectedWeekId);
      const qs = params.toString() ? `?${params.toString()}` : "";
      // mode 보존 — 상태창/개설과 동일 모드로 개설 대상 주차(테스트 W13 예외)를 판정.
      const res = await fetch(`/api/admin/cluster4/competency/opening-status${qs}`);
      const json = await res.json();
      if (json?.success) {
        setOpened(Boolean(json.data?.opened));
        setCanOpen(Boolean(json.data?.canOpen));
        setTargetStartDate(json.data?.targetWeek?.startDate ?? null);
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
        setCanOpen(false);
      }
    } catch {
      setOpened(null);
      setCanOpen(false);
    } finally {
      setLoadingStatus(false);
    }
  }, [org, selectedWeekId]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // 개설 주차 드롭다운 옵션(최근 주차 목록). 개설 대상 주차만 enabled.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // ?org·?hub=competency 전달 → line_opening_windows 예외를 org+역량 스코프로만 드롭다운에 노출.
        const res = await fetch(
          `/api/admin/cluster4/weeks-options?limit=8${
            org ? `&org=${encodeURIComponent(org)}` : ""
          }&hub=competency`,
        );
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
  }, [org]);

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
  }, [initialLink, initialDesc]);

  const runAction = useCallback(
    async (action: "open" | "cancel") => {
      if (!org) {
        toast("error", "클럽(?org)이 지정되지 않았습니다");
        return;
      }
      // 개설(open)은 그 주차 실무 역량 정상 진행 설정이 있어야만 허용 — 서버(409)와 동일 게이트를
      //   클라에서도 선차단(취소는 원복이라 게이트 없음). URL 조작 등으로 버튼이 눌려도 여기서 막힘.
      if (action === "open" && !canOpen) {
        toast("error", "미오픈 — 활동 관리에서 ‘정상 진행’으로 설정한 뒤 개설할 수 있습니다.");
        return;
      }
      // 필수 입력 검증(개설 한정) — 선행 필수값(주차·오픈) 다음, 개설 확인 팝업 이전.
      //   아웃풋 링크 1·설명 1 은 모두 필수(공백만=미입력). 하나라도 비면 개설 중단하고
      //   팝업으로 첫 누락 항목 하나만 안내한 뒤, 확인을 누르면 그 칸으로 스크롤·포커스한다.
      if (action === "open") {
        const missing = validateCompetencyOutput(linkUrl, linkDesc);
        if (missing) {
          // "description" = 링크는 채워졌고 설명만 누락 → 설명 칸. 그 외(both/link)는 링크 칸.
          const key = missing === "description" ? "desc" : "link";
          const scrollFocus = () =>
            scrollFocusInvalidTarget(
              (key === "desc" ? descBoxRef : linkBoxRef).current,
              (key === "desc" ? descInputRef : linkInputRef).current,
            );
          // ⚠ practical-info 와 동일: 팝업을 열기 전에 먼저 강조 + 스크롤/포커스한다(팝업 닫힘 시 포커스
          //    복원이 [개설 완료] 버튼이 아니라 이 필드로 향하도록). 약 1.6s 후 강조 해제(무한 깜빡임 금지).
          if (invalidTimerRef.current) {
            clearTimeout(invalidTimerRef.current);
            invalidTimerRef.current = null;
          }
          setInvalidKey(key);
          scrollFocus();
          await adminDialog.alert({
            variant: "warning",
            title: "필수 입력 확인",
            description: COMPETENCY_OUTPUT_MESSAGE[missing],
          });
          requestAnimationFrame(scrollFocus);
          invalidTimerRef.current = setTimeout(() => setInvalidKey(null), OPENING_INVALID_HIGHLIGHT_MS);
          return;
        }
      }
      if (action === "open") {
        const ok = await adminDialog.confirm({
          title: "실무 역량 허브 개설 완료",
          description: "실무 역량 허브 전체 라인을 개설 완료(크루 반영)하시겠습니까?",
          confirmLabel: "개설 완료",
        });
        if (!ok) return;
      }
      if (action === "cancel") {
        const ok = await adminDialog.confirm({
          variant: "warning",
          title: "개설 취소",
          description: "실무 역량 허브 전체 개설을 취소(크루 반영 원복)하시겠습니까?",
          confirmLabel: "개설 취소",
        });
        if (!ok) return;
      }
      setActing(true);
      try {
        const body: Record<string, unknown> = { action, organization: org };
        // 운영/테스트 모드 — 읽기와 동일 모드로 개설/취소(대상 사용자 스코프 + 예외 주차 판정). 서버 fail-closed.
        if (mode === "test") body.mode = "test";
        // 선택한 개설 주차(허용 예외 포함) 전달 — 서버가 정규 대상/예외 주차만 허용(fail-closed).
        if (openTargetWeek) body.week_id = openTargetWeek.id;
        if (action === "open") {
          body.output_link_1 = linkUrl.trim();
          body.output_description = linkDesc.trim();
        }
        const res = await fetch(
          "/api/admin/cluster4/competency/opening",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const json = await res.json();
        if (!json.success) {
          console.error("[competency] open/cancel failed", json?.error);
          t.error(action === "cancel" ? "cancel" : "open", { status: res.status });
          return;
        }
        const d = json.data ?? {};
        // 실제 반영 수(reflectedLines/reflectedCrews) = 사전 토글 + 신청 반영/삭제 합산.
        //   competency 라인은 전부 common 마스터 → linesChanged/linesTotal 은 항상 0(loadOrgCompetencyLines
        //   가 common 제외). 실제 개설은 신청 반영(openedLines) 경로이므로 그 합산값을 표시해야 "0/0" 오표시를
        //   피한다. (구 필드 폴백: reflectedLines 미제공 시 openedLines+linesChanged 로 계산.)
        const reflectedLines =
          d.reflectedLines ?? (d.openedCrews ?? 0) + (d.linesChanged ?? 0);
        const reflectedCrews = d.reflectedCrews ?? d.openedCrews ?? 0;
        console.warn("[line-opening] competency open/cancel", {
          reflectedLines,
          reflectedCrews,
          rejectedCrews: d.rejectedCrews,
          action,
        });
        toast(
          "success",
          action === "cancel"
            ? LINE_OPENING_RESULT.cancelSuccess
            : LINE_OPENING_RESULT.openSuccess,
        );
        setRefreshKey((k) => k + 1);
        await fetchStatus();
      } catch {
        toast("error", "처리 중 오류가 발생했습니다");
      } finally {
        setActing(false);
      }
    },
    [org, mode, linkUrl, linkDesc, fetchStatus, openTargetWeek, toast, t, canOpen],
  );

  return (
    <div className="space-y-4">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <LineOpeningStatusBoard hub="competency" refreshKey={refreshKey} />
        <CompetencyOpeningLogPanel refreshKey={refreshKey} />
      </div>

      {/* 상태창(위)과 라인 개설(아래)을 명확히 분리 — 공용 구분선 + 바깥 여백. */}
      <LineOpeningSectionDivider />

      {/* 라인 개설 — 개설 주차 + 주차 공통 아웃풋(링크/설명) 입력 + 개설 완료/취소.
          overflow-visible: 개설 주차 커스텀 드롭다운(absolute)이 Card 의 기본 overflow-hidden 에
          잘리지 않도록 이 카드만 해제(이미지 없음 → 안전). */}
      <Card className="overflow-visible">
        <CardHeader className="pb-3">
          <CardTitle className="inline-flex items-center gap-1.5 text-base">
            라인 개설
            <AdminHelpIconButton
              size="sm"
              helpKey="admin.competency.dashboard.section.lineOpening"
              title="라인 개설 (허브 전체)"
            />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 액션 버튼([개설]/[초기화]/[개설 취소])은 '해당 크루' 아래 최종 액션 영역으로 이동.
              이 카드에는 기본 정보(개설 주차·아웃풋 링크/설명) 입력만 남긴다. */}
          {/* [개설 주차] | [아웃풋 링크 1] | [설명 1] — 한 행 */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                개설 주차 <span className="text-red-500">*</span>
                <AdminHelpIconButton
                  helpKey="admin.competency.dashboard.input.openWeek"
                  title="개설 주차"
                />
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
                  <div className={CUSTOM_DROPDOWN_POPUP_CLASS}>
                    {weekOptions.map((w) => {
                      const selectable = isSelectableWeek(w);
                      const selected = openTargetWeek?.id === w.id;
                      return (
                        <button
                          key={w.id}
                          type="button"
                          disabled={!selectable}
                          onClick={() => {
                            if (selectable) onSelectWeek(w.id);
                            setWeekMenuOpen(false);
                          }}
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
                            {w.isOpenTarget ? " · 개설 대상" : ""}
                            {w.hasOpeningException ? " · 허용 주차" : ""}
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
              <p className="text-xs text-muted-foreground">
                오늘 기준 개설 대상 주차로 자동 고정 · 허용된 예외 주차(설정 &gt; 라인 개설 기간)만
                추가 선택 가능
              </p>
            </div>

            <div
              ref={linkBoxRef}
              className={cn("space-y-1", invalidKey === "link" && OPENING_INVALID_HIGHLIGHT)}
            >
              <Label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                아웃풋 링크 1 <span className="text-red-500">*</span>
                <AdminHelpIconButton
                  helpKey="admin.competency.dashboard.input.outputLink1"
                  title="아웃풋 링크 1"
                />
              </Label>
              <Input
                ref={linkInputRef}
                value={linkUrl}
                onChange={(e) => {
                  clearInvalidHighlight();
                  setLinkUrl(e.target.value);
                }}
                placeholder="카페 공표 게시물 링크 (https://...)"
                aria-label="아웃풋 링크 1"
                aria-invalid={invalidKey === "link" || undefined}
                disabled={acting}
              />
            </div>

            <div
              ref={descBoxRef}
              className={cn("space-y-1", invalidKey === "desc" && OPENING_INVALID_HIGHLIGHT)}
            >
              <Label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                설명 1 <span className="text-red-500">*</span>
                <AdminHelpIconButton
                  helpKey="admin.competency.dashboard.input.outputDesc1"
                  title="설명 1"
                />
              </Label>
              <Input
                ref={descInputRef}
                value={linkDesc}
                onChange={(e) => {
                  clearInvalidHighlight();
                  setLinkDesc(e.target.value);
                }}
                placeholder="아웃풋 링크 1 설명"
                aria-label="설명 1"
                aria-invalid={invalidKey === "desc" || undefined}
                disabled={acting}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* [해당 크루] — 신청/승인 명단(요약 + 수동 추가 + 테이블 + 반려 사유). 개설 완료/취소 시 refreshKey 로 갱신.
          selectedWeekId = 상단에서 선택한 개설 주차 — 명단 조회/수동 추가가 그 주차를 대상으로 하도록 전달(상태창과 동일 주차). */}
      <CompetencyApplicantSection
        refreshKey={refreshKey}
        selectedWeekId={openTargetWeek?.id ?? null}
      />

      {/* 최종 액션 (기본 정보·해당 크루 다음 최하단) — [개설] [초기화] [개설 취소].
          모든 정보를 확인한 뒤 마지막에 실행하는 최종 액션 영역. 기능/조건/API 는 기존과 동일. */}
      <div className="space-y-2 border-t pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => runAction("open")}
            loading={acting}
            // 개설은 그 주차 실무 역량이 "정상 진행" 으로 설정된 경우에만 가능(프로세스 체크와 동일 SoT).
            //   미오픈이면 버튼 라벨 자체를 "미오픈" 으로 바꿔 왜 개설이 안 되는지 즉시 드러낸다.
            disabled={acting || loadingStatus || !org || !canOpen}
            className="h-11 px-6 text-base"
          >
            {org && !loadingStatus && !canOpen ? "미오픈" : "개설"}
          </Button>
          <AdminHelpIconButton
            helpKey="admin.lineOpening.competency.action.open"
            title="개설"
            size="sm"
          />
          <Button
            variant="outline"
            onClick={handleReset}
            disabled={acting}
            className="h-11 px-6 text-base"
          >
            초기화
          </Button>
          <AdminHelpIconButton
            helpKey="admin.lineOpening.competency.action.reset"
            title="초기화"
            size="sm"
          />
          <Button
            variant="outline"
            className="h-11 border-red-300 px-6 text-base text-red-700 hover:bg-red-50"
            onClick={() => runAction("cancel")}
            loading={acting}
            // 기본적으로 개설 완료(opened) 상태일 때만 enabled.
            disabled={acting || loadingStatus || !org || opened !== true}
          >
            개설 취소
          </Button>
          <AdminHelpIconButton
            helpKey="admin.lineOpening.competency.action.cancel"
            title="개설 취소"
            size="sm"
          />
        </div>
        {!org && (
          <p className="text-sm text-muted-foreground">
            클럽(?org)이 지정되어야 개설/취소할 수 있습니다.
          </p>
        )}
        {/* 개설 차단 표시 — "미오픈" 한 단어로 이유를 즉시 드러낸다(내부 개념 노출 없음).
            드롭다운으로 다른(정상 진행) 주차를 선택하면 canOpen 재계산되어 개설 가능해진다. */}
        {org && !loadingStatus && !canOpen && (
          <div className="space-y-0.5">
            <p className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
              <span aria-hidden>⚪</span> 미오픈
            </p>
            <p className="text-xs text-muted-foreground">
              활동 관리에서 해당 라인을 ‘정상 진행’으로 설정하면 개설할 수 있습니다.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
