"use client";

// /admin/lines/info — 라인 정보 (2026-06-07 개정: line_registrations 전용 화면).
//
// 4원천 통합 카탈로그(LineCatalogManager)를 대체한다 — 조회 원천은 line_registrations
// 단일 테이블(GET /api/admin/lines/registrations)이며 기존 4허브 SoT(cluster4_lines ·
// 마스터 · career_projects)와 snapshot 경로는 일절 참조/수정하지 않는다.
//
// 표시 컬럼(8): 라인명 · 적용 클럽(organization_slug) · 소속 허브 · 라인 종류 ·
//   라인 코드 · 메인 타이틀 종류(고정/변동) · 메인 타이틀 · 유닛 링크
//   + 상태 / 개설 연결 / 관리(수정) — Phase 2C·2E-6 기능을 그대로 유지.
//
// 필터/정렬/페이지네이션 (2026-06-07 추가, 전부 클라이언트 사이드):
//   필터 5종(적용 클럽·허브·라인 종류·메인 타이틀 종류[표시 정책 기준]·상태[활성/연결]),
//   검색 4필드(라인명·코드·메인 타이틀 표시값·유닛 링크), 정렬 6종 + 기본 정렬
//   (클럽→허브→종류→코드 asc, 전 옵션 id tiebreaker 로 안정성 보장), 20개/페이지,
//   필터·검색·정렬 변경 시 1페이지 리셋.
//
// 메인 타이틀 종류 표시 SoT = 허브 정책 (lineRegistrationDisplayMainTitle):
//   실무 정보/경력 = 변동(타이틀 '-') · 실무 경험/역량 = 고정(저장 main_title 표시).
//   저장 컬럼 main_title_mode 는 무수정 보존 — 편집 모달은 기존 동작 유지.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link2, Loader2, Pencil, RefreshCw, Search, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  LINE_REGISTRATION_HUBS,
  LINE_REGISTRATION_HUB_LABEL,
  LINE_REGISTRATION_LINE_TYPES,
  LINE_REGISTRATION_ORGS,
  LINE_REGISTRATION_ORG_LABEL,
  LINE_REGISTRATION_PROFILE_KEYS,
  VARIABLE_MAIN_TITLE_NOTICE,
  lineRegistrationDisplayMainTitle,
  type LineRegistrationDto,
  type LineRegistrationHub,
  type LineRegistrationOrg,
  type ListLineRegistrationsResult,
} from "@/lib/adminLineRegistrationsTypes";

const ALL = "all" as const;

// 정렬 옵션 — default = 적용 클럽 → 소속 허브 → 라인 종류 → 라인 코드 오름차순 (안정적 기본 정렬).
type SortKey =
  | "default"
  | "latest"
  | "oldest"
  | "name_asc"
  | "name_desc"
  | "code_asc"
  | "code_desc";

const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: "default", label: "기본 정렬 (클럽·허브·종류·코드)" },
  { value: "latest", label: "최신 등록순" },
  { value: "oldest", label: "오래된 등록순" },
  { value: "name_asc", label: "라인명 오름차순" },
  { value: "name_desc", label: "라인명 내림차순" },
  { value: "code_asc", label: "라인 코드 오름차순" },
  { value: "code_desc", label: "라인 코드 내림차순" },
];

// 메인 타이틀 종류 필터 — 표시 정책(허브 SoT) 기준 값으로 매칭.
type ModeFilter = typeof ALL | "fixed" | "variable";

// 상태 필터 — 활성/비활성(is_active) · 연결됨/미연결(bridged_master_id) 단일 셀렉트.
type StatusFilter = typeof ALL | "active" | "inactive" | "bridged" | "unbridged";

const PAGE_SIZE = 20;

// ── 기본 정렬 비교자 ──
// 모든 정렬은 마지막 tiebreaker 로 id 를 사용해 항상 동일한 순서를 보장한다(안정성).
const ORG_ORDER = new Map<string, number>(LINE_REGISTRATION_ORGS.map((o, i) => [o, i]));
const HUB_ORDER = new Map<string, number>(LINE_REGISTRATION_HUBS.map((h, i) => [h, i]));
// 라인 종류 전역 순서 — 일반 → 경험 5종 → 역량 4종 (필터 옵션과 동일 순서).
const LINE_TYPE_ORDER = new Map<string, number>(
  ["일반", "도출", "분석", "평가", "관리", "확장", "원리", "기술", "관점", "자원"].map(
    (t, i) => [t, i],
  ),
);

