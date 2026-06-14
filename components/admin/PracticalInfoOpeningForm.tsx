"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Upload, Trash2, X, Search, Users, Lock, Unlock } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";

// 실무 정보 라인 개설 폼 — [섹션 0] 하단 실제 개설 영역.
//   (1) 개설할 주차: getOpenableWeekStartMs(금요일 경계 규칙)로 자동 고정 + disabled.
//   (2) 개설할 라인: practical_info 활동 유형 9종(위즈덤 … 기타A).
//   (3) 메인 타이틀: 직접 입력(textarea) + "일반" 버튼(고정 문구 삽입).
//   (4) 아웃풋: 링크 1개(주소+설명) + 이미지 1개(파일+설명) — 둘 다 필수.
//   (5) 라인 개설 크루: 네이버 카페 검수(매칭) + 수동 추가/삭제/초기화.
//       0명 개설 허용 — 0명이면 그 주차/라인은 전체 크루 강화 실패, 1명↑이면 그 크루만 대기→성공.
//   (6) 저장: POST /api/admin/cluster4/info-lines (target_user_ids=후보 목록, cafe 메타 포함).

const DAY_KO = ["일", "월", "화", "수", "목", "금", "토"] as const;

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

// 우리 클럽 크루 레코드(검수/후보/수동추가 공통 — cluster4CafeLineMatch.CrewRecord 미러).
type CafeCrew = {
  userId: string;
  crewNo: number | null;
  name: string;
  teamName: string | null;
  partName: string | null;
  schoolName: string | null;
  majorName: string | null;
  organization: string | null;
};

type CafeReviewItem = { order: number; nickname: string; reason: string };

type UploadedImage = { url: string; name: string };

type Banner = { kind: "success" | "error" | "info"; message: string } | null;

