"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, ImageIcon, Lock, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { adminDialog } from "@/components/ui/admin-dialog";
import { useActionToast } from "@/lib/actionToast";
import { type ScopeMode } from "@/lib/userScopeShared";
import { type CrewIdentity, dash } from "@/components/admin/crew/CrewIdentityCards";
import type { AdminCrewWeekLineDetailDto } from "@/lib/adminCrewWeekLineDetail";
import type { Cluster4EnhancementStatus } from "@/shared/cluster4.contracts";
import type { CareerGrade } from "@/lib/careerGrade";

// ─────────────────────────────────────────────────────────────────────
// 관리자 라인 상세·수정 팝업. 크루 카드 라인 SoT(GET .../lines/[lineId])를 표시하고,
//   관리자 권한으로 제출(서브타이틀/그로스/링크/이미지)·강화 결과를 수정한다.
//   원칙:
//   · 성공 상태 제출 데이터(A)는 절대 삭제/빈값 덮어쓰기 금지. 실패/해당없음은 화면에서만 숨김·비활성.
//     다시 성공으로 오면 A 복원 → draft 는 상태 전환에도 계속 A 를 보존한다(빈값 초기화 안 함).
//   · Main Title·허브·라인명·라인코드·실무자 = 조회 전용(서버 allowlist 에서도 거부).
//   · 강화 결과 레버: 경험=평점, 경력=grade(파생), 정보/역량=표시 override.
//   · 저장 전까지 draft 만 유지, 저장은 원자적(부분 저장 방지). 이미지 편집은 인터페이스만(업로드 후속).
// ─────────────────────────────────────────────────────────────────────

// 오픈된 라인의 개인 결과는 강화 성공/실패만 설정한다(정책 2026-07-16):
//   오픈 + 대상자 = 성공 / 오픈 + 대상자 아님 = 실패 / 미오픈 = 해당 없음(클럽 전체 데이터, 이 화면 변경 불가).
//   이 팝업은 오픈 라인(lineId 보유)만 열리므로 "해당 없음"은 선택지에서 제외한다.
const RESULT_OPTIONS: { value: Cluster4EnhancementStatus; label: string }[] = [
  { value: "success", label: "강화 성공" },
  { value: "fail", label: "강화 실패" },
];
const MAX_LINKS = 5;
const MAX_IMAGES = 4;
const SUBTITLE_MAX = 300;
const GROWTHPOINT_MAX = 200;

type LinkDraft = { url: string; label: string };
type ImgSlot = { url: string; caption: string };

// 경험: 평점(0~10)에서 강화 결과 파생(rating>=4 성공, 그 외 실패). 오픈 라인은 해당없음이 될 수 없다.
//   미책정(null)은 "성공 아님" = 실패로 본다(저장 시 대상자 해제). 서버가 최종 권위.
function deriveExperienceStatus(rating: number | null): Cluster4EnhancementStatus {
  return rating != null && rating >= 4 ? "success" : "fail";
}
// 드롭다운 → 경험 평점 canonical(현재 값이 그 결과를 이미 만들면 유지, 아니면 대표값). 관리자는 이후 미세조정.
function canonicalRatingFor(status: Cluster4EnhancementStatus, cur: number | null): number | null {
  if (status === "success") return cur != null && cur >= 4 ? cur : 4;
  return cur != null && cur <= 3 ? cur : 3; // fail
}
// 드롭다운 → 경력 grade canonical.
function canonicalGradeFor(status: Cluster4EnhancementStatus, cur: CareerGrade | null): CareerGrade | null {
  if (status === "success") return cur && cur !== "D" ? cur : "A";
  return "D"; // fail
}
// 이미지 슬롯 항상 4개(위치 고정). 빈 슬롯은 url:"".
function padSlots(urls: string[], captions: (string | null)[]): ImgSlot[] {
  return Array.from({ length: MAX_IMAGES }, (_, i) => ({ url: urls[i] ?? "", caption: captions[i] ?? "" }));
}

// 실무 역량 placeholder(라인 선택) 모드에서 드롭다운에 뿌리는 마스터 옵션.
type CompetencyMasterOption = {
  masterId: string;
  lineCode: string | null;
  lineName: string;
  mainTitle: string | null;
  previewLink: string | null;
  previewImage: string | null;
};

