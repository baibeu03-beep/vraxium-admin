"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Loader2,
  Search,
  Plus,
  X,
  ExternalLink,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { adminDialog } from "@/components/ui/admin-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { Checkbox, checkedTextClass, checkedRowClass } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { readOrgParam } from "@/lib/adminOrgContext";
import { excludeAddedByUserId } from "@/lib/crewSearchExclude";
import { formatLogPeriodLabel } from "@/lib/practicalInfoSection0Format";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { useToast } from "@/components/ui/toast";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";

// 실무 역량 [라인 개설] — [해당 크루] 영역.
//   상단: 요약(활동/신청/개설/반려/신청 라인/개설 라인) + 수동 추가(자동완성 + 추가).
//   본문: 승인 명단 테이블(크루명/라인명/제출 링크/카페/승인/반려 사유) + 반려 사유 팝업.
//   고객 신청 데이터가 존재한다고 가정한 어드민 승인/개설 준비 UI. snapshot 무관.

type ApplicationDto = {
  id: string;
  targetUserId: string;
  crewNo: number | null;
  crewCode: string | null;
  displayName: string;
  teamName: string | null;
  schoolName: string | null;
  crewLabel: string;
  competencyLineMasterId: string | null;
  lineCode: string | null;
  lineName: string;
  submissionLink: string | null;
  cafeChecked: boolean;
  approvalChecked: boolean;
  rejectionReason: string | null;
  source: "customer" | "manual";
  resolution: "pending" | "opened" | "rejected";
  createdAt: string;
};

type Summary = {
  activeCrews: number;
  appliedCrews: number;
  openedCrews: number;
  rejectedCrews: number;
  appliedLines: number;
  openedLines: number;
  enhanceSuccess: number;
  enhanceFail: number;
};

type CrewSearchItem = {
  userId: string;
  crewNo: number | null;
  crewCode: string | null;
  name: string;
  teamName: string | null;
  schoolName: string | null;
  majorName: string | null;
};

// 수동 추가 라인명 드롭다운 = 개설 가능한 competency master line(현재 org + 실무 역량 허브).
type MasterItem = {
  id: string; // competency_line_master_id (bridged)
  organizationSlug: string | null;
  lineCode: string;
  lineName: string;
  mainTitle: string | null;
  isActive: boolean;
};

// 주차 헤더용 메타(weeks-options 로 resolve) — 신청 API 응답의 week_id 를 라벨로 바꾼다.
type WeekMeta = { year: number; seasonKey: string; weekNumber: number };

// "26년 여름 시즌 1주차" — info/experience 로그창과 동일 주차 표기(단일 SoT).
function weekHeaderLabel(meta: WeekMeta | undefined): string {
  return formatLogPeriodLabel({
    isoYear: meta?.year ?? null,
    seasonKey: meta?.seasonKey ?? null,
    weekNumber: meta?.weekNumber ?? null,
  });
}

const EMPTY_SUMMARY: Summary = {
  activeCrews: 0,
  appliedCrews: 0,
  openedCrews: 0,
  rejectedCrews: 0,
  appliedLines: 0,
  openedLines: 0,
  enhanceSuccess: 0,
  enhanceFail: 0,
};

function SummaryChip({ label, value, tone, helpKey }: { label: string; value: number; tone?: "default" | "success" | "error" | "info"; helpKey?: string }) {
  return (
    <div
      className={cn(
        "min-w-[68px] rounded-md border px-3 py-1.5 text-center",
        tone === "success" && "border-green-200 bg-green-50",
        tone === "error" && "border-red-200 bg-red-50",
        tone === "info" && "border-blue-200 bg-blue-50",
        (!tone || tone === "default") && "border-border bg-muted",
      )}
    >
      <p className="text-lg font-bold leading-none">{value}</p>
      <p className="mt-1 inline-flex items-center justify-center gap-1 text-xs text-muted-foreground">
        {label}
        {helpKey ? (
          <AdminHelpIconButton helpKey={helpKey} title={label} size="xs" />
        ) : null}
      </p>
    </div>
  );
}

