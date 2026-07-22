"use client";

// /admin/rest-management — 크루 휴식 신청 관리.
//
//   [0] 조직 탭 — 노출 규칙이 URL 스코프(?org)로 갈린다:
//       · 통합 경로(?org 없음): [통합]+엥크레/오랑캐/팔랑크스 4탭. 페이지 내부 상태(selectedOrg)
//         전환·라우팅 없음(URL·사이드바 배지 불변). [통합] = 빈 본문(list/summary 미호출).
//       · 개별 경로(?org={slug}): 자기 조직 탭 1개만 렌더(고정 active). 다른 조직 탭은 DOM 부재 →
//         내부 상태로도 전환 불가. 조회/액션 스코프 = URL org 로 고정(activeOrg = urlOrg).
//   [1] 시즌 드롭다운 — 현재(운영) 시즌 기본. 시즌 1개씩만 조회("전체 시즌" 없음).
//   [2~5] 요약 카드 — 전체 / 정상 / 긴급 / 크루(distinct user_id).
//   [6] [긴급 휴식 신청] — 배치만(후속 작업). [7] [전체 승인] — pending 일괄 승인.
//   [표] 신청 목록 — 선택 조직+시즌 기준. 20개/페이지(21개부터 페이지네이션). 승인/삭제.
//
// 집계·목록은 실제 DB(vacation_requests) 기준. mode·일반 모드·actAsTestUserId 는 동일 DTO·동일
//   조회 흐름을 타며 로직/모집단을 바꾸지 않는다(URL 보존만).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, ArrowUpDown, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { adminDialog } from "@/components/ui/admin-dialog";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfirm, CONFIRM } from "@/components/ui/confirm-dialog";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import EmergencyRestModal from "@/components/admin/EmergencyRestModal";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { readOrgParam } from "@/lib/adminOrgContext";
import {
  ORGANIZATIONS,
  organizationLabelKo,
  type OrganizationSlug,
} from "@/lib/organizations";
import {
  getCurrentActivityDateIso,
  operationalSeasonDbKey,
} from "@/lib/seasonCalendar";
import { classTone } from "@/lib/statusBadge";
import { cn } from "@/lib/utils";
import type {
  RestManagementSummary,
  RestManagementSeasonOption,
  RestRequestDisplayStatus,
  RestRequestListRow,
} from "@/lib/adminRestManagementData";

const PAGE_SIZE = 20;