export default function CrewWeekLineDetailDialog({
  userId,
  weekId,
  lineId,
  mode,
  member,
  weekLabel,
  competencyPlaceholder,
  placeholderEditable,
  orgSlug,
  onClose,
  onSaved,
}: {
  userId: string;
  weekId: string;
  lineId: string | null; // null = 실무 역량 placeholder(라인 선택 모드)
  mode: ScopeMode;
  member: CrewIdentity | null;
  weekLabel?: string | null; // placeholder 헤더 주차명(상세 GET 없이 표시)
  competencyPlaceholder?: boolean; // true = 라인 선택 후 강화 성공 생성 모드
  placeholderEditable?: boolean; // placeholder 편집 가능(확정 주차)
  orgSlug?: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // 실무 역량 placeholder(-) 모드: lineId 없음. 공통 상세 팝업 UI 를 그대로 쓰되 "라인 선택" 필드만 추가.
  const isPlaceholder = competencyPlaceholder === true;
  const t = useActionToast();
  const [detail, setDetail] = useState<AdminCrewWeekLineDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ── draft 상태 ── (resultStatus = 강화 결과 단일 소스, 허브별 rating/grade 와 동기화)
  const [resultStatus, setResultStatus] = useState<Cluster4EnhancementStatus>("fail");
  const [subTitle, setSubTitle] = useState("");
  const [growthPoint, setGrowthPoint] = useState("");
  const [links, setLinks] = useState<LinkDraft[]>([]);
  const [images, setImages] = useState<ImgSlot[]>([]); // 항상 length 4(위치 고정), 빈 슬롯 url:""
  const [rating, setRating] = useState<number | null>(null);
  const [grade, setGrade] = useState<CareerGrade | null>(null);
  const [editingSub, setEditingSub] = useState(false);
  const [editingGrowth, setEditingGrowth] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  // placeholder(라인 선택) 모드 전용 상태.
  const [options, setOptions] = useState<CompetencyMasterOption[] | null>(null);
  const [selectedMasterId, setSelectedMasterId] = useState("");

  const ctxQuery = mode === "test" ? "?mode=test" : "";

  const applyDetailToDraft = useCallback((d: AdminCrewWeekLineDetailDto) => {
    // 오픈 라인 개인 결과는 성공/실패만. 현재 성공이면 성공, 그 외(실패/해당없음/집계전)는 실패로 표시.
    setResultStatus(d.currentStatus === "success" ? "success" : "fail");
    setSubTitle(d.submission.subTitle ?? "");
    setGrowthPoint(d.submission.growthPoint ?? "");
    setLinks(d.submission.outputLinks.map((l) => ({ url: l.url ?? "", label: l.label ?? "" })));
    setImages(padSlots(d.submission.outputImages, d.submission.outputImageCaptions));
    setRating(d.rating.value);
    setGrade(d.careerGrade);
    setEditingSub(false);
    setEditingGrowth(false);
  }, []);

  // placeholder 모드의 합성 detail — 선택 마스터를 반영해 Main Title/링크/이미지 영역이 공통 UI 로 채워진다.
  const buildPlaceholderDetail = useCallback(
    (opt: CompetencyMasterOption | null): AdminCrewWeekLineDetailDto => ({
      identity: {
        lineId: "",
        lineTargetId: null,
        lineCode: opt?.lineCode ?? null,
        lineName: opt?.lineName ?? "라인명 미정",
        partType: "competency",
        hubLabel: "실무 역량",
        mainTitle: opt?.mainTitle ?? null,
      },
      week: { id: weekId, label: weekLabel ?? "-", startDate: "", endDate: "" },
      organizationSlug: orgSlug ?? null,
      clubOpen: true,
      currentStatus: "fail",
      editable: placeholderEditable === true,
      rating: { supported: false, value: null },
      careerGrade: null,
      practitioner: null,
      submission: {
        subTitle: null,
        growthPoint: null,
        outputLinks: opt?.previewLink ? [{ url: opt.previewLink, label: null }] : [],
        outputImages: opt?.previewImage ? [opt.previewImage] : [],
        outputImageCaptions: opt?.previewImage ? [null] : [],
      },
    }),
    [weekId, weekLabel, orgSlug, placeholderEditable],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (isPlaceholder) {
        // 라인 선택 모드 — 상세 GET 없이 마스터 옵션을 불러오고 합성 detail(강화 실패·미선택)로 시작.
        const res = await fetch(
          `/api/admin/members/${userId}/weeks/${weekId}/competency-lines${ctxQuery}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json?.error ?? "실무 역량 라인 목록을 불러오지 못했습니다.");
        setOptions((json.data.options ?? []) as CompetencyMasterOption[]);
        const base = buildPlaceholderDetail(null);
        setDetail(base);
        applyDetailToDraft(base);
        setSelectedMasterId("");
        return;
      }
      const res = await fetch(
        `/api/admin/members/${userId}/weeks/${weekId}/lines/${lineId}${ctxQuery}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json?.error ?? "라인 상세를 불러오지 못했습니다.");
      const d = json.data as AdminCrewWeekLineDetailDto;
      setDetail(d);
      applyDetailToDraft(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "라인 상세를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, [userId, weekId, lineId, ctxQuery, applyDetailToDraft, isPlaceholder, buildPlaceholderDetail]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // placeholder 모드에서 마스터 선택이 바뀌면 합성 detail 을 갱신해 Main Title/링크/이미지 영역을 채운다.
  const onSelectMaster = useCallback(
    (masterId: string) => {
      setSelectedMasterId(masterId);
      const opt = options?.find((o) => o.masterId === masterId) ?? null;
      const d = buildPlaceholderDetail(opt);
      setDetail(d);
      applyDetailToDraft(d);
    },
    [options, buildPlaceholderDetail, applyDetailToDraft],
  );

  const partType = detail?.identity.partType;
  const isExperience = partType === "experience";
  const isCareer = partType === "career";

  // 강화 결과 단일 소스 = resultStatus(모든 허브 드롭다운). 허브별 레버(rating/grade)와 양방향 동기화.
  const effectiveStatus = resultStatus;

  // 드롭다운 변경 → 허브별 레버 canonical 반영(모든 허브 동일 UI, 저장은 각 SoT).
  const onResultChange = useCallback(
    (next: Cluster4EnhancementStatus) => {
      setResultStatus(next);
      if (isExperience) setRating((r) => canonicalRatingFor(next, r));
      else if (isCareer) setGrade((g) => canonicalGradeFor(next, g));
    },
    [isExperience, isCareer],
  );
  // 평점 직접 변경(경험) → 드롭다운 동기화.
  const onRatingChange = useCallback((r: number | null) => {
    setRating(r);
    setResultStatus(deriveExperienceStatus(r));
  }, []);

  const editable = detail?.editable === true;
  // placeholder 모드: 제출 필드는 선택 라인 미리보기(조회 전용). 실제 제출 편집은 라인 생성 후 일반 팝업.
  const submissionEditable = !isPlaceholder && editable && effectiveStatus === "success";

  const dirty = useMemo(() => {
    // placeholder: 강화 성공 + 라인 선택 시에만 저장 가능(변경).
    if (isPlaceholder) return effectiveStatus === "success" && selectedMasterId !== "";
    const b = detail;
    if (!b) return false;
    if (effectiveStatus !== b.currentStatus) return true;
    if ((subTitle.trim() || null) !== (b.submission.subTitle ?? null)) return true;
    if ((growthPoint.trim() || null) !== (b.submission.growthPoint ?? null)) return true;
    if (rating !== b.rating.value) return true;
    if (grade !== b.careerGrade) return true;
    const baseLinks = b.submission.outputLinks.map((l) => `${l.url ?? ""}|${l.label ?? ""}`).join("~");
    const draftLinks = links.map((l) => `${l.url}|${l.label}`).join("~");
    if (baseLinks !== draftLinks) return true;
    const baseImgs = b.submission.outputImages
      .map((url, i) => `${url}|${b.submission.outputImageCaptions[i] ?? ""}`)
      .join("~");
    // draft 는 위치 고정 4슬롯 — 빈 슬롯 제외하고 순서대로 비교(저장은 compact).
    const draftImgs = images.filter((im) => im.url.trim()).map((im) => `${im.url}|${im.caption}`).join("~");
    if (baseImgs !== draftImgs) return true;
    return false;
  }, [effectiveStatus, subTitle, growthPoint, rating, grade, links, images, detail, isPlaceholder, selectedMasterId]);

  const reset = useCallback(() => {
    if (detail) applyDetailToDraft(detail);
  }, [detail, applyDetailToDraft]);

  const requestClose = useCallback(async () => {
    if (saving) return;
    if (dirty) {
      const ok = await adminDialog.confirm({
        variant: "warning",
        title: "닫기",
        description: "저장하지 않은 변경사항이 있습니다.\n팝업을 닫으시겠습니까?",
        confirmLabel: "닫기",
      });
      if (!ok) return;
    }
    onClose();
  }, [dirty, saving, onClose]);

  const submit = useCallback(
    async (confirmGrowthFlip: boolean) => {
      if (isPlaceholder) {
        // 라인 선택 모드: 선택 마스터로 이 크루 전용 역량 라인 인스턴스 + 대상자 생성(강화 성공).
        const res = await fetch(`/api/admin/members/${userId}/weeks/${weekId}/competency-lines`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ masterId: selectedMasterId, confirmGrowthFlip, mode }),
        });
        const json = await res.json().catch(() => ({}));
        return { status: res.status, ok: res.ok, json };
      }
      const body = {
        enhancementStatus: effectiveStatus,
        statusData: {
          subTitle: subTitle.trim() || null,
          growthPoint: growthPoint.trim() || null,
          outputLinks: links
            .filter((l) => l.url.trim())
            .slice(0, MAX_LINKS)
            .map((l) => ({ url: l.url.trim(), label: l.label.trim() || null })),
          images: images
            .filter((im) => im.url.trim())
            .slice(0, MAX_IMAGES)
            .map((im) => ({ url: im.url.trim(), caption: im.caption.trim() || null })),
          rating: isExperience ? rating : null,
          grade: isCareer ? grade : null,
        },
        confirmGrowthFlip,
        mode,
      };
      const res = await fetch(`/api/admin/members/${userId}/weeks/${weekId}/lines/${lineId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, ok: res.ok, json };
    },
    [isPlaceholder, selectedMasterId, effectiveStatus, subTitle, growthPoint, links, images, rating, grade, isExperience, isCareer, mode, userId, weekId, lineId],
  );

  const doSave = useCallback(async () => {
    setSaving(true);
    try {
      let r = await submit(false);
      // 성장 결과 변경 확인(409) — 사용자 확인 후 재요청(재귀 아님).
      if (r.status === 409 && r.json?.error === "GROWTH_STATUS_WILL_CHANGE") {
        const g = r.json.growth ?? {};
        const ok = await adminDialog.confirm({
          variant: "warning",
          title: "성장 결과 변경",
          description: `${dash(member?.displayName)} 크루의 ${detail?.week.label ?? "해당 주차"} 결과가\n'${g.beforeLabel ?? "-"}'에서 '${g.afterLabel ?? "-"}'(으)로 변경됩니다.\n\n그래도 저장하시겠습니까?`,
          confirmLabel: "저장",
        });
        if (!ok) return;
        r = await submit(true);
      }
      if (!r.ok || !r.json?.success) {
        t.error("save", { status: r.status, message: r.json?.error });
        return;
      }
      t.success("save");
      onSaved();
      onClose(); // 서버 결과 반영(optimistic 금지) — 부모가 재조회.
    } catch {
      t.error("save", "network");
    } finally {
      setSaving(false);
    }
  }, [submit, t, onSaved, onClose, member, detail]);

  // ── 렌더 ──
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) void requestClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="라인 상세"
        className="flex max-h-[92vh] w-full max-w-[1200px] flex-col overflow-hidden rounded-xl bg-card text-card-foreground shadow-xl ring-1 ring-foreground/10"
      >
        {/* 헤더 */}
        <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
          <div className="min-w-0">
            {loading ? (
              <div className="h-6 w-64 animate-pulse rounded bg-muted" />
            ) : detail ? (
              <>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-sm font-semibold text-muted-foreground">
                    {detail.identity.hubLabel}
                  </span>
                  <span className="text-lg font-bold text-foreground">{detail.identity.lineName}</span>
                  {detail.identity.lineCode ? (
                    <span className="font-mono text-xs text-muted-foreground">
                      {detail.identity.lineCode}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{detail.week.label}</span>
                  {detail.week.startDate ? (
                    <span>
                      {detail.week.startDate} ~ {detail.week.endDate}
                    </span>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            {detail ? (
              <div className="flex items-center gap-2">
                <span className="whitespace-nowrap text-sm font-medium text-muted-foreground">
                  강화 결과
                </span>
                {/* 모든 허브 동일하게 드롭다운. 저장 시 경험=평점·경력=grade·정보/역량=override 로 반영. */}
                <select
                  value={effectiveStatus}
                  disabled={!editable || saving}
                  onChange={(e) => onResultChange(e.target.value as Cluster4EnhancementStatus)}
                  className={cn(
                    "rounded-md border bg-background px-2.5 py-1.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                    effectiveStatus === "success"
                      ? "border-emerald-500/50 text-emerald-700 dark:text-emerald-400"
                      : effectiveStatus === "fail"
                        ? "border-red-500/50 text-red-600 dark:text-red-400"
                        : "border-input text-muted-foreground",
                  )}
                  title={
                    isExperience
                      ? "선택 시 평점이 대표값으로 조정됩니다(평점으로 세부 조정 가능)."
                      : isCareer
                        ? "선택 시 등급이 대표값으로 조정됩니다."
                        : undefined
                  }
                >
                  {RESULT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <button
              type="button"
              aria-label="닫기"
              onClick={() => void requestClose()}
              disabled={saving}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-40"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* 본문(세로 스크롤) */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <p className="py-8 text-sm text-muted-foreground">불러오는 중…</p>
          ) : error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
              {error}
            </div>
          ) : detail ? (
            <div className="flex flex-col gap-5">
              {/* 회원 인적사항 / 클럽 소속 요약(조회 전용) */}
              {member ? <MemberStrip member={member} /> : null}

              {!editable && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                  성장 결과가 확정된 주차에서만 수정할 수 있습니다. 현재는 조회 전용입니다.
                </div>
              )}

              {/* 실무 역량 placeholder 전용 — 공통 UI 에 "라인 선택" 필드 1개만 추가. 강화 성공 시 노출. */}
              {isPlaceholder ? (
                effectiveStatus === "success" ? (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-sm font-semibold text-muted-foreground">실무 역량 라인 선택</label>
                    {options && options.length > 0 ? (
                      <select
                        value={selectedMasterId}
                        disabled={!editable || saving}
                        onChange={(e) => onSelectMaster(e.target.value)}
                        className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                      >
                        <option value="">라인 선택…</option>
                        {options.map((o) => (
                          <option key={o.masterId} value={o.masterId}>
                            {o.lineCode ? `[${o.lineCode}] ` : ""}
                            {o.lineName}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                        이 조직에서 선택 가능한(아직 배정되지 않은) 실무 역량 라인이 없습니다.
                      </div>
                    )}
                    {!selectedMasterId ? (
                      <span className="text-xs text-muted-foreground">
                        강화 성공으로 저장하려면 실무 역량 라인을 선택해주세요.
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <div className="rounded-md border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                    이 회원은 아직 실무 역량 대상자가 아닙니다(강화 실패). 강화 성공으로 인정하려면 상단에서
                    <b className="text-foreground"> 강화 성공</b>을 선택하고 실무 역량 라인을 지정해주세요.
                  </div>
                )
              ) : null}

              <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]">
                {/* 좌: 제출 텍스트 */}
                <div className="flex flex-col gap-4">
                  {/* Main Title — 조회 전용 */}
                  <ReadOnlyBox label="Main Title" value={detail.identity.mainTitle} />

                  {/* Sub Title — 수정 가능(성공 상태에서만) */}
                  <EditableBox
                    label="Sub Title"
                    value={subTitle}
                    onChange={setSubTitle}
                    editing={editingSub}
                    onToggleEdit={() => setEditingSub((v) => !v)}
                    disabled={!submissionEditable}
                    disabledReason={editable ? "강화 성공 상태에서만 수정할 수 있습니다." : undefined}
                    maxLength={SUBTITLE_MAX}
                  />

                  {/* Growth Point */}
                  <EditableBox
                    label="Growth Point"
                    value={growthPoint}
                    onChange={setGrowthPoint}
                    editing={editingGrowth}
                    onToggleEdit={() => setEditingGrowth((v) => !v)}
                    disabled={!submissionEditable}
                    disabledReason={editable ? "강화 성공 상태에서만 수정할 수 있습니다." : undefined}
                    maxLength={GROWTHPOINT_MAX}
                  />

                  {/* 평점(경험) / 실무자(경력) */}
                  {isExperience ? (
                    <RatingField rating={rating} onChange={onRatingChange} disabled={!editable || saving} />
                  ) : null}
                  {isCareer && detail.practitioner ? (
                    <PractitionerBox practitioner={detail.practitioner} />
                  ) : null}
                </div>

                {/* 우: 링크 + 이미지 */}
                <div className="flex flex-col gap-4">
                  <LinksEditor
                    links={links}
                    setLinks={setLinks}
                    disabled={!submissionEditable}
                  />
                  <ImagesEditor
                    userId={userId}
                    weekId={weekId}
                    lineId={lineId ?? ""}
                    mode={mode}
                    images={images}
                    setImages={setImages}
                    disabled={!submissionEditable}
                    onOpen={setLightbox}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* 푸터 */}
        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <Button type="button" variant="outline" size="sm" disabled={!editable || saving || !dirty} onClick={reset}>
            초기화
          </Button>
          <Button type="button" size="sm" loading={saving} disabled={!editable || !dirty} onClick={() => void doSave()}>
            저장
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => void requestClose()}>
            취소
          </Button>
        </div>
      </div>

      {lightbox ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-6"
          onMouseDown={() => setLightbox(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="아웃풋 이미지" className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      ) : null}
    </div>
  );
}

// ── 하위 표시/편집 컴포넌트 ──

function MemberStrip({ member }: { member: CrewIdentity }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md border bg-muted/20 px-4 py-3 text-sm">
      <span className="font-semibold text-foreground">{dash(member.displayName)}</span>
      <Meta label="성별" value={dash(member.gender)} />
      <Meta label="나이" value={member.age != null ? `만 ${member.age}` : "-"} />
      <Meta label="학교" value={dash(member.schoolName)} />
      <Meta label="전공" value={dash(member.departmentName)} />
      <Meta label="클래스" value={dash(member.classLabel)} />
      <Meta label="팀" value={dash(member.teamName)} />
      <Meta label="파트" value={dash(member.partName)} />
    </div>
  );
}
function Meta({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </span>
  );
}

function ReadOnlyBox({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <div className="min-h-[3rem] whitespace-pre-wrap break-words rounded-md border bg-muted/40 px-3 py-2 text-sm text-foreground">
        {value?.trim() ? value : <span className="text-muted-foreground">-</span>}
      </div>
    </div>
  );
}

function EditableBox({
  label,
  value,
  onChange,
  editing,
  onToggleEdit,
  disabled,
  disabledReason,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  editing: boolean;
  onToggleEdit: () => void;
  disabled: boolean;
  disabledReason?: string;
  maxLength: number;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground">{label}</span>
        {!disabled ? (
          <Button type="button" variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={onToggleEdit}>
            {editing ? "확인" : "수정"}
          </Button>
        ) : disabledReason ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Lock className="h-3 w-3" aria-hidden />
            {disabledReason}
          </span>
        ) : null}
      </div>
      {disabled ? (
        <div className="min-h-[3rem] rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          -
        </div>
      ) : editing ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={maxLength}
          rows={3}
          className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
        />
      ) : (
        <div className="min-h-[3rem] whitespace-pre-wrap break-words rounded-md border bg-muted/40 px-3 py-2 text-sm text-foreground">
          {value.trim() ? value : <span className="text-muted-foreground">-</span>}
        </div>
      )}
      {/* 실시간 글자 수 카운터(하단 우측) — 문자 단위(한/영/공백 동일). 초과 시 빨강. */}
      {!disabled ? (
        <span
          className={cn(
            "text-right text-xs tabular-nums",
            value.length > maxLength ? "text-red-500" : "text-muted-foreground",
          )}
        >
          {value.length} / {maxLength}
        </span>
      ) : null}
    </div>
  );
}

function RatingField({
  rating,
  onChange,
  disabled,
}: {
  rating: number | null;
  onChange: (v: number | null) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-muted-foreground">평점 (0~10)</span>
      <div className="flex items-center gap-2">
        <select
          value={rating == null ? "" : String(rating)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          className="w-28 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          <option value="">미책정</option>
          {Array.from({ length: 11 }, (_, i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">
          평점이 강화 결과를 결정합니다(4점 이상 = 강화 성공).
        </span>
      </div>
    </div>
  );
}

function PractitionerBox({
  practitioner,
}: {
  practitioner: NonNullable<AdminCrewWeekLineDetailDto["practitioner"]>;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-muted-foreground">실무자 정보 (조회 전용)</span>
      <dl className="grid grid-cols-2 gap-2 rounded-md border bg-muted/20 px-3 py-2.5 text-sm">
        <Meta label="기업·기관" value={dash(practitioner.companyName)} />
        <Meta label="실무자" value={dash(practitioner.supervisorName)} />
        <Meta label="부서" value={dash(practitioner.supervisorDepartment)} />
        <Meta label="직무" value={dash(practitioner.supervisorPosition)} />
      </dl>
    </div>
  );
}

function LinksEditor({
  links,
  setLinks,
  disabled,
}: {
  links: LinkDraft[];
  setLinks: (v: LinkDraft[]) => void;
  disabled: boolean;
}) {
  const update = (i: number, patch: Partial<LinkDraft>) =>
    setLinks(links.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const remove = (i: number) => setLinks(links.filter((_, idx) => idx !== i));
  const add = () => {
    if (links.length >= MAX_LINKS) return;
    setLinks([...links, { url: "", label: "" }]);
  };
  const validUrl = (u: string) => /^https?:\/\//i.test(u.trim());
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold text-muted-foreground">아웃풋 링크</span>
      {disabled ? (
        <div className="flex flex-col gap-1.5">
          {links.length === 0 ? (
            <span className="text-sm text-muted-foreground">-</span>
          ) : (
            links.map((l, i) => (
              <a
                key={i}
                href={validUrl(l.url) ? l.url : undefined}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-sm",
                  validUrl(l.url) ? "text-foreground hover:underline" : "pointer-events-none text-muted-foreground",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{l.label || l.url || "-"}</span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              </a>
            ))
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {links.map((l, i) => (
            <div key={i} className="flex flex-col gap-1 rounded-md border bg-muted/20 px-2.5 py-2">
              <div className="flex items-center gap-1.5">
                <input
                  value={l.label}
                  onChange={(e) => update(i, { label: e.target.value })}
                  placeholder="링크 설명"
                  maxLength={20}
                  className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                />
                <a
                  href={validUrl(l.url) ? l.url : undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded",
                    validUrl(l.url) ? "text-foreground hover:bg-muted" : "pointer-events-none opacity-30",
                  )}
                  title="열기"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  className="flex h-7 w-7 items-center justify-center rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10"
                  title="삭제"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <input
                value={l.url}
                onChange={(e) => update(i, { url: e.target.value })}
                placeholder="https://..."
                className={cn(
                  "w-full rounded border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  l.url.trim() && !validUrl(l.url) ? "border-red-400" : "border-input",
                )}
              />
              {l.url.trim() && !validUrl(l.url) ? (
                <span className="text-xs text-red-500">http(s):// 로 시작하는 URL 을 입력하세요.</span>
              ) : null}
            </div>
          ))}
          {links.length < MAX_LINKS ? (
            <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={add}>
              <Plus className="h-3.5 w-3.5" /> 링크 추가
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

// 아웃풋 이미지 편집 — 업로드/교체/삭제/캡션. 비활성(실패·해당없음) 시 "-"(draft 는 A 보존).
//   MAX_IMAGES 상수는 파일 상단(모듈 스코프)에서 이미 선언 — 여기서 재선언하지 않는다(중복 const = SyntaxError).
function ImagesEditor({
  userId,
  weekId,
  lineId,
  mode,
  images,
  setImages,
  disabled,
  onOpen,
}: {
  userId: string;
  weekId: string;
  lineId: string;
  mode: ScopeMode;
  images: ImgSlot[];
  setImages: (v: ImgSlot[]) => void;
  disabled: boolean;
  onOpen: (url: string) => void;
}) {
  const t = useActionToast();
  const [busySlot, setBusySlot] = useState<number | null>(null);
  const ctxQuery = mode === "test" ? "?mode=test" : "";
  // 항상 4슬롯(위치 고정). 삭제해도 슬롯 자체는 유지(빈 슬롯).
  const slots = Array.from({ length: MAX_IMAGES }, (_, i) => images[i] ?? { url: "", caption: "" });
  const busy = busySlot != null;

  const upload = async (slotIndex: number, file: File) => {
    setBusySlot(slotIndex);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("slot_index", String(slotIndex));
      const res = await fetch(
        `/api/admin/members/${userId}/weeks/${weekId}/lines/${lineId}/upload-image${ctxQuery}`,
        { method: "POST", body: fd },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        t.error("update", { status: res.status, message: json?.error });
        return;
      }
      setImages(slots.map((s, idx) => (idx === slotIndex ? { url: json.url as string, caption: s.caption } : s)));
    } catch {
      t.error("update", "network");
    } finally {
      setBusySlot(null);
    }
  };
  const removeAt = (i: number) =>
    setImages(slots.map((s, idx) => (idx === i ? { url: "", caption: "" } : s)));
  const setCaption = (i: number, caption: string) =>
    setImages(slots.map((s, idx) => (idx === i ? { ...s, caption } : s)));

  if (disabled) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-muted-foreground">아웃풋 이미지</span>
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: MAX_IMAGES }, (_, i) => (
            <div
              key={i}
              className="flex aspect-square items-center justify-center rounded-md border bg-muted/30 text-sm text-muted-foreground"
            >
              -
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold text-muted-foreground">아웃풋 이미지 (최대 {MAX_IMAGES})</span>
      {/* 항상 2×2 4슬롯. 채워진 슬롯=썸네일+교체/삭제/캡션, 빈 슬롯=업로드. 저장 순서=슬롯 순서. */}
      <div className="grid grid-cols-2 gap-3">
        {slots.map((im, i) =>
          im.url ? (
            <div key={i} className="flex flex-col gap-1 rounded-md border bg-muted/20 p-1.5">
              <div className="relative aspect-square overflow-hidden rounded bg-muted">
                <button type="button" onClick={() => onOpen(im.url)} className="block h-full w-full" title="확대">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={im.url} alt={im.caption || `이미지 ${i + 1}`} className="h-full w-full object-cover" />
                </button>
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  disabled={busy}
                  className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded bg-black/60 text-white hover:bg-black/80 disabled:opacity-40"
                  title="삭제"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
                <label
                  className={cn(
                    "absolute bottom-1 right-1 flex h-6 items-center gap-1 rounded bg-black/60 px-1.5 text-[10px] text-white",
                    busy ? "opacity-40" : "cursor-pointer hover:bg-black/80",
                  )}
                  title="교체"
                >
                  {busySlot === i ? "…" : "교체"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    className="hidden"
                    disabled={busy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void upload(i, f);
                      e.currentTarget.value = "";
                    }}
                  />
                </label>
              </div>
              <input
                value={im.caption}
                onChange={(e) => setCaption(i, e.target.value)}
                placeholder="캡션"
                maxLength={200}
                className="w-full rounded border border-input bg-background px-1.5 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </div>
          ) : (
            <label
              key={i}
              className={cn(
                "flex aspect-square flex-col items-center justify-center gap-1 rounded-md border border-dashed text-xs text-muted-foreground",
                busy ? "opacity-40" : "cursor-pointer hover:bg-muted/30",
              )}
            >
              {busySlot === i ? (
                "업로드 중…"
              ) : (
                <>
                  <ImageIcon className="h-5 w-5" /> 이미지 추가
                </>
              )}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void upload(i, f);
                  e.currentTarget.value = "";
                }}
              />
            </label>
          ),
        )}
      </div>
    </div>
  );
}
