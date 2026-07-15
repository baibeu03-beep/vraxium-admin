"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Upload, Trash2, X, Lock, Unlock } from "lucide-react";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { adminDialog } from "@/components/ui/admin-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatClubDate } from "@/lib/clubDate";
import { formatBannerPeriod } from "@/lib/practicalInfoSection0Format";
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";
import CafeCrewPicker, {
  type CafeCrew,
  type CafeCrewMeta,
} from "@/components/admin/CafeCrewPicker";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { useToast } from "@/components/ui/toast";
import { useActionToast } from "@/lib/actionToast";
import { LINE_OPENING_RESULT, lineOpenSuccessMessage } from "@/lib/lineOpeningResultMessages";

// 실무 정보 라인 개설 폼 — [섹션 0] 하단 실제 개설 영역.
//   (1) 개설할 주차: getOpenableWeekStartMs(금요일 경계 규칙)로 자동 고정 + disabled.
//   (2) 개설할 라인: practical_info 활동 유형 9종(위즈덤 … 기타A).
//   (3) 메인 타이틀: 직접 입력(textarea) + "일반" 버튼(고정 문구 삽입).
//   (4) 아웃풋: 링크 1개(주소+설명) + 이미지 1개(파일+설명) — 둘 다 필수.
//   (5) 라인 개설 크루: 네이버 카페 검수(매칭) + 수동 추가/삭제/초기화.
//       0명 개설 허용 — 0명이면 그 주차/라인은 전체 크루 강화 실패, 1명↑이면 그 크루만 대기→성공.
//   (6) 저장: POST /api/admin/cluster4/info-lines (target_user_ids=후보 목록, cafe 메타 포함).

// "일반" 버튼 고정 문구.
const GENERAL_MAIN_TITLE =
  "해당 주제에 대한 [실무 정보] 를 인지, 탐구, 분석하여, 관련 산업/커리어를 향상시켰습니다.";

export type OpeningFormWeek = {
  id: string;
  seasonName: string;
  year: number;
  weekNumber: number;
  startDate: string;
  endDate: string;
  isOfficialRest: boolean;
  canOpen: boolean;
  isOpenTarget?: boolean;
  isCurrent?: boolean;
  submissionOpensAt: string | null;
  submissionClosesAt: string | null;
};

// 라인 개설 예외(line_opening_windows /active) 주차 — OpeningFormWeek + 허용 라인.
//   allowedActivityTypeIds: null = 해당 주차 전체 허용, 배열 = 그 라인들만 허용.
//   canOpen 은 항상 true(예외는 자동 정책의 휴식 차단을 덮어쓴다).
export type ExceptionFormWeek = OpeningFormWeek & {
  allowedActivityTypeIds: string[] | null;
};

type ActivityTypeOption = { id: string; name: string };

type UploadedImage = { url: string; name: string };

// "26년, 여름 시즌, 3주차" — 시즌·주차 공통 포맷(formatBannerPeriod SoT).
function weekTitle(w: OpeningFormWeek): string {
  return formatBannerPeriod({
    year: w.year,
    seasonName: w.seasonName,
    weekNumber: w.weekNumber,
  });
}
function weekRange(w: OpeningFormWeek): string {
  return `${formatClubDate(w.startDate)} ~ ${formatClubDate(w.endDate)}`;
}