function fmtDot(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return `${m[1].slice(2)}.${m[2]}.${m[3]}(${DAY_KO[dow]})`;
}
function weekTitle(w: OpeningFormWeek): string {
  return `${w.year}년 ${w.seasonName} ${w.weekNumber}주차`;
}
function weekRange(w: OpeningFormWeek): string {
  return `${fmtDot(w.startDate)} - ${fmtDot(w.endDate)}`;
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
          alert(json.error || "업로드에 실패했습니다");
          return;
        }
        onUpload({ url: json.data.url, name: file.name });
      } catch {
        alert("업로드 중 오류가 발생했습니다");
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
        <Label className="w-12 shrink-0 pt-1 text-xs text-muted-foreground">
          이미지 1
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
              aria-label="이미지 업로드"
              title="업로드"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
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
        <Label className="w-12 shrink-0 text-xs text-muted-foreground">설명 1</Label>
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

  const [adminUnlock, setAdminUnlock] = useState(false);
  const [forcedWeekId, setForcedWeekId] = useState<string>("");
  // 일반 모드에서 선택한 주차(자동 정책 또는 예외 허용). 기본 = 자동 정책 주차.
  const [normalWeekId, setNormalWeekId] = useState<string>("");

  const [lineId, setLineId] = useState<string>(defaultActivityTypeId ?? "");
  const [mainTitle, setMainTitle] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkDesc, setLinkDesc] = useState("");
  const [image, setImage] = useState<UploadedImage | null>(null);
  const [imageDesc, setImageDesc] = useState("");

  // ── 라인 개설 크루 ──
  const [cafeUrl, setCafeUrl] = useState("");
  const [cafeLoading, setCafeLoading] = useState(false);
  const [cafeError, setCafeError] = useState<string | null>(null);
  const [cafeMeta, setCafeMeta] = useState<{
    cafeUrl: string;
    rawCommentCount: number;
    matchedCrewCount: number;
  } | null>(null);
  // 후보 목록(개설 크루) — 댓글 시간순(자동 매칭) 우선, 이후 수동 추가분 append. 저장 전 임시 상태.
  const [candidates, setCandidates] = useState<CafeCrew[]>([]);
  const [review, setReview] = useState<CafeReviewItem[]>([]);
  // 수동 추가 검색.
  const [manualQ, setManualQ] = useState("");
  const [manualResults, setManualResults] = useState<CafeCrew[]>([]);
  const [manualSearching, setManualSearching] = useState(false);

  const [imageModalOpen, setImageModalOpen] = useState(false);
  // 개설 확인 / 초기화 확인 / 개설 취소 확인 모달.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // 현재 (선택 주차 + 선택 라인) 에 이미 개설된 활성 라인 — [개설 취소] 대상.
  const [openedLine, setOpenedLine] = useState<{ id: string; mainTitle: string } | null>(null);
  // 개설/취소 후 openedLine 재조회 트리거.
  const [refreshTick, setRefreshTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  const unlocked = devMode && adminUnlock;

  // 상단 활동유형 탭이 바뀌면(=defaultActivityTypeId 변경) "라인명" 선택값을 현재 탭으로 맞춘다.
  // 기존 선택이 새 탭과 맞지 않으면 초기화되는 효과(라인명 드롭다운은 현재 탭 활동유형만 노출).
  useEffect(() => {
    setLineId((prev) =>
      prev === (defaultActivityTypeId ?? "") ? prev : defaultActivityTypeId ?? "",
    );
  }, [defaultActivityTypeId]);

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

  const candidateIds = useMemo(
    () => new Set(candidates.map((c) => c.userId)),
    [candidates],
  );

  // 현재 (선택 주차 + 선택 라인) 에 이미 개설된 활성 라인 조회 — [개설 취소] 대상 판정.
  //   라인 개설/취소 후 refreshTick 으로 재조회. setTimeout(0) 로 비동기 분리(effect 동기 setState 회피).
  const effectiveWeekId = effectiveWeek?.id ?? null;
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      if (!effectiveWeekId || !lineId) {
        if (!cancelled) setOpenedLine(null);
        return;
      }
      try {
        const org = new URLSearchParams(window.location.search).get("org");
        const qs = new URLSearchParams({
          week_id: effectiveWeekId,
          activity_type_id: lineId,
        });
        if (org) qs.set("organization", org);
        const res = await fetch(`/api/admin/cluster4/info-lines?${qs.toString()}`);
        const json = await res.json();
        if (cancelled) return;
        const row = json?.success
          ? (json.data?.rows ?? []).find((r: { isActive: boolean }) => r.isActive)
          : null;
        setOpenedLine(row ? { id: row.id, mainTitle: row.mainTitle } : null);
      } catch {
        if (!cancelled) setOpenedLine(null);
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [effectiveWeekId, lineId, refreshTick]);

  // 수동 추가 검색 — q 디바운스. (검색창이 비면 드롭다운이 숨겨지므로 별도 clear 불필요)
  useEffect(() => {
    const q = manualQ.trim();
    if (!q) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setManualSearching(true);
      try {
        // 현재 org + mode 모집단으로만 검색 — 조직/모드 경계 밖 동명이인 제외.
        const loc = new URLSearchParams(window.location.search);
        const org = loc.get("org");
        const sp = new URLSearchParams({ q });
        if (org) sp.set("organization", org);
        if (loc.get("mode") === "test") sp.set("mode", "test");
        const res = await fetch(
          `/api/admin/cluster4/cafe-line-crew?${sp.toString()}`,
        );
        const json = await res.json();
        if (cancelled) return;
        setManualResults(json?.success ? (json.data?.crews ?? []) : []);
      } catch {
        if (!cancelled) setManualResults([]);
      } finally {
        if (!cancelled) setManualSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [manualQ]);

  const addCandidate = useCallback((crew: CafeCrew) => {
    setCandidates((prev) =>
      prev.some((c) => c.userId === crew.userId) ? prev : [...prev, crew],
    );
  }, []);
  const removeCandidate = useCallback((userId: string) => {
    setCandidates((prev) => prev.filter((c) => c.userId !== userId));
  }, []);
  const clearCandidates = useCallback(() => {
    setCandidates([]);
  }, []);

  const handleVerifyCafe = useCallback(async () => {
    if (!cafeUrl.trim()) {
      setCafeError("네이버 카페 게시물 링크를 입력해주세요");
      return;
    }
    setCafeLoading(true);
    setCafeError(null);
    try {
      // 현재 org + mode(운영/테스트) 모집단으로만 매칭 — 조직/모드 경계 밖 동명이인 제외.
      const loc = new URLSearchParams(window.location.search);
      const org = loc.get("org");
      const sp = new URLSearchParams();
      if (org) sp.set("organization", org);
      if (loc.get("mode") === "test") sp.set("mode", "test");
      const res = await fetch(
        `/api/admin/cluster4/cafe-line-crew${sp.toString() ? `?${sp.toString()}` : ""}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: cafeUrl.trim() }),
        },
      );
      const json = await res.json();
      if (!json.success) {
        setCafeError(json.message ?? json.error ?? "검수 실패");
        return;
      }
      const d = json.data as {
        cafeUrl: string;
        rawCommentCount: number;
        matchedCrewCount: number;
        matched: Array<{ crew: CafeCrew }>;
        review: CafeReviewItem[];
      };
      // 자동 매칭 크루를 댓글 시간순 그대로 후보 목록에 채운다(기존 후보와 dedupe).
      const matchedCrews = d.matched.map((m) => m.crew);
      setCandidates((prev) => {
        const seen = new Set(prev.map((c) => c.userId));
        const fresh = matchedCrews.filter((c) => !seen.has(c.userId));
        return [...prev, ...fresh];
      });
      setReview(d.review ?? []);
      setCafeMeta({
        cafeUrl: d.cafeUrl,
        rawCommentCount: d.rawCommentCount,
        matchedCrewCount: d.matchedCrewCount,
      });
    } catch {
      setCafeError("검수 요청 중 오류가 발생했습니다");
    } finally {
      setCafeLoading(false);
    }
  }, [cafeUrl]);

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
    setCafeUrl("");
    setCafeError(null);
    setCafeMeta(null);
    setCandidates([]);
    setReview([]);
    setManualQ("");
    setManualResults([]);
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
    setBanner(null);
    setConfirmOpen(true);
  }, [canOpen]);

  // [개설 취소] 클릭 → 취소 확인 모달. (openedLine 있을 때만 활성)
  const handleCancelClick = useCallback(() => {
    if (!openedLine) return;
    setBanner(null);
    setConfirmCancel(true);
  }, [openedLine]);

  // 취소 확인 모달 [개설 취소] → 실제 DELETE(개설 되돌리기).
  const executeCancel = useCallback(async () => {
    if (!openedLine || !effectiveWeek || !lineId) return;
    setSaving(true);
    setBanner(null);
    try {
      const qs = new URLSearchParams({
        week_id: effectiveWeek.id,
        activity_type_id: lineId,
      });
      const res = await fetch(
        `/api/admin/cluster4/info-lines?${qs.toString()}`,
        { method: "DELETE" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        setBanner({
          kind: "error",
          message: json?.error ?? `개설 취소에 실패했습니다 (HTTP ${res.status})`,
        });
        return;
      }
      setBanner({
        kind: "success",
        message: "라인 개설이 취소되었습니다. (해당 주차/라인이 전체 크루에게 '해당 없음'으로 복귀)",
      });
      setOpenedLine(null);
      setRefreshTick((t) => t + 1);
      onOpened();
    } catch {
      setBanner({ kind: "error", message: "개설 취소 중 오류가 발생했습니다" });
    } finally {
      setSaving(false);
      setConfirmCancel(false);
    }
  }, [openedLine, effectiveWeek, lineId, onOpened]);

  // 확인 모달 [확인] → 실제 API 저장 실행.
  const executeOpen = useCallback(async () => {
    if (!canOpen || !effectiveWeek) return;
    const week = effectiveWeek;
    setSaving(true);
    setBanner(null);
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
        cafe_url: cafeMeta?.cafeUrl ?? (cafeUrl.trim() || null),
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
        setBanner({
          kind: "error",
          message: json?.error ?? `개설에 실패했습니다 (HTTP ${res.status})`,
        });
        return;
      }
      setBanner({
        kind: "success",
        message: `라인이 개설되었습니다 (개설 크루: ${json.data?.targetCount ?? candidates.length}명)`,
      });
      resetForm();
      setRefreshTick((t) => t + 1);
      onOpened();
    } catch {
      setBanner({ kind: "error", message: "개설 중 오류가 발생했습니다" });
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
    cafeUrl,
    unlocked,
    resetForm,
    onOpened,
  ]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">라인 개설</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {banner && (
          <div
            className={cn(
              "flex items-start justify-between gap-2 rounded-md border px-3 py-2 text-sm",
              banner.kind === "success"
                ? "border-green-300 bg-green-50 text-green-800"
                : banner.kind === "info"
                  ? "border-sky-300 bg-sky-50 text-sky-800"
                  : "border-red-300 bg-red-50 text-red-800",
            )}
          >
            <span>{banner.message}</span>
            <button type="button" onClick={() => setBanner(null)}>
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* 개설 액션 (폼 최상단 · 왼쪽 정렬) — [개설] [초기화] [개설 취소] */}
        <div className="space-y-2 border-b pb-4">
          <div className="flex flex-wrap justify-start gap-2">
            <Button
              type="button"
              onClick={handleOpenClick}
              disabled={saving || !canOpen}
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              개설
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmReset(true)}
              disabled={saving}
            >
              초기화
            </Button>
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
            <Label className="text-sm font-semibold">
              개설 주차 <span className="text-red-500">*</span>
            </Label>
            {devMode && (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-amber-700">
                <input
                  type="checkbox"
                  className="rounded border-gray-300"
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
                    {w.isOpenTarget ? " · 개설대상" : ""}
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
          <Label className="text-sm font-semibold">
            라인명 <span className="text-red-500">*</span>
          </Label>
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
            <Label htmlFor="opening-main-title" className="text-sm font-semibold">
              메인 타이틀 <span className="text-red-500">*</span>
            </Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setMainTitle(GENERAL_MAIN_TITLE)}
              title="고정 문구를 입력란에 불러옵니다"
            >
              일반
            </Button>
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
          <Label className="text-sm font-semibold">
            아웃풋 <span className="text-red-500">*</span>
          </Label>
          <div className="grid grid-cols-1 gap-4">
            {/* 아웃풋 링크 — "링크 1" / "설명 1" 각각 한 줄 */}
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-xs font-medium text-muted-foreground">아웃풋 링크</p>
              <div className="flex items-center gap-2">
                <Label className="w-12 shrink-0 text-xs text-muted-foreground">
                  링크 1
                </Label>
                <Input
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  placeholder="아웃풋 링크 주소 (https://...)"
                  aria-label="아웃풋 링크 주소"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-12 shrink-0 text-xs text-muted-foreground">
                  설명 1
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
              <p className="text-xs font-medium text-muted-foreground">아웃풋 이미지</p>
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

        {/* 5. 라인 개설 크루 */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-semibold">라인 개설 크루</Label>
            <span className="text-xs text-muted-foreground">
              <Users className="mr-1 inline h-3 w-3" />
              {candidates.length}명
            </span>
          </div>

          {/* 카페 링크 검수 */}
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-xs font-medium text-muted-foreground">카페 링크 검수</p>
            <div className="flex items-center gap-2">
              <Input
                value={cafeUrl}
                onChange={(e) => setCafeUrl(e.target.value)}
                placeholder="https://cafe.naver.com/... (게시물 링크)"
                aria-label="카페 게시물 링크"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !cafeLoading) handleVerifyCafe();
                }}
                disabled={cafeLoading}
              />
              <Button
                type="button"
                onClick={handleVerifyCafe}
                disabled={cafeLoading}
                className="shrink-0"
              >
                {cafeLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Search className="mr-2 h-4 w-4" />
                )}
                {cafeLoading ? "검수 중..." : "검수"}
              </Button>
            </div>
            {cafeError && <p className="text-sm text-red-600">{cafeError}</p>}
            {cafeMeta && (
              <p className="text-xs text-muted-foreground">
                원본 댓글 {cafeMeta.rawCommentCount} · 자동 매칭 {cafeMeta.matchedCrewCount} · 수동
                확인 {review.length}
              </p>
            )}
          </div>

          {/* 인원 수 + 초기화 + 수동 추가 (한 줄, 목록 위) */}
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                <Users className="mr-1 inline h-3 w-3" />
                개설 크루 {candidates.length}명
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={clearCandidates}
                disabled={candidates.length === 0}
              >
                초기화
              </Button>
              <div className="relative min-w-[200px] flex-1">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="pl-9"
                  placeholder="크루 수동 추가 검색..."
                  value={manualQ}
                  onChange={(e) => setManualQ(e.target.value)}
                  aria-label="크루 수동 추가 검색"
                />
              </div>
            </div>
            {manualQ.trim() && (
              <div className="max-h-52 overflow-y-auto rounded-md border">
                {manualSearching ? (
                  <p className="flex items-center gap-1.5 px-3 py-3 text-sm text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> 검색 중…
                  </p>
                ) : manualResults.length === 0 ? (
                  <p className="px-3 py-3 text-sm text-muted-foreground">검색 결과가 없습니다</p>
                ) : (
                  manualResults.map((c) => {
                    const already = candidateIds.has(c.userId);
                    return (
                      <div
                        key={c.userId}
                        className="flex items-center justify-between gap-2 border-b px-3 py-2 text-sm last:border-0"
                      >
                        <span className="min-w-0 truncate">
                          <span className="font-mono text-xs text-muted-foreground">
                            {c.crewNo ?? "-"}
                          </span>{" "}
                          <span className="font-medium">{c.name || "-"}</span>{" "}
                          <span className="text-xs text-muted-foreground">
                            {c.teamName ?? "-"} · {c.schoolName ?? "-"} · {c.majorName ?? "-"}
                          </span>
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={already}
                          onClick={() => addCandidate(c)}
                        >
                          {already ? "추가됨" : "추가"}
                        </Button>
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* 수동 확인 필요 (자동 매칭 안 됨 — 직접 검색해 추가).
              운영자가 자동 매칭 실패 건을 먼저 확인·처리하도록 목록 위로 배치(문구/색상/동작 동일). */}
          {review.length > 0 && (
            <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3">
              <p className="text-xs font-medium text-amber-800">
                수동 확인 필요 {review.length}건 — 자동 매칭하지 않았습니다(오매칭 방지). 위
                &quot;수동 추가&quot;로 직접 확인 후 넣어주세요.
              </p>
              <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-amber-900">
                {review.map((r) => (
                  <li key={`${r.order}-${r.nickname}`} className="truncate">
                    · <span className="font-medium">{r.nickname}</span>{" "}
                    <span className="text-amber-700">({r.reason})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 검수 크루 목록 — 댓글 시간순 */}
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-xs font-medium text-muted-foreground">
              검수 크루 목록 · 댓글 시간순
            </p>
            {candidates.length === 0 ? (
              <p className="py-3 text-center text-sm text-muted-foreground">
                후보가 없습니다.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="px-2 py-1.5">크루 번호</th>
                      <th className="px-2 py-1.5">이름</th>
                      <th className="px-2 py-1.5">팀명</th>
                      <th className="px-2 py-1.5">파트명</th>
                      <th className="px-2 py-1.5">학교명</th>
                      <th className="px-2 py-1.5">전공명</th>
                      <th className="px-2 py-1.5 text-right">삭제</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((c) => (
                      <tr key={c.userId} className="border-b last:border-0">
                        <td className="px-2 py-1.5 font-mono text-xs">{c.crewNo ?? "-"}</td>
                        <td className="px-2 py-1.5 font-medium">{c.name || "-"}</td>
                        <td className="px-2 py-1.5 text-xs">{c.teamName ?? "-"}</td>
                        <td className="px-2 py-1.5 text-xs">{c.partName ?? "-"}</td>
                        <td className="px-2 py-1.5 text-xs">{c.schoolName ?? "-"}</td>
                        <td className="px-2 py-1.5 text-xs">{c.majorName ?? "-"}</td>
                        <td className="px-2 py-1.5 text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => removeCandidate(c.userId)}
                            aria-label={`${c.name} 제거`}
                          >
                            <X className="h-4 w-4 text-red-500" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
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
            className="w-full max-w-md space-y-4 rounded-lg bg-background p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold">라인 개설 확인</h3>
            <p className="text-sm text-muted-foreground">아래 정보로 라인을 개설합니다.</p>
            <dl className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">개설 주차</dt>
                <dd className="font-medium">{weekTitle(effectiveWeek)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">라인명</dt>
                <dd className="font-medium">{lineName}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">메인 타이틀</dt>
                <dd className="min-w-0 break-words font-medium">{mainTitle.trim()}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">아웃풋 링크</dt>
                <dd className="font-medium">{linkUrl.trim() ? 1 : 0}개</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">아웃풋 이미지</dt>
                <dd className="font-medium">{image ? 1 : 0}개</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">개설 크루</dt>
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
              <Button type="button" onClick={executeOpen} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
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
            className="w-full max-w-sm space-y-4 rounded-lg bg-background p-5 shadow-xl"
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
                  setBanner(null);
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
            className="w-full max-w-md space-y-4 rounded-lg bg-background p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold">라인 개설 취소 확인</h3>
            <p className="text-sm text-muted-foreground">
              아래 개설된 라인을 취소(되돌리기)합니다.
            </p>
            <dl className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">개설 주차</dt>
                <dd className="font-medium">{weekTitle(effectiveWeek)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">라인명</dt>
                <dd className="font-medium">{lineName}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">메인 타이틀</dt>
                <dd className="min-w-0 break-words font-medium">{openedLine.mainTitle}</dd>
              </div>
            </dl>
            <p className="text-xs text-red-600">
              주의: 개설 데이터·대상 크루가 삭제되고, 고객 앱에서 해당 라인이 사라집니다.
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
                disabled={saving}
                className="bg-red-600 text-white hover:bg-red-700"
              >
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                개설 취소
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
