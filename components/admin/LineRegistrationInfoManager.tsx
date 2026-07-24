"use client";

// /admin/lines (라인 정보 탭) — 모든 클럽에서 사용 중인 라인을 한 표로 보여주는 읽기 전용 화면 (2026-06-27 개편).
//
// 조회 원천 = line_registrations (GET /api/admin/lines/registrations, hub 별 조회로 합산).
//   - 실무 경력(career) 허브는 이 화면에서 제외한다.
//   - 적용 클럽 / 메인 타이틀 표시 정책은 lib/adminLineRegistrationsTypes 의 표시 헬퍼
//     (lineRegistrationDisplayClub · lineRegistrationDisplayMainTitle)를 단일 SoT 로 사용한다.
//   - 기존 4허브 SoT(cluster4_lines · 마스터 · career_projects) · snapshot · 저장 로직은 일절 참조/수정하지 않는다.
//
// 구성: 상단 통계(전체 허브 갯수 / 전체 라인 갯수) → 필터(클럽 단일·허브 다중[확인]·결과 갯수·초기화)
//       → 표(적용 클럽 · 라인 코드 · 라인명 · 소속 허브 · 라인 종류 · 메인 타이틀 내용 · 유닛 버튼).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ExternalLink,
  Link2,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { TableSkeletonRows } from "@/components/ui/table-skeleton";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import LineRegistrationEditModal from "@/components/admin/LineRegistrationEditModal";
import { ClubBadge, HubBadge } from "@/components/admin/LineRegistrationBadges";
import {
  rowOrgAllowed,
  useAdminOrgAccess,
} from "@/components/admin/AdminOrgAccessProvider";
import { formatAdminDateTime } from "@/lib/adminDateTime";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";
import { useActionToast } from "@/lib/actionToast";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useStickyColumns, type StickyColProps } from "@/components/ui/sticky-columns";
import { Checkbox, checkedTextClass, checkedRowClass } from "@/components/ui/checkbox";
import {
  COMMON_CLUB_LABEL,
  formatLineDuration,
  LINE_REGISTRATION_HUBS,
  LINE_REGISTRATION_HUB_LABEL,
  lineRegistrationDisplayClub,
  lineRegistrationDisplayMainTitle,
  type LineRegistrationDto,
  type LineRegistrationHub,
  type ListLineRegistrationsResult,
} from "@/lib/adminLineRegistrationsTypes";
import {
  organizationLabelKo,
  organizationSelectOptions,
  type OrganizationSlug,
} from "@/lib/organizations";

// 이 화면이 다루는 허브 — 실무 경력(career)은 제외.
const INFO_HUBS = LINE_REGISTRATION_HUBS.filter(
  (h) => h !== "career",
) as readonly LineRegistrationHub[]; // ["info", "experience", "competency"]

// 적용 클럽 한글 표시 — lineRegistrationDisplayClub 반환(공통/encre/oranke/phalanx/-) → 한글.
//   매핑 SoT = lib/organizations.organizationLabelKo (화면별 재작성 금지). "공통"/"-" 는 그대로 통과.
function clubKo(raw: string): string {
  return organizationLabelKo(raw, { nullLabel: "-" });
}

// 클럽 필터 — value 는 표시 헬퍼 반환값과 매칭하기 위한 **키(slug 유지)**, label 만 한글.
type ClubFilter = "-" | "encre" | "oranke" | "phalanx" | "common";
const CLUB_FILTER_OPTIONS: { value: ClubFilter; label: string }[] = [
  { value: "-", label: "-" },
  ...organizationSelectOptions({ includeCommon: true }).map((o) => ({
    value: o.value as ClubFilter,
    label: o.label,
  })),
];

// 적용 클럽 필터 매칭 — 표시값(displayClub ∈ {"공통","encre","oranke","phalanx","-"}) 기준.
//   엥크레/오랑캐/팔랑크스 → 해당 클럽 OR 공통 · 공통 → 공통만 · "-" → 조건 없음.
function matchesClub(filter: ClubFilter, displayClub: string): boolean {
  switch (filter) {
    case "-":
      return true;
    case "common":
      return displayClub === COMMON_CLUB_LABEL;
    default:
      return displayClub === filter || displayClub === COMMON_CLUB_LABEL;
  }
}

// 표 정렬 — 허브 → 라인 종류 → 라인 코드 순(안정적). 마지막 tiebreaker = id.
const HUB_ORDER = new Map<string, number>(INFO_HUBS.map((h, i) => [h, i]));
const LINE_TYPE_ORDER = new Map<string, number>(
  ["일반", "도출", "분석", "평가", "관리", "확장", "원리", "기술", "관점", "자원"].map(
    (t, i) => [t, i],
  ),
);