// ── 이미지 업로드 슬롯 (사각형 미리보기 + 클릭 확대 모달) ──
function OpeningImageSlot({
  image,
  caption,
  onUpload,
  onRemove,
  onCaptionChange,
  onExpand,
  disabled,
}: {
  image: UploadedImage | null;
  caption: string;
  onUpload: (img: UploadedImage) => void;
  onRemove: () => void;
  onCaptionChange: (v: string) => void;
  onExpand: () => void;
  disabled: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      setUploading(true);
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/admin/cluster4/upload-image", {
          method: "POST",
          body: formData,
        });
        const json = await res.json();
        if (!json.success) {
          void adminDialog.alert({ variant: "danger", title: "업로드 실패", description: json.error || "업로드에 실패했습니다" });
          return;
        }
        onUpload({ url: json.data.url, name: file.name });
      } catch {
        void adminDialog.alert({ variant: "danger", title: "업로드 오류", description: "업로드 중 오류가 발생했습니다" });
      } finally {
        setUploading(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [onUpload],
  );

  // 파일 입력은 항상 렌더(미리보기 유무와 무관) — 업로드 아이콘이 트리거.
  return (
    <div className="space-y-2">
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={handleFileChange}
        disabled={disabled || uploading}
      />

      {/* 1행: "이미지 1" 라벨 + 미리보기 공간(우측 상단 업로드/삭제 2행 1열) */}
      <div className="flex items-start gap-2">
        <Label className="inline-flex w-20 shrink-0 items-center gap-1 pt-1 whitespace-nowrap text-xs text-muted-foreground">
          이미지 1<AdminHelpIconButton size="xs" helpKey="admin.lineOpening.info.field.outputImage1" title="이미지 1" />
        </Label>
        <div className="relative">
          {image ? (
            <button
              type="button"
              onClick={onExpand}
              className="group block aspect-square w-40 overflow-hidden rounded-md border"
              title="클릭하면 크게 보기"
            >
              <img
                src={image.url}
                alt={image.name}
                className="h-full w-full object-cover transition-transform group-hover:scale-105"
              />
            </button>
          ) : (
            <div className="flex aspect-square w-40 items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
              {uploading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                "미리보기"
              )}
            </div>
          )}
          {/* 우측 상단: 업로드 / 삭제 (2행 1열) */}
          <div className="absolute right-1 top-1 flex flex-col gap-1">
            <Button
              type="button"
              variant="secondary"
              size="icon"
              className="h-7 w-7 shadow"
              onClick={() => fileRef.current?.click()}
              disabled={disabled || uploading}
              loading={uploading}
              aria-label="이미지 업로드"
              title="업로드"
            >
              {!uploading && <Upload className="h-4 w-4" />}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="icon"
              className="h-7 w-7 shadow"
              onClick={onRemove}
              disabled={disabled || !image}
              aria-label="이미지 삭제"
              title="삭제"
            >
              <Trash2 className="h-4 w-4 text-red-500" />
            </Button>
          </div>
        </div>
      </div>

      {/* 2행: "설명 1" 라벨 + 이미지 설명 입력 */}
      <div className="flex items-center gap-2">
        <Label className="inline-flex w-20 shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">설명 1<AdminHelpIconButton size="xs" helpKey="admin.lineOpening.info.field.outputImage1Desc" title="설명 1" /></Label>
        <Input
          value={caption}
          onChange={(e) => onCaptionChange(e.target.value)}
          placeholder="아웃풋 이미지 설명"
          aria-label="아웃풋 이미지 설명"
          disabled={disabled}
        />
      </div>
    </div>
  );
}