// 클럽 표시명 = lib/organizations 단일 SoT(organizationLabelKo). 화면별 한글 매핑 재작성 금지.
const CLUB_LABEL_KO: Record<OrganizationSlug, string> = {
  encre: organizationLabelKo("encre"),
  oranke: organizationLabelKo("oranke"),
  phalanx: organizationLabelKo("phalanx"),
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

// 진행 상태 · 분류 표기/색.
const STATUS_LABEL: Record<RestRequestDisplayStatus, string> = {
  pending: "휴식 신청",
  approved: "휴식 승인",
  fulfilled: "휴식 이행",
};
const STATUS_TONE: Record<RestRequestDisplayStatus, BadgeTone> = {
  pending: "warning",
  approved: "success",
  fulfilled: "violet",
};
const TYPE_LABEL: Record<"normal" | "urgent", string> = {
  normal: "정상",
  urgent: "긴급",
};
const TYPE_TONE: Record<"normal" | "urgent", BadgeTone> = {
  normal: "success",
  urgent: "danger",
};

// 사유 — 최대 50자 표시, 초과 시 말줄임.
function truncateReason(reason: string): string {
  const t = reason.trim();
  return t.length > 50 ? `${t.slice(0, 50)}…` : t;
}

// ── 테이블 컬럼 정의(헤더 라벨 · 도움말 키 · 정렬 기준) ─────────────────────────
//   · 일반 모드/테스트 모드/모든 org 가 이 단일 배열을 공유한다(mode 분기 없음).
//   · sortValue 가 있는 컬럼만 정렬 가능. 액션(휴식 승인/삭제) 컬럼은 정렬 제외 —
//     정렬 의미가 없으나(버튼 전용) 도움말은 부여한다.
//   · 정렬 기준은 표시 문자열이 아니라 "실제 정렬 가능한 값":
//       진행상태/분류 = 업무 순서(enum), 주차/신청시점 = 실제 날짜·타임스탬프(ISO),
//       크루/소속팀/클래스/사유 = 한글 locale-aware 문자열(빈값은 항상 뒤).
type ColKey =
  | "status"
  | "week"
  | "category"
  | "crew"
  | "team"
  | "class"
  | "reason"
  | "requestedAt"
  | "approve"
  | "delete";
type SortValue = number | string | null;

// 진행 상태 업무 순서: 휴식 신청 → 휴식 승인 → 휴식 이행(STATUS_LABEL 과 동일 SoT 순서).
const STATUS_SORT_ORDER: Record<RestRequestDisplayStatus, number> = {
  pending: 0,
  approved: 1,
  fulfilled: 2,
};
// 분류 순서: 정상 → 긴급.
const TYPE_SORT_ORDER: Record<"normal" | "urgent", number> = {
  normal: 0,
  urgent: 1,
};

// 빈값 규칙: null/undefined/빈문자열/공백/"-" 는 모두 동일한 빈값으로 정규화(→ null).
function emptyToNull(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t === "" || t === "-" ? null : t;
}

type ColumnDef = {
  key: ColKey;
  label: string;
  helpKey: string;
  // 없으면 정렬 불가(액션 전용 컬럼).
  sortValue?: (row: RestRequestListRow) => SortValue;
};

const COLUMNS: ColumnDef[] = [
  {
    key: "status",
    label: "진행 상태",
    helpKey: "admin.restManagement.column.status",
    sortValue: (r) => STATUS_SORT_ORDER[r.displayStatus],
  },
  {
    key: "week",
    label: "주차",
    helpKey: "admin.restManagement.column.week",
    // 표시 문자열("26년, 여름, 7주차")이 아니라 실제 주차 시작일(ISO)로 정렬 → 연·시즌·주차 순.
    sortValue: (r) => r.weekStartDate ?? null,
  },
  {
    key: "category",
    label: "분류",
    helpKey: "admin.restManagement.column.category",
    sortValue: (r) => TYPE_SORT_ORDER[r.requestType],
  },
  {
    key: "crew",
    label: "크루",
    helpKey: "admin.restManagement.column.crew",
    sortValue: (r) => emptyToNull(r.crewName),
  },
  {
    key: "team",
    label: "소속 팀",
    helpKey: "admin.restManagement.column.team",
    sortValue: (r) => emptyToNull(r.teamName),
  },
  {
    key: "class",
    label: "클래스",
    helpKey: "admin.restManagement.column.class",
    sortValue: (r) => emptyToNull(r.classLabel),
  },
  {
    key: "reason",
    label: "사유",
    helpKey: "admin.restManagement.column.reason",
    sortValue: (r) => emptyToNull(r.reason),
  },
  {
    key: "requestedAt",
    label: "신청 시점",
    helpKey: "admin.restManagement.column.requestedAt",
    // 한국어 가공 문자열이 아니라 실제 timestamptz(ISO) 로 정렬.
    sortValue: (r) => r.createdAt ?? null,
  },
  {
    key: "approve",
    label: "휴식 승인",
    helpKey: "admin.restManagement.column.approve",
  },
  {
    key: "delete",
    label: "삭제",
    helpKey: "admin.restManagement.column.delete",
  },
];

// null/빈값/"-" 은 정렬 방향과 무관하게 항상 뒤로. 숫자는 숫자, 문자열은 한글 locale.
function compareSortValues(
  a: SortValue,
  b: SortValue,
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

// 컬럼 헤더: 정렬 트리거(button)와 도움말(button)을 형제로 둔다(버튼 중첩 방지).
//   · 도움말은 stopPropagation(AdminHelpIconButton 내부) + 구조 분리로 정렬을 트리거하지 않는다.
//   · 액션 컬럼(sortValue 없음)은 정렬 트리거 없이 라벨 + 도움말만.
function ColumnHeader({
  col,
  dir,
  onSort,
}: {
  col: ColumnDef;
  dir: "asc" | "desc" | null;
  onSort: () => void;
}) {
  const sortable = Boolean(col.sortValue);
  return (
    <TableHead
      aria-sort={
        dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"
      }
    >
      <div className="inline-flex items-center justify-center gap-1">
        {sortable ? (
          <button
            type="button"
            onClick={onSort}
            aria-label={`${col.label} 정렬`}
            className={cn(
              "inline-flex items-center gap-1 text-sm font-semibold tracking-wide text-muted-foreground hover:text-foreground",
              dir && "text-foreground",
            )}
          >
            <span>{col.label}</span>
            {dir === "asc" ? (
              <ArrowUp className="h-3 w-3" />
            ) : dir === "desc" ? (
              <ArrowDown className="h-3 w-3" />
            ) : (
              <ArrowUpDown className="h-3 w-3 opacity-40" />
            )}
          </button>
        ) : (
          <span className="text-sm font-semibold tracking-wide text-muted-foreground">
            {col.label}
          </span>
        )}
        <AdminHelpIconButton helpKey={col.helpKey} title={col.label} size="xs" />
      </div>
    </TableHead>
  );
}

// 요약 카드 1장. tone=urgent 면 숫자에 강조색(긴급). help 지정 시 라벨 옆 돋보기 도움말.
function StatCard({
  label,
  value,
  suffix,
  tone = "default",
  loading,
  help,
}: {
  label: string;
  value: number;
  suffix?: string;
  tone?: "default" | "urgent";
  loading: boolean;
  help?: { helpKey: string; title?: string };
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1.5 py-5">
        <span className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground">
          {label}
          {help ? (
            <AdminHelpIconButton
              helpKey={help.helpKey}
              title={help.title ?? label}
              size="xs"
            />
          ) : null}
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
  // URL 의 ?org = 이 페이지의 "고정 스코프" 여부만 판정한다(값 자체가 스코프).
  //   · urlOrg 있음(개별 경로): 조직 고정 — 탭 1개(자기 조직)만·내부 전환 불가.
  //   · urlOrg 없음(통합 경로): 통합 컨텍스트 — 4탭·selectedOrg 내부 상태 전환.
  const urlOrg = readOrgParam(searchParams);
  const confirm = useConfirm();

  // 통합 경로의 선택 조직 탭 = 페이지 내부 상태. null = [통합](빈 본문·API 미호출).
  //   개별 경로(urlOrg 있음)에서는 이 상태를 쓰지 않는다(activeOrg 가 urlOrg 로 고정).
  const [selectedOrg, setSelectedOrg] = useState<OrganizationSlug | null>(null);

  // 실제 조회/액션 스코프 = 개별 경로면 URL org 고정, 통합 경로면 내부 선택(null=통합).
  //   데이터·조직별 캐시 key·승인/삭제/전체승인 대상 = 모두 activeOrg(개별=URL org 항상 일치).
  const activeOrg: OrganizationSlug | null = urlOrg ?? selectedOrg;

  const [seasons, setSeasons] = useState<RestManagementSeasonOption[]>([]);
  // selectedSeason: 드롭다운 선택 시즌. 초기값 = 현재(운영) 시즌(seasonCalendar 는 browser-safe).
  const [selectedSeason, setSelectedSeason] = useState<string>(
    () => operationalSeasonDbKey(getCurrentActivityDateIso()) ?? "",
  );
  const [summary, setSummary] = useState<RestManagementSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState<boolean>(Boolean(urlOrg));
  const [error, setError] = useState<string | null>(null);

  // 목록(테이블) — 전체 행을 받아 클라이언트에서 20개/페이지 슬라이스.
  const [listRows, setListRows] = useState<RestRequestListRow[]>([]);
  const [listLoading, setListLoading] = useState<boolean>(Boolean(urlOrg));
  const [listError, setListError] = useState<string | null>(null);
  const [listPage, setListPage] = useState(1);
  // 컬럼 헤더 클릭 정렬. null = 기본 순서(서버 정렬 = 주차 최신 → 신청 시점 최신).
  //   클릭 순환: 없음 → 오름차순 → 내림차순 → 기본 복귀.
  const [columnSort, setColumnSort] = useState<{
    key: ColKey;
    dir: "asc" | "desc";
  } | null>(null);

  const cycleSort = (key: ColKey) => {
    setColumnSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null; // 내림차순 다음 클릭 → 기본 순서 복귀
    });
    setListPage(1); // 정렬 변경 시 1페이지로 복귀
  };

  // 액션(승인/삭제/전체승인) 후 요약·목록 동시 갱신 트리거.
  const [refreshTick, setRefreshTick] = useState(0);
  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  // 긴급 휴식 신청 모달.
  const [emergencyOpen, setEmergencyOpen] = useState(false);

  useReportLoading(loading || listLoading);

  const listViewKeyRef = useRef("");

  // 요약 조회 — 활성 조직(activeOrg)/시즌/refreshTick(액션 후) 변경 시 재조회.
  //   [통합](activeOrg=null)에서는 조회하지 않는다(빈 본문). API 에는 개별=URL org, 통합=내부
  //   탭 상태를 organization 으로 명시 전달한다(개별 경로는 항상 URL org 와 일치·브라우저 URL 불변).
  useEffect(() => {
    if (!activeOrg) return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ organization: activeOrg });
        if (selectedSeason) qs.set("season_key", selectedSeason);
        const res = await fetch(
          `/api/admin/rest-management/summary?${qs.toString()}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json?.success) {
          throw new Error(json?.error ?? "요약을 불러오지 못했습니다.");
        }
        setSeasons(json.seasons ?? []);
        setSummary(json.summary ?? EMPTY_SUMMARY);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "요약을 불러오지 못했습니다.");
        setSummary(EMPTY_SUMMARY);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [activeOrg, selectedSeason, refreshTick]);

  // 목록 조회 — 활성 조직/시즌 변경 시 첫 페이지로 리셋(listViewKeyRef), 액션 재조회 시 페이지 유지.
  //   viewKey 에 activeOrg 를 포함해 조직별 조회가 섞이지 않도록 한다(탭 전환 = 새 view).
  useEffect(() => {
    if (!activeOrg) return;
    let cancelled = false;
    const viewKey = `${activeOrg}|${selectedSeason}`;
    const isNewView = listViewKeyRef.current !== viewKey;
    listViewKeyRef.current = viewKey;
    const run = async () => {
      setListLoading(true);
      setListError(null);
      try {
        const qs = new URLSearchParams({ organization: activeOrg });
        if (selectedSeason) qs.set("season_key", selectedSeason);
        const res = await fetch(
          `/api/admin/rest-management/list?${qs.toString()}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json?.success) {
          throw new Error(json?.error ?? "목록을 불러오지 못했습니다.");
        }
        setListRows(json.rows ?? []);
        if (isNewView) setListPage(1);
      } catch (err) {
        if (cancelled) return;
        setListError(err instanceof Error ? err.message : "목록을 불러오지 못했습니다.");
        setListRows([]);
      } finally {
        if (!cancelled) setListLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [activeOrg, selectedSeason, refreshTick]);

  // 통합 경로의 조직 탭 전환 = 페이지 내부 상태만 변경(URL 불변·라우팅 없음).
  //   · 개별 경로(urlOrg 고정)에서는 호출하지 않는다(탭 1개·no-op) — 조직 전환 불가.
  //   · 같은 탭 재클릭은 무시. 다른 탭이면 이전 조직 데이터/페이지/정렬/오류를 즉시 초기화해
  //     이전 조직 데이터가 잠깐 노출되지 않도록 하고, 실 조직 탭이면 로딩 상태로 진입시킨다.
  const selectOrg = useCallback(
    (targetOrg: OrganizationSlug | null) => {
      if (urlOrg || targetOrg === selectedOrg) return;
      setListRows([]);
      setSummary(EMPTY_SUMMARY);
      setSeasons([]);
      setError(null);
      setListError(null);
      setColumnSort(null);
      setListPage(1);
      setLoading(Boolean(targetOrg));
      setListLoading(Boolean(targetOrg));
      setSelectedOrg(targetOrg);
    },
    [urlOrg, selectedOrg],
  );

  // 상단 조직 탭 — URL 스코프로 노출 규칙이 갈린다:
  //   · 개별 경로(urlOrg 있음): 자기 조직 탭 1개만 렌더(고정 active·no-op onSelect). 통합·타 조직
  //     탭은 DOM 에 렌더하지 않는다 → 다른 조직으로 전환 불가.
  //   · 통합 경로(urlOrg 없음): [통합]+엥크레/오랑캐/팔랑크스 4개. onSelect 로 내부 상태(selectedOrg)만
  //     전환한다(AdminPageHeader 가 button 으로 렌더·URL/사이드바 배지 불변).
  const tabs = urlOrg
    ? [{ label: CLUB_LABEL_KO[urlOrg], active: true, onSelect: () => {} }]
    : [
        {
          label: "통합",
          active: selectedOrg === null,
          onSelect: () => selectOrg(null),
        },
        ...ORGANIZATIONS.map((o) => ({
          label: CLUB_LABEL_KO[o],
          active: selectedOrg === o,
          onSelect: () => selectOrg(o),
        })),
      ];

  const accent = activeOrg ? ORG_ACCENT[activeOrg] : null;

  // 정렬은 화면에 보이는 행이 아니라 "전체 결과"(listRows: 서버가 전체 행 반환) 기준으로 적용한 뒤
  //   클라이언트에서 페이지 슬라이스. 원본(listRows)은 mutate 하지 않고 복사본을 정렬한다.
  //   columnSort=null 이면 서버 기본 정렬 순서(원본)를 그대로 사용.
  const sortedRows = useMemo(() => {
    if (!columnSort) return listRows;
    const col = COLUMNS.find((c) => c.key === columnSort.key);
    if (!col?.sortValue) return listRows;
    const sortValue = col.sortValue;
    return [...listRows].sort((a, b) => {
      const c = compareSortValues(sortValue(a), sortValue(b), columnSort.dir);
      if (c !== 0) return c;
      // 동값 타이브레이크 — 신청 시점 최신(안정적 표시).
      return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    });
  }, [listRows, columnSort]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const safePage = Math.min(listPage, totalPages);
  const pageRows = sortedRows.slice(
    (safePage - 1) * PAGE_SIZE,
    (safePage - 1) * PAGE_SIZE + PAGE_SIZE,
  );

  // ── 액션 ────────────────────────────────────────────────────────────────
  async function approveRow(row: RestRequestListRow) {
    if (row.ended) {
      void adminDialog.alert({ variant: "warning", title: "처리 종료", description: "이미 진행된 기간으로서, 처리가 종료되었습니다." });
      return;
    }
    if (row.displayStatus === "approved") {
      void adminDialog.alert({ variant: "info", title: "이미 승인됨", description: "이미 승인된 휴식입니다." });
      return;
    }
    const ok = await confirm({
      title: "휴식 승인",
      description: "이 휴식을 승인하시겠습니까?",
      confirmLabel: "승인",
    });
    if (!ok) return;
    const res = await fetch(`/api/admin/rest-management/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.success) {
      void adminDialog.alert({ variant: "danger", title: "승인 실패", description: json?.error ?? "승인에 실패했습니다." });
    }
    refresh();
  }

  async function deleteRow(row: RestRequestListRow) {
    if (row.ended) {
      void adminDialog.alert({ variant: "warning", title: "취소 불가", description: "취소할 수 없습니다." });
      return;
    }
    const ok = await confirm({
      ...CONFIRM.delete,
      title: "휴식 신청 삭제",
      description: "이 휴식 신청을 삭제하시겠습니까? 삭제한 내용은 되돌릴 수 없습니다.",
    });
    if (!ok) return;
    const res = await fetch(`/api/admin/rest-management/${row.id}`, {
      method: "DELETE",
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.success) {
      void adminDialog.alert({ variant: "danger", title: "삭제 실패", description: json?.error ?? "삭제에 실패했습니다." });
    }
    refresh();
  }

  async function approveAll() {
    if (!activeOrg || !selectedSeason) return;
    const ok = await confirm({
      title: "전체 승인",
      description:
        "현재 클럽·시즌의 신청 중인 휴식을 모두 승인하시겠습니까? (이미 승인/이행된 휴식은 제외됩니다.)",
      confirmLabel: "전체 승인",
    });
    if (!ok) return;
    const res = await fetch(`/api/admin/rest-management/approve-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        organization: activeOrg,
        season_key: selectedSeason,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.success) {
      void adminDialog.alert({ variant: "danger", title: "일괄 승인 실패", description: json?.error ?? "일괄 승인에 실패했습니다." });
    } else {
      void adminDialog.alert({ variant: "success", title: "일괄 승인 완료", description: `${(json.approved ?? 0).toLocaleString()}건을 승인했습니다.` });
    }
    refresh();
  }

  return (
    // data-active-org = 현재 활성 조직 스코프(개별=URL org, 통합=내부 선택·통합=integrated). 테스트/디버그 훅.
    <div
      className="admin-section-stack"
      data-active-org={activeOrg ?? "integrated"}
    >
      <AdminPageHeader title="휴식 관리" tabs={tabs} />

      {!activeOrg ? (
        // [통합] 탭 — 조직 횡단 집계는 아직 없다(list/summary API 미호출). 오류/로딩이 아니라
        //   데이터 없는 정상 통합 화면으로서 본문을 비워 둔다.
        null
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
              {/* 시즌 선택(좌) + 액션 버튼(우) — 좌측 필터는 행을 채우고, 우측 액션은 우측 정렬 유지. */}
              <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2.5">
                  {accent ? (
                    <span
                      aria-hidden
                      className={cn("h-2.5 w-2.5 rounded-full", accent.dot)}
                    />
                  ) : null}
                  <span className="text-base font-semibold text-foreground">
                    {CLUB_LABEL_KO[activeOrg]}
                  </span>
                  <Select
                    value={selectedSeason}
                    onValueChange={(v) => {
                      const next = v ?? "";
                      if (next) setSelectedSeason(next); // 표시 + 재조회 트리거
                    }}
                  >
                    {/* 폭 확대(≈248px) · 모바일은 화면폭 초과 방지. */}
                    <SelectTrigger className="w-[248px] max-w-[calc(100vw-3rem)]">
                      {/* 트리거 표시는 옵션 SoT(seasons)의 season_label 로 — raw season_key 노출 방지.
                          옵션 목록과 동일한 seasons 를 유일 SoT 로 사용(중복 변환 없음). */}
                      <SelectValue placeholder="시즌 선택">
                        {(value: unknown) => {
                          const key = value == null ? "" : String(value);
                          return (
                            seasons.find((s) => s.season_key === key)?.season_label ??
                            "시즌 선택"
                          );
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {seasons.map((s) => (
                        <SelectItem key={s.season_key} value={s.season_key}>
                          {s.season_label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <AdminHelpIconButton
                    helpKey="admin.restManagement.filter.season"
                    title="시즌 선택"
                    size="sm"
                  />
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <div className="inline-flex items-center gap-1">
                    <Button
                      variant="destructive"
                      onClick={() => setEmergencyOpen(true)}
                    >
                      긴급 휴식 신청
                    </Button>
                    <AdminHelpIconButton
                      helpKey="admin.restManagement.action.urgentRequest"
                      title="긴급 휴식 신청"
                      size="sm"
                    />
                  </div>
                  <div className="inline-flex items-center gap-1">
                    <Button onClick={approveAll}>전체 승인</Button>
                    <AdminHelpIconButton
                      helpKey="admin.restManagement.action.approveAll"
                      title="전체 승인"
                      size="sm"
                    />
                  </div>
                </div>
              </div>

              {/* 집계 카드 */}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <StatCard
                  label="전체"
                  value={summary.total}
                  suffix="건"
                  loading={loading}
                  help={{ helpKey: "admin.restManagement.metric.total" }}
                />
                <StatCard
                  label="정상"
                  value={summary.normal}
                  suffix="건"
                  loading={loading}
                  help={{ helpKey: "admin.restManagement.metric.normal" }}
                />
                <StatCard
                  label="긴급"
                  value={summary.urgent}
                  suffix="건"
                  tone="urgent"
                  loading={loading}
                  help={{ helpKey: "admin.restManagement.metric.urgent" }}
                />
                <StatCard
                  label="크루"
                  value={summary.crews}
                  suffix="명"
                  loading={loading}
                  help={{ helpKey: "admin.restManagement.metric.crews" }}
                />
              </div>
            </CardContent>
          </Card>

          {/* 신청 목록 — 헤더(정렬 + 도움말)는 로딩/빈 상태에서도 항상 유지. */}
          <Card>
            <CardContent className="pt-6">
              {listError ? (
                <div className="py-4 text-sm text-destructive">{listError}</div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="overflow-hidden rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          {COLUMNS.map((col) => (
                            <ColumnHeader
                              key={col.key}
                              col={col}
                              dir={
                                columnSort?.key === col.key
                                  ? columnSort.dir
                                  : null
                              }
                              onSort={() => cycleSort(col.key)}
                            />
                          ))}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {listLoading && listRows.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={COLUMNS.length}
                              className="py-12 text-center text-sm text-muted-foreground"
                            >
                              불러오는 중…
                            </TableCell>
                          </TableRow>
                        ) : pageRows.length === 0 ? (
                          <TableRow>
                            <TableCell
                              colSpan={COLUMNS.length}
                              className="py-12 text-center text-sm text-muted-foreground"
                            >
                              신청된 휴식이 없습니다.
                            </TableCell>
                          </TableRow>
                        ) : (
                          pageRows.map((row) => (
                            <TableRow key={row.id}>
                              <TableCell>
                                <Badge tone={STATUS_TONE[row.displayStatus]}>
                                  {STATUS_LABEL[row.displayStatus]}
                                </Badge>
                              </TableCell>
                              <TableCell className="font-medium">
                                {row.weekLabel}
                              </TableCell>
                              <TableCell>
                                <Badge
                                  tone={TYPE_TONE[row.requestType]}
                                  appearance="soft"
                                >
                                  {TYPE_LABEL[row.requestType]}
                                </Badge>
                              </TableCell>
                              <TableCell>{row.crewName ?? "—"}</TableCell>
                              <TableCell>{row.teamName ?? "—"}</TableCell>
                              <TableCell>
                                <Badge
                                  tone={classTone(row.classLabel)}
                                  appearance="outline"
                                >
                                  {row.classLabel}
                                </Badge>
                              </TableCell>
                              <TableCell
                                className="max-w-[320px] text-left"
                                title={row.reason ?? undefined}
                              >
                                {row.reason ? truncateReason(row.reason) : "—"}
                              </TableCell>
                              <TableCell className="text-muted-foreground">
                                {row.createdAtLabel || "—"}
                              </TableCell>
                              <TableCell>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => approveRow(row)}
                                >
                                  휴식 승인
                                </Button>
                              </TableCell>
                              <TableCell>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label="휴식 신청 삭제"
                                  onClick={() => deleteRow(row)}
                                >
                                  <X className="size-4" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>

                  {/* 21개부터 페이지네이션 */}
                  {sortedRows.length > PAGE_SIZE ? (
                    <div className="flex items-center justify-center gap-3 pt-1">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={safePage <= 1}
                        onClick={() => setListPage((p) => Math.max(1, p - 1))}
                      >
                        이전
                      </Button>
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {safePage} / {totalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={safePage >= totalPages}
                        onClick={() => setListPage((p) => Math.min(totalPages, p + 1))}
                      >
                        다음
                      </Button>
                    </div>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 긴급 휴식 신청 모달 — 성공 시 요약+목록 재조회(refresh). activeOrg 는 이 분기에서 항상 존재. */}
          {emergencyOpen ? (
            <EmergencyRestModal
              org={activeOrg}
              // po.C 표시명 스코프: 개별 경로(urlOrg 있음)에서만 조직별 명칭, 통합 경로(특정 조직
              //   탭 선택 포함)에서는 null → 중립 "Po.C" 유지. 조회/액션 스코프(org=activeOrg)와 분리.
              labelOrg={urlOrg ? activeOrg : null}
              onClose={() => setEmergencyOpen(false)}
              onCreated={refresh}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
