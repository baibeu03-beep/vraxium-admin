"use client";

// /admin/rest-management — 크루 휴식 신청 관리.
//
//   [0] 클럽 탭(엥크레/오랑캐/팔랑크스) — ?org 전환. mode=test 보존.
//   [1] 시즌 드롭다운 — 현재(운영) 시즌 기본. 시즌 1개씩만 조회("전체 시즌" 없음).
//   [2~5] 요약 카드 — 전체 / 정상 / 긴급 / 크루(distinct user_id).
//   [6] [긴급 휴식 신청] — 배치만(후속 작업). [7] [전체 승인] — pending 일괄 승인.
//   [표] 신청 목록 — org+시즌 기준. 20개/페이지(21개부터 페이지네이션). 승인/삭제.
//
// 집계·목록은 실제 DB(vacation_requests) 기준. mode 는 로직/모집단을 바꾸지 않는다(URL 보존만).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, ArrowUpDown, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
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
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { readOrgParam } from "@/lib/adminOrgContext";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
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

const BASE_PATH = "/admin/rest-management";
const PAGE_SIZE = 20;

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
  const org = readOrgParam(searchParams);
  const confirm = useConfirm();

  const [seasons, setSeasons] = useState<RestManagementSeasonOption[]>([]);
  // selectedSeason: 드롭다운 선택 시즌. 초기값 = 현재(운영) 시즌(seasonCalendar 는 browser-safe).
  const [selectedSeason, setSelectedSeason] = useState<string>(
    () => operationalSeasonDbKey(getCurrentActivityDateIso()) ?? "",
  );
  const [summary, setSummary] = useState<RestManagementSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState<boolean>(Boolean(org));
  const [error, setError] = useState<string | null>(null);

  // 목록(테이블) — 전체 행을 받아 클라이언트에서 20개/페이지 슬라이스.
  const [listRows, setListRows] = useState<RestRequestListRow[]>([]);
  const [listLoading, setListLoading] = useState<boolean>(Boolean(org));
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

  useReportLoading(loading || listLoading);

  const listViewKeyRef = useRef("");

  // 요약 조회 — org/시즌/refreshTick(액션 후) 변경 시 재조회.
  useEffect(() => {
    if (!org) return;
    let cancelled = false;
    const run = async () => {
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
  }, [org, selectedSeason, refreshTick]);

  // 목록 조회 — org/시즌 변경 시 첫 페이지로 리셋(listViewKeyRef), 액션 재조회 시 페이지 유지.
  useEffect(() => {
    if (!org) return;
    let cancelled = false;
    const viewKey = `${org}|${selectedSeason}`;
    const isNewView = listViewKeyRef.current !== viewKey;
    listViewKeyRef.current = viewKey;
    const run = async () => {
      setListLoading(true);
      setListError(null);
      try {
        const qs = new URLSearchParams({ organization: org });
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
  }, [org, selectedSeason, refreshTick]);

  // 상단 조직 탭: [통합] + 엥크레/오랑캐/팔랑크스. 조직 범위는 URL의 org 하나로 고정한다.
  //   · [통합] = org 없는 통합 경로(BASE_PATH). 조직 탭 = ?org={slug}.
  //   · 탭 이동 시 mode 등 기존 쿼리는 보존하고 org 만 설정/제거한다(통합 탭은 org 제거).
  const tabHref = (targetOrg: OrganizationSlug | null): string => {
    const params = new URLSearchParams(searchParams.toString());
    if (targetOrg) params.set("org", targetOrg);
    else params.delete("org");
    const qs = params.toString();
    return qs ? `${BASE_PATH}?${qs}` : BASE_PATH;
  };
  //   · 통합 경로(org 없음): [통합]+엥크레/오랑캐/팔랑크스 전체 노출(통합 active) — 여기서만 조직 전환.
  //   · 개별 경로(?org={slug}): 현재 조직 탭 1개만 노출(고정 선택). [통합]·타 조직 탭은 숨겨
  //     탭으로 다른 조직/통합 경로로 전환할 수 없다(조직 전환은 통합 경로에서만).
  const tabs = org
    ? [{ label: CLUB_LABEL_KO[org], href: tabHref(org), active: true }]
    : [
        { label: "통합", href: tabHref(null), active: true },
        ...ORGANIZATIONS.map((o) => ({
          label: CLUB_LABEL_KO[o],
          href: tabHref(o),
          active: false,
        })),
      ];

  const accent = org ? ORG_ACCENT[org] : null;

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
      window.alert("이미 진행된 기간으로서, 처리가 종료되었습니다.");
      return;
    }
    if (row.displayStatus === "approved") {
      window.alert("이미 승인된 휴식입니다.");
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
      window.alert(json?.error ?? "승인에 실패했습니다.");
    }
    refresh();
  }

  async function deleteRow(row: RestRequestListRow) {
    if (row.ended) {
      window.alert("취소할 수 없습니다");
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
      window.alert(json?.error ?? "삭제에 실패했습니다.");
    }
    refresh();
  }

  async function approveAll() {
    if (!org || !selectedSeason) return;
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
      body: JSON.stringify({ organization: org, season_key: selectedSeason }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.success) {
      window.alert(json?.error ?? "일괄 승인에 실패했습니다.");
    } else {
      window.alert(`${(json.approved ?? 0).toLocaleString()}건을 승인했습니다.`);
    }
    refresh();
  }

  return (
    <div className="admin-section-stack">
      <AdminPageHeader title="휴식 관리" tabs={tabs} />

      {!org ? (
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
                    {CLUB_LABEL_KO[org]}
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
                      onClick={() => window.alert(NEXT_TASK_MSG)}
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
        </>
      )}
    </div>
  );
}