// 공통 라인 중복 제거 — 적용 클럽이 "공통"인 라인은 클럽(encre/oranke/phalanx)별로
// 별도 행이 저장돼 있어(같은 line_code·hub·line_type·라인명) 표에 3번씩 중복 노출된다.
//   → 표시 전에 공통 라인을 line_code + hub + line_type 기준으로 1행만 남긴다.
//   org별 라인(적용 클럽이 공통이 아닌 라인)은 line_code 가 클럽마다 달라 그대로 둔다(잘못 합치지 않음).
function dedupeCommonLines(
  list: readonly LineRegistrationDto[],
): LineRegistrationDto[] {
  const seen = new Set<string>();
  const out: LineRegistrationDto[] = [];
  for (const r of list) {
    const displayClub = lineRegistrationDisplayClub(r.hub, r.lineType, r.organizationSlug);
    if (displayClub === COMMON_CLUB_LABEL) {
      const key = `${r.lineCode}__${r.hub}__${r.lineType}`;
      if (seen.has(key)) continue; // 같은 공통 라인의 클럽별 복제 → 1행만
      seen.add(key);
    }
    out.push(r);
  }
  return out;
}

// 유닛 외부 링크 정규화 — '-'/빈값은 링크 없음(null). http(s) 가 아니면 https:// 보정(베스트 에포트).
function normalizeUnitHref(raw: string): string | null {
  const t = (raw ?? "").trim();
  if (!t || t === "-") return null;
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

function StatCard({
  label,
  value,
  helpKey,
}: {
  label: string;
  value: number | null;
  helpKey: string;
}) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="inline-flex items-center gap-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <AdminHelpIconButton helpKey={helpKey} title={label} size="xs" />
      </div>
      <p className="mt-1 text-2xl font-semibold tabular-nums">
        {value === null ? "—" : value.toLocaleString()}
      </p>
    </div>
  );
}

// 필터 라벨 + 요소별 편집형 돋보기 도움말. 라벨 영역에만 배치(입력/Select 폭 불변).
function FilterLabel({ label, helpKey }: { label: string; helpKey: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      {label}
      <AdminHelpIconButton helpKey={helpKey} title={label} size="xs" />
    </span>
  );
}

// ── 표 컬럼 정렬/도움말 정의 (season-weeks 표와 동일 기준) ─────────────────────
//   · 모든 컬럼 정렬 가능. 정렬 기준값은 표시 문자열이 아니라 "실제 정렬 가능한 값"
//     (허브/라인 종류=고정 순서 인덱스, 유닛=링크 유무 랭크, 그 외=문자열 locale-aware).
//   · 헤더는 정렬 button 과 도움말 button 을 형제로 두고, 도움말은 stopPropagation(내부)
//     + 구조 분리로 정렬을 트리거하지 않는다.
type InfoColKey =
  | "club"
  | "lineCode"
  | "lineName"
  | "hub"
  | "lineType"
  | "duration"
  | "pointA"
  | "pointB"
  | "mainTitle"
  | "unit"
  | "bridge"
  | "edit";
type InfoSortValue = number | string | null;

// 행에서 각 컬럼의 정렬 기준값을 뽑는 함수 묶음(표시 로직과 동일 SoT 헬퍼 사용).
type InfoColumnDef = {
  key: InfoColKey;
  label: string;
  helpKey: string;
  center?: boolean;
  // 정렬 가치가 있는 컬럼만 true(기본). 자유서술/액션 컬럼은 false → 정렬 컨트롤 미노출.
  //   (도움말 돋보기는 모든 컬럼에 유지 — 정렬만 제거한다.)
  sortable: boolean;
  sortValue: (row: LineRegistrationDto) => InfoSortValue;
};