function rankOf(map: Map<string, number>, key: string | null): number {
  if (key === null) return Number.MAX_SAFE_INTEGER; // 미지정/미등록 값은 항상 뒤
  return map.get(key) ?? Number.MAX_SAFE_INTEGER - 1;
}

function defaultCompare(a: LineRegistrationDto, b: LineRegistrationDto): number {
  const org = rankOf(ORG_ORDER, a.organizationSlug) - rankOf(ORG_ORDER, b.organizationSlug);
  if (org !== 0) return org;
  const hub = rankOf(HUB_ORDER, a.hub) - rankOf(HUB_ORDER, b.hub);
  if (hub !== 0) return hub;
  const type = rankOf(LINE_TYPE_ORDER, a.lineType) - rankOf(LINE_TYPE_ORDER, b.lineType);
  if (type !== 0) return type;
  const code = a.lineCode.localeCompare(b.lineCode, "ko");
  if (code !== 0) return code;
  return a.id.localeCompare(b.id);
}

function compareRows(a: LineRegistrationDto, b: LineRegistrationDto, sort: SortKey): number {
  let cmp = 0;
  switch (sort) {
    case "default":
      return defaultCompare(a, b);
    case "latest":
      cmp = b.createdAt.localeCompare(a.createdAt);
      break;
    case "oldest":
      cmp = a.createdAt.localeCompare(b.createdAt);
      break;
    case "name_asc":
      cmp = a.lineName.localeCompare(b.lineName, "ko");
      break;
    case "name_desc":
      cmp = b.lineName.localeCompare(a.lineName, "ko");
      break;
    case "code_asc":
      cmp = a.lineCode.localeCompare(b.lineCode, "ko");
      break;
    case "code_desc":
      cmp = b.lineCode.localeCompare(a.lineCode, "ko");
      break;
  }
  return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <Label className="shrink-0 text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// 등록 편집 모달 (2E-6 선행 관리 기능 — LineCatalogManager 에서 이식, 동작 무변경).
// 게이트: 개설 라인(openedLineCount>0)이 있으면 라인 코드/소속 조직/경험 라인 종류 잠금.
// 허브는 항상 read-only. 저장 시 PATCH → mirror 마스터 정방향 sync (서버).
// ──────────────────────────────────────────────────────────────

type RegistrationDetail = {
  id: string;
  lineName: string;
  hub: LineRegistrationHub;
  hubLabel: string;
  lineType: string;
  lineCode: string;
  mainTitleMode: "fixed" | "variable";
  mainTitle: string;
  unitLink: string;
  organizationSlug: string | null;
  bridgedMasterId: string | null;
  partnerCompany: string | null;
  companyLogoUrl: string | null;
  managerName: string | null;
  managerPosition: string | null;
  managerJob: string | null;
  managerProfileKey: string | null;
  isActive: boolean;
  openedLineCount: number;
};

function RegistrationEditModal({
  registrationId,
  onClose,
  onSaved,
}: {
  registrationId: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [detail, setDetail] = useState<RegistrationDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // form state
  const [lineName, setLineName] = useState("");
  const [lineCode, setLineCode] = useState("");
  const [lineType, setLineType] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [mainTitleMode, setMainTitleMode] = useState<"fixed" | "variable">("fixed");
  const [mainTitle, setMainTitle] = useState("");
  const [unitLink, setUnitLink] = useState("");
  const [partnerCompany, setPartnerCompany] = useState("");
  const [managerName, setManagerName] = useState("");
  const [managerPosition, setManagerPosition] = useState("");
  const [managerJob, setManagerJob] = useState("");
  const [managerProfileKey, setManagerProfileKey] = useState("");
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/admin/lines/registrations/${encodeURIComponent(registrationId)}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(
            (json && typeof json.error === "string" && json.error) || `HTTP ${res.status}`,
          );
        }
        if (cancelled) return;
        const d = json.data as RegistrationDetail;
        setDetail(d);
        setLineName(d.lineName);
        setLineCode(d.lineCode);
        setLineType(d.lineType);
        setOrgSlug(d.organizationSlug ?? "");
        setMainTitleMode(d.mainTitleMode);
        setMainTitle(d.mainTitleMode === "variable" ? "" : d.mainTitle);
        setUnitLink(d.unitLink === "-" ? "" : d.unitLink);
        setPartnerCompany(d.partnerCompany ?? "");
        setManagerName(d.managerName ?? "");
        setManagerPosition(d.managerPosition ?? "");
        setManagerJob(d.managerJob ?? "");
        setManagerProfileKey(d.managerProfileKey ?? "");
        setIsActive(d.isActive);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "로드 실패");
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [registrationId]);

  const gateLocked = (detail?.openedLineCount ?? 0) > 0;

  const handleSave = useCallback(async () => {
    if (!detail) return;
    if (!lineName.trim()) {
      setError("라인명을 입력해주세요");
      return;
    }
    if (mainTitleMode === "fixed" && !mainTitle.trim()) {
      setError("메인 타이틀을 입력해주세요 (변동이면 '변동'을 선택)");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        line_name: lineName.trim(),
        line_type: lineType,
        main_title_mode: mainTitleMode,
        main_title: mainTitleMode === "fixed" ? mainTitle.trim() : null,
        unit_link: unitLink.trim() || null,
        is_active: isActive,
      };
      // 게이트 필드는 잠금 해제 상태(개설 0건)에서만 전송 — 값이 그대로면 서버 게이트도 통과하지만
      // 의도를 명확히 하기 위해 잠금 시 아예 보내지 않는다.
      if (!gateLocked) {
        payload.line_code = lineCode.trim();
        payload.organization_slug = orgSlug || null;
      }
      if (detail.hub === "career") {
        payload.partner_company = partnerCompany.trim() || null;
        payload.manager_name = managerName.trim() || null;
        payload.manager_position = managerPosition.trim() || null;
        payload.manager_job = managerJob.trim() || null;
        payload.manager_profile_key = managerProfileKey || null;
      }
      const res = await fetch(
        `/api/admin/lines/registrations/${encodeURIComponent(detail.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw new Error(
          (json && typeof json.error === "string" && json.error) || `HTTP ${res.status}`,
        );
      }
      const sync = (json as { driftSync?: { synced: boolean; warning: string | null } }).driftSync;
      onSaved(
        `등록이 수정되었습니다 (${lineName.trim()})` +
          (sync?.synced ? " — mirror 마스터에 동기화됨" : "") +
          (sync?.warning ? ` · 경고: ${sync.warning}` : ""),
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장에 실패했습니다");
    } finally {
      setSaving(false);
    }
  }, [
    detail, lineName, lineCode, lineType, orgSlug, mainTitleMode, mainTitle, unitLink,
    partnerCompany, managerName, managerPosition, managerJob, managerProfileKey,
    isActive, gateLocked, onClose, onSaved,
  ]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3">
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border bg-background shadow-xl"
      >
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <h2 className="text-base font-semibold">등록 수정</h2>
            {detail && (
              <p className="text-xs text-muted-foreground">
                {detail.hubLabel} · {detail.lineCode}
                {gateLocked &&
                  ` — 개설 라인 ${detail.openedLineCount}건: 라인 코드/소속 조직${detail.hub === "experience" ? "/라인 종류" : ""} 수정 잠금`}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="닫기"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {loadError ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {loadError}
            </div>
          ) : !detail ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 불러오는 중…
            </div>
          ) : (
            <>
              {error && (
                <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                  {error}
                </div>
              )}
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1.5 md:col-span-2">
                  <Label className="text-xs">라인명</Label>
                  <Input value={lineName} onChange={(e) => setLineName(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">소속 허브 (수정 불가)</Label>
                  <Input value={detail.hubLabel} disabled />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    라인 종류{detail.hub === "experience" && gateLocked ? " (잠금)" : ""}
                  </Label>
                  <select
                    aria-label="라인 종류 수정"
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                    value={lineType}
                    onChange={(e) => setLineType(e.target.value)}
                    disabled={detail.hub === "experience" && gateLocked}
                  >
                    {LINE_REGISTRATION_LINE_TYPES[detail.hub].map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">라인 코드{gateLocked ? " (잠금)" : ""}</Label>
                  <Input
                    value={lineCode}
                    onChange={(e) => setLineCode(e.target.value)}
                    disabled={gateLocked}
                    aria-label="라인 코드 수정"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">소속 조직{gateLocked ? " (잠금)" : ""}</Label>
                  <select
                    aria-label="소속 조직 수정"
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                    value={orgSlug}
                    onChange={(e) => setOrgSlug(e.target.value)}
                    disabled={gateLocked}
                  >
                    {/* bridged 행은 미지정(-) 복귀 금지 — 서버에서도 차단 */}
                    {!detail.bridgedMasterId && <option value="">-</option>}
                    {LINE_REGISTRATION_ORGS.map((o) => (
                      <option key={o} value={o}>
                        {LINE_REGISTRATION_ORG_LABEL[o]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label className="text-xs">메인 타이틀</Label>
                  <Input
                    value={mainTitle}
                    onChange={(e) => setMainTitle(e.target.value)}
                    placeholder="메인 타이틀"
                    disabled={mainTitleMode === "variable"}
                    aria-label="메인 타이틀 수정"
                  />
                  <div className="flex items-center gap-4 text-sm">
                    <label className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="radio"
                        name="editMainTitleMode"
                        checked={mainTitleMode === "fixed"}
                        onChange={() => setMainTitleMode("fixed")}
                      />
                      고정
                    </label>
                    <label className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="radio"
                        name="editMainTitleMode"
                        checked={mainTitleMode === "variable"}
                        onChange={() => setMainTitleMode("variable")}
                      />
                      변동
                    </label>
                  </div>
                  {mainTitleMode === "variable" && (
                    <p className="text-xs text-muted-foreground">{VARIABLE_MAIN_TITLE_NOTICE}</p>
                  )}
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label className="text-xs">유닛 링크</Label>
                  <Input
                    value={unitLink}
                    onChange={(e) => setUnitLink(e.target.value)}
                    placeholder='미입력 시 "-" 저장'
                    aria-label="유닛 링크 수정"
                  />
                </div>
              </div>

              {detail.hub === "career" && (
                <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    실무 경력 전용
                  </p>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">제휴/연계사</Label>
                      <Input value={partnerCompany} onChange={(e) => setPartnerCompany(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">담당자명</Label>
                      <Input value={managerName} onChange={(e) => setManagerName(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">직급</Label>
                      <Input value={managerPosition} onChange={(e) => setManagerPosition(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">직무</Label>
                      <Input value={managerJob} onChange={(e) => setManagerJob(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">프로필 사진</Label>
                      <select
                        aria-label="프로필 사진 수정"
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                        value={managerProfileKey}
                        onChange={(e) => setManagerProfileKey(e.target.value)}
                      >
                        <option value="">-</option>
                        {LINE_REGISTRATION_PROFILE_KEYS.map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* soft 비활성화 — 기존 개설 라인 무영향(신규 개설/개설 연결만 차단) */}
              <label className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  aria-label="활성 여부"
                />
                활성 (해제 시 신규 개설·개설 연결이 차단됩니다 — 기존 개설 라인은 영향 없음)
              </label>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t bg-muted/30 px-5 py-3">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            취소
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving || !detail}
          >
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            저장
          </Button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Main — line_registrations 전용 테이블.
// ──────────────────────────────────────────────────────────────

export default function LineRegistrationInfoManager() {
  const [data, setData] = useState<ListLineRegistrationsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  // Phase 2C — 브리지 진행/결과 상태.
  const [bridgingId, setBridgingId] = useState<string | null>(null);
  // 관리 기능(2E-6 선행) — 편집 모달 대상 registration id.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [banner, setBanner] = useState<
    { kind: "success" | "error"; message: string } | null
  >(null);

  const handleBridge = useCallback(async (row: LineRegistrationDto) => {
    setBridgingId(row.id);
    setBanner(null);
    try {
      const res = await fetch(
        `/api/admin/lines/registrations/${encodeURIComponent(row.id)}/bridge`,
        { method: "POST" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        const message =
          (json && typeof json.error === "string" && json.error) || `HTTP ${res.status}`;
        throw new Error(message);
      }
      const result = json.data as { action: string; masterTable: string; masterId: string };
      const actionLabel =
        result.action === "created"
          ? "마스터를 새로 생성해 연결했습니다"
          : result.action === "found"
            ? "기존 마스터에 연결했습니다 (마스터 무수정)"
            : "이미 연결된 마스터를 재사용했습니다";
      setBanner({
        kind: "success",
        message: `개설 연결 완료 — ${row.lineName}: ${actionLabel}. 기존 개설 화면 드롭다운에서 선택해 개설하세요.`,
      });
      setRefreshTick((n) => n + 1);
    } catch (err) {
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "개설 연결에 실패했습니다",
      });
    } finally {
      setBridgingId(null);
    }
  }, []);

  // 필터/정렬 상태 — 기간 정보 페이지 패턴 (클라이언트 사이드).
  const [sort, setSort] = useState<SortKey>("default");
  const [orgFilter, setOrgFilter] = useState<LineRegistrationOrg | typeof ALL>(ALL);
  const [hubFilter, setHubFilter] = useState<LineRegistrationHub | typeof ALL>(ALL);
  const [typeFilter, setTypeFilter] = useState<string | typeof ALL>(ALL);
  const [modeFilter, setModeFilter] = useState<ModeFilter>(ALL);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(ALL);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  // 필터/검색/정렬 변경 시 1페이지로 이동.
  useEffect(() => {
    setPage(1);
  }, [orgFilter, hubFilter, typeFilter, modeFilter, statusFilter, search, sort]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        // limit 상한 200 (API cap) — 초과분은 설명 영역에 표기해 silent truncation 을 막는다.
        const res = await fetch("/api/admin/lines/registrations?limit=200", {
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(
            (json && typeof json.error === "string" && json.error) || `HTTP ${res.status}`,
          );
        }
        if (cancelled) return;
        setData(json.data as ListLineRegistrationsResult);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "목록을 불러오지 못했습니다");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  const filtered = useMemo(() => {
    const rows = data?.rows ?? [];
    const q = search.trim().toLowerCase();
    const list = rows.filter((r) => {
      if (orgFilter !== ALL && r.organizationSlug !== orgFilter) return false;
      if (hubFilter !== ALL && r.hub !== hubFilter) return false;
      if (typeFilter !== ALL && r.lineType !== typeFilter) return false;
      // 메인 타이틀 종류 — 표시 정책(허브 SoT) 기준으로 매칭 (저장 mode 아님).
      const display = lineRegistrationDisplayMainTitle(r.hub, r.mainTitle);
      if (modeFilter !== ALL && display.mode !== modeFilter) return false;
      if (statusFilter === "active" && !r.isActive) return false;
      if (statusFilter === "inactive" && r.isActive) return false;
      if (statusFilter === "bridged" && r.bridgedMasterId === null) return false;
      if (statusFilter === "unbridged" && r.bridgedMasterId !== null) return false;
      // 검색 — 라인명 · 라인 코드 · 메인 타이틀(표시값) · 유닛 링크.
      if (
        q.length > 0 &&
        !r.lineName.toLowerCase().includes(q) &&
        !r.lineCode.toLowerCase().includes(q) &&
        !display.title.toLowerCase().includes(q) &&
        !r.unitLink.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
    return [...list].sort((a, b) => compareRows(a, b, sort));
  }, [data, orgFilter, hubFilter, typeFilter, modeFilter, statusFilter, search, sort]);

  // 페이지네이션 — 20개씩. 필터 결과 축소로 현재 페이지가 범위를 벗어나면 마지막 페이지로 보정.
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const paged = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
  );

  const fetchedCount = data?.rows.length ?? 0;
  const total = data?.total ?? 0;

  return (
    <div className="flex w-full flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-normal text-foreground">라인 정보</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          등록 대장(line_registrations)에 등록된 라인을 조회합니다. 신규 등록은 라인 등록
          페이지에서, 개설 연결은 이 화면의 &quot;개설 연결&quot;로 기존 개설 플로우에
          연결할 수 있습니다.
        </p>
      </div>

      {banner && (
        <div
          className={cn(
            "flex items-center justify-between rounded-md border px-3 py-2 text-sm",
            banner.kind === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-rose-200 bg-rose-50 text-rose-800",
          )}
        >
          <span>{banner.message}</span>
          <button type="button" onClick={() => setBanner(null)} className="hover:opacity-70">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* 필터/정렬 영역 — 기간 정보 페이지 패턴 */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-5 gap-y-2 py-3">
          <FilterField label="정렬">
            <select
              aria-label="정렬"
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </FilterField>

          <FilterField label="적용 클럽">
            <select
              aria-label="적용 클럽 필터"
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={orgFilter}
              onChange={(e) => setOrgFilter(e.target.value as LineRegistrationOrg | typeof ALL)}
            >
              <option value={ALL}>전체</option>
              {LINE_REGISTRATION_ORGS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </FilterField>

          <FilterField label="허브">
            <select
              aria-label="허브 필터"
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={hubFilter}
              onChange={(e) => setHubFilter(e.target.value as LineRegistrationHub | typeof ALL)}
            >
              <option value={ALL}>전체</option>
              {LINE_REGISTRATION_HUBS.map((h) => (
                <option key={h} value={h}>
                  {LINE_REGISTRATION_HUB_LABEL[h]}
                </option>
              ))}
            </select>
          </FilterField>

          <FilterField label="라인 종류">
            <select
              aria-label="라인 종류 필터"
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value={ALL}>전체</option>
              {[...LINE_TYPE_ORDER.keys()].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </FilterField>

          <FilterField label="메인 타이틀 종류">
            <select
              aria-label="메인 타이틀 종류 필터"
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={modeFilter}
              onChange={(e) => setModeFilter(e.target.value as ModeFilter)}
            >
              <option value={ALL}>전체</option>
              <option value="fixed">고정</option>
              <option value="variable">변동</option>
            </select>
          </FilterField>

          <FilterField label="상태">
            <select
              aria-label="상태 필터"
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            >
              <option value={ALL}>전체</option>
              <option value="active">활성</option>
              <option value="inactive">비활성</option>
              <option value="bridged">연결됨</option>
              <option value="unbridged">미연결</option>
            </select>
          </FilterField>

          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="라인명 · 라인 코드 · 메인 타이틀 · 유닛 링크 검색"
              className="h-8 pl-8"
              aria-label="라인 검색"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                title="검색어 지우기"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setRefreshTick((n) => n + 1)}
            disabled={loading}
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            <span className="ml-1.5">새로고침</span>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">등록된 라인</CardTitle>
          <CardDescription>
            {loading || !data
              ? "불러오는 중…"
              : `검색 결과 ${filtered.length.toLocaleString()}건 / 전체 ${total.toLocaleString()}건` +
                ` · 페이지 ${safePage}/${pageCount} (${PAGE_SIZE}개씩)` +
                (fetchedCount < total ? ` — 최근 ${fetchedCount}건만 로드됨` : "")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {error}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>라인명</TableHead>
                    <TableHead>적용 클럽</TableHead>
                    <TableHead>소속 허브</TableHead>
                    <TableHead>라인 종류</TableHead>
                    <TableHead>라인 코드</TableHead>
                    <TableHead>메인 타이틀 종류</TableHead>
                    <TableHead>메인 타이틀</TableHead>
                    <TableHead>유닛 링크</TableHead>
                    <TableHead>상태</TableHead>
                    <TableHead>개설 연결</TableHead>
                    <TableHead>관리</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 && !loading ? (
                    <TableRow>
                      <TableCell
                        colSpan={11}
                        className="py-8 text-center text-muted-foreground"
                      >
                        조회 결과가 없습니다.
                      </TableCell>
                    </TableRow>
                  ) : (
                    paged.map((row) => {
                      // 메인 타이틀 종류 표시 SoT = 허브 정책 (저장 main_title_mode 와 무관).
                      const display = lineRegistrationDisplayMainTitle(row.hub, row.mainTitle);
                      return (
                        <TableRow key={row.id}>
                          <TableCell className="max-w-72 font-medium">
                            <span className="block truncate" title={row.lineName}>
                              {row.lineName}
                            </span>
                          </TableCell>
                          {/* 적용 클럽 — organization_slug 원문 표시 (미지정 = '-') */}
                          <TableCell className="font-mono text-xs">
                            {row.organizationSlug ?? "-"}
                          </TableCell>
                          <TableCell>{row.hubLabel}</TableCell>
                          <TableCell>{row.lineType}</TableCell>
                          <TableCell className="font-mono text-xs">{row.lineCode}</TableCell>
                          <TableCell>
                            <span
                              className={cn(
                                "inline-flex items-center rounded-md border px-2 py-0.5 text-xs",
                                display.mode === "fixed"
                                  ? "border-sky-200 bg-sky-50 text-sky-700"
                                  : "border-amber-200 bg-amber-50 text-amber-800",
                              )}
                            >
                              {display.modeLabel}
                            </span>
                          </TableCell>
                          <TableCell className="max-w-72">
                            <span className="block truncate" title={display.title}>
                              {display.title}
                            </span>
                          </TableCell>
                          <TableCell className="max-w-48">
                            <span className="block truncate text-xs" title={row.unitLink}>
                              {row.unitLink}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span
                              className={cn(
                                "inline-flex items-center rounded-md border px-2 py-0.5 text-xs",
                                row.isActive
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                  : "border-slate-200 bg-slate-50 text-slate-600",
                              )}
                            >
                              {row.isActive ? "활성" : "비활성"}
                            </span>
                          </TableCell>
                          <TableCell>
                            {/* Phase 2C — 동작 무변경 (LineCatalogManager 에서 이식). */}
                            {row.bridgedMasterId ? (
                              <span
                                className="inline-flex items-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700"
                                title={`연결된 마스터: ${row.bridgedMasterId}`}
                              >
                                <Link2 className="mr-1 h-3 w-3" />
                                연결됨
                              </span>
                            ) : row.hub === "info" ? (
                              <a
                                href={
                                  row.mainTitleMode === "fixed" && row.mainTitle !== "-"
                                    ? `/admin/line-opening/practical-info?prefillMainTitle=${encodeURIComponent(row.mainTitle)}`
                                    : "/admin/line-opening/practical-info"
                                }
                                className="text-xs text-sky-700 underline underline-offset-2 hover:text-sky-900"
                                title="실무 정보는 마스터가 없어 브리지 대상이 아닙니다 — 개설 화면에서 직접 개설(메인 타이틀 프리필)"
                              >
                                개설 화면(프리필)
                              </a>
                            ) : !row.organizationSlug ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled
                                title="소속 조직 미지정 — 조직을 지정한 등록만 개설 연결이 가능합니다"
                              >
                                조직 미지정
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => void handleBridge(row)}
                                disabled={bridgingId === row.id}
                              >
                                {bridgingId === row.id ? (
                                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Link2 className="mr-1 h-3.5 w-3.5" />
                                )}
                                개설 연결
                              </Button>
                            )}
                          </TableCell>
                          <TableCell>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setEditingId(row.id)}
                            >
                              <Pencil className="mr-1 h-3.5 w-3.5" />
                              수정
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          )}

          {/* 페이지네이션 — 20개씩. 필터/검색/정렬 변경 시 1페이지로 리셋. */}
          {!error && !loading && filtered.length > 0 && (
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">
                {(safePage - 1) * PAGE_SIZE + 1}–
                {Math.min(safePage * PAGE_SIZE, filtered.length)} / {filtered.length}건
              </span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(safePage - 1)}
                  disabled={safePage <= 1}
                  aria-label="이전 페이지"
                >
                  이전
                </Button>
                {Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => (
                  <Button
                    key={p}
                    type="button"
                    variant={p === safePage ? "default" : "outline"}
                    size="sm"
                    className="min-w-9"
                    onClick={() => setPage(p)}
                    aria-label={`${p}페이지`}
                    aria-current={p === safePage ? "page" : undefined}
                  >
                    {p}
                  </Button>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPage(safePage + 1)}
                  disabled={safePage >= pageCount}
                  aria-label="다음 페이지"
                >
                  다음
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {editingId && (
        <RegistrationEditModal
          registrationId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={(message) => {
            setBanner({ kind: "success", message });
            setRefreshTick((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
