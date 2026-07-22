"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Upload, Trash2, X, Lock, Unlock, CheckCircle2 } from "lucide-react";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";
import type { Cluster4InfoLineDetail } from "@/lib/adminCluster4LinesTypes";
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
import { Checkbox, checkedTextClass } from "@/components/ui/checkbox";
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
import { LINE_OPENING_RESULT, lineOpenSuccessMessage } from "@/lib/lineOpeningResultMessages";
import {
  OPENING_INVALID_HIGHLIGHT,
  OPENING_INVALID_HIGHLIGHT_MS,
  scrollFocusInvalidTarget,
} from "@/lib/openingInvalidHighlight";

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

// 개설 완료 상태에서 표시할 저장값(서버 SoT). 편집 폼 로컬 state 를 그대로 두지 않고,
//   info-lines GET 이 돌려준 활성 라인을 그대로 읽어 "개설 완료" 읽기 전용 뷰에 표시한다.
//   → 개설 직후 / 새로고침 / 주차 재방문 어느 경우든 서버 재조회 결과로 동일하게 복원된다.
type OpenedLineDetail = {
  id: string;
  mainTitle: string;
  activityTypeName: string | null;
  outputLinks: { url: string; label?: string | null }[];
  outputLink1: string | null;
  outputImages: string[];
  outputImageCaptions: (string | null)[];
  targets: { userId: string; displayName: string; organization: string | null }[];
};

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

// 필수 입력 오류 강조 대상 필드 키(폼 위→아래 순서). [개설] 클릭 시 첫 누락 항목으로 이동/강조한다.
type OpeningFieldKey =
  | "week"
  | "lineName"
  | "mainTitle"
  | "linkUrl"
  | "linkDesc"
  | "image"
  | "imageDesc";

// 누락 필드 wrapper 임시 강조 클래스·스크롤/포커스 로직은 공용 SoT(lib/openingInvalidHighlight)에서
//   가져온다 — practical-experience 등 다른 개설 폼과 동일한 UX(붉은 ring + 깜빡임 + 스크롤/포커스)를 공유.