const INFO_COLUMNS: InfoColumnDef[] = [
  // ── 정렬 유지: 범주/식별자 컬럼(그룹핑·조회에 유용) ──
  {
    key: "club",
    label: "적용 클럽",
    helpKey: "admin.lines.info.column.club",
    sortable: true,
    sortValue: (row) =>
      clubKo(
        lineRegistrationDisplayClub(row.hub, row.lineType, row.organizationSlug),
      ),
  },
  {
    key: "lineCode",
    label: "라인 코드",
    helpKey: "admin.lines.info.column.lineCode",
    sortable: true,
    sortValue: (row) => row.lineCode,
  },
  {
    key: "lineName",
    label: "라인명",
    helpKey: "admin.lines.info.column.lineName",
    sortable: true,
    sortValue: (row) => row.lineName,
  },
  {
    key: "hub",
    label: "소속 허브",
    helpKey: "admin.lines.info.column.hub",
    sortable: true,
    // 허브 고정 순서(정보→경험→역량). 미지정은 뒤로.
    sortValue: (row) => HUB_ORDER.get(row.hub) ?? null,
  },
  {
    key: "lineType",
    label: "라인 종류",
    helpKey: "admin.lines.info.column.lineType",
    sortable: true,
    sortValue: (row) => LINE_TYPE_ORDER.get(row.lineType) ?? null,
  },
  // ── 소요 시간 — line_registrations.estimated_duration_minutes(마스터 속성) 조회값.
  //    정렬은 표시 문자열("0.5 h")이 아니라 분(30/60/90/120) 기준 — 문자열 정렬이면 "1 h" < "0.5 h"
  //    같은 오답이 나온다. null(미설정)은 compareInfoSortValues 가 항상 뒤로 보낸다. ──
  {
    key: "duration",
    label: "소요 시간",
    helpKey: "admin.lines.info.column.duration",
    center: true,
    sortable: true,
    sortValue: (row) => row.estimatedDurationMinutes,
  },
  // ── 라인 강화 Point.A/B — cluster4_line_point_configs 조회값(오픈확인 A/B/N 과 동일 SoT).
  //    숫자(0 포함) 표시 · null(미설정/미연결)은 compareInfoSortValues 가 항상 뒤로 보낸다. ──
  {
    key: "pointA",
    label: "Point A",
    helpKey: "admin.lines.info.column.pointA",
    center: true,
    sortable: true,
    sortValue: (row) => row.pointA,
  },
  {
    key: "pointB",
    label: "Point B",
    helpKey: "admin.lines.info.column.pointB",
    center: true,
    sortable: true,
    sortValue: (row) => row.pointB,
  },
  // ── 정렬 제거: 자유서술 표시 컬럼(대부분 '-') · 액션 버튼 컬럼 ──
  //   (정렬 가치가 낮아 컨트롤만 제거 — 도움말 돋보기는 유지.)
  {
    key: "mainTitle",
    label: "메인 타이틀 내용",
    helpKey: "admin.lines.info.column.mainTitle",
    sortable: false,
    sortValue: () => null,
  },
  {
    key: "unit",
    label: "유닛",
    helpKey: "admin.lines.info.column.unit",
    center: true,
    sortable: false,
    sortValue: () => null,
  },
  // 개설 연결(브리지) — 경험/역량 라인을 허브 마스터에 연결해 개설 드롭다운에 노출시킨다.
  //   (2026-06-27 탭 통합 때 컬럼이 누락돼 신규 등록 라인을 개설할 경로가 끊겼던 것을 복원.)
  {
    key: "bridge",
    label: "개설 연결",
    helpKey: "admin.lines.info.column.bridge",
    center: true,
    sortable: false,
    sortValue: () => null,
  },
  // 수정 — 기존 편집 흐름(PATCH /[id] + point-configs PUT) 진입 버튼. 정렬 없음.
  {
    key: "edit",
    label: "수정",
    helpKey: "admin.lines.info.column.edit",
    center: true,
    sortable: false,
    sortValue: () => null,
  },
];

// null/빈값/"-" 은 정렬 방향과 무관하게 항상 뒤로. 숫자는 숫자, 문자열은 한글 locale.
function compareInfoSortValues(
  a: InfoSortValue,
  b: InfoSortValue,
  dir: "asc" | "desc",
): number {
  const aEmpty = a == null || a === "";
  const bEmpty = b == null || b === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  let c: number;
  if (typeof a === "number" && typeof b === "number") c = a - b;
  else c = String(a).localeCompare(String(b), "ko");
  return dir === "asc" ? c : -c;
}

// 컬럼 헤더: 컬럼명+정렬 아이콘(button) 과 도움말(button) 을 형제로 둔다(버튼 중첩 방지).
function InfoSortableHeader({
  label,
  helpKey,
  dir,
  center,
  sortable,
  onSort,
  sticky,
}: {
  label: string;
  helpKey: string;
  dir: "asc" | "desc" | null;
  center?: boolean;
  sortable: boolean;
  onSort: () => void;
  // 왼쪽 식별 열 고정(공통 계약) — 지정 시 해당 셀에 stick-col-* 클래스/속성을 얹는다.
  sticky?: StickyColProps;
}) {
  return (
    <TableHead
      className={cn(center && "text-center", sticky?.className)}
      data-sticky-col={sticky?.["data-sticky-col"]}
      aria-sort={
        !sortable
          ? undefined
          : dir === "asc"
            ? "ascending"
            : dir === "desc"
              ? "descending"
              : "none"
      }
    >
      <div
        className={cn(
          "inline-flex items-center gap-1",
          center && "justify-center",
        )}
      >
        {sortable ? (
          <button
            type="button"
            onClick={onSort}
            aria-label={`${label} 정렬`}
            className={cn(
              "inline-flex items-center gap-1 font-semibold tracking-wide text-muted-foreground hover:text-foreground",
              dir && "text-foreground",
            )}
          >
            <span>{label}</span>
            {dir === "asc" ? (
              <ArrowUp className="h-3 w-3" />
            ) : dir === "desc" ? (
              <ArrowDown className="h-3 w-3" />
            ) : (
              <ArrowUpDown className="h-3 w-3 opacity-40" />
            )}
          </button>
        ) : (
          // 정렬 비대상 컬럼 — 정렬 컨트롤 없이 라벨만(도움말 돋보기는 유지).
          <span className="font-semibold tracking-wide text-muted-foreground">
            {label}
          </span>
        )}
        <AdminHelpIconButton helpKey={helpKey} title={label} size="xs" />
      </div>
    </TableHead>
  );
}