export default function PracticalInfoOpeningForm({
  openableWeek,
  weekOptions,
  exceptionWeeks = [],
  activityTypes,
  defaultActivityTypeId,
  onOpened,
}: {
  openableWeek: OpeningFormWeek | null;
  weekOptions: OpeningFormWeek[];
  // 활성 라인 개설 예외 주차 — 일반 모드에서 자동 정책 주차와 함께 선택 가능.
  exceptionWeeks?: ExceptionFormWeek[];
  activityTypes: ActivityTypeOption[];
  defaultActivityTypeId: string | null;
  // users prop 은 더 이상 쓰지 않는다(크루는 카페 검수/수동추가 API 로 채운다).
  users?: unknown;
  onOpened: () => void;
}) {
  const devMode = useAdminDevMode();
  const { toast } = useToast();
  const t = useActionToast();

  const [adminUnlock, setAdminUnlock] = useState(false);
  const [forcedWeekId, setForcedWeekId] = useState<string>("");
  // 일반 모드에서 선택한 주차(자동 정책 또는 예외 허용). 기본 = 자동 정책 주차.
  const [normalWeekId, setNormalWeekId] = useState<string>("");

  const [lineId, setLineId] = useState<string>(defaultActivityTypeId ?? "");
  // 상단 활동유형 탭이 바뀌면(=defaultActivityTypeId 변경) "라인명" 선택값을 현재 탭으로 맞춘다.
  // effect 대신 렌더 단계 prop-동기화 패턴(React 권장) — 직전 prop 값을 추적해 변경 시에만 set.
  const [seenDefaultActivityTypeId, setSeenDefaultActivityTypeId] = useState<string>(
    defaultActivityTypeId ?? "",
  );
  if ((defaultActivityTypeId ?? "") !== seenDefaultActivityTypeId) {
    setSeenDefaultActivityTypeId(defaultActivityTypeId ?? "");
    setLineId(defaultActivityTypeId ?? "");
  }
  const [mainTitle, setMainTitle] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkDesc, setLinkDesc] = useState("");
  const [image, setImage] = useState<UploadedImage | null>(null);
  const [imageDesc, setImageDesc] = useState("");

  // ── 라인 개설 크루 (CafeCrewPicker 가 카페 검수·수동추가 로직 소유) ──
  //   candidates / cafeMeta 는 개설 payload 에 필요하므로 폼이 소유(controlled).
  const [candidates, setCandidates] = useState<CafeCrew[]>([]);
  const [cafeMeta, setCafeMeta] = useState<CafeCrewMeta>(null);
  // resetSignal 증가 → 피커 내부 입력(카페 URL/검수결과/수동검색) 초기화.
  const [crewResetSignal, setCrewResetSignal] = useState(0);

  const [imageModalOpen, setImageModalOpen] = useState(false);
  // 개설 확인 / 초기화 확인 / 개설 취소 확인 모달.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // 현재 (선택 주차 + 선택 라인) 에 이미 개설된 활성 라인 — [개설 취소] 대상.
  const [openedLine, setOpenedLine] = useState<{ id: string; mainTitle: string } | null>(null);
  // 이번 주 (선택 주차+라인) 오픈(개설 대상) 여부 — info-lines GET(isOpenThisWeek). false=미오픈(개설 차단).
  //   null = 미상(통합/미조회) → 게이트 미적용(개설 서버 강제로 최종 차단).
  const [openThisWeek, setOpenThisWeek] = useState<boolean | null>(null);
  // 개설/취소 후 openedLine 재조회 트리거.
  const [refreshTick, setRefreshTick] = useState(0);
  const [saving, setSaving] = useState(false);

  const unlocked = devMode && adminUnlock;

  // 일반 모드 선택지 = 자동 정책 주차 + 활성 예외 주차(중복 id 는 예외가 우선 — 휴식 덮어쓰기).
  //   isException=false → 자동 정책, true → 예외 허용. allowed = 예외의 허용 라인(null=전체).
  const normalOptions = useMemo(() => {
    const map = new Map<
      string,
      {
        week: OpeningFormWeek;
        isException: boolean;
        allowed: string[] | null;
      }
    >();
    if (openableWeek) {
      map.set(openableWeek.id, {
        week: openableWeek,
        isException: false,
        allowed: null,
      });
    }
    for (const e of exceptionWeeks) {
      // 같은 id 면 예외가 자동 항목을 덮어쓴다(휴식 주차 예외 등).
      map.set(e.id, {
        week: e,
        isException: true,
        allowed: e.allowedActivityTypeIds,
      });
    }
    // 자동 정책 주차 먼저.
    return Array.from(map.values()).sort((a, b) =>
      a.isException === b.isException ? 0 : a.isException ? 1 : -1,
    );
  }, [openableWeek, exceptionWeeks]);

  // 일반 모드 유효 선택 id — 사용자가 고른 값이 유효하면 그대로, 아니면 자동 정책 주차 기본값.
  //   (effect 로 setState 하지 않고 파생값으로 계산 — 불필요한 cascading render 방지)
  const effectiveNormalId = normalOptions.some((o) => o.week.id === normalWeekId)
    ? normalWeekId
    : openableWeek?.id ?? normalOptions[0]?.week.id ?? "";

  const effectiveWeek = useMemo<OpeningFormWeek | null>(() => {
    if (unlocked) {
      return weekOptions.find((w) => w.id === forcedWeekId) ?? openableWeek;
    }
    const found = normalOptions.find((o) => o.week.id === effectiveNormalId);
    return found?.week ?? openableWeek;
  }, [unlocked, weekOptions, forcedWeekId, openableWeek, normalOptions, effectiveNormalId]);

  // 일반 모드에서 단일 자동 주차만 있는지(예외 없음) — 드롭다운 고정 여부.
  const normalFixed = normalOptions.length <= 1;

  // 선택한 주차가 라인-스코프 예외인데 현재 라인이 허용 목록에 없으면 개설 불가.
  const lineNotAllowedForException = useMemo(() => {
    if (unlocked) return false;
    const opt = normalOptions.find((o) => o.week.id === effectiveWeek?.id);
    if (!opt || !opt.isException || opt.allowed === null) return false;
    return !!lineId && !opt.allowed.includes(lineId);
  }, [unlocked, normalOptions, effectiveWeek, lineId]);

  // 현재 (선택 주차 + 선택 라인) 에 이미 개설된 활성 라인 조회 — [개설 취소] 대상 판정.
  //   라인 개설/취소 후 refreshTick 으로 재조회. setTimeout(0) 로 비동기 분리(effect 동기 setState 회피).
  const effectiveWeekId = effectiveWeek?.id ?? null;
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      if (!effectiveWeekId || !lineId) {
        if (!cancelled) {
          setOpenedLine(null);
          setOpenThisWeek(null);
        }
        return;
      }
      try {
        const org = new URLSearchParams(window.location.search).get("org");
        const qs = new URLSearchParams({
          week_id: effectiveWeekId,
          activity_type_id: lineId,
        });
        if (org) qs.set("organization", org);
        // ⚠ QA 누수 차단: 개설된 라인(대상 크루 포함)도 mode 전달 필수 — 미전달=operating(실사용자) 노출.
        const res = await fetch(
          appendModeQuery(
            `/api/admin/cluster4/info-lines?${qs.toString()}`,
            readScopeMode(new URLSearchParams(window.location.search)),
          ),
        );
        const json = await res.json();
        if (cancelled) return;
        const row = json?.success
          ? (json.data?.rows ?? []).find((r: { isActive: boolean }) => r.isActive)
          : null;
        setOpenedLine(row ? { id: row.id, mainTitle: row.mainTitle } : null);
        // 이번 주 오픈(개설 대상) 여부 — 서버(weekOpenGate) 판정. boolean 이 아니면 미상(null).
        setOpenThisWeek(
          json?.success && typeof json.data?.isOpenThisWeek === "boolean"
            ? json.data.isOpenThisWeek
            : null,
        );
      } catch {
        if (!cancelled) {
          setOpenedLine(null);
          setOpenThisWeek(null);
        }
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [effectiveWeekId, lineId, refreshTick]);

  // 초기화 = 화면 입력값만 페이지 최초 상태로 되돌린다(DB 무관). 주차/라인은 기본값으로.
  const resetForm = useCallback(() => {
    setLineId(defaultActivityTypeId ?? "");
    setAdminUnlock(false);
    setForcedWeekId("");
    setMainTitle("");
    setLinkUrl("");
    setLinkDesc("");
    setImage(null);
    setImageDesc("");
    setCafeMeta(null);
    setCandidates([]);
    setCrewResetSignal((s) => s + 1);
  }, [defaultActivityTypeId]);

  // [개설] 활성 판정 — 필수값 누락 사유 목록(복수). 비어 있으면 개설 가능.
  //   ⚠ 개설 크루는 0명도 유효 → 사유에 포함하지 않는다. (candidates 는 항상 배열 — null/undefined/로딩실패 아님)
  const missingReasons = useMemo<string[]>(() => {
    const r: string[] = [];
    if (!effectiveWeek) {
      r.push("개설 주차 정보가 필요합니다.");
      return r;
    }
    if (!effectiveWeek.canOpen)
      r.push("선택한 주차는 공식 휴식 주차로 개설할 수 없습니다.");
    else if (!effectiveWeek.submissionOpensAt || !effectiveWeek.submissionClosesAt)
      r.push("선택한 주차의 기입 기간을 확인할 수 없습니다.");
    if (!lineId) r.push("라인명을 선택해주세요.");
    // 미오픈 라인(오픈 설정 미포함) — 개설 차단(서버 강제와 동일 사유). null(미상)은 서버가 최종 판정.
    if (openThisWeek === false)
      r.push("이번 주에 오픈되지 않은 라인입니다.");
    if (lineNotAllowedForException)
      r.push("이 예외 허용 주차는 선택한 라인의 개설을 허용하지 않습니다.");
    if (!mainTitle.trim()) r.push("메인 타이틀이 필요합니다.");
    if (!linkUrl.trim()) r.push("아웃풋 링크 주소가 필요합니다.");
    if (!linkDesc.trim()) r.push("아웃풋 링크 설명이 필요합니다.");
    if (!image) r.push("아웃풋 이미지가 필요합니다.");
    if (!imageDesc.trim()) r.push("아웃풋 이미지 설명이 필요합니다.");
    // 이미 개설된 라인이 있으면 재개설 불가(409 방지) — 개설 취소 후 가능.
    if (openedLine) r.push("이미 개설된 라인이 있습니다. (개설 취소 후 재개설)");
    return r;
  }, [
    effectiveWeek,
    lineId,
    lineNotAllowedForException,
    mainTitle,
    linkUrl,
    linkDesc,
    image,
    imageDesc,
    openedLine,
    openThisWeek,
  ]);

  const canOpen = missingReasons.length === 0;

  // 개설 확인 모달용 요약값.
  const lineName = useMemo(
    () => activityTypes.find((t) => t.id === lineId)?.name ?? "-",
    [activityTypes, lineId],
  );

  // [개설] 클릭 → 즉시 저장하지 않고 확인 모달을 띄운다. (버튼이 disabled 라 사실상 canOpen 일 때만)
  const handleOpenClick = useCallback(() => {
    if (!canOpen) return;
    setConfirmOpen(true);
  }, [canOpen]);

  // [개설 취소] 클릭 → 취소 확인 모달. (openedLine 있을 때만 활성)
  const handleCancelClick = useCallback(() => {
    if (!openedLine) return;
    setConfirmCancel(true);
  }, [openedLine]);

  // 취소 확인 모달 [개설 취소] → 실제 DELETE(개설 되돌리기).
  const executeCancel = useCallback(async () => {
    if (!openedLine || !effectiveWeek || !lineId) return;
    setSaving(true);
    try {
      const org = new URLSearchParams(window.location.search).get("org");
      const qs = new URLSearchParams({
        week_id: effectiveWeek.id,
        activity_type_id: lineId,
      });
      // org 분기 진입이면 organization 전달 → 서버가 그 org 라인만 취소(타org 오삭제 방지).
      if (org) qs.set("organization", org);
      const res = await fetch(
        `/api/admin/cluster4/info-lines?${qs.toString()}`,
        { method: "DELETE" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        console.error("[info] open-cancel failed", json?.error);
        t.error("cancel", { status: res.status });
        return;
      }
      toast("success", LINE_OPENING_RESULT.cancelSuccess);
      setOpenedLine(null);
      setRefreshTick((t) => t + 1);
      onOpened();
    } catch {
      toast("error", "개설 취소 중 오류가 발생했습니다");
    } finally {
      setSaving(false);
      setConfirmCancel(false);
    }
  }, [openedLine, effectiveWeek, lineId, onOpened, toast]);

  // 확인 모달 [확인] → 실제 API 저장 실행.
  const executeOpen = useCallback(async () => {
    if (!canOpen || !effectiveWeek) return;
    const week = effectiveWeek;
    setSaving(true);
    try {
      const payload = {
        activity_type_id: lineId,
        main_title: mainTitle.trim(),
        output_links: [{ url: linkUrl.trim(), label: linkDesc.trim() }],
        output_link_1: linkUrl.trim(),
        output_link_2: null,
        output_images: [{ url: image!.url, caption: imageDesc.trim() }],
        // 후보 목록에 남은 크루만 target 에 포함(0명 허용).
        target_user_ids: candidates.map((c) => c.userId),
        target_crew_ids: candidates.map((c) => c.userId),
        targetCount: candidates.length,
        week_id: week.id,
        submission_opens_at: week.submissionOpensAt,
        submission_closes_at: week.submissionClosesAt,
        cafe_url: cafeMeta?.cafeUrl ?? null,
        matched_crew_count: cafeMeta?.matchedCrewCount ?? null,
        raw_comment_count: cafeMeta?.rawCommentCount ?? null,
      };
      // dev(과거 주차) + organization + mode(운영/테스트) 를 함께 전달 — 서버 org+mode 가드와 정합.
      const openLoc = new URLSearchParams(window.location.search);
      const openSp = new URLSearchParams();
      if (unlocked) openSp.set("dev", "true");
      const openOrg = openLoc.get("org");
      if (openOrg) openSp.set("organization", openOrg);
      if (openLoc.get("mode") === "test") openSp.set("mode", "test");
      const res = await fetch(
        `/api/admin/cluster4/info-lines${openSp.toString() ? `?${openSp.toString()}` : ""}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        console.error("[info] open failed", json?.error);
        t.error("open", { status: res.status });
        return;
      }
      console.warn("[line-opening] info form open result", {
        targetCount: json.data?.targetCount ?? candidates.length,
      });
      toast("success", lineOpenSuccessMessage(false));
      resetForm();
      setRefreshTick((t) => t + 1);
      onOpened();
    } catch {
      toast("error", "개설 중 오류가 발생했습니다");
    } finally {
      setSaving(false);
      // 성공·실패·오류 어느 경우든 확인 모달은 닫는다(결과는 상단 배너로 노출).
      setConfirmOpen(false);
    }
  }, [
    canOpen,
    effectiveWeek,
    candidates,
    lineId,
    mainTitle,
    linkUrl,
    linkDesc,
    image,
    imageDesc,
    cafeMeta,
    unlocked,
    resetForm,
    onOpened,
    toast,
  ]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="inline-flex items-center gap-1.5 text-base">
          라인 개설
          <AdminHelpIconButton
            helpKey="admin.lineOpening.info.title.openingForm"
            title="라인 개설"
            size="xs"
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {openThisWeek === false ? (
          // 미오픈 라인 — 이번 주 개설 대상이 아님. 폼 본문 대신 차단 패널(어둡게)만 표시(개설 불가).
          //   판정 = 서버 isInfoLineOpenForWeek(개설 저장 API 와 동일). URL 직접 선택도 동일 차단.
          <div className="rounded-md border border-zinc-300 bg-zinc-100 p-8 text-center dark:border-zinc-700 dark:bg-zinc-800/60">
            <span className="mb-3 inline-flex items-center rounded-full border border-zinc-400 bg-zinc-200 px-2.5 py-0.5 text-sm font-semibold text-zinc-700 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-200">
              미오픈
            </span>
            <p className="text-sm font-medium text-foreground">
              이 라인은 이번 주에 개설 대상이 아닙니다.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              활동 관리에서 오픈 설정(오픈 확인)된 라인만 개설할 수 있습니다.
            </p>
            <div className="mt-5">
              <Button type="button" disabled title="이번 주에 오픈되지 않은 라인입니다.">
                개설
              </Button>
            </div>
          </div>
        ) : (
        <>
        {/* 개설 액션 (폼 최상단 · 왼쪽 정렬) — [개설] [초기화] [개설 취소] */}
        <div className="space-y-2 border-b pb-4">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <div className="flex items-center gap-1">
              <Button
                type="button"
                onClick={handleOpenClick}
                disabled={saving || !canOpen}
                loading={saving}
              >
                개설
              </Button>
              <AdminHelpIconButton
                helpKey="admin.lineOpening.info.action.open"
                title="개설"
                size="xs"
              />
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmReset(true)}
                disabled={saving}
              >
                초기화
              </Button>
              <AdminHelpIconButton
                helpKey="admin.lineOpening.info.action.reset"
                title="초기화"
                size="xs"
              />
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                onClick={handleCancelClick}
                disabled={saving || !openedLine}
                className="text-red-600 hover:text-red-700"
                title={
                  openedLine
                    ? "개설된 라인을 취소(되돌리기)합니다"
                    : "이 주차·라인에 개설된 라인이 없습니다"
                }
              >
                개설 취소
              </Button>
              <AdminHelpIconButton
                helpKey="admin.lineOpening.info.action.cancelOpen"
                title="개설 취소"
                size="xs"
              />
            </div>
          </div>
          {/* 개설 비활성 사유(복수). 개설 크루 0명은 사유 아님. */}
          {!canOpen && (
            <ul className="space-y-0.5 text-xs text-amber-700">
              {missingReasons.map((r) => (
                <li key={r}>· {r}</li>
              ))}
            </ul>
          )}
        </div>

        {/* 1. 개설할 주차 */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Label className="text-sm font-semibold">
                개설 주차 <span className="text-red-500">*</span>
              </Label>
              <AdminHelpIconButton
                helpKey="admin.lineOpening.info.filter.openingWeek"
                title="개설 주차"
                size="xs"
              />
            </div>
            {devMode && (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-amber-700">
                <input
                  type="checkbox"
                  className="rounded border-input"
                  checked={adminUnlock}
                  onChange={(e) => {
                    setAdminUnlock(e.target.checked);
                    if (e.target.checked && openableWeek)
                      setForcedWeekId((p) => p || openableWeek.id);
                  }}
                />
                {adminUnlock ? (
                  <Unlock className="h-3.5 w-3.5" />
                ) : (
                  <Lock className="h-3.5 w-3.5" />
                )}
                관리자 강제 선택(잠금 해제 · dev)
              </label>
            )}
          </div>

          <select
            aria-label="개설 주차"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:bg-muted/50"
            disabled={!unlocked && normalFixed}
            value={effectiveWeek?.id ?? ""}
            onChange={(e) =>
              unlocked
                ? setForcedWeekId(e.target.value)
                : setNormalWeekId(e.target.value)
            }
          >
            {!openableWeek &&
              weekOptions.length === 0 &&
              normalOptions.length === 0 && (
                <option value="">개설 대상 주차를 계산할 수 없습니다</option>
              )}
            {unlocked
              ? weekOptions.map((w) => (
                  <option key={w.id} value={w.id} disabled={!w.canOpen}>
                    {weekTitle(w)} · {weekRange(w)}
                    {w.isOpenTarget ? " · 개설 대상" : ""}
                    {w.isCurrent ? " · 현재" : ""}
                    {!w.canOpen ? " · 휴식" : ""}
                  </option>
                ))
              : normalOptions.map((o) => (
                  <option
                    key={o.week.id}
                    value={o.week.id}
                    disabled={!o.week.canOpen}
                  >
                    {weekTitle(o.week)} · {weekRange(o.week)}
                    {o.isException ? " · 예외 허용" : " · 자동 정책"}
                    {!o.week.canOpen ? " · 휴식" : ""}
                  </option>
                ))}
          </select>

          {effectiveWeek ? (
            <div
              className={cn(
                "rounded-md border px-3 py-2",
                effectiveWeek.canOpen
                  ? "border-input bg-muted/30"
                  : "border-orange-300 bg-orange-50",
              )}
            >
              <p className="text-sm font-semibold text-foreground">
                {weekTitle(effectiveWeek)}
              </p>
              <p className="text-xs text-muted-foreground">{weekRange(effectiveWeek)}</p>
              {!effectiveWeek.canOpen && (
                <p className="mt-1 text-xs font-medium text-orange-600">
                  공식 휴식 주차 — 라인 개설 불가
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              개설 대상 주차 정보를 확인할 수 없습니다.
            </p>
          )}
        </section>

        {/* 2. 라인명 — 상단 활동유형 탭에서 선택된 유형의 라인만 후보로 노출(Manager 가 필터). */}
        <section className="space-y-2">
          <div className="flex items-center gap-1">
            <Label className="text-sm font-semibold">
              라인명 <span className="text-red-500">*</span>
            </Label>
            <AdminHelpIconButton
              helpKey="admin.lineOpening.info.filter.lineName"
              title="라인명"
              size="xs"
            />
          </div>
          <select
            aria-label="라인명"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={lineId}
            onChange={(e) => setLineId(e.target.value)}
          >
            <option value="">라인을 선택해주세요</option>
            {activityTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </section>

        {/* 3. 메인 타이틀 + "일반" */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="opening-main-title" className="inline-flex items-center gap-1 text-sm font-semibold">
              메인 타이틀 <span className="text-red-500">*</span><AdminHelpIconButton size="xs" helpKey="admin.lineOpening.field.mainTitle" title="메인 타이틀" />
            </Label>
            <span className="inline-flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setMainTitle(GENERAL_MAIN_TITLE)}
                title="고정 문구를 입력란에 불러옵니다"
              >
                일반
              </Button>
              <AdminHelpIconButton size="xs" helpKey="admin.lineOpening.info.action.generalTitle" title="일반" />
            </span>
          </div>
          <textarea
            id="opening-main-title"
            value={mainTitle}
            onChange={(e) => setMainTitle(e.target.value)}
            rows={3}
            placeholder="메인 타이틀을 입력하거나 우측 상단 '일반' 버튼으로 고정 문구를 불러오세요"
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
        </section>

        {/* 4. 아웃풋 — 2행 1열(링크 행 / 이미지 행) */}
        <section className="space-y-4">
          <Label className="inline-flex items-center gap-1 text-sm font-semibold">
            아웃풋 <span className="text-red-500">*</span><AdminHelpIconButton size="xs" helpKey="admin.lineOpening.field.output" title="아웃풋" />
          </Label>
          <div className="grid grid-cols-1 gap-4">
            {/* 아웃풋 링크 — "링크 1" / "설명 1" 각각 한 줄 */}
            <div className="space-y-2 rounded-md border p-3">
              <p className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">아웃풋 링크<AdminHelpIconButton size="xs" helpKey="admin.lineOpening.info.field.outputLink" title="아웃풋 링크" /></p>
              <div className="flex items-center gap-2">
                <Label className="inline-flex w-20 shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
                  링크 1<AdminHelpIconButton size="xs" helpKey="admin.lineOpening.field.outputLink" title="링크 1" />
                </Label>
                <Input
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  placeholder="아웃풋 링크 주소 (https://...)"
                  aria-label="아웃풋 링크 주소"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="inline-flex w-20 shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
                  설명 1<AdminHelpIconButton size="xs" helpKey="admin.lineOpening.field.outputLinkDescription" title="설명 1" />
                </Label>
                <Input
                  value={linkDesc}
                  onChange={(e) => setLinkDesc(e.target.value)}
                  placeholder="아웃풋 링크 설명"
                  aria-label="아웃풋 링크 설명"
                />
              </div>
            </div>
            {/* 아웃풋 이미지 — "이미지 1"(미리보기+업로드/삭제) / "설명 1" 각각 한 줄 */}
            <div className="space-y-2 rounded-md border p-3">
              <p className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">아웃풋 이미지<AdminHelpIconButton size="xs" helpKey="admin.lineOpening.info.field.outputImage" title="아웃풋 이미지" /></p>
              <OpeningImageSlot
                image={image}
                caption={imageDesc}
                onUpload={setImage}
                onRemove={() => {
                  setImage(null);
                  setImageDesc("");
                }}
                onCaptionChange={setImageDesc}
                onExpand={() => setImageModalOpen(true)}
                disabled={saving}
              />
            </div>
          </div>
        </section>

        {/* 5. 라인 개설 크루 — 공용 CafeCrewPicker(카페 검수·수동추가 단일 SoT).
            초기화는 key 변경으로 피커를 remount 해 내부 입력/검수 상태를 비운다. */}
        <CafeCrewPicker
          key={crewResetSignal}
          candidates={candidates}
          onCandidatesChange={setCandidates}
          onMetaChange={setCafeMeta}
          disabled={saving}
        />
        </>
        )}
      </CardContent>

      {/* 이미지 확대 모달 */}
      {imageModalOpen && image && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
          onClick={() => setImageModalOpen(false)}
        >
          <div className="relative max-h-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="absolute -right-3 -top-3 rounded-full bg-white p-1 shadow"
              onClick={() => setImageModalOpen(false)}
              aria-label="닫기"
            >
              <X className="h-5 w-5" />
            </button>
            <img
              src={image.url}
              alt={image.name}
              className="max-h-[80vh] max-w-full rounded-md object-contain"
            />
            {imageDesc.trim() && (
              <p className="mt-2 text-center text-sm text-white">{imageDesc.trim()}</p>
            )}
          </div>
        </div>
      )}

      {/* 개설 확인 모달 — [확인] 클릭 시에만 실제 API 저장 */}
      {confirmOpen && effectiveWeek && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !saving && setConfirmOpen(false)}
        >
          <div
            className="modal-w-sm space-y-4 rounded-lg bg-background p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold">라인 개설 확인</h3>
            <p className="text-sm text-muted-foreground">아래 정보로 라인을 개설합니다.</p>
            <dl className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 whitespace-nowrap text-muted-foreground">개설 주차</dt>
                <dd className="font-medium">{weekTitle(effectiveWeek)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 whitespace-nowrap text-muted-foreground">라인명</dt>
                <dd className="font-medium">{lineName}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 whitespace-nowrap text-muted-foreground">메인 타이틀</dt>
                <dd className="min-w-0 break-words font-medium">{mainTitle.trim()}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 whitespace-nowrap text-muted-foreground">아웃풋 링크</dt>
                <dd className="font-medium">{linkUrl.trim() ? 1 : 0}개</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 whitespace-nowrap text-muted-foreground">아웃풋 이미지</dt>
                <dd className="font-medium">{image ? 1 : 0}개</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 whitespace-nowrap text-muted-foreground">개설 크루</dt>
                <dd className="font-medium">{candidates.length}명</dd>
              </div>
            </dl>
            <p className="text-xs text-amber-700">
              주의: 개설 후에는 대상 크루의 라인 상태가 변경됩니다.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmOpen(false)}
                disabled={saving}
              >
                취소
              </Button>
              <Button type="button" onClick={executeOpen} loading={saving}>
                확인
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 초기화 확인 모달 — 화면 입력값만 초기화(DB 무관) */}
      {confirmReset && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setConfirmReset(false)}
        >
          <div
            className="modal-w-sm space-y-4 rounded-lg bg-background p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold">초기화</h3>
            <p className="text-sm text-muted-foreground">
              입력 중인 내용을 모두 초기화하시겠습니까? (DB 데이터에는 영향이 없습니다)
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmReset(false)}
              >
                취소
              </Button>
              <Button
                type="button"
                onClick={() => {
                  resetForm();
                  setConfirmReset(false);
                }}
              >
                초기화
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 개설 취소 확인 모달 — 실제 개설 되돌리기(DB 삭제 + 전체 크루 '해당 없음' 복귀) */}
      {confirmCancel && openedLine && effectiveWeek && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !saving && setConfirmCancel(false)}
        >
          <div
            className="modal-w-sm space-y-4 rounded-lg bg-background p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold">라인 개설 취소 확인</h3>
            <p className="text-sm text-muted-foreground">
              아래 개설된 라인을 취소(되돌리기)합니다.
            </p>
            <dl className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 whitespace-nowrap text-muted-foreground">개설 주차</dt>
                <dd className="font-medium">{weekTitle(effectiveWeek)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 whitespace-nowrap text-muted-foreground">라인명</dt>
                <dd className="font-medium">{lineName}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 whitespace-nowrap text-muted-foreground">메인 타이틀</dt>
                <dd className="min-w-0 break-words font-medium">{openedLine.mainTitle}</dd>
              </div>
            </dl>
            <p className="text-xs text-red-600">
              주의: 개설 데이터·대상 크루가 삭제되고, 크루 페이지에서 해당 라인이 사라집니다.
              전체 크루의 해당 라인 상태가 &apos;해당 없음&apos;으로 복귀합니다. (되돌릴 수 없음)
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmCancel(false)}
                disabled={saving}
              >
                취소
              </Button>
              <Button
                type="button"
                onClick={executeCancel}
                loading={saving}
                className="bg-red-600 text-white hover:bg-red-700"
              >
                개설 취소
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