// 강조된 필드 바로 아래 오류 설명(aria-describedby 로 연결). 강조 중이 아닐 땐 렌더하지 않는다.
function OpeningFieldError({
  show,
  id,
  message,
}: {
  show: boolean;
  id: string;
  message: string;
}) {
  if (!show) return null;
  return (
    <p id={id} role="alert" className="text-xs font-medium text-red-600">
      {message}
    </p>
  );
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
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) {
          throw apiErrorFrom(res, json, "업로드에 실패했습니다");
        }
        onUpload({ url: json.data.url, name: file.name });
      } catch (err) {
        console.error("[info] image upload failed", err);
        void adminDialog.alert({
          variant: "danger",
          title: "업로드 실패",
          description: getApiErrorMessage(err, "업로드에 실패했습니다"),
        });
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
  selectedWeekId,
  onSelectWeek,
  activityTypes,
  defaultActivityTypeId,
  onOpened,
}: {
  openableWeek: OpeningFormWeek | null;
  weekOptions: OpeningFormWeek[];
  // 활성 라인 개설 예외 주차 — 일반 모드에서 자동 정책 주차와 함께 선택 가능.
  exceptionWeeks?: ExceptionFormWeek[];
  // 대상 주차 단일 SoT — 상위(Section0)가 소유. 상태창·개설 판정·POST week_id·재조회가 모두 이 값을 쓴다.
  //   현재/자동 정책 주차 고정이 아니라 시즌의 선택 가능한 주차(weekOptions) 중 관리자가 고른 주차.
  selectedWeekId: string;
  onSelectWeek: (weekId: string) => void;
  activityTypes: ActivityTypeOption[];
  defaultActivityTypeId: string | null;
  // users prop 은 더 이상 쓰지 않는다(크루는 카페 검수/수동추가 API 로 채운다).
  users?: unknown;
  onOpened: () => void;
}) {
  const devMode = useAdminDevMode();
  const { toast } = useToast();

  // dev(?dev=true) 관리자 강제 개설 토글 — 저장 시 dev=true 를 붙여 서버 통합/휴식 fail-closed 게이트까지
  //   우회한다(테스트용). org-scoped 관리자 수동 개설은 dev 없이도 선택 주차를 서버가 허용(활동 관리 오픈 재검증).
  const [adminUnlock, setAdminUnlock] = useState(false);

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
  // 현재 (선택 주차 + 선택 라인) 에 이미 개설된 활성 라인 — [개설 취소] 대상 + "개설 완료" 뷰의 표시값(서버 SoT).
  const [openedLine, setOpenedLine] = useState<OpenedLineDetail | null>(null);
  // 이번 주 (선택 주차+라인) 오픈(개설 대상) 여부 — info-lines GET(isOpenThisWeek). false=미오픈(개설 차단).
  //   null = 미상(통합/미조회) → 게이트 미적용(개설 서버 강제로 최종 차단).
  const [openThisWeek, setOpenThisWeek] = useState<boolean | null>(null);
  // 개설/취소 후 openedLine 재조회 트리거.
  const [refreshTick, setRefreshTick] = useState(0);
  const [saving, setSaving] = useState(false);

  const unlocked = devMode && adminUnlock;

  // 대상 주차 옵션 = 시즌의 선택 가능한 주차(weekOptions) ∪ 활성 예외 주차(창 밖 과거/미래 포함).
  //   weeks-options 가 이미 scope=all 예외를 병합하지만, 라인-스코프 예외(allowed 목록)는 exceptionWeeks 로만
  //   내려오므로 누락 방지를 위해 합집합으로 구성한다(중복 id 는 첫 항목 유지).
  const weekChoices = useMemo<OpeningFormWeek[]>(() => {
    const map = new Map<string, OpeningFormWeek>();
    for (const w of weekOptions) map.set(w.id, w);
    for (const e of exceptionWeeks) if (!map.has(e.id)) map.set(e.id, e);
    // 최신순(시작일 내림차순) — weeks-options 정렬과 동일.
    return Array.from(map.values()).sort((a, b) =>
      a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0,
    );
  }, [weekOptions, exceptionWeeks]);

  // 유효 선택 id — 상위가 준 selectedWeekId 가 목록에 있으면 그대로, 아니면 자동 정책 주차 → 첫 항목 fallback.
  const effectiveWeekIdResolved = weekChoices.some((w) => w.id === selectedWeekId)
    ? selectedWeekId
    : openableWeek?.id ?? weekChoices[0]?.id ?? "";

  const effectiveWeek = useMemo<OpeningFormWeek | null>(
    () => weekChoices.find((w) => w.id === effectiveWeekIdResolved) ?? openableWeek,
    [weekChoices, effectiveWeekIdResolved, openableWeek],
  );

  // 선택한 주차가 라인-스코프 예외인데 현재 라인이 허용 목록에 없으면 개설 불가.
  //   (dev 잠금 해제 시 우회 — 강제 개설 테스트용.)
  const lineNotAllowedForException = useMemo(() => {
    if (unlocked) return false;
    const ex = exceptionWeeks.find((e) => e.id === effectiveWeek?.id);
    if (!ex || ex.allowedActivityTypeIds === null) return false;
    return !!lineId && !ex.allowedActivityTypeIds.includes(lineId);
  }, [unlocked, exceptionWeeks, effectiveWeek, lineId]);

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
        const row: Cluster4InfoLineDetail | null = json?.success
          ? (json.data?.rows ?? []).find((r: Cluster4InfoLineDetail) => r.isActive) ?? null
          : null;
        setOpenedLine(
          row
            ? {
                id: row.id,
                mainTitle: row.mainTitle,
                activityTypeName: row.activityTypeName ?? null,
                outputLinks: row.outputLinks ?? [],
                outputLink1: row.outputLink1 ?? null,
                outputImages: row.outputImages ?? [],
                outputImageCaptions: row.outputImageCaptions ?? [],
                targets: (row.targets ?? [])
                  .filter((tt) => tt.targetUserId)
                  .map((tt) => ({
                    userId: tt.targetUserId as string,
                    displayName: tt.displayName,
                    organization: tt.organizationSlug ?? null,
                  })),
              }
            : null,
        );
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
    setMainTitle("");
    setLinkUrl("");
    setLinkDesc("");
    setImage(null);
    setImageDesc("");
    setCafeMeta(null);
    setCandidates([]);
    setCrewResetSignal((s) => s + 1);
  }, [defaultActivityTypeId]);

  // 개설 완료 여부 — 서버(openedLine)에 활성 라인이 있으면, 폼을 저장값으로 채운 채 잠근다(읽기 전용).
  //   별도 결과 레이아웃으로 바꾸지 않고 '개설 전과 동일한 입력 폼'에 값만 주입 후 disabled 처리한다.
  const locked = openedLine != null;

  // 개설 완료 상태 진입 시 서버 저장값을 같은 입력 폼에 그대로 주입(hydrate)한다.
  //   클라 빈 초기값이 서버 조회 결과를 덮지 않도록, id 가 (없음→있음)/(A→B) 로 바뀔 때만 채운다.
  //   개설 취소 등으로 완료 상태를 벗어나면(id 있음→없음) 편집 가능한 빈 폼으로 복귀한다.
  const prevOpenedIdRef = useRef<string | null>(null);
  useEffect(() => {
    const curr = openedLine?.id ?? null;
    // id 가 실제로 바뀔 때만(없음↔있음, A↔B) 반영. 같은 라인 재조회(동일 id)는 폼을 건드리지 않는다.
    if (curr === prevOpenedIdRef.current) return;
    // effect 동기 setState 회피(형제 fetch effect 와 동일 패턴) — setTimeout(0) 로 분리.
    const timer = setTimeout(() => {
      if (openedLine) {
        setMainTitle(openedLine.mainTitle);
        setLinkUrl(openedLine.outputLinks[0]?.url ?? openedLine.outputLink1 ?? "");
        setLinkDesc(openedLine.outputLinks[0]?.label ?? "");
        setImage(
          openedLine.outputImages[0]
            ? { url: openedLine.outputImages[0], name: "저장된 이미지" }
            : null,
        );
        setImageDesc(openedLine.outputImageCaptions[0] ?? "");
        setCandidates(
          openedLine.targets.map((tt) => ({
            userId: tt.userId,
            crewNo: null,
            crewCode: null,
            name: tt.displayName,
            teamName: null,
            partName: null,
            schoolName: null,
            majorName: null,
            organization: tt.organization,
          })),
        );
      } else {
        // 완료 상태에서 벗어남(개설 취소) → 편집 가능한 빈 폼으로 복귀.
        resetForm();
      }
      prevOpenedIdRef.current = curr;
    }, 0);
    return () => clearTimeout(timer);
  }, [openedLine, resetForm]);

  // ── 필수 입력 오류 UX — [개설] 클릭 시 팝업 + 첫 누락 항목으로 스크롤/강조/포커스 ──
  //   상시 누락 목록 대신, 클릭 시 첫 번째 누락 필드로 이동해 짧게 강조한다.
  const weekSectionRef = useRef<HTMLDivElement>(null);
  const weekSelectRef = useRef<HTMLSelectElement>(null);
  const lineSectionRef = useRef<HTMLDivElement>(null);
  const lineSelectRef = useRef<HTMLSelectElement>(null);
  const mainTitleSectionRef = useRef<HTMLDivElement>(null);
  const mainTitleRef = useRef<HTMLTextAreaElement>(null);
  const linkBoxRef = useRef<HTMLDivElement>(null);
  const imageBoxRef = useRef<HTMLDivElement>(null);
  // 현재 강조 중인 필드(짧은 빨간 강조). null = 강조 없음.
  const [invalidKey, setInvalidKey] = useState<OpeningFieldKey | null>(null);
  const [invalidMsg, setInvalidMsg] = useState("");
  const invalidTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 강조/포커스 대상 필드의 wrapper(스크롤용)와 focus 대상 element 를 key 로 해석.
  const resolveInvalidTargets = useCallback(
    (key: OpeningFieldKey): { wrap: HTMLElement | null; target: HTMLElement | null } => {
      switch (key) {
        case "week":
          return { wrap: weekSectionRef.current, target: weekSelectRef.current };
        case "lineName":
          return { wrap: lineSectionRef.current, target: lineSelectRef.current };
        case "mainTitle":
          return { wrap: mainTitleSectionRef.current, target: mainTitleRef.current };
        case "linkUrl":
          return {
            wrap: linkBoxRef.current,
            target: linkBoxRef.current?.querySelector<HTMLElement>('input[aria-label="아웃풋 링크 주소"]') ?? null,
          };
        case "linkDesc":
          return {
            wrap: linkBoxRef.current,
            target: linkBoxRef.current?.querySelector<HTMLElement>('input[aria-label="아웃풋 링크 설명"]') ?? null,
          };
        case "image":
          return {
            wrap: imageBoxRef.current,
            target: imageBoxRef.current?.querySelector<HTMLElement>('button[aria-label="이미지 업로드"]') ?? null,
          };
        case "imageDesc":
          return {
            wrap: imageBoxRef.current,
            target: imageBoxRef.current?.querySelector<HTMLElement>('input[aria-label="아웃풋 이미지 설명"]') ?? null,
          };
      }
    },
    [],
  );

  // 대상 필드로 스크롤 + 포커스 — 공용 helper(scrollFocusInvalidTarget) 재사용.
  const scrollFocusInvalid = useCallback(
    (key: OpeningFieldKey) => {
      const { wrap, target } = resolveInvalidTargets(key);
      scrollFocusInvalidTarget(wrap, target);
    },
    [resolveInvalidTargets],
  );

  // 입력을 시작하면 즉시 강조 해제.
  const clearInvalidHighlight = useCallback(() => {
    if (invalidTimerRef.current) {
      clearTimeout(invalidTimerRef.current);
      invalidTimerRef.current = null;
    }
    setInvalidKey((k) => (k === null ? k : null));
  }, []);

  // 언마운트 시 타이머 정리.
  useEffect(
    () => () => {
      if (invalidTimerRef.current) clearTimeout(invalidTimerRef.current);
    },
    [],
  );

  // [개설] 필수값 검증 — 폼 위→아래 순서(주차 → 라인명 → 메인 타이틀 → 링크 → 설명 → 이미지 → 이미지 설명).
  //   ⚠ 개설 크루는 0명도 유효 → 검증에 포함하지 않는다(0명 개설 허용 정책).
  const requiredChecks = useMemo<
    { key: OpeningFieldKey; missing: boolean; message: string }[]
  >(
    () => [
      { key: "week", missing: !effectiveWeek, message: "개설 대상 주차 정보를 확인할 수 없습니다." },
      {
        key: "week",
        missing: !!effectiveWeek && !effectiveWeek.canOpen,
        message: "선택한 주차는 공식 휴식 주차라 개설할 수 없습니다.",
      },
      {
        key: "week",
        missing:
          !!effectiveWeek &&
          effectiveWeek.canOpen &&
          (!effectiveWeek.submissionOpensAt || !effectiveWeek.submissionClosesAt),
        message: "선택한 주차의 기입 기간을 확인할 수 없습니다.",
      },
      { key: "lineName", missing: !lineId, message: "라인명을 선택해야 개설할 수 있습니다." },
      {
        key: "lineName",
        missing: lineNotAllowedForException,
        message: "이 예외 허용 주차는 선택한 라인의 개설을 허용하지 않습니다.",
      },
      { key: "mainTitle", missing: !mainTitle.trim(), message: "메인 타이틀을 입력해야 개설할 수 있습니다." },
      { key: "linkUrl", missing: !linkUrl.trim(), message: "아웃풋 링크 주소를 입력해야 개설할 수 있습니다." },
      { key: "linkDesc", missing: !linkDesc.trim(), message: "아웃풋 링크 설명을 입력해야 개설할 수 있습니다." },
      { key: "image", missing: !image, message: "아웃풋 이미지를 업로드해야 개설할 수 있습니다." },
      { key: "imageDesc", missing: !imageDesc.trim(), message: "아웃풋 이미지 설명을 입력해야 개설할 수 있습니다." },
    ],
    [effectiveWeek, lineId, lineNotAllowedForException, mainTitle, linkUrl, linkDesc, image, imageDesc],
  );

  const firstMissing = useMemo(
    () => requiredChecks.find((c) => c.missing) ?? null,
    [requiredChecks],
  );

  // 개설 가능 = 모든 필수 충족 + 미오픈 아님 + 이미 개설 아님(재개설 방지, executeOpen 가드에서도 사용).
  const canOpen = !firstMissing && openThisWeek !== false && !openedLine;

  // 개설 확인 모달용 요약값.
  const lineName = useMemo(
    () => activityTypes.find((t) => t.id === lineId)?.name ?? "-",
    [activityTypes, lineId],
  );

  // [개설] 클릭 → 필수 누락이 있으면 팝업 + 첫 누락 항목으로 이동/강조(개설 중단). 모두 충족 시 확인 모달.
  //   버튼은 (saving·locked 외에는) 항상 클릭 가능 — 눌러야 검증이 돌고 왜 안 되는지 안내된다.
  const handleOpenClick = useCallback(async () => {
    if (saving || locked) return;
    if (firstMissing) {
      const { key, message } = firstMissing;
      // ⚠ 다이얼로그를 열기 전에 먼저 강조 + 대상 필드로 포커스/스크롤한다. 이렇게 하면 다이얼로그가 닫힐 때
      //    포커스 복원 대상이 [개설] 버튼(폼 하단)이 아니라 이 필드가 되어, 스크롤이 버튼 쪽으로 되돌려지지 않는다.
      if (invalidTimerRef.current) {
        clearTimeout(invalidTimerRef.current);
        invalidTimerRef.current = null;
      }
      setInvalidKey(key);
      setInvalidMsg(message);
      scrollFocusInvalid(key);
      await adminDialog.alert({
        variant: "warning",
        title: "필수 입력 항목",
        description: `${message}\n첫 번째 누락 항목으로 이동합니다.`,
      });
      // 닫힌 뒤 한 번 더 확정(혹시 모를 복원 대비) + 1.6s 후 강조 해제(무한 깜빡임 금지).
      requestAnimationFrame(() => scrollFocusInvalid(key));
      invalidTimerRef.current = setTimeout(() => setInvalidKey(null), OPENING_INVALID_HIGHLIGHT_MS);
      return;
    }
    // 필드 아닌 하드 게이트(미오픈) — 스크롤 대상 없음. 안내만.
    if (openThisWeek === false) {
      await adminDialog.alert({
        variant: "warning",
        title: "개설 불가",
        description: "이번 주에 오픈되지 않은 라인입니다. 활동 관리에서 오픈 설정된 라인만 개설할 수 있습니다.",
      });
      return;
    }
    if (openedLine) return;
    setConfirmOpen(true);
  }, [saving, locked, firstMissing, openThisWeek, openedLine, scrollFocusInvalid]);

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
      // 운영/테스트 모드 전달 — 개설(executeOpen)과 동일. 서버가 스코프 가드로 타 모드 라인 삭제를 차단.
      if (new URLSearchParams(window.location.search).get("mode") === "test") qs.set("mode", "test");
      const res = await fetch(
        `/api/admin/cluster4/info-lines?${qs.toString()}`,
        { method: "DELETE" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw apiErrorFrom(res, json, "개설 취소에 실패했습니다");
      }
      toast("success", LINE_OPENING_RESULT.cancelSuccess);
      setOpenedLine(null);
      setRefreshTick((t) => t + 1);
      onOpened();
    } catch (err) {
      console.error("[info] open-cancel failed", err);
      toast("error", getApiErrorMessage(err, "개설 취소에 실패했습니다"));
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
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw apiErrorFrom(res, json, "개설에 실패했습니다");
      }
      console.warn("[line-opening] info form open result", {
        targetCount: json.data?.targetCount ?? candidates.length,
      });
      toast("success", lineOpenSuccessMessage(false));
      // 폼을 비우지 않는다 — 재조회로 openedLine 이 채워지면 hydrate 가 저장값을 주입하고 잠근다.
      setRefreshTick((t) => t + 1);
      onOpened();
    } catch (err) {
      console.error("[info] open failed", err);
      toast("error", getApiErrorMessage(err, "개설에 실패했습니다"));
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
        {/* 대상 주차 — 항상 최상단·게이트 바깥에 둔다. 선택 주차가 미오픈이어도 여기서 다른(오픈된) 주차로
            이동할 수 있어야 하므로 아래 openThisWeek 차단 패널 바깥에 배치한다. 단일 SoT=selectedWeekId(상위 소유). */}
        <section
          ref={weekSectionRef}
          className={cn("space-y-2", invalidKey === "week" && OPENING_INVALID_HIGHLIGHT)}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <Label className="text-sm font-semibold">
                대상 주차 <span className="text-red-500">*</span>
              </Label>
              <AdminHelpIconButton
                helpKey="admin.lineOpening.info.filter.openingWeek"
                title="대상 주차"
                size="xs"
              />
            </div>
            {devMode && (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-amber-700">
                <Checkbox
                  checked={adminUnlock}
                  onChange={(e) => setAdminUnlock(e.target.checked)}
                />
                {adminUnlock ? (
                  <Unlock className="h-3.5 w-3.5" />
                ) : (
                  <Lock className="h-3.5 w-3.5" />
                )}
                <span className={cn(checkedTextClass(adminUnlock))}>
                  관리자 강제 개설(휴식·통합 게이트 우회 · dev)
                </span>
              </label>
            )}
          </div>

          {/* 대상 주차 드롭다운 — 시즌의 선택 가능한 주차 전체를 항상 활성으로 노출(현재 주차 고정 아님).
              주차를 바꾸면 상위 selectedWeekId 가 갱신되어 상태창/개설 판정/POST week_id/재조회가 함께 이동한다.
              드롭다운 자체는 목록이 없을 때만 비활성 — 개설 가능 여부(휴식/미오픈/중복 등)는 아래 [개설] 버튼에만 적용. */}
          <select
            ref={weekSelectRef}
            aria-label="대상 주차"
            aria-invalid={invalidKey === "week"}
            aria-describedby={invalidKey === "week" ? "opening-err-week" : undefined}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:bg-muted/50"
            disabled={weekChoices.length === 0}
            value={effectiveWeek?.id ?? ""}
            onChange={(e) => {
              clearInvalidHighlight();
              onSelectWeek(e.target.value);
            }}
          >
            {weekChoices.length === 0 && (
              <option value="">개설 대상 주차를 계산할 수 없습니다</option>
            )}
            {weekChoices.map((w) => (
              <option key={w.id} value={w.id}>
                {weekTitle(w)} · {weekRange(w)}
                {w.isOpenTarget ? " · 개설 대상" : ""}
                {w.isCurrent ? " · 현재" : ""}
                {!w.canOpen ? " · 휴식" : ""}
              </option>
            ))}
          </select>
          <OpeningFieldError
            show={invalidKey === "week"}
            id="opening-err-week"
            message={invalidMsg}
          />

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
        {/* 개설 완료 배지 — 폼 구조/레이아웃은 개설 전과 동일하게 두고, 상태만 작은 배지로 표시한다. */}
        {locked && (
          <div className="flex items-start gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2.5 dark:border-emerald-800 dark:bg-emerald-950/40">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-300">개설 완료</p>
              <p className="text-xs text-emerald-700/90 dark:text-emerald-400/90">
                아래는 이 주차·라인에 저장된 개설 정보입니다(읽기 전용). 수정하려면 하단 [개설 취소] 후 다시 개설하세요.
              </p>
            </div>
          </div>
        )}
        {/* 상단 입력 — 데스크톱 2열(라인명 · 메인 타이틀). 좁은 화면은 1열로 쌓인다.
            대상 주차는 게이트 바깥(최상단)에 남아 이 그리드에 포함하지 않는다. */}
        <div className="grid grid-cols-1 gap-x-6 gap-y-6 xl:grid-cols-2">
        {/* 2. 라인명 — 상단 활동유형 탭에서 선택된 유형의 라인만 후보로 노출(Manager 가 필터). */}
        <section
          ref={lineSectionRef}
          className={cn("space-y-2", invalidKey === "lineName" && OPENING_INVALID_HIGHLIGHT)}
        >
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
            ref={lineSelectRef}
            aria-label="라인명"
            aria-invalid={invalidKey === "lineName"}
            aria-describedby={invalidKey === "lineName" ? "opening-err-lineName" : undefined}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:bg-muted/50"
            value={lineId}
            onChange={(e) => {
              clearInvalidHighlight();
              setLineId(e.target.value);
            }}
            disabled={saving || locked}
          >
            <option value="">라인을 선택해주세요</option>
            {activityTypes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <OpeningFieldError
            show={invalidKey === "lineName"}
            id="opening-err-lineName"
            message={invalidMsg}
          />
        </section>

        {/* 3. 메인 타이틀 + "일반" */}
        <section
          ref={mainTitleSectionRef}
          className={cn("space-y-2", invalidKey === "mainTitle" && OPENING_INVALID_HIGHLIGHT)}
        >
          <div className="flex items-center justify-between">
            <Label htmlFor="opening-main-title" className="inline-flex items-center gap-1 text-sm font-semibold">
              메인 타이틀 <span className="text-red-500">*</span><AdminHelpIconButton size="xs" helpKey="admin.lineOpening.field.mainTitle" title="메인 타이틀" />
            </Label>
            <span className="inline-flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  clearInvalidHighlight();
                  setMainTitle(GENERAL_MAIN_TITLE);
                }}
                title="고정 문구를 입력란에 불러옵니다"
                disabled={saving || locked}
              >
                일반
              </Button>
              <AdminHelpIconButton size="xs" helpKey="admin.lineOpening.info.action.generalTitle" title="일반" />
            </span>
          </div>
          <textarea
            id="opening-main-title"
            ref={mainTitleRef}
            aria-invalid={invalidKey === "mainTitle"}
            aria-describedby={invalidKey === "mainTitle" ? "opening-err-mainTitle" : undefined}
            value={mainTitle}
            onChange={(e) => {
              clearInvalidHighlight();
              setMainTitle(e.target.value);
            }}
            rows={3}
            placeholder="메인 타이틀을 입력하거나 우측 상단 '일반' 버튼으로 고정 문구를 불러오세요"
            disabled={saving || locked}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:bg-muted/50"
          />
          <OpeningFieldError
            show={invalidKey === "mainTitle"}
            id="opening-err-mainTitle"
            message={invalidMsg}
          />
        </section>
        </div>

        {/* 4. 아웃풋 — 라벨 아래 데스크톱 2열(링크 · 이미지). 좁은 화면은 1열. */}
        <section className="space-y-4">
          <Label className="inline-flex items-center gap-1 text-sm font-semibold">
            아웃풋 <span className="text-red-500">*</span><AdminHelpIconButton size="xs" helpKey="admin.lineOpening.field.output" title="아웃풋" />
          </Label>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {/* 아웃풋 링크 — "링크 1" / "설명 1" 각각 한 줄 */}
            <div
              ref={linkBoxRef}
              className={cn(
                "space-y-2 rounded-md border p-3",
                (invalidKey === "linkUrl" || invalidKey === "linkDesc") &&
                  OPENING_INVALID_HIGHLIGHT,
              )}
            >
              <p className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">아웃풋 링크<AdminHelpIconButton size="xs" helpKey="admin.lineOpening.info.field.outputLink" title="아웃풋 링크" /></p>
              <div className="flex items-center gap-2">
                <Label className="inline-flex w-20 shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
                  링크 1<AdminHelpIconButton size="xs" helpKey="admin.lineOpening.field.outputLink" title="링크 1" />
                </Label>
                <Input
                  value={linkUrl}
                  onChange={(e) => {
                    clearInvalidHighlight();
                    setLinkUrl(e.target.value);
                  }}
                  placeholder="아웃풋 링크 주소 (https://...)"
                  aria-label="아웃풋 링크 주소"
                  aria-invalid={invalidKey === "linkUrl"}
                  aria-describedby={invalidKey === "linkUrl" ? "opening-err-linkUrl" : undefined}
                  disabled={saving || locked}
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="inline-flex w-20 shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
                  설명 1<AdminHelpIconButton size="xs" helpKey="admin.lineOpening.field.outputLinkDescription" title="설명 1" />
                </Label>
                <Input
                  value={linkDesc}
                  onChange={(e) => {
                    clearInvalidHighlight();
                    setLinkDesc(e.target.value);
                  }}
                  placeholder="아웃풋 링크 설명"
                  aria-label="아웃풋 링크 설명"
                  aria-invalid={invalidKey === "linkDesc"}
                  aria-describedby={invalidKey === "linkDesc" ? "opening-err-linkDesc" : undefined}
                  disabled={saving || locked}
                />
              </div>
              <OpeningFieldError
                show={invalidKey === "linkUrl"}
                id="opening-err-linkUrl"
                message={invalidMsg}
              />
              <OpeningFieldError
                show={invalidKey === "linkDesc"}
                id="opening-err-linkDesc"
                message={invalidMsg}
              />
            </div>
            {/* 아웃풋 이미지 — "이미지 1"(미리보기+업로드/삭제) / "설명 1" 각각 한 줄 */}
            <div
              ref={imageBoxRef}
              className={cn(
                "space-y-2 rounded-md border p-3",
                (invalidKey === "image" || invalidKey === "imageDesc") &&
                  OPENING_INVALID_HIGHLIGHT,
              )}
            >
              <p className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">아웃풋 이미지<AdminHelpIconButton size="xs" helpKey="admin.lineOpening.info.field.outputImage" title="아웃풋 이미지" /></p>
              <OpeningImageSlot
                image={image}
                caption={imageDesc}
                onUpload={(img) => {
                  clearInvalidHighlight();
                  setImage(img);
                }}
                onRemove={() => {
                  setImage(null);
                  setImageDesc("");
                }}
                onCaptionChange={(v) => {
                  clearInvalidHighlight();
                  setImageDesc(v);
                }}
                onExpand={() => setImageModalOpen(true)}
                disabled={saving || locked}
              />
              <OpeningFieldError
                show={invalidKey === "image"}
                id="opening-err-image"
                message={invalidMsg}
              />
              <OpeningFieldError
                show={invalidKey === "imageDesc"}
                id="opening-err-imageDesc"
                message={invalidMsg}
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
          disabled={saving || locked}
        />

        {/* 개설 액션 (폼 최하단 — '라인 개설 크루' 다음 최종 액션 영역) — [개설] [초기화] [개설 취소].
            상태 구분은 버튼 활성 상태만으로: 미개설=개설/초기화 활성·개설 취소 비활성,
            개설 완료(locked)=개설/초기화 비활성·개설 취소 활성. 위치/구조는 개설 전과 동일. */}
        <div className="space-y-2 border-t pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1">
              <Button
                type="button"
                onClick={handleOpenClick}
                disabled={saving || locked}
                loading={saving}
                className="h-11 px-6 text-base"
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
                disabled={saving || locked}
                className="h-11 px-6 text-base"
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
                loading={saving}
                className="h-11 px-6 text-base text-red-600 hover:text-red-700"
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
          {/* 상시 누락 목록은 제거 — 누락 안내는 [개설] 클릭 시 팝업 + 첫 누락 항목 스크롤/강조로 통일. */}
        </div>
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