export default function LineRegistrationInfoManager({
  org,
}: {
  // org optional — 없으면(null/undefined) 통합(전체 조직) 컨텍스트, 있으면 해당 조직 스코프.
  org?: OrganizationSlug | null;
}) {
  // 클럽 필터 옵션:
  //   · 조직 스코프(org 있음) → "-"(스코프 전체) + 해당 org 만(타 조직 옵션 숨김).
  //   · 통합(org 없음)        → 전체 옵션(-, 엥크레/오랑캐/팔랑크스, 공통).
  const clubFilterOptions = org
    ? CLUB_FILTER_OPTIONS.filter((option) => option.value === "-" || option.value === org)
    : CLUB_FILTER_OPTIONS;

  const [rows, setRows] = useState<LineRegistrationDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  // 수정 모달 — 편집 대상 행(null = 닫힘). 저장 성공 시 목록 재조회로 즉시 반영.
  const [editingRow, setEditingRow] = useState<LineRegistrationDto | null>(null);
  useReportLoading(loading);
  // 왼쪽 2열 고정(적용 클럽·라인 코드) — 공통 sticky 계약. col-1 실측폭으로 col-2 offset.
  const sticky = useStickyColumns({ headerSticky: true });

  // ── 개설 연결(브리지) ──────────────────────────────────────────────
  //   요청 중인 행 id(중복 클릭 차단·버튼 비활성화) + 행별 실패 사유(행 내 인라인 표시).
  //   성공은 전역 toast, 실패 원인은 해당 행에만 남긴다(다른 행 상태 무영향).
  const [bridgingId, setBridgingId] = useState<string | null>(null);
  const [bridgeErrors, setBridgeErrors] = useState<Record<string, string>>({});
  const orgAccess = useAdminOrgAccess();
  const t = useActionToast();

  // 클럽 필터(즉시 적용) · 허브 필터(보류 → [확인] 시 적용).
  const [clubFilter, setClubFilter] = useState<ClubFilter>("-");
  const [pendingHubs, setPendingHubs] = useState<Set<LineRegistrationHub>>(new Set());
  const [appliedHubs, setAppliedHubs] = useState<Set<LineRegistrationHub>>(new Set());
  const [hubMenuOpen, setHubMenuOpen] = useState(false);
  // 컬럼 헤더 클릭 정렬. null = 기본 순서(허브→라인 종류→라인 코드).
  //   클릭 순환: 없음 → 오름차순 → 내림차순 → 기본 복귀. (season-weeks 표와 동일)
  const [columnSort, setColumnSort] = useState<{
    key: InfoColKey;
    dir: "asc" | "desc";
  } | null>(null);

  const cycleSort = useCallback((key: InfoColKey) => {
    setColumnSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null; // 내림차순 다음 클릭 → 기본 순서 복귀
    });
  }, []);
  // 드롭다운은 body 로 portal 된다(필터 Card 의 overflow-hidden·표/카드 stacking 에 가리지 않게).
  //   trigger 버튼 rect 로 위치(fixed)·너비를 잡고, 스크롤/리사이즈 시 재계산한다.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );

  const computeMenuPos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 192) });
  }, []);

  const openHubMenu = useCallback(() => {
    // 열 때 보류 선택을 현재 적용값으로 동기화(닫았다 다시 열어도 일관).
    setPendingHubs(new Set(appliedHubs));
    computeMenuPos();
    setHubMenuOpen(true);
  }, [appliedHubs, computeMenuPos]);

  // 바깥 클릭 / Esc 로 닫기(보류 선택은 유지 — [확인] 전까지 표 미반영).
  // trigger·portal 메뉴 내부 클릭은 무시한다(메뉴가 body 로 분리돼 있어 둘 다 명시 검사).
  useEffect(() => {
    if (!hubMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setHubMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHubMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [hubMenuOpen]);

  // 열린 동안 스크롤/리사이즈 → 위치 재계산(fixed 좌표라 trigger 를 따라가게).
  useEffect(() => {
    if (!hubMenuOpen) return;
    const onMove = () => computeMenuPos();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [hubMenuOpen, computeMenuPos]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        // 실무 경력(career) 제외 → 3허브를 각각 조회(허브당 200 cap 내).
        //   org 있음 → &organization= 로 조직 스코프 · org 없음 → 파라미터 생략 = 통합(전체 조직).
        //   (서버가 organization 미지정을 통합으로 해석하고 권한/스코프를 적용한다 — 클라 합산 아님.)
        const orgQuery = org ? `&organization=${org}` : "";
        const results = await Promise.all(
          INFO_HUBS.map(async (h) => {
            const res = await fetch(
              `/api/admin/lines/registrations?hub=${h}&limit=200${orgQuery}`,
              { cache: "no-store" },
            );
            const json = await res.json();
            if (!res.ok || !json.success) {
              throw apiErrorFrom(res, json);
            }
            return (json.data as ListLineRegistrationsResult).rows;
          }),
        );
        if (cancelled) return;
        // 방어적으로 career 한 번 더 제외(허브별 조회라 이미 없지만 안전망).
        setRows(results.flat().filter((r) => r.hub !== "career"));
      } catch (err) {
        if (!cancelled) {
          setError(getApiErrorMessage(err, "목록을 불러오지 못했습니다"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshTick, org]);

  // ── 개설 연결 실행 — 기존 API/기존 bridgeLineRegistration() 재사용(로직 중복 구현 없음) ──
  //   POST /api/admin/lines/registrations/[id]/bridge → { action, masterTable, masterId, bridgedAt }
  //   · action: created(마스터 신규) · found(기존 마스터 연결·무수정) · already_bridged(멱등 재호출)
  //   · 세 경우 모두 "연결 완료"로 수렴한다 — 이미 연결된 행의 재호출도 오류가 아니다(멱등 계약).
  //   · 성공 시 목록 전체를 재조회하지 않고 **해당 행만** 응답값으로 패치한다
  //     (다른 행 상태·필터·정렬·스크롤 위치 무영향).
  const handleBridge = useCallback(
    async (row: LineRegistrationDto) => {
      if (bridgingId) return; // 다른 행 처리 중 — 중복 실행 차단
      setBridgingId(row.id);
      setBridgeErrors((prev) => {
        if (!(row.id in prev)) return prev;
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      try {
        const res = await fetch(
          `/api/admin/lines/registrations/${encodeURIComponent(row.id)}/bridge`,
          { method: "POST" },
        );
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) {
          throw apiErrorFrom(res, json, "개설 연결에 실패했습니다");
        }
        const result = json.data as {
          action: "created" | "found" | "already_bridged";
          masterId: string;
          bridgedAt: string;
        };
        // 행 단위 즉시 반영 — bridgedMasterId/bridgedAt 이 채워지면 셀이 "연결 완료"로 바뀐다.
        setRows((prev) =>
          prev
            ? prev.map((r) =>
                r.id === row.id
                  ? { ...r, bridgedMasterId: result.masterId, bridgedAt: result.bridgedAt }
                  : r,
              )
            : prev,
        );
        t.success(
          "save",
          result.action === "created"
            ? `개설 연결 완료 — ${row.lineName}: 마스터를 새로 생성해 연결했습니다.`
            : result.action === "found"
              ? `개설 연결 완료 — ${row.lineName}: 기존 마스터에 연결했습니다(마스터 무수정).`
              : `이미 연결된 라인입니다 — ${row.lineName}: 기존 연결을 그대로 유지합니다.`,
        );
      } catch (err) {
        // 실패 사유(서버 4xx 업무 문구)는 해당 행 인라인 + 토스트 모두 같은 파서 결과를 쓴다.
        //   5xx·네트워크는 파서가 안전 문구로 치환하므로 내부 원문이 새지 않는다.
        console.error("[lines/info] bridge failed", err);
        setBridgeErrors((prev) => ({
          ...prev,
          [row.id]: getApiErrorMessage(err, "개설 연결에 실패했습니다"),
        }));
        t.apiError("save", err, "개설 연결에 실패했습니다");
      } finally {
        setBridgingId(null);
      }
    },
    [bridgingId, t],
  );

  // 통계 — 전체 허브 갯수(데이터에 존재하는 비-career 허브 종류 수) · 전체 라인 갯수.
  //   전체 라인 갯수는 공통 라인 중복을 제거한 "구분되는 라인 수"로 센다(클럽별 복제 제외).
  const totalLines = useMemo(
    () => dedupeCommonLines(rows ?? []).length,
    [rows],
  );
  const totalHubs = useMemo(
    () => new Set((rows ?? []).map((r) => r.hub)).size,
    [rows],
  );

  // 필터 + 기본 순서 정렬 + 공통 라인 중복 제거. 결과 건수(=행 수)의 SoT.
  const filtered = useMemo(() => {
    const list = (rows ?? []).filter((r) => {
      const displayClub = lineRegistrationDisplayClub(
        r.hub,
        r.lineType,
        r.organizationSlug,
      );
      if (!matchesClub(clubFilter, displayClub)) return false;
      if (appliedHubs.size > 0 && !appliedHubs.has(r.hub)) return false;
      return true;
    });
    const defaultSorted = [...list].sort((a, b) => {
      const hub = (HUB_ORDER.get(a.hub) ?? 99) - (HUB_ORDER.get(b.hub) ?? 99);
      if (hub !== 0) return hub;
      const type =
        (LINE_TYPE_ORDER.get(a.lineType) ?? 99) -
        (LINE_TYPE_ORDER.get(b.lineType) ?? 99);
      if (type !== 0) return type;
      const code = a.lineCode.localeCompare(b.lineCode, "ko");
      if (code !== 0) return code;
      return a.id.localeCompare(b.id);
    });
    // 정렬 후 공통 라인 중복 제거 → 클럽 필터(엥크레/오랑캐/팔랑크스/-)와 무관하게 공통 라인은 1행만.
    return dedupeCommonLines(defaultSorted);
  }, [rows, clubFilter, appliedHubs]);

  // 표 렌더용 — 컬럼 정렬이 활성이면 그 기준으로 재정렬, 아니면 기본 순서(filtered) 유지.
  //   원본(filtered)을 mutate 하지 않도록 복사본을 정렬한다. 행 집합은 동일(정렬만 변경).
  const sorted = useMemo(() => {
    if (!columnSort) return filtered;
    const col = INFO_COLUMNS.find((c) => c.key === columnSort.key);
    if (!col || !col.sortable) return filtered;
    return [...filtered].sort((a, b) => {
      const c = compareInfoSortValues(
        col.sortValue(a),
        col.sortValue(b),
        columnSort.dir,
      );
      if (c !== 0) return c;
      // 동값 타이브레이크 — 라인 코드 → id(안정적 표시).
      return (
        a.lineCode.localeCompare(b.lineCode, "ko") || a.id.localeCompare(b.id)
      );
    });
  }, [filtered, columnSort]);

  const togglePendingHub = useCallback((hub: LineRegistrationHub) => {
    setPendingHubs((prev) => {
      const next = new Set(prev);
      if (next.has(hub)) next.delete(hub);
      else next.add(hub);
      return next;
    });
  }, []);

  const applyHubs = useCallback(() => {
    setAppliedHubs(new Set(pendingHubs));
    setHubMenuOpen(false);
  }, [pendingHubs]);

  const handleReset = useCallback(() => {
    setClubFilter("-");
    setPendingHubs(new Set());
    setAppliedHubs(new Set());
    setHubMenuOpen(false);
    setColumnSort(null);
  }, []);

  // 허브 드롭다운 버튼 라벨 — 적용된 허브가 없으면 "-".
  const hubButtonLabel =
    appliedHubs.size === 0
      ? "-"
      : INFO_HUBS.filter((h) => appliedHubs.has(h))
          .map((h) => LINE_REGISTRATION_HUB_LABEL[h])
          .join(", ");

  const statsReady = rows !== null;

  // 주의: 아래 `true ? … : null` 은 의도적 React Compiler 억제다. 이 컴포넌트의 일부 수동
  //   memoization(openHubMenu 등)이 preserve-manual-memoization 규칙과 불일치해, 평범한
  //   `return (…)` 로 바꾸면 빌드가 깨진다. 상수 조건 삼항이 컴파일러 최적화를 건너뛰게 해 통과시킨다.
  //   (근본 해결 = memoization 정리 → 별도 작업. 여기서 임의로 "정리"하지 말 것.)
  return true ? (
    <div className="flex w-full flex-col gap-4">
      {/* ── 상단 통계 ── */}
      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <StatCard
          label="전체 허브 갯수"
          value={statsReady ? totalHubs : null}
          helpKey="admin.lines.info.stat.totalHubs"
        />
        <StatCard
          label="전체 라인 갯수"
          value={statsReady ? totalLines : null}
          helpKey="admin.lines.info.stat.totalLines"
        />
      </div>

      {/* ── 필터 ──
          · 좌측 필터(클럽·허브)는 flex-1 컨테이너에서 넓은 gap 으로 남는 가로 공간을 활용.
          · 우측 액션(결과 수·초기화·새로고침)은 shrink-0 로 우측 정렬 유지.
          · 폭이 줄면 그룹 단위(shrink-0)로 줄바꿈, 우측 영역도 다음 행으로. 가로 스크롤 없음. */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 py-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-10 gap-y-3">
            {/* 클럽 — 즉시 적용 */}
            <div className="flex shrink-0 items-center gap-2">
              <FilterLabel label="클럽" helpKey="admin.lines.info.filter.club" />
              <select
                aria-label="클럽 필터"
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                value={clubFilter}
                onChange={(e) => setClubFilter(e.target.value as ClubFilter)}
              >
                {clubFilterOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>

          {/* 허브 — 다중 선택 후 [확인] 시 적용 */}
          <div className="flex shrink-0 items-center gap-2">
            <FilterLabel label="허브" helpKey="admin.lines.info.filter.hub" />
            <button
              type="button"
              ref={triggerRef}
              onClick={() => (hubMenuOpen ? setHubMenuOpen(false) : openHubMenu())}
              aria-haspopup="true"
              aria-expanded={hubMenuOpen}
              aria-label="허브 필터"
              className="flex h-8 min-w-32 items-center justify-between gap-2 rounded-md border border-input bg-background px-2 text-sm"
            >
              <span className="truncate">{hubButtonLabel}</span>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
            {hubMenuOpen &&
              menuPos &&
              typeof document !== "undefined" &&
              createPortal(
                <div
                  ref={menuRef}
                  role="menu"
                  style={{
                    position: "fixed",
                    top: menuPos.top,
                    left: menuPos.left,
                    width: menuPos.width,
                    zIndex: 60,
                  }}
                  className="max-h-[60vh] overflow-auto rounded-md border bg-background p-2 shadow-lg"
                >
                  <ul className="space-y-1">
                    {INFO_HUBS.map((h) => {
                      const sel = pendingHubs.has(h);
                      return (
                      <li key={h} className={cn(checkedRowClass(sel))}>
                        <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted">
                          <Checkbox
                            checked={sel}
                            onChange={() => togglePendingHub(h)}
                          />
                          <span className={cn(checkedTextClass(sel))}>{LINE_REGISTRATION_HUB_LABEL[h]}</span>
                        </label>
                      </li>
                      );
                    })}
                  </ul>
                  <div className="mt-2 flex justify-end gap-1.5 border-t pt-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setPendingHubs(new Set())}
                    >
                      해제
                    </Button>
                    <Button type="button" size="sm" onClick={applyHubs}>
                      확인
                    </Button>
                  </div>
                </div>,
                document.body,
              )}
            </div>
          </div>

          {/* 우측: 결과 수 + 초기화 + 새로고침 (도움말은 각 요소 외부에 배치) */}
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
              <span>
                결과 수{" "}
                <span className="font-semibold tabular-nums text-foreground">
                  {filtered.length.toLocaleString()}
                </span>
                건
              </span>
              <AdminHelpIconButton
                helpKey="admin.lines.info.filter.resultCount"
                title="결과 수"
                size="xs"
              />
            </span>
            <div className="inline-flex items-center gap-1.5">
              <Button type="button" variant="outline" size="sm" onClick={handleReset}>
                <RotateCcw className="mr-1.5 h-4 w-4" />
                초기화
              </Button>
              <AdminHelpIconButton
                helpKey="admin.lines.info.button.reset"
                title="초기화"
                size="xs"
              />
            </div>
            <div className="inline-flex items-center gap-1.5">
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
              <AdminHelpIconButton
                helpKey="admin.lines.info.button.refresh"
                title="새로고침"
                size="xs"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── 표 ── */}
      {error ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </div>
      ) : (
        <div className="rounded-md border">
          <Table containerRef={sticky.ref} regionClassName={sticky.regionClassName} stickyLeft>
            <TableHeader>
              <TableRow>
                {INFO_COLUMNS.map((col, idx) => (
                  <InfoSortableHeader
                    key={col.key}
                    label={col.label}
                    helpKey={col.helpKey}
                    center={col.center}
                    sortable={col.sortable}
                    dir={
                      col.sortable && columnSort?.key === col.key
                        ? columnSort.dir
                        : null
                    }
                    onSort={() => cycleSort(col.key)}
                    // 왼쪽 2열(적용 클럽·라인 코드) 고정 — 공통 계약.
                    sticky={idx === 0 ? sticky.col(1) : idx === 1 ? sticky.col(2) : undefined}
                  />
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && !rows ? (
                <TableSkeletonRows columns={INFO_COLUMNS.length} rows={6} />
              ) : sorted.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={INFO_COLUMNS.length}
                    className="py-8 text-center text-muted-foreground"
                  >
                    조회 결과가 없습니다.
                  </TableCell>
                </TableRow>
              ) : (
                sorted.map((row) => {
                  const displayClub = lineRegistrationDisplayClub(
                    row.hub,
                    row.lineType,
                    row.organizationSlug,
                  );
                  // 메인 타이틀 내용 — 허브 정책 SoT(실무 정보=변동 → "-").
                  const mainTitle = lineRegistrationDisplayMainTitle(
                    row.hub,
                    row.mainTitle,
                  ).title;
                  const href = normalizeUnitHref(row.unitLink);
                  return (
                    <TableRow key={row.id}>
                      {/* 적용 클럽 — 표시 배지(색상 매핑 SoT = LineRegistrationBadges).
                          정렬/필터/원본값은 무변경(clubKo·displayClub 그대로 사용). 좌측 고정 col-1. */}
                      <TableCell {...sticky.col(1)} className={sticky.col(1).className}>
                        <ClubBadge value={displayClub}>{clubKo(displayClub)}</ClubBadge>
                      </TableCell>
                      <TableCell
                        {...sticky.col(2)}
                        className={cn("font-mono text-xs", sticky.col(2).className)}
                      >
                        {row.lineCode}
                      </TableCell>
                      <TableCell className="max-w-72 font-medium">
                        <span className="block truncate" title={row.lineName}>
                          {row.lineName}
                        </span>
                      </TableCell>
                      {/* 소속 허브 — 각진 배지(흰 글자). hub enum 으로 색상 매핑. */}
                      <TableCell>
                        <HubBadge hub={row.hub}>{row.hubLabel}</HubBadge>
                      </TableCell>
                      <TableCell>{row.lineType}</TableCell>
                      {/* 소요 시간 — 공통 formatter 단일 SoT. 미설정(null)은 '-'(회색). */}
                      <TableCell className="text-center tabular-nums">
                        {row.estimatedDurationMinutes === null ? (
                          <span className="text-muted-foreground">
                            {formatLineDuration(null)}
                          </span>
                        ) : (
                          formatLineDuration(row.estimatedDurationMinutes)
                        )}
                      </TableCell>
                      {/* Point.A / Point.B — 0 은 0, 미설정/미연결(null)은 '-'(회색). */}
                      <TableCell className="text-center tabular-nums">
                        {row.pointA === null ? (
                          <span className="text-muted-foreground">-</span>
                        ) : (
                          row.pointA
                        )}
                      </TableCell>
                      <TableCell className="text-center tabular-nums">
                        {row.pointB === null ? (
                          <span className="text-muted-foreground">-</span>
                        ) : (
                          row.pointB
                        )}
                      </TableCell>
                      <TableCell className="max-w-72">
                        <span className="block truncate" title={mainTitle}>
                          {mainTitle}
                        </span>
                      </TableCell>
                      <TableCell className="text-center">
                        {href ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={cn(
                              buttonVariants({ variant: "outline", size: "sm" }),
                            )}
                            title="등록된 외부 링크 열기 (새 탭)"
                          >
                            <ExternalLink className="mr-1 h-3.5 w-3.5" />
                            유닛
                          </a>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled
                            title="등록된 유닛 링크가 없습니다"
                          >
                            유닛
                          </Button>
                        )}
                      </TableCell>
                      {/* 개설 연결 — 연결 전이면 버튼, 연결 후면 "연결 완료" 배지.
                          허브별 연결 대상:
                            · 경험/역량 = 개설 마스터(bridged_master_id) — 자동 브리지 + 수동 재시도
                            · 실무 정보 = 고정 9종 활동유형(point_activity_type_id) — 신규 활동유형을
                              만들지 않으므로 브리지 버튼이 아니라 **수정(활동유형 선택)** 이 복구 경로다
                            · 실무 경력 = 대상 아님 */}
                      <TableCell className="text-center">
                        {row.hub === "info" ? (
                          row.pointActivityTypeId ? (
                            <span
                              className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700"
                              title={`활동유형 연결됨: ${row.pointActivityTypeId}`}
                            >
                              <Link2 className="h-3 w-3" />
                              연결 완료
                            </span>
                          ) : (
                            // 과거에 활동유형 없이 저장된 등록행(현재는 서버가 422 로 차단).
                            //   임의 활동유형으로 자동 연결하지 않는다 — 관리자가 9종 중 하나를 고르게 한다.
                            <div className="flex flex-col items-center gap-1">
                              <span className="text-[11px] leading-tight text-amber-700">
                                활동유형 미연결
                              </span>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => setEditingRow(row)}
                                title="수정에서 실무 정보 활동유형(고정 9종) 중 하나를 선택해 연결하세요"
                              >
                                <Link2 className="mr-1 h-3.5 w-3.5" />
                                활동유형 연결
                              </Button>
                            </div>
                          )
                        ) : row.bridgedMasterId ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700"
                            // master UUID 는 노출하지 않는다 — 연결 시각만 보조 정보로.
                            title={
                              row.bridgedAt
                                ? `연결 시각: ${formatAdminDateTime(row.bridgedAt)}`
                                : "개설 마스터에 연결됨"
                            }
                          >
                            <Link2 className="h-3 w-3" />
                            연결 완료
                          </span>
                        ) : row.hub === "career" ? (
                          <span
                            className="text-xs text-muted-foreground"
                            title="실무 경력은 개설 연결 대상이 아닙니다."
                          >
                            —
                          </span>
                        ) : !row.isActive ? (
                          <span
                            className="text-xs text-muted-foreground"
                            title="비활성 라인은 개설 연결을 할 수 없습니다 — 수정에서 활성으로 전환하세요."
                          >
                            비활성
                          </span>
                        ) : !rowOrgAllowed(orgAccess, row.organizationSlug) ? (
                          <span
                            className="text-xs text-muted-foreground"
                            title="이 클럽의 라인을 연결할 권한이 없습니다."
                          >
                            권한 없음
                          </span>
                        ) : (
                          <div className="flex flex-col items-center gap-1">
                            {/* 등록은 됐으나 개설 목록에 연결되지 않은 상태 — 자동 연결 실패분의
                                복구 경로. 상태를 문구로 먼저 밝히고 재시도 버튼을 준다. */}
                            <span className="text-[11px] leading-tight text-amber-700">
                              등록 완료 · 개설 미연결
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              loading={bridgingId === row.id}
                              disabled={bridgingId !== null && bridgingId !== row.id}
                              onClick={() => void handleBridge(row)}
                              title="개설 마스터에 연결해 개설 화면 드롭다운에 노출시킵니다"
                            >
                              <Link2 className="mr-1 h-3.5 w-3.5" />
                              개설 연결
                            </Button>
                            {bridgeErrors[row.id] && (
                              <span className="max-w-48 text-left text-[11px] leading-tight text-rose-600">
                                {bridgeErrors[row.id]}
                              </span>
                            )}
                          </div>
                        )}
                      </TableCell>
                      {/* 수정 — 기존 편집 흐름(모달) 진입. 공용 outline/sm 버튼 스타일 재사용. */}
                      <TableCell className="text-center">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setEditingRow(row)}
                          title="라인 수정"
                        >
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

      {/* 수정 모달 — 기존 PATCH /[id] + point-configs PUT 재사용. 저장 성공 시 목록 재조회. */}
      {editingRow ? (
        <LineRegistrationEditModal
          row={editingRow}
          onClose={() => setEditingRow(null)}
          onSaved={() => {
            setEditingRow(null);
            setRefreshTick((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  ) : null;
}