// ── 승인 명단 컬럼 정의(라벨 · 도움말 키 · 정렬 기준) — RestManagementManager 와 동일 패턴 ──
//   · 모든 org / mode=test 공유(모드 분기 없음).
//   · 승인 명단은 "주차 헤더 + 그 주차 크루"로 그룹핑되므로 정렬은 각 주차 그룹 "내부"에서만 적용
//     (그룹 순서 보존, stable). 정렬 가능 = 크루명/라인명(한글 locale 문자열, 빈값 항상 뒤).
//   · 제출 링크(url)·카페/승인(checkbox)·반려 사유/삭제(action)는 정렬 의미가 없어 제외 —
//     하지만 도움말은 7개 컬럼 전부 부여.
type AppColKey =
  | "crew"
  | "line"
  | "link"
  | "cafe"
  | "approve"
  | "reject"
  | "delete";
type AppSortValue = string | null;

function emptyToNull(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t === "" || t === "-" ? null : t;
}

type AppColumnDef = {
  key: AppColKey;
  label: string;
  helpKey: string;
  headClassName?: string;
  // 없으면 정렬 불가(정렬 트리거 없이 라벨 + 도움말만).
  sortValue?: (row: ApplicationDto) => AppSortValue;
};

const APP_COLUMNS: AppColumnDef[] = [
  {
    key: "crew",
    label: "크루명",
    helpKey: "admin.lineOpening.competency.applicants.column.crew",
    sortValue: (a) => emptyToNull(a.crewLabel),
  },
  {
    key: "line",
    label: "라인명",
    helpKey: "admin.lineOpening.competency.applicants.column.line",
    sortValue: (a) => emptyToNull(a.lineName),
  },
  {
    key: "link",
    label: "제출 링크",
    helpKey: "admin.lineOpening.competency.applicants.column.submissionLink",
    // 폭은 colgroup(30%)이 결정. 헤더는 가운데 정렬 + 필요 시 줄바꿈 허용(전역 whitespace-nowrap 덮음).
    headClassName: "text-center whitespace-normal break-words align-middle",
  },
  {
    key: "cafe",
    label: "카페",
    helpKey: "admin.lineOpening.competency.applicants.column.cafe",
    headClassName: "text-center",
  },
  {
    key: "approve",
    label: "승인",
    helpKey: "admin.lineOpening.competency.applicants.column.approve",
    headClassName: "text-center",
  },
  {
    key: "reject",
    label: "반려 사유",
    helpKey: "admin.lineOpening.competency.applicants.column.reject",
  },
  {
    key: "delete",
    label: "삭제",
    helpKey: "admin.lineOpening.competency.applicants.column.delete",
    headClassName: "text-center",
  },
];

// null/빈값/"-" 은 방향 무관 항상 뒤. 문자열은 한글 locale.
function compareAppSortValues(
  a: AppSortValue,
  b: AppSortValue,
  dir: "asc" | "desc",
): number {
  const aEmpty = a == null || a === "";
  const bEmpty = b == null || b === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  const c = String(a).localeCompare(String(b), "ko");
  return dir === "asc" ? c : -c;
}

// 컬럼 헤더: 정렬 트리거(button)와 도움말(button)을 형제로. 정렬 없는 컬럼은 라벨 + 도움말만.
function AppColumnHeader({
  col,
  dir,
  onSort,
}: {
  col: AppColumnDef;
  dir: "asc" | "desc" | null;
  onSort: () => void;
}) {
  const sortable = Boolean(col.sortValue);
  return (
    <TableHead
      className={col.headClassName}
      aria-sort={
        dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"
      }
    >
      <div
        className={cn(
          "inline-flex items-center gap-1",
          col.headClassName?.includes("text-center") && "justify-center",
        )}
      >
        {sortable ? (
          <button
            type="button"
            onClick={onSort}
            aria-label={`${col.label} 정렬`}
            className={cn(
              "inline-flex items-center gap-1 hover:text-foreground",
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
          <span>{col.label}</span>
        )}
        <AdminHelpIconButton helpKey={col.helpKey} title={col.label} size="xs" />
      </div>
    </TableHead>
  );
}

export default function CompetencyApplicantSection({
  refreshKey,
  // 상단 대시보드에서 선택한 개설 주차 — 명단 조회/수동 추가가 이 주차를 대상으로 한다.
  //   미지정(null)이면 백엔드가 개설 대상 주차(금요일 경계·테스트 W13 예외)로 fallback(상태창과 동일 SoT).
  selectedWeekId,
}: {
  refreshKey?: number;
  selectedWeekId?: string | null;
}) {
  const searchParams = useSearchParams();
  const org = readOrgParam(searchParams);
  const { toast } = useToast();

  const [apps, setApps] = useState<ApplicationDto[]>([]);
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
  // 신청 명단이 속한 개설 대상 주차(단일). 주차 헤더 그룹핑 키로 사용한다.
  const [weekId, setWeekId] = useState<string | null>(null);
  // weekId → 주차 메타(라벨용). weeks-options(읽기 전용, 기존 엔드포인트)로 resolve.
  const [weekMetaById, setWeekMetaById] = useState<Map<string, WeekMeta>>(new Map());
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);

  // 수동 추가 자동완성.
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CrewSearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedCrew, setSelectedCrew] = useState<CrewSearchItem | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  // 검색 결과에서 이미 승인 명단(apps)에 있는 크루는 완전 제외(공통 SoT). 결과는 userId,
  // apps 는 targetUserId 로 대상자를 보관 → 두 키를 각각 뽑아 비교. apps 변화 시 재계산:
  // 추가 즉시 사라지고, 삭제하면 다시 나타난다. org/mode/test/demo 무관 — 순수 필터.
  const visibleResults = useMemo(
    () =>
      excludeAddedByUserId(
        results,
        apps,
        (c) => c.userId,
        (a) => a.targetUserId,
      ),
    [results, apps],
  );

  // 수동 추가 팝업.
  const [addOpen, setAddOpen] = useState(false);
  // 라인명은 자유 입력이 아니라 master 드롭다운 선택(오타/미존재 라인 방지).
  const [addMasterId, setAddMasterId] = useState("");
  const [addLink, setAddLink] = useState("");
  const [saving, setSaving] = useState(false);
  // 개설 가능한 competency master line 목록(현재 org 관련 + 활성).
  const [masters, setMasters] = useState<MasterItem[]>([]);

  // 반려 사유 팝업.
  const [rejectApp, setRejectApp] = useState<ApplicationDto | null>(null);
  const [rejectDraft, setRejectDraft] = useState("");

  // 수동 추가 항목 삭제 확인 팝업(source='manual' 만).

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (org) qs.set("organization", org);
      // 선택한 개설 주차 전달 — 서버가 그 주차 명단/집계를 반환(미전달 시 개설 대상 주차 fallback).
      if (selectedWeekId) qs.set("week_id", selectedWeekId);
      // 집계/결과 모집단 = 서버 QA_HIDE_REAL_USERS 스위치 기준(QA=테스트 유저 / 종료 후 실사용자).
      const res = await fetch(
        `/api/admin/cluster4/competency/applications?${qs.toString()}`,
      );
      const json = await res.json();
      if (json?.success) {
        setApps(json.data?.applications ?? []);
        setSummary(json.data?.summary ?? EMPTY_SUMMARY);
        setWeekId(json.data?.weekId ?? null);
      } else {
        setApps([]);
        setSummary(EMPTY_SUMMARY);
        setWeekId(null);
      }
    } catch {
      setApps([]);
      setSummary(EMPTY_SUMMARY);
      setWeekId(null);
    } finally {
      setLoading(false);
    }
  }, [org, selectedWeekId]);

  useEffect(() => {
    void fetchData();
  }, [fetchData, refreshKey]);

  // 개설 가능한 competency master line 목록(실무 역량 허브). 활성 + (org 일치 OR 공통)만.
  //   조회 원천 = listCompetencyLineMasters(= bridged line_registrations, id=bridged_master_id).
  //   서버가 organization_slug ∈ {org, 'common'} 로 스코프하므로 org 를 넘긴다(2026-07-22).
  //     · 종전에는 "org 를 넘기면 공통이 빠진다"는 이유로 전량을 받아 클라에서 걸렀는데,
  //       서버가 org+common 으로 고쳐진 뒤로는 타 조직 마스터까지 내려받는 과다 조회일 뿐이다.
  //     · 클라이언트 필터는 방어적으로 유지한다(서버 스코프와 이중 게이트).
  //   cache: "no-store" — bridge 직후 돌아왔을 때 브라우저 캐시로 옛 목록이 재사용되지 않게 한다.
  //   (state 를 직접 쓰지 않고 목록을 반환한다 — 호출부가 취소 여부를 판단해 반영.)
  const loadMasters = useCallback(async (): Promise<MasterItem[]> => {
    try {
      const qs = org ? `?organization=${encodeURIComponent(org)}` : "";
      const res = await fetch(`/api/admin/cluster4/competency-line-masters${qs}`, {
        cache: "no-store",
      });
      const json = await res.json();
      return (json?.success ? json.data ?? [] : []).filter(
        (m: MasterItem) =>
          m.isActive && (!m.organizationSlug || m.organizationSlug === "common" || m.organizationSlug === org),
      );
    } catch {
      return [];
    }
  }, [org]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await loadMasters();
      if (!cancelled) setMasters(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadMasters, refreshKey]);

  // 주차 라벨 맵 — weeks-options(읽기 전용, 기존 엔드포인트)로 weekId→메타 resolve.
  //   신청 API 응답은 개설 대상 주차 1개(week_id)만 돌려주므로 그 주차 라벨만 있으면 되지만,
  //   주차가 늘어도 자동 대응하도록 최근 주차 전체를 맵으로 담아둔다(백엔드/응답 무변경).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const qs = new URLSearchParams({ limit: "20", hub: "competency" });
        if (org) qs.set("org", org);
        const res = await fetch(`/api/admin/cluster4/weeks-options?${qs.toString()}`);
        const json = await res.json();
        if (cancelled) return;
        const m = new Map<string, WeekMeta>();
        for (const w of (json?.success ? json.data?.weeks ?? [] : []) as Array<{
          id: string;
          year: number;
          seasonKey: string;
          weekNumber: number;
        }>) {
          m.set(w.id, { year: w.year, seasonKey: w.seasonKey, weekNumber: w.weekNumber });
        }
        setWeekMetaById(m);
      } catch {
        if (!cancelled) setWeekMetaById(new Map());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org]);

  // 신청 명단을 주차 기준으로 그룹핑 — info/experience 와 동일한 "주차 헤더 + 그 주차 크루" UI.
  //   현재 신청 API 는 개설 대상 주차 1개만 반환하므로 그룹은 하나지만, 응답이 여러 주차를
  //   담게 되면 주차별로 자동 분리된다(순수 렌더 그룹핑 — API/DB 무관).
  const weekGroups = useMemo(() => {
    const byWeek = new Map<string, ApplicationDto[]>();
    for (const a of apps) {
      // 행 단위 week_id 가 응답에 없으므로 명단 전체가 속한 개설 대상 주차(weekId)로 묶는다.
      const key = weekId ?? "__none__";
      const arr = byWeek.get(key);
      if (arr) arr.push(a);
      else byWeek.set(key, [a]);
    }
    return Array.from(byWeek.entries()).map(([wid, list]) => ({
      weekId: wid,
      meta: weekMetaById.get(wid),
      apps: list,
    }));
  }, [apps, weekId, weekMetaById]);

  // 컬럼 헤더 클릭 정렬(크루명/라인명). null = 서버 순서. 클릭 순환: 없음 → 오름 → 내림 → 기본.
  const [columnSort, setColumnSort] = useState<{
    key: AppColKey;
    dir: "asc" | "desc";
  } | null>(null);
  const cycleSort = (key: AppColKey) =>
    setColumnSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });

  // 정렬은 각 주차 그룹 "내부"에서만(그룹 순서·경계 보존). 원본 apps 는 mutate 하지 않고 복사본 정렬.
  const sortedWeekGroups = useMemo(() => {
    if (!columnSort) return weekGroups;
    const col = APP_COLUMNS.find((c) => c.key === columnSort.key);
    if (!col?.sortValue) return weekGroups;
    const sv = col.sortValue;
    return weekGroups.map((g) => ({
      ...g,
      apps: [...g.apps].sort((a, b) =>
        compareAppSortValues(sv(a), sv(b), columnSort.dir),
      ),
    }));
  }, [weekGroups, columnSort]);

  // 자동완성 검색(디바운스). cafe-line-crew GET 재사용 — 크루 번호+이름+학교 반환.
  useEffect(() => {
    const term = q.trim();
    if (!term || selectedCrew?.name === term) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        // 현재 org + mode 모집단으로만 검색 — 조직/모드 경계 밖 동명이인(실사용자/타org) 제외.
        const sp = new URLSearchParams({ q: term });
        if (org) sp.set("organization", org);
        sp.set("excludeSeasonRest", "1"); // 역량 라인 개설 후보 = 현재 시즌 휴식자 제외
        // 성장 중단(paused/suspended) 유저 제외 — 개설해도 고객앱에서 카드가 truncate 되어 노출되지 않으므로
        //   개설 대상 후보에서 뺀다(서버 excludeGrowthStopped opt-in).
        sp.set("excludeGrowthStopped", "1");
        const res = await fetch(`/api/admin/cluster4/cafe-line-crew?${sp.toString()}`);
        const json = await res.json();
        if (cancelled) return;
        setResults(json?.success ? (json.data?.crews ?? []) : []);
        setMenuOpen(true);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, selectedCrew, org]);

  // 검색 드롭다운 바깥 클릭 닫기.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  const pickCrew = useCallback((c: CrewSearchItem) => {
    setSelectedCrew(c);
    const code = c.crewCode?.trim() || "-";
    setQ(`${code} - ${c.name}`);
    setMenuOpen(false);
  }, []);

  const openAddPopup = useCallback(() => {
    if (!selectedCrew) {
      toast("error", "추가할 크루를 검색해 선택해주세요");
      return;
    }
    setAddMasterId("");
    setAddLink("");
    setAddOpen(true);
    // 팝업을 열 때마다 라인 옵션을 재조회한다 — 화면을 열어둔 채 다른 탭에서 [개설 연결]
    //   (bridge) 한 신규 라인이 mount 시점 state 에 갇혀 누락되지 않게 한다.
    void loadMasters().then(setMasters);
  }, [selectedCrew, loadMasters]);

  const submitAdd = useCallback(async () => {
    if (!org || !selectedCrew) return;
    const master = masters.find((m) => m.id === addMasterId);
    if (!master) {
      toast("error", "라인을 드롭다운에서 선택해주세요");
      return;
    }
    setSaving(true);
    try {
      // 서버 스코프 가드(QA_HIDE_REAL_USERS 기준 모집단 혼입 422)가 화면과 동일 축으로 판정.
      const res = await fetch("/api/admin/cluster4/competency/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization: org,
          target_user_id: selectedCrew.userId,
          // 선택한 개설 주차로 저장 — 미전달 시 서버가 개설 대상 주차로 fallback(조회/개설과 동일 주차).
          week_id: selectedWeekId ?? null,
          // line_master_id + line_code + line_name 함께 저장(자유 입력 아님).
          competency_line_master_id: master.id,
          line_code: master.lineCode,
          line_name: master.lineName,
          submission_link: addLink.trim() || null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw apiErrorFrom(res, json, "수동 추가에 실패했습니다");
      }
      toast("success", "승인 명단에 추가되었습니다");
      setAddOpen(false);
      setSelectedCrew(null);
      setQ("");
      await fetchData();
    } catch (err) {
      console.error("[competency] manual add failed", err);
      toast("error", getApiErrorMessage(err, "수동 추가에 실패했습니다"));
    } finally {
      setSaving(false);
    }
  }, [org, selectedCrew, masters, addMasterId, addLink, selectedWeekId, fetchData]);

  const patchApp = useCallback(
    async (id: string, patch: Record<string, unknown>) => {
      try {
        const res = await fetch(`/api/admin/cluster4/competency/applications/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) {
          throw apiErrorFrom(res, json, "변경에 실패했습니다");
        }
        await fetchData();
        return true;
      } catch (err) {
        console.error("[competency] application patch failed", err);
        toast("error", getApiErrorMessage(err, "변경에 실패했습니다"));
        return false;
      }
    },
    [fetchData],
  );

  // 수동 추가 항목 삭제(고객 신청은 X 버튼 자체가 없음 + 서버 source 게이트로 이중 차단).
  const submitDelete = useCallback(async (app: ApplicationDto) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/cluster4/competency/applications/${app.id}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw apiErrorFrom(res, json, "삭제에 실패했습니다");
      }
      toast("success", "수동 추가 항목이 삭제되었습니다");
      await fetchData();
    } catch (err) {
      console.error("[competency] application delete failed", err);
      toast("error", getApiErrorMessage(err, "삭제에 실패했습니다"));
    } finally {
      setSaving(false);
    }
  }, [fetchData]);

  // 수동 추가 삭제 확인(공통 adminDialog·danger) → 확인 시 submitDelete 실행.
  const requestDelete = useCallback(
    (app: ApplicationDto) =>
      adminDialog.confirm({
        variant: "danger",
        title: "수동 추가 삭제",
        confirmLabel: "삭제",
        description: (
          <div className="space-y-3">
            <p>아래 수동 추가 항목을 승인 명단에서 삭제하시겠습니까? (되돌릴 수 없음)</p>
            <dl className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">크루명</dt>
                <dd className="min-w-0 break-words font-medium">{app.crewLabel}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-muted-foreground">라인명</dt>
                <dd className="font-medium">{app.lineName}</dd>
              </div>
            </dl>
          </div>
        ),
        onConfirm: () => submitDelete(app),
      }),
    [submitDelete],
  );

  const submitReject = useCallback(async () => {
    if (!rejectApp) return;
    setSaving(true);
    const ok = await patchApp(rejectApp.id, { rejection_reason: rejectDraft.trim() || null });
    setSaving(false);
    if (ok) {
      toast("success", "반려 사유가 저장되었습니다");
      setRejectApp(null);
      setRejectDraft("");
    }
  }, [rejectApp, rejectDraft, patchApp]);

  return (
    <Card>
      <CardHeader className="pb-3">
        {/* 헤더: 제목 + 요약 + 수동 추가 (우측 같은 행, 좁으면 wrap) */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="inline-flex items-center gap-1.5 text-base">
              해당 크루
              <AdminHelpIconButton
                helpKey="admin.lineOpening.competency.title.applicants"
                title="해당 크루"
                size="xs"
              />
            </CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SummaryChip label="활동 크루" value={summary.activeCrews} helpKey="admin.lineOpening.competency.stat.activeCrews" />
            <SummaryChip label="신청 크루" value={summary.appliedCrews} tone="info" helpKey="admin.lineOpening.competency.stat.appliedCrews" />
            <SummaryChip label="개설 크루" value={summary.openedCrews} tone="success" helpKey="admin.lineOpening.competency.stat.openedCrews" />
            <SummaryChip label="반려 크루" value={summary.rejectedCrews} tone="error" helpKey="admin.lineOpening.competency.stat.rejectedCrews" />
            <SummaryChip label="신청 라인" value={summary.appliedLines} tone="info" helpKey="admin.lineOpening.competency.stat.appliedLines" />
            <SummaryChip label="개설 라인" value={summary.openedLines} tone="success" helpKey="admin.lineOpening.competency.stat.openedLines" />
            {/* 강화 결과(분모=활동 크루, 미신청 포함). 성공=개설 대상, 실패=활동−성공(반려+미신청). */}
            <span className="mx-1 h-8 w-px bg-border" aria-hidden />
            <SummaryChip label="강화 성공" value={summary.enhanceSuccess} tone="success" helpKey="admin.lineOpening.competency.stat.enhanceSuccess" />
            <SummaryChip label="강화 실패" value={summary.enhanceFail} tone="error" helpKey="admin.lineOpening.competency.stat.enhanceFail" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 수동 추가 — 자동완성 검색 + [추가] */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[260px] flex-1 space-y-1">
            <Label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              수동 추가 (크루 코드 + 이름 검색)
              <AdminHelpIconButton
                helpKey="admin.lineOpening.competency.filter.crewSearch"
                title="수동 추가 크루 검색"
                size="xs"
              />
            </Label>
            <div className="relative" ref={searchRef}>
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="크루 이름 검색..."
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setSelectedCrew(null);
                }}
                onFocus={() => visibleResults.length > 0 && setMenuOpen(true)}
                aria-label="수동 추가 크루 검색"
              />
              {menuOpen && (
                <div className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-md border bg-background py-1 shadow-md">
                  {searching ? (
                    <p className="flex items-center gap-1.5 px-3 py-2 text-sm text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> 검색 중…
                    </p>
                  ) : visibleResults.length === 0 ? (
                    <p className="px-3 py-2 text-sm text-muted-foreground">검색 결과가 없습니다</p>
                  ) : (
                    visibleResults.map((c) => (
                      <button
                        key={c.userId}
                        type="button"
                        onClick={() => pickCrew(c)}
                        className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
                      >
                        <span className="font-mono text-xs text-muted-foreground">
                          {c.crewCode ?? "-"}
                        </span>{" "}
                        <span className="font-medium">{c.name}</span>{" "}
                        <span className="text-xs text-muted-foreground">
                          {[c.teamName, c.schoolName].filter(Boolean).join(" · ")}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
          <Button type="button" onClick={openAddPopup} disabled={!selectedCrew || !org}>
            <Plus className="mr-1 h-4 w-4" /> 추가
          </Button>
          <AdminHelpIconButton
            helpKey="admin.lineOpening.competency.action.add"
            title="수동 추가"
            size="sm"
          />
        </div>

        {/* 승인 명단 테이블 */}
        {loading ? (
          <LoadingState active />
        ) : apps.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            신청 데이터가 없습니다. (크루 신청 또는 수동 추가 시 표시됩니다)
          </p>
        ) : (
          <div className="overflow-x-auto">
            {/* table-fixed + colgroup 로 컬럼 폭을 명시 배분 — 크루명은 좁히고 제출 링크는 넓혀
                URL 을 말줄임(...) 없이 2~3줄 줄바꿈으로 끝까지 노출한다(폭 %는 컨테이너 기준 반응형). */}
            <Table className="table-fixed">
              <colgroup>
                <col style={{ width: "17%" }} />{/* 크루명(축소) */}
                <col style={{ width: "15%" }} />{/* 라인명 */}
                <col style={{ width: "30%" }} />{/* 제출 링크(확대 — URL 줄바꿈 노출) */}
                <col style={{ width: "7%" }} />{/* 카페 */}
                <col style={{ width: "7%" }} />{/* 승인 */}
                <col style={{ width: "14%" }} />{/* 반려 사유 */}
                <col style={{ width: "10%" }} />{/* 삭제 */}
              </colgroup>
              <TableHeader>
                <TableRow>
                  {APP_COLUMNS.map((col) => (
                    <AppColumnHeader
                      key={col.key}
                      col={col}
                      dir={columnSort?.key === col.key ? columnSort.dir : null}
                      onSort={() => cycleSort(col.key)}
                    />
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedWeekGroups.map((g) => (
                  <Fragment key={g.weekId}>
                    {/* 주차 헤더 — "26년 여름 시즌 N주차" + 그 주차 크루 수. 아래에 해당 주차 크루만 표시. */}
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell
                        colSpan={7}
                        className="whitespace-nowrap py-2 text-sm font-semibold"
                      >
                        {weekHeaderLabel(g.meta)}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {g.apps.length}명
                        </span>
                      </TableCell>
                    </TableRow>
                    {g.apps.map((a) => (
                  <TableRow key={a.id} className={cn(checkedRowClass(a.approvalChecked))}>
                    {/* 크루명 — 좁아진 컬럼(colgroup 17%)에서 자연 줄바꿈 허용(전역 whitespace-nowrap 덮음). */}
                    <TableCell className="align-top whitespace-normal break-words font-medium">
                      <span className={cn(checkedTextClass(a.approvalChecked))}>{a.crewLabel}</span>
                      {a.source === "manual" && (
                        <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                          수동
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="align-top whitespace-normal break-words">
                      <div className="font-medium">{a.lineName}</div>
                      {a.lineCode && (
                        <div className="font-mono text-[10px] text-muted-foreground">{a.lineCode}</div>
                      )}
                    </TableCell>
                    {/* 제출 링크 — 넓은 컬럼(colgroup 30%). URL 은 truncate(...) 대신 줄바꿈(break-all,
                        whitespace-normal)해 말줄임 없이 끝까지 노출한다. 여러 줄이면 행 높이가 자연히 늘어난다.
                        colgroup 이 폭을 고정하므로 옆 [카페] 컬럼을 침범하지 않는다. */}
                    <TableCell className="align-top text-center whitespace-normal break-words">
                      {a.submissionLink ? (
                        <a
                          href={a.submissionLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-start justify-center gap-1 text-sky-700 underline underline-offset-2 hover:text-sky-900"
                        >
                          <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0 break-all text-center">{a.submissionLink}</span>
                        </a>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center">
                      <Checkbox
                        checked={a.cafeChecked}
                        onChange={(e) => patchApp(a.id, { cafe_checked: e.target.checked })}
                        aria-label={`${a.displayName} 카페 체크`}
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <Checkbox
                        checked={a.approvalChecked}
                        onChange={(e) => patchApp(a.id, { approval_checked: e.target.checked })}
                        aria-label={`${a.displayName} 승인 체크`}
                      />
                    </TableCell>
                    <TableCell>
                      {a.approvalChecked ? (
                        <span className="text-xs text-muted-foreground">-</span>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="border-red-300 text-red-700 hover:bg-red-50"
                          onClick={() => {
                            setRejectApp(a);
                            setRejectDraft(a.rejectionReason ?? "");
                          }}
                        >
                          반려 사유
                          {a.rejectionReason ? " ✓" : ""}
                        </Button>
                      )}
                    </TableCell>
                    <TableCell>
                      {/* X 삭제는 수동 추가(source='manual') 항목에만. 고객 신청(customer)은 버튼 미표시. */}
                      {a.source === "manual" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => void requestDelete(a)}
                          aria-label={`${a.displayName} 수동 추가 삭제`}
                          title="수동 추가 항목 삭제"
                        >
                          <X className="h-4 w-4 text-red-500" />
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                    ))}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* 수동 추가 팝업 */}
      {addOpen && selectedCrew && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !saving && setAddOpen(false)}
        >
          <div
            className="modal-w-md space-y-4 rounded-lg bg-background p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="inline-flex items-center gap-1 text-base font-bold">
              수동 추가
              <AdminHelpIconButton
                size="xs"
                helpKey="admin.lineOpening.competency.section.manualAdd"
                title="수동 추가"
              />
            </h3>
            <p className="text-sm text-muted-foreground">
              {selectedCrew.crewCode ?? "-"} -{" "}
              {selectedCrew.name}
              {selectedCrew.teamName ? ` - ${selectedCrew.teamName}` : ""}
            </p>
            <div className="space-y-1">
              <Label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                라인명 <span className="text-red-500">*</span>
                <AdminHelpIconButton
                  size="xs"
                  helpKey="admin.lineOpening.competency.field.manualLineName"
                  title="라인명"
                />
              </Label>
              {/* 자유 입력 금지 — 개설 가능한 competency master line 드롭다운에서만 선택(오타/미존재 방지). */}
              <select
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={addMasterId}
                onChange={(e) => setAddMasterId(e.target.value)}
                aria-label="수동 추가 라인명"
              >
                <option value="">라인을 선택하세요</option>
                {masters.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.lineName} ({m.lineCode})
                  </option>
                ))}
              </select>
              {masters.length === 0 && (
                <p className="text-xs text-amber-600">
                  선택 가능한 실무 역량 라인이 없습니다. (라인 등록 확인 필요)
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                제출 링크
                <AdminHelpIconButton
                  size="xs"
                  helpKey="admin.lineOpening.competency.field.manualSubmissionLink"
                  title="제출 링크"
                />
              </Label>
              <Input
                value={addLink}
                onChange={(e) => setAddLink(e.target.value)}
                placeholder="https://... (output link 2)"
                aria-label="수동 추가 제출 링크"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setAddOpen(false)} disabled={saving}>
                취소
              </Button>
              <Button onClick={submitAdd} loading={saving} disabled={saving}>
                확인
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 반려 사유 팝업 */}
      {rejectApp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !saving && setRejectApp(null)}
        >
          <div
            className="modal-w-md space-y-4 rounded-lg bg-background p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="inline-flex items-center gap-1 text-base font-bold">
              반려 사유
              <AdminHelpIconButton
                size="xs"
                helpKey="admin.lineOpening.competency.section.rejectReason"
                title="반려 사유"
              />
            </h3>
            <dl className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div className="flex gap-2">
                <dt className="inline-flex w-24 shrink-0 items-center gap-1 whitespace-nowrap text-muted-foreground">
                  크루명
                  <AdminHelpIconButton
                    size="xs"
                    helpKey="admin.lineOpening.competency.applicants.column.crew"
                    title="크루명"
                  />
                </dt>
                <dd className="min-w-0 break-words font-medium">{rejectApp.crewLabel}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="inline-flex w-24 shrink-0 items-center gap-1 whitespace-nowrap text-muted-foreground">
                  라인명
                  <AdminHelpIconButton
                    size="xs"
                    helpKey="admin.lineOpening.competency.applicants.column.line"
                    title="라인명"
                  />
                </dt>
                <dd className="font-medium">{rejectApp.lineName}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="inline-flex w-24 shrink-0 items-center gap-1 whitespace-nowrap text-muted-foreground">
                  제출 링크
                  <AdminHelpIconButton
                    size="xs"
                    helpKey="admin.lineOpening.competency.applicants.column.submissionLink"
                    title="제출 링크"
                  />
                </dt>
                <dd className="min-w-0 break-all">
                  {rejectApp.submissionLink ? (
                    <a
                      href={rejectApp.submissionLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sky-700 underline underline-offset-2"
                    >
                      {rejectApp.submissionLink}
                    </a>
                  ) : (
                    "-"
                  )}
                </dd>
              </div>
            </dl>
            <div className="space-y-1">
              <Label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                반려 사유
                <AdminHelpIconButton
                  size="xs"
                  helpKey="admin.lineOpening.competency.field.rejectReason"
                  title="반려 사유"
                />
              </Label>
              <textarea
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                rows={4}
                value={rejectDraft}
                onChange={(e) => setRejectDraft(e.target.value)}
                placeholder="반려 사유를 입력하세요"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setRejectApp(null)} disabled={saving}>
                취소
              </Button>
              <Button onClick={submitReject} loading={saving} disabled={saving}>
                확인
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 수동 추가 삭제 확인 팝업 */}
      {/* 수동 추가 삭제 확인은 공통 adminDialog(danger)로 대체됨(requestDelete). */}
    </Card>
  );
}
