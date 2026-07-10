"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, ArrowUpDown, RefreshCw, RotateCcw, Search } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableSkeletonRows } from "@/components/ui/table-skeleton";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { StatusBadge } from "@/components/ui/status-badge";
import { Badge } from "@/components/ui/badge";
import { classTone, rankTone } from "@/lib/statusBadge";
import { cn } from "@/lib/utils";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { buildCrewsTabs, buildMembersTabs } from "@/lib/adminHeaderTabs";
import {
  ORGANIZATION_LABEL,
  type OrganizationSlug,
} from "@/lib/organizations";
import { getProcessPointLabels, type ProcessPointKey } from "@/lib/pointLabels";
import { classLabel } from "@/lib/adminMembersTypes";
import {
  BUCKET_LABEL,
  statusBucket,
  type MemberStatusBucket,
} from "@/lib/memberStatusBucket";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import {
  resolveMembersInfoSection0,
  type MembersInfoSection0,
  type SeasonWeekInfoRow,
} from "@/lib/adminMembersInfoSection0";
import type {
  MembersInfoStatsDto,
  InfoWeekRow,
} from "@/lib/adminMembersInfoStats";

type Member = {
  userId: string;
  displayName: string | null;
  organizationSlug: string | null;
  role: string | null;
  membershipLevel: string | null;
  displayGrowthStatus: string | null;
  gender: string | null;
  birthDate: string | null;
  schoolName: string | null;
  departmentName: string | null;
  teamName: string | null;
  partName: string | null;
  rankGradeNumber: number | null;
  rankGradeLabel: string | null;
  successWeeks: number | null;
  growableWeeks: number | null;
  poA: number;
  poB: number;
  poC: number;
  scheduleReliability: number | null;
  activityCompletion: number | null;
};

// 로스터 전체 조회 중 일부 사용자의 성장 지표(snapshot)를 못 읽었을 때의 부분 실패 신호.
//   (lib/adminMembersData.RosterPartialFailure 와 동일 모양 — 화면 안내 전용)
type RosterPartialFailureClient = {
  growthUnavailable: number;
  failedChunks: number;
};

// 조직/모드별 로스터 캐시 1건 — 멤버 + 부분 실패 안내를 함께 보관(왕복 시 안내 유지).
type RosterCacheEntry = {
  members: Member[];
  partialFailure: RosterPartialFailureClient | null;
};

// ── 탭 ──────────────────────────────────────────────────────────────
type MemberTab = "list" | "info";

// ── 조건: 클럽 ──────────────────────────────────────────────────────
// "all"=전체 / 조직 slug / "none"=- (검색 시 중립). all·none 은 데이터상 동일(전체 조회).
type ClubValue = "all" | "encre" | "oranke" | "phalanx" | "none";
const CLUB_OPTIONS: { value: ClubValue; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "encre", label: "엥크레" },
  { value: "oranke", label: "오랑캐" },
  { value: "phalanx", label: "팔랑크스" },
  { value: "none", label: "-" },
];

const CLUB_LABEL_KO: Record<string, string> = {
  encre: "엥크레",
  oranke: "오랑캐",
  phalanx: "팔랑크스",
};
function clubLabelKo(slug: string | null): string {
  if (!slug) return "-";
  return CLUB_LABEL_KO[slug] ?? slug;
}

// ── 상태 버킷 — 표시 성장상태(GrowthStatusKey) → 상태 컬럼/필터 공용 버킷 ──
//   statusBucket/BUCKET_LABEL 은 lib/memberStatusBucket(단일 SoT, 크루 상세 페이지와 공유)에서 import.
type Bucket = MemberStatusBucket;

// ── 조건: 필터 ──────────────────────────────────────────────────────
type FilterValue =
  | "clubbing_expand"
  | "clubbing_reduce"
  | "elite"
  | "seasonal_rest"
  | "weekly_rest"
  | "suspended"
  | "onboarding"
  | "basanos"
  | "none";

const FILTER_OPTIONS: { value: FilterValue; label: string }[] = [
  { value: "clubbing_expand", label: "클러빙_확대" },
  { value: "clubbing_reduce", label: "클러빙_축소" },
  { value: "elite", label: "엘리트" },
  { value: "seasonal_rest", label: "시즌 휴식" },
  { value: "weekly_rest", label: "주차 휴식" },
  { value: "suspended", label: "활동 중단" },
  { value: "onboarding", label: "온보딩" },
  { value: "basanos", label: "바사노스" },
  { value: "none", label: "-" },
];

// 필터 → 허용 상태 버킷. null = 필터 없음(전체 통과).
//   클러빙_확대 = 활동 중 + 주차 휴식 + 시즌 휴식 + 온보딩 + 바사노스
//   클러빙_축소 = 확대 − 시즌 휴식 − 바사노스
const FILTER_BUCKETS: Record<FilterValue, Bucket[] | null> = {
  clubbing_expand: ["active", "weekly_rest", "seasonal_rest", "onboarding", "basanos"],
  clubbing_reduce: ["active", "weekly_rest", "onboarding"],
  elite: ["elite"],
  seasonal_rest: ["seasonal_rest"],
  weekly_rest: ["weekly_rest"],
  suspended: ["suspended"],
  onboarding: ["onboarding"],
  basanos: ["basanos"],
  none: null,
};

const DEFAULT_CLUB: ClubValue = "all";
const DEFAULT_FILTER: FilterValue = "clubbing_expand";

// 클래스 라벨(classLabel)은 lib/adminMembersTypes(단일 SoT, 크루 상세 페이지와 공유)에서 import.

// ── 표시 헬퍼 ───────────────────────────────────────────────────────
function fmtStr(value: string | null | undefined): string {
  return value && value.trim() ? value : "—";
}
function fmtNum(value: number | null | undefined): string {
  return value == null ? "—" : value.toLocaleString();
}
function fmtPct(value: number | null | undefined): string {
  return value == null ? "—" : `${value}%`;
}
function birthMs(value: string | null): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

// ── 컬럼 정의 ───────────────────────────────────────────────────────
type ColType = "string" | "number" | "date" | "rank";
type ColKey =
  | "name"
  | "club"
  | "status"
  | "class"
  | "gender"
  | "birth"
  | "school"
  | "major"
  | "team"
  | "part"
  | "rank"
  | "success"
  | "growable"
  | "poA"
  | "poB"
  | "poC"
  | "schedule"
  | "activity";

type Column = {
  key: ColKey;
  label: string;
  type: ColType;
  align?: "right";
  // 긴 텍스트 컬럼 너비 상한(max-width 클래스). 지정 시 한 줄 ellipsis + title hover.
  clamp?: string;
  // 컬럼 헤더 옆 인라인 도움말(돋보기). 지정한 컬럼에만 표시(의미가 모호한 지표 위주).
  help?: { helpKey: string; title?: string };
  text: (m: Member) => string; // 표시 + 검색
  num?: (m: Member) => number | null; // number/rank 정렬값
  date?: (m: Member) => number | null; // date 정렬값(ms)
};

const COLUMNS: Column[] = [
  { key: "name", label: "이름", type: "string", text: (m) => fmtStr(m.displayName) },
  { key: "club", label: "클럽명", type: "string", text: (m) => clubLabelKo(m.organizationSlug) },
  {
    key: "status",
    label: "상태",
    type: "string",
    help: { helpKey: "admin.members.column.status", title: "상태" },
    text: (m) => BUCKET_LABEL[statusBucket(m.displayGrowthStatus)],
  },
  {
    key: "class",
    label: "클래스",
    type: "string",
    help: { helpKey: "admin.members.column.class", title: "클래스" },
    text: (m) => classLabel(m.role, m.membershipLevel),
  },
  { key: "gender", label: "성별", type: "string", text: (m) => fmtStr(m.gender) },
  {
    key: "birth",
    label: "생년월일",
    type: "date",
    text: (m) => fmtStr(m.birthDate),
    date: (m) => birthMs(m.birthDate),
  },
  { key: "school", label: "학교", type: "string", clamp: "max-w-[160px]", text: (m) => fmtStr(m.schoolName) },
  { key: "major", label: "전공", type: "string", clamp: "max-w-[160px]", text: (m) => fmtStr(m.departmentName) },
  {
    key: "team",
    label: "팀",
    type: "string",
    clamp: "max-w-[120px]",
    help: { helpKey: "admin.members.column.team", title: "팀" },
    text: (m) => fmtStr(m.teamName),
  },
  {
    key: "part",
    label: "파트",
    type: "string",
    clamp: "max-w-[120px]",
    help: { helpKey: "admin.members.column.part", title: "파트" },
    text: (m) => fmtStr(m.partName),
  },
  {
    key: "rank",
    label: "품계",
    type: "rank",
    help: { helpKey: "admin.members.column.rank", title: "품계" },
    text: (m) => fmtStr(m.rankGradeLabel),
    // 정승=1(최상위) → 높은 순 = grade 오름차순. null 은 정렬 시 항상 뒤로.
    num: (m) => m.rankGradeNumber,
  },
  {
    key: "success",
    label: "성장 성공",
    type: "number",
    align: "right",
    help: { helpKey: "admin.members.column.success", title: "성장 성공" },
    text: (m) => fmtNum(m.successWeeks),
    num: (m) => m.successWeeks,
  },
  {
    key: "growable",
    label: "성장 가능",
    type: "number",
    align: "right",
    help: { helpKey: "admin.members.column.growable", title: "성장 가능" },
    text: (m) => fmtNum(m.growableWeeks),
    num: (m) => m.growableWeeks,
  },
  {
    key: "poA",
    label: "Po.A",
    type: "number",
    align: "right",
    help: { helpKey: "admin.members.column.poA", title: "Po.A" },
    text: (m) => fmtNum(m.poA),
    num: (m) => m.poA,
  },
  {
    key: "poB",
    label: "Po.B",
    type: "number",
    align: "right",
    help: { helpKey: "admin.members.column.poB", title: "Po.B" },
    text: (m) => fmtNum(m.poB),
    num: (m) => m.poB,
  },
  {
    key: "poC",
    label: "Po.C",
    type: "number",
    align: "right",
    help: { helpKey: "admin.members.column.poC", title: "Po.C" },
    text: (m) => fmtNum(m.poC),
    num: (m) => m.poC,
  },
  {
    key: "schedule",
    label: "일정 신뢰도",
    type: "number",
    align: "right",
    help: { helpKey: "admin.members.column.schedule", title: "일정 신뢰도" },
    text: (m) => fmtPct(m.scheduleReliability),
    num: (m) => m.scheduleReliability,
  },
  {
    key: "activity",
    label: "활동 완료율",
    type: "number",
    align: "right",
    help: { helpKey: "admin.members.column.activity", title: "활동 완료율" },
    text: (m) => fmtPct(m.activityCompletion),
    num: (m) => m.activityCompletion,
  },
];

const COLUMN_MAP: Record<ColKey, Column> = Object.fromEntries(
  COLUMNS.map((c) => [c.key, c]),
) as Record<ColKey, Column>;

// 컬럼 key → 프로세스 포인트 키(a/b/c). 헤더/도움말 라벨을 조직별로 치환할 때 사용.
const PO_COLUMN_KEY: Partial<Record<ColKey, ProcessPointKey>> = {
  poA: "a",
  poB: "b",
  poC: "c",
};

// 기본 정렬 방향 — 숫자=높은 순(desc), 그 외(글자·날짜·품계)=오름차순(asc).
//   날짜 asc=빠른 순 · 품계 asc=높은 순(정승 먼저) · 글자 asc=가나다순.
function defaultDir(type: ColType): "asc" | "desc" {
  return type === "number" ? "desc" : "asc";
}

type SortEntry = { key: ColKey; dir: "asc" | "desc" };

function compareCol(a: Member, b: Member, col: Column, dir: "asc" | "desc"): number {
  if (col.type === "number" || col.type === "rank") {
    const av = col.num!(a);
    const bv = col.num!(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // null 은 항상 뒤로
    if (bv == null) return -1;
    return dir === "asc" ? av - bv : bv - av;
  }
  if (col.type === "date") {
    const av = col.date!(a);
    const bv = col.date!(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return dir === "asc" ? av - bv : bv - av;
  }
  const av = col.text(a);
  const bv = col.text(b);
  const ae = av === "—" || av === "";
  const be = bv === "—" || bv === "";
  if (ae && be) return 0;
  if (ae) return 1;
  if (be) return -1;
  const c = av.localeCompare(bv, "ko");
  return dir === "asc" ? c : -c;
}

// 검색 대상 — 표 A 에 렌더되는 모든 표시값을 한 줄로 합쳐 부분검색.
function rowSearchText(m: Member): string {
  return COLUMNS.map((c) => c.text(m)).join(" ").toLowerCase();
}

function clubFetchOrg(club: ClubValue): string | null {
  if (club === "encre" || club === "oranke" || club === "phalanx") return club;
  return null; // all | none → 전체
}

// sessionStorage 영속 스냅샷 — 상세 페이지 왕복 시 조건/정렬 복원용.
type PersistedState = {
  pendingClub: ClubValue;
  pendingFilter: FilterValue;
  pendingSearch: string;
  appliedClub: ClubValue;
  appliedFilter: FilterValue;
  appliedSearch: string;
  lastEdited: "search" | "condition";
  sortStack: SortEntry[];
};

export default function MembersList({
  lockedOrg,
}: {
  // 조직 크루 화면(/admin/crews/{org})에서 org 를 고정한다. 지정 시:
  //   · "클럽" 드롭다운을 숨기고 목록/검색을 항상 이 org 로 스코프한다(실제 데이터 필터).
  //   · 두 번째 탭이 크루 정보(집계)가 아니라 크루 관리(CrewManager)가 된다.
  // 미지정(/admin/members)이면 기존 동작과 완전히 동일하다.
  lockedOrg?: OrganizationSlug;
} = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const mode = readScopeMode(searchParams);

  // 탭은 ?tab 으로 구동된다 — 본문은 URL 만 읽는다.
  //   · 멤버 모드: 크루 목록(list) / 크루 정보(info, ?tab=info)
  //   · 크루 모드(lockedOrg): 크루 목록(list) / 크루 관리(?tab=manage) — 두 번째 탭을 "info" 슬롯으로 재사용.
  const secondTabActive = lockedOrg
    ? searchParams?.get("tab") === "manage"
    : searchParams?.get("tab") === "info";
  const tab: MemberTab = secondTabActive ? "info" : "list";

  // 클럽 조건 기본값 — 크루 모드면 고정 org, 아니면 전체.
  const defaultClub: ClubValue = lockedOrg ?? DEFAULT_CLUB;

  // po.A/B/C 컬럼 표시명 — 조직 고정(크루 화면) 시 조직별 명칭, 통합(/admin/members)은 중립.
  //   통합 목록은 여러 조직의 크루가 섞여 헤더 조직을 특정할 수 없으므로 중립 유지.
  const poPointLabels = getProcessPointLabels(lockedOrg);

  // pending = 입력 중 · applied = 확인으로 적용된 값.
  const [pendingClub, setPendingClub] = useState<ClubValue>(defaultClub);
  const [pendingFilter, setPendingFilter] = useState<FilterValue>(DEFAULT_FILTER);
  const [pendingSearch, setPendingSearch] = useState("");
  const [appliedClub, setAppliedClub] = useState<ClubValue>(defaultClub);
  const [appliedFilter, setAppliedFilter] = useState<FilterValue>(DEFAULT_FILTER);
  const [appliedSearch, setAppliedSearch] = useState("");
  const lastEditedRef = useRef<"search" | "condition">("condition");

  const [roster, setRoster] = useState<Member[]>([]); // 서버 페이지(이미 필터/정렬/슬라이스됨)
  const [loading, setLoading] = useState(true);
  // 전역 로딩 배너에 보고(검색/필터/페이지/정렬/새로고침 = 서버 재조회).
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);
  // 일부 사용자의 성장 지표(snapshot)를 못 읽은 부분 실패 — 전체는 정상 표시하되 안내만.
  const [partialFailure, setPartialFailure] = useState<RosterPartialFailureClient | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  // 서버 페이지네이션 상태 — 모집단/필터결과 카운트 + 현재 페이지.
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0); // operationalSeasonKey 모집단(필터 전)
  const [filteredTotal, setFilteredTotal] = useState(0); // 검색/상태필터 후 결과 수
  const [statusCounts, setStatusCounts] = useState<{ active: number; rest: number; stopped: number }>(
    { active: 0, rest: 0, stopped: 0 },
  );

  // 정렬 스택 — 맨 앞이 1순위. 새 클릭이 항상 1순위가 되고 직전 조건은 후순위로 밀린다.
  const [sortStack, setSortStack] = useState<SortEntry[]>([]);

  // ── 조건/정렬 유지(상세 페이지 왕복) ──────────────────────────────────
  // [이동] → /admin/members/[userId] → [목록으로 돌아가기] 시 클럽/필터/검색/정렬을
  // sessionStorage 로 복원한다(모집단 모드별 분리 키). URL 마이그레이션 없이 "최대한 유지".
  const storageKey = `members-list-state:${lockedOrg ?? "all"}:${mode}`;
  const persistSkip = useRef(false);
  // sessionStorage 복원 완료 게이트 — 복원 전 기본값으로 한 번, 복원 후 또 한 번 조회되는
  // 왕복 시 이중 fetch 를 막는다(상세 페이지 → 목록 복귀). 복원값으로 1회만 조회.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const s = JSON.parse(raw) as Partial<PersistedState>;
        // 복원이 유발하는 첫 persist 1회 스킵 — 기본값이 저장값을 덮어쓰지 않게.
        persistSkip.current = true;
        // 마운트 시 1회 sessionStorage → state 동기화(상세 페이지 왕복 복원). 외부 저장소
        // 복원은 effect 가 정석이며 cascading 의도된 동작이라 규칙을 좁게 끈다.
        /* eslint-disable react-hooks/set-state-in-effect */
        // 크루 모드(lockedOrg)는 클럽이 org 로 고정 — 저장된 클럽값은 복원하지 않는다.
        if (!lockedOrg && s.pendingClub) setPendingClub(s.pendingClub);
        if (s.pendingFilter) setPendingFilter(s.pendingFilter);
        if (typeof s.pendingSearch === "string") setPendingSearch(s.pendingSearch);
        if (!lockedOrg && s.appliedClub) setAppliedClub(s.appliedClub);
        if (s.appliedFilter) setAppliedFilter(s.appliedFilter);
        if (typeof s.appliedSearch === "string") setAppliedSearch(s.appliedSearch);
        if (s.lastEdited) lastEditedRef.current = s.lastEdited;
        if (Array.isArray(s.sortStack)) setSortStack(s.sortStack);
        /* eslint-enable react-hooks/set-state-in-effect */
      }
    } catch {
      // 손상된 스냅샷은 무시(기본값 유지).
    } finally {
      // 복원 적용(또는 복원값 없음 확정) 후에야 fetch 를 연다 — 복원 전 기본값 조회 1회를 생략.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHydrated(true);
    }
  }, [storageKey, lockedOrg]);

  useEffect(() => {
    if (persistSkip.current) {
      persistSkip.current = false;
      return;
    }
    try {
      const snapshot: PersistedState = {
        pendingClub,
        pendingFilter,
        pendingSearch,
        appliedClub,
        appliedFilter,
        appliedSearch,
        lastEdited: lastEditedRef.current,
        sortStack,
      };
      sessionStorage.setItem(storageKey, JSON.stringify(snapshot));
    } catch {
      // 저장 실패(quota 등)는 무시.
    }
  }, [
    storageKey,
    pendingClub,
    pendingFilter,
    pendingSearch,
    appliedClub,
    appliedFilter,
    appliedSearch,
    sortStack,
  ]);

  const fetchOrg = clubFetchOrg(appliedClub);
  const sortParam = sortStack.map((s) => `${s.key}:${s.dir}`).join(",");

  // 서버 페이지네이션 — 필터/검색/정렬/페이지를 서버로 보내고 해당 페이지 행만 받는다.
  useEffect(() => {
    // sessionStorage 복원 전에는 조회하지 않는다(복원값으로 1회만 — 이중 fetch 방지).
    if (!hydrated) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      setPartialFailure(null);
      try {
        const params = new URLSearchParams();
        if (fetchOrg) params.set("organization", fetchOrg);
        params.set("page", String(page));
        params.set("pageSize", String(PAGE_SIZE));
        if (appliedFilter && appliedFilter !== "none") params.set("filter", appliedFilter);
        if (appliedSearch.trim()) params.set("search", appliedSearch.trim());
        if (sortParam) params.set("sort", sortParam);
        const url = appendModeQuery(`/api/admin/members/roster?${params}`, mode);
        const res = await fetch(url, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json?.error ?? "Failed to load roster.");
        if (cancelled) return;
        const d = json.data ?? {};
        setRoster((d.members ?? []) as Member[]);
        setPartialFailure((d.partialFailure ?? null) as RosterPartialFailureClient | null);
        setTotal(d.total ?? 0);
        setFilteredTotal(d.filteredTotal ?? 0);
        setStatusCounts({
          active: d.statusCounts?.active ?? 0,
          rest: d.statusCounts?.rest ?? 0,
          stopped: d.statusCounts?.stopped ?? 0,
        });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load roster.");
        setRoster([]);
        setPartialFailure(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [hydrated, fetchOrg, mode, appliedFilter, appliedSearch, sortParam, page, refreshTick]);

  // 서버가 필터/정렬/슬라이스를 끝낸 페이지 — 클라이언트는 그대로 렌더.
  const rows = roster;
  const totalPages = Math.max(1, Math.ceil(filteredTotal / PAGE_SIZE));

  const applyConditions = useCallback(() => {
    setPage(1); // 조건 변경 → 1페이지부터
    if (lastEditedRef.current === "search" && pendingSearch.trim() !== "") {
      // 검색은 클럽/필터와 중첩 안 함(중립화). 단 크루 모드는 org 스코프를 반드시 유지한다.
      const searchClub: ClubValue = lockedOrg ?? "none";
      setPendingClub(searchClub);
      setPendingFilter("none");
      setAppliedClub(searchClub);
      setAppliedFilter("none");
      setAppliedSearch(pendingSearch.trim());
    } else {
      setAppliedClub(lockedOrg ?? pendingClub);
      setAppliedFilter(pendingFilter);
      setAppliedSearch("");
      setPendingSearch("");
    }
  }, [pendingSearch, pendingClub, pendingFilter, lockedOrg]);

  const resetConditions = useCallback(() => {
    lastEditedRef.current = "condition";
    setPage(1);
    setPendingClub(defaultClub);
    setPendingFilter(DEFAULT_FILTER);
    setPendingSearch("");
    setAppliedClub(defaultClub);
    setAppliedFilter(DEFAULT_FILTER);
    setAppliedSearch("");
    setSortStack([]);
  }, [defaultClub]);

  const reload = () => {
    setRefreshTick((n) => n + 1);
  };

  // 헤더 클릭 — 3-state: 기본방향 → 반대방향 → 정렬 해제. 그 외 컬럼 클릭은 1순위로.
  const handleSort = useCallback((key: ColKey) => {
    const col = COLUMN_MAP[key];
    setPage(1); // 정렬 변경 → 1페이지부터
    setSortStack((prev) => {
      if (prev[0]?.key === key) {
        const cur = prev[0].dir;
        const d0 = defaultDir(col.type);
        if (cur === d0) {
          return [{ key, dir: d0 === "asc" ? "desc" : "asc" }, ...prev.slice(1)];
        }
        return prev.slice(1); // 두 번째 방향에서 한 번 더 → 해제
      }
      const rest = prev.filter((s) => s.key !== key);
      return [{ key, dir: defaultDir(col.type) }, ...rest];
    });
  }, []);

  return (
    // 목록 페이지는 전체 너비 사용(18컬럼 표 A 가로 스크롤 방지) — 상세 페이지(CrewDetail)의
    // max-w 와 분리. 좁은 max-w 를 강제하지 않는다(공통 wrapper 미공유).
    <div className="admin-section-stack-lg w-full px-4 py-6">
      <AdminPageHeader
        title={lockedOrg ? `${ORGANIZATION_LABEL[lockedOrg]} 크루` : "크루 관리"}
        tabs={
          lockedOrg
            ? buildCrewsTabs(pathname, searchParams, secondTabActive ? "manage" : "list")
            : buildMembersTabs(pathname, searchParams, tab)
        }
      />

      {tab === "info" ? (
        // 두 번째 탭 = 집계(크루 정보) 뷰. 크루 모드(lockedOrg)는 현재 org 로 스코프(클럽 탭·집계 모두).
        //   크루 편집(수정/저장/공개토글)은 크루 목록 탭 → 상세(회원 상세)에서 수행.
        <MembersInfoTab lockedOrg={lockedOrg} />
      ) : (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1 space-y-2">
              <CardTitle className="text-base">크루 목록</CardTitle>
              {/* 제목 아래 = 전체 현황(전체/활동/휴식/중단)만. 결과 값은 확인 버튼 옆(필터 결과). */}
              {/* 데스크톱(sm+): 좌측 가용 폭을 4등분(grid-cols-4)해 균등 배치. 좁은 폭: flex-wrap 로 자연 줄바꿈(셀 overflow·가로 스크롤 없음). */}
              <div className="flex flex-wrap gap-x-8 gap-y-3 text-base text-muted-foreground sm:grid sm:grid-cols-4">
                <span className="whitespace-nowrap">전체 <b className="text-foreground text-lg">{total.toLocaleString()}</b></span>
                <span className="whitespace-nowrap">활동 <b className="text-foreground text-lg">{statusCounts.active.toLocaleString()}</b></span>
                <span className="whitespace-nowrap">휴식 <b className="text-foreground text-lg">{statusCounts.rest.toLocaleString()}</b></span>
                <span className="whitespace-nowrap">중단 <b className="text-foreground text-lg">{statusCounts.stopped.toLocaleString()}</b></span>
              </div>
            </div>
            <Button variant="outline" onClick={reload} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              새로고침
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* 조건 영역 */}
            <div className="flex flex-wrap items-end gap-x-5 gap-y-3 rounded-lg border bg-muted/30 p-3">
              {/* 클럽 드롭다운 — 크루 모드(lockedOrg)는 org 가 고정이라 숨긴다. */}
              {!lockedOrg && (
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    클럽
                    <AdminHelpIconButton
                      helpKey="admin.members.filter.club"
                      title="클럽"
                      size="xs"
                    />
                  </span>
                  <select
                    value={pendingClub}
                    onChange={(e) => {
                      lastEditedRef.current = "condition";
                      setPendingClub(e.target.value as ClubValue);
                    }}
                    className="h-9 w-48 min-w-[180px] rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  >
                    {CLUB_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  필터
                  <AdminHelpIconButton
                    helpKey="admin.members.filter.growthFilter"
                    title="필터"
                    size="xs"
                  />
                </span>
                <select
                  value={pendingFilter}
                  onChange={(e) => {
                    lastEditedRef.current = "condition";
                    setPendingFilter(e.target.value as FilterValue);
                  }}
                  className="h-9 w-48 min-w-[180px] rounded-md border border-input bg-background px-3 text-sm text-foreground"
                >
                  {FILTER_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  검색
                  <AdminHelpIconButton
                    helpKey="admin.members.filter.search"
                    title="검색"
                    size="xs"
                  />
                </span>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={pendingSearch}
                    onChange={(e) => {
                      lastEditedRef.current = "search";
                      setPendingSearch(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") applyConditions();
                    }}
                    placeholder="이름·학교·전공 등 표 안의 모든 표시값 부분검색"
                    className="h-9 pl-9"
                  />
                </div>
              </label>

              {/* 우측 그룹: [확인] · 결과 값 n · [초기화] (전체 현황 집계는 카드 헤더로 이동) */}
              <div className="ml-auto flex items-center gap-4">
                <Button onClick={applyConditions} disabled={loading}>
                  확인
                </Button>

                <span className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
                  결과 값
                  <span className="rounded-full border border-foreground/20 bg-foreground/5 px-3 py-1 font-mono text-sm text-foreground">
                    {loading ? "…" : filteredTotal.toLocaleString()}
                  </span>
                </span>

                <Button variant="outline" onClick={resetConditions} disabled={loading}>
                  <RotateCcw className="h-4 w-4" />
                  초기화
                </Button>
              </div>
            </div>

            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            {!error && partialFailure && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                일부 정보를 불러오지 못했습니다 — {partialFailure.growthUnavailable.toLocaleString()}명의 성장
                성공/성장 가능/활동 완료율을 “-”로 표시합니다. 잠시 후 새로고침하면
                복구될 수 있습니다.
              </div>
            )}

            {/* 재요청 중(필터/검색/페이지 변경) — 기존 표를 유지하고 상단에 진행 표시.
                최초 로딩(데이터 없음)은 표 안 스켈레톤이 담당. (요구사항 3·4) */}
            {rows.length > 0 && (
              <LoadingState active={loading} variant="inline" className="px-1" />
            )}

            <div className="overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {COLUMNS.map((c, idx) => {
                      const priority = sortStack.findIndex((s) => s.key === c.key);
                      const entry = priority >= 0 ? sortStack[priority] : null;
                      // po.A/B/C 헤더는 조직 고정(lockedOrg) 시 조직별 명칭, 통합 시 중립.
                      const poKey = PO_COLUMN_KEY[c.key];
                      const label = poKey ? poPointLabels[poKey] : c.label;
                      const help =
                        poKey && c.help ? { ...c.help, title: poPointLabels[poKey] } : c.help;
                      return (
                        <SortableHeader
                          key={c.key}
                          label={label}
                          help={help}
                          dir={entry?.dir ?? null}
                          priority={priority >= 0 ? priority + 1 : null}
                          showPriority={sortStack.length > 1}
                          onSort={() => handleSort(c.key)}
                          className={
                            idx === 0 ? "sticky left-0 z-20 bg-card border-r" : undefined
                          }
                        />
                      );
                    })}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((m) => (
                    <TableRow key={m.userId}>
                      {COLUMNS.map((c, idx) => {
                        const val = c.text(m);
                        return (
                          <TableCell
                            key={c.key}
                            className={cn(
                              "whitespace-nowrap text-center align-middle",
                              c.align === "right" && "tabular-nums",
                              idx === 0 && "sticky left-0 z-10 bg-card border-r font-medium",
                            )}
                          >
                            {c.key === "name" ? (
                              // 이름 — 클릭 시 상세 페이지 진입([이동] 컬럼 대체). 현재 모집단 모드 유지.
                              <button
                                type="button"
                                onClick={() =>
                                  router.push(appendModeQuery(`/admin/members/${m.userId}`, mode))
                                }
                                className="cursor-pointer underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                              >
                                {val}
                              </button>
                            ) : c.key === "status" && val !== "-" ? (
                              // 상태 — 가장 눈에 띄는 solid 배지(같은 상태=같은 색).
                              <StatusBadge label={val} size="sm" />
                            ) : c.key === "rank" && val !== "—" ? (
                              // 품계 — 상태보다 덜 튀는 soft 배지(품계 밴드별 색·같은 값=같은 색).
                              <StatusBadge
                                label={val}
                                size="sm"
                                appearance="soft"
                                tone={rankTone(m.rankGradeNumber)}
                              />
                            ) : c.key === "class" ? (
                              // 클래스 — 가장 은은한 outline 배지(계층별 색·같은 값=같은 색).
                              <StatusBadge
                                label={val}
                                size="sm"
                                appearance="outline"
                                tone={classTone(val)}
                              />
                            ) : c.clamp ? (
                              <div className={cn("mx-auto truncate", c.clamp)} title={val}>
                                {val}
                              </div>
                            ) : (
                              val
                            )}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                  {!loading && rows.length === 0 && !error && (
                    <TableRow>
                      <TableCell
                        colSpan={COLUMNS.length}
                        className="py-10 text-center text-muted-foreground"
                      >
                        조회된 크루가 없습니다.
                      </TableCell>
                    </TableRow>
                  )}
                  {loading && rows.length === 0 && (
                    <TableSkeletonRows columns={COLUMNS.length} rows={8} />
                  )}
                </TableBody>
              </Table>
            </div>

            {/* 페이지네이션 — 서버 페이지(50/page). 검색/필터/정렬 결과 기준. */}
            {filteredTotal > 0 && (
              <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
                <span>
                  {((page - 1) * PAGE_SIZE + 1).toLocaleString()}–
                  {Math.min(page * PAGE_SIZE, filteredTotal).toLocaleString()} / {filteredTotal.toLocaleString()}
                </span>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" disabled={loading || page <= 1} onClick={() => setPage(1)}>처음</Button>
                  <Button variant="outline" size="sm" disabled={loading || page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>이전</Button>
                  <span className="px-2 font-mono text-foreground">{page} / {totalPages}</span>
                  <Button variant="outline" size="sm" disabled={loading || page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>다음</Button>
                  <Button variant="outline" size="sm" disabled={loading || page >= totalPages} onClick={() => setPage(totalPages)}>마지막</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── 크루 정보 탭 ────────────────────────────────────────────────────
// [섹션.0] 상단 현재 정보(오늘/시즌·주차/기간/공식 활동·휴식) + 4개 클럽 하위 탭.
//   섹션.0 = /api/admin/season-weeks(시즌·주차 SoT) 그대로 표기 — 프론트 임의 계산 없음.
//   클럽 탭 전환은 로컬 state 일 뿐 섹션.0 은 동일하게 유지된다(상단 고정).
//   snapshot·demoUserId 무관(현재 접속 시점 시즌/주차 정보 — 사용자별 데이터 아님).

type InfoClubTab = "all" | "encre" | "oranke" | "phalanx";
const INFO_CLUB_TABS: { value: InfoClubTab; label: string }[] = [
  { value: "all", label: "통합" },
  { value: "encre", label: "엥크레" },
  { value: "oranke", label: "오랑캐" },
  { value: "phalanx", label: "팔랑크스" },
];

function MembersInfoTab({
  // 조직 크루 화면(/admin/crews/{org})의 "크루 관리" 탭에서 org 를 고정한다. 지정 시:
  //   · 클럽 하위 탭을 현재 org 하나로 제한(다른 조직 클럽 미노출).
  //   · 집계(info-stats)를 항상 이 org 로 스코프(실제 데이터 필터).
  // 미지정(/admin/members 크루 정보 탭)이면 통합 포함 4개 탭 = 기존과 동일.
  lockedOrg,
}: {
  lockedOrg?: OrganizationSlug;
} = {}) {
  const searchParams = useSearchParams();
  const mode = readScopeMode(searchParams);
  const [section0, setSection0] = useState<MembersInfoSection0 | null>(null);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [clubTab, setClubTab] = useState<InfoClubTab>(lockedOrg ?? "all");

  // 클럽 하위 탭 — 크루 모드(lockedOrg)는 현재 org 하나만 노출한다.
  const clubTabs = lockedOrg
    ? INFO_CLUB_TABS.filter((t) => t.value === lockedOrg)
    : INFO_CLUB_TABS;
  // 크루 모드는 org 고정(탭 전환 불가) — 집계 스코프도 항상 lockedOrg.
  const activeOrg: InfoClubTab = lockedOrg ?? clubTab;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/admin/season-weeks", { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to load season weeks.");
        }
        if (cancelled) return;
        const rows = (json.data?.rows ?? []) as SeasonWeekInfoRow[];
        // 접속 로컬 시각 기준으로 섹션.0 표기값 계산(순수 함수 — 검증 스크립트와 동일 코드).
        setSection0(resolveMembersInfoSection0(rows, new Date()));
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load season weeks.");
        setSection0(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      {/* [섹션.0] 상단 현재 정보 — 단일 가로 배너(통합 관리자 상단 A영역과 동일 UX).
          클럽 탭 전환과 무관하게 고정. */}
      <Card data-testid="members-info-section0">
        <CardContent className="py-4">
          {error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : loading ? (
            <div className="py-2 text-sm text-muted-foreground">불러오는 중...</div>
          ) : section0 && section0.found ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
              <span className="text-foreground">오늘은,</span>
              {/* 날짜 + 시즌/주차 — 강조 배지 */}
              <Badge tone="info" appearance="solid" size="lg" className="tabular-nums">
                {section0.todayLabel}, {section0.seasonWeekName}
              </Badge>
              <span className="text-foreground">입니다.</span>
              {/* 주차 기간(월 ~ 일) — 중립 pill */}
              <span className="rounded-md border bg-muted/40 px-2.5 py-1 text-sm tabular-nums text-muted-foreground">
                {section0.periodRange}
              </span>
              {/* 공식 활동/휴식 — 별도 강조 배지 */}
              <span className="flex items-center gap-1">
                <Badge
                  tone={section0.weekStatus === "공식 휴식" ? "warning" : "success"}
                  appearance="solid"
                  size="lg"
                >
                  {section0.weekStatus}
                </Badge>
                <span className="text-foreground">주차</span>
              </span>
              <AdminHelpIconButton helpKey={`${INFO_HELP}.section.currentWeek`} title="현재 시즌·주차" />
            </div>
          ) : (
            <div className="py-2 text-sm text-muted-foreground">
              현재 시즌/주차 정보를 찾지 못했습니다.
            </div>
          )}
        </CardContent>
      </Card>

      {/* 클럽 하위 탭 (통합 / 엥크레 / 오랑캐 / 팔랑크스) — 탭 전환은 로컬 state(섹션.0 불변).
          크루 모드(lockedOrg)는 현재 org 하나만 노출(다른 조직 클럽 미노출). */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-sm font-semibold">
          <span>클럽</span>
          <AdminHelpIconButton helpKey={`${INFO_HELP}.filter.club`} title="클럽 선택" />
        </span>
        <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/30 p-1">
        {clubTabs.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setClubTab(t.value)}
            disabled={Boolean(lockedOrg)}
            className={cn(
              "rounded-md px-4 py-1.5 text-sm font-medium transition-colors",
              activeOrg === t.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
              lockedOrg && "cursor-default",
            )}
          >
            {t.label}
          </button>
        ))}
        </div>
      </div>

      {/* [섹션.1] 역대 누적 + 주차별 데이터 — 선택 클럽(크루 모드는 org 고정) 스코프. */}
      <InfoStatsPanel org={activeOrg} mode={mode} />
    </div>
  );
}

// ── [섹션.1] 집계 패널 — 역대 누적(1-A) + 주차별 데이터(1-B) ─────────────
//   데이터 = /api/admin/members/info-stats(백엔드 DTO 단일 SoT). 프론트 임의 계산 없음.
//   값 null = 미확정/placeholder → "-" 표시. 20주차/page 페이지네이션(최신 상단).

const WEEKS_PER_PAGE = 20;

// 1-B 컬럼 정의 — 라벨 + InfoWeekRow 셀 렌더(숫자/배지/Oldest). 표시 전용.
const fmtNumCell = (v: number | null): string => (v == null ? "-" : v.toLocaleString());
const fmtPctCell = (v: number | null): string => (v == null ? "-" : `${v}%`);

// 크루 정보 탭 도움말 help key prefix(org/mode 무관 공통 키).
const INFO_HELP = "admin.members.info";

// ── 주차별 데이터(1-B) 정렬 — 클라이언트 전량 정렬 ──────────────────────────
//   info-stats DTO 는 weeks[] 전량을 내려주고(최신 상단) 프론트가 20/page slice 한다
//   → 서버 페이지네이션이 아니므로 "전체 목록 정렬 후 슬라이스" 가 곧 전체 정렬(정답).
//   기본(sort=null)은 API 원본 순서(최신 상단)로 복귀. 원본 배열 mutate 금지(복사본 정렬).
type InfoSortDir = "asc" | "desc";
type InfoSort = { key: string; dir: InfoSortDir } | null;

// 클럽 상태 업무 순서(활동 → 휴식). enum 라벨 가나다순 금지.
const CLUB_STATUS_RANK: Record<InfoWeekRow["clubStatus"], number> = {
  "공식 활동": 0,
  "공식 휴식": 1,
};

type InfoCol = {
  key: string;
  label: string;
  helpKey: string;
  // number = 숫자/순위/시퀀스(빈값 null 최하단), text = 문자/복합(빈값 최하단·locale ko-KR).
  kind: "number" | "text";
  num?: (w: InfoWeekRow, seq: number) => number | null;
  str?: (w: InfoWeekRow) => string;
};

// 컬럼 정의(헤더 렌더·help key·정렬 필드 매핑 SoT). 셀 렌더는 InfoWeekTableRow 가 동일 순서로 담당.
//   po.A/B/C 는 조직별 탭에서만(showPoints) 우측 추가 — 정렬은 리더 포인트(숫자) 기준.
function buildInfoWeekColumns(
  showPoints: boolean,
  poLabels: { a: string; b: string; c: string },
): InfoCol[] {
  const oldestText = (w: InfoWeekRow): string =>
    w.oldest ? `${w.oldest.startWeekLabel ?? "-"}, ${w.oldest.name}(${w.oldest.clubLabel})` : "";
  const cols: InfoCol[] = [
    { key: "clubStatus", label: "클럽 상태", helpKey: `${INFO_HELP}.column.clubStatus`, kind: "number", num: (w) => CLUB_STATUS_RANK[w.clubStatus] },
    // 시즌 & 주차 = 연대순. weeks 는 최신 상단이므로 원본 인덱스로 recency seq 부여(desc=최신 먼저=기본).
    { key: "seasonWeek", label: "시즌 & 주차", helpKey: `${INFO_HELP}.column.seasonWeek`, kind: "number", num: (_w, seq) => seq },
    { key: "clubCount", label: "클럽 수", helpKey: `${INFO_HELP}.column.clubCount`, kind: "number", num: (w) => w.clubCount },
    { key: "clubbing", label: "클러빙", helpKey: `${INFO_HELP}.column.clubbing`, kind: "number", num: (w) => w.clubbing },
    { key: "seasonalRest", label: "시즌 휴식", helpKey: `${INFO_HELP}.column.seasonalRest`, kind: "number", num: (w) => w.seasonalRest },
    { key: "elite", label: "엘리트", helpKey: `${INFO_HELP}.column.elite`, kind: "number", num: (w) => w.elite },
    { key: "suspended", label: "활동 중단", helpKey: `${INFO_HELP}.column.suspended`, kind: "number", num: (w) => w.suspended },
    { key: "weeklyRest", label: "주차 휴식", helpKey: `${INFO_HELP}.column.weeklyRest`, kind: "number", num: (w) => w.weeklyRest },
    { key: "growthSuccess", label: "성장 성공(a)", helpKey: `${INFO_HELP}.column.growthSuccess`, kind: "number", num: (w) => w.growthSuccess },
    { key: "growthFail", label: "성장 실패(b)", helpKey: `${INFO_HELP}.column.growthFail`, kind: "number", num: (w) => w.growthFail },
    { key: "growthSuccessRate", label: "성장 성공율(c)", helpKey: `${INFO_HELP}.column.growthSuccessRate`, kind: "number", num: (w) => w.growthSuccessRate },
    { key: "weeklyGrowthRate", label: "주차 성장률(d)", helpKey: `${INFO_HELP}.column.weeklyGrowthRate`, kind: "number", num: (w) => w.weeklyGrowthRate },
    { key: "oldest", label: "Oldest", helpKey: `${INFO_HELP}.column.oldest`, kind: "text", str: oldestText },
  ];
  if (showPoints) {
    cols.push(
      { key: "poA", label: poLabels.a, helpKey: `${INFO_HELP}.column.poA`, kind: "number", num: (w) => w.weeklyPointLeaders?.poA?.points ?? null },
      { key: "poB", label: poLabels.b, helpKey: `${INFO_HELP}.column.poB`, kind: "number", num: (w) => w.weeklyPointLeaders?.poB?.points ?? null },
      { key: "poC", label: poLabels.c, helpKey: `${INFO_HELP}.column.poC`, kind: "number", num: (w) => w.weeklyPointLeaders?.poC?.points ?? null },
    );
  }
  return cols;
}

function compareInfoWeek(a: InfoWeekRow, seqA: number, b: InfoWeekRow, seqB: number, col: InfoCol, dir: InfoSortDir): number {
  if (col.kind === "number") {
    const av = col.num!(a, seqA);
    const bv = col.num!(b, seqB);
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // 빈값은 방향 무관 항상 최하단
    if (bv == null) return -1;
    return dir === "asc" ? av - bv : bv - av;
  }
  const av = (col.str?.(a) ?? "").trim();
  const bv = (col.str?.(b) ?? "").trim();
  const ae = av === "" || av === "-" || av === "—";
  const be = bv === "" || bv === "-" || bv === "—";
  if (ae && be) return 0;
  if (ae) return 1;
  if (be) return -1;
  const c = av.localeCompare(bv, "ko-KR", { numeric: true, sensitivity: "base" });
  return dir === "asc" ? c : -c;
}

function InfoStatsPanel({ org, mode }: { org: InfoClubTab; mode: "operating" | "test" }) {
  const [data, setData] = useState<MembersInfoStatsDto | null>(null);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  // 주차별 데이터 3단계 정렬(오름 → 내림 → 기본). 기본=API 원본 순서(최신 상단).
  const [sort, setSort] = useState<InfoSort>(null);
  // (org, mode)별 결과 캐시 — 탭 왕복 시 재조회 방지.
  const cache = useRef<Map<string, MembersInfoStatsDto>>(new Map());
  const cacheKey = `${mode}:${org}`;

  useEffect(() => {
    let cancelled = false;
    // 클럽 탭/모드 전환 시 정렬도 기본으로 초기화(새 데이터셋). 외부(org/mode) 동기화 effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSort(null);
    const cached = cache.current.get(cacheKey);
    if (cached) {
      setData(cached);
      setPage(0); // 탭/모드 변경 시 첫 페이지로.
      setLoading(false);
      setError(null);
      return;
    }
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams();
        if (org !== "all") qs.set("organization", org);
        const url = appendModeQuery(
          `/api/admin/members/info-stats${qs.toString() ? `?${qs}` : ""}`,
          mode,
        );
        const res = await fetch(url, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to load info stats.");
        }
        if (cancelled) return;
        const dto = json.data as MembersInfoStatsDto;
        cache.current.set(cacheKey, dto);
        setData(dto);
        setPage(0); // 새 데이터 로드 시 첫 페이지로.
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load info stats.");
        setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [cacheKey, org, mode]);

  const weeks = useMemo(() => data?.weeks ?? [], [data]);
  // Po.A/B/C 는 조직별 탭(엥크레/오랑캐/팔랑크스)에서만 노출 — 통합 탭은 미표시.
  const showPoints = org !== "all";
  // 노출 시 org 는 항상 특정 조직 → 조직별 명칭으로 헤더 표기.
  const poPointLabels = useMemo(() => getProcessPointLabels(org === "all" ? null : org), [org]);

  // 컬럼 정의(헤더/help/정렬 SoT).
  const columns = useMemo(
    () => buildInfoWeekColumns(showPoints, poPointLabels),
    [showPoints, poPointLabels],
  );
  // 전체 목록 정렬(복사본) → 슬라이스. seq = 최신 상단 원본 인덱스 기반 recency(높을수록 최신).
  const sortedWeeks = useMemo(() => {
    if (!sort) return weeks;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return weeks;
    const seqOf = new Map(weeks.map((w, i) => [w.weekId, weeks.length - i]));
    return [...weeks].sort((a, b) =>
      compareInfoWeek(a, seqOf.get(a.weekId) ?? 0, b, seqOf.get(b.weekId) ?? 0, col, sort.dir),
    );
  }, [weeks, sort, columns]);

  const totalPages = Math.max(1, Math.ceil(sortedWeeks.length / WEEKS_PER_PAGE));
  const pageRows = sortedWeeks.slice(page * WEEKS_PER_PAGE, page * WEEKS_PER_PAGE + WEEKS_PER_PAGE);

  // 3단계 정렬 순환(오름 → 내림 → 기본). 정렬 변경 시 1페이지로.
  const cycleSort = (key: string) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
    setPage(0);
  };

  return (
    <div className="flex flex-col gap-6">
      {/* [섹션.1-A] 역대 누적 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="inline-flex items-center gap-1.5 text-base">
            역대 누적
            <AdminHelpIconButton helpKey={`${INFO_HELP}.section.cumulative`} title="역대 누적" size="sm" />
          </CardTitle>
          <CardDescription>클럽 등록 이력 전체 기준 누적 지표 (역대)</CardDescription>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : loading || !data ? (
            <div className="py-2 text-sm text-muted-foreground">불러오는 중...</div>
          ) : (
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              <CumulativeStat label="데이터 시작" value={data.cumulative.dataStartWeekLabel} helpKey={`${INFO_HELP}.summary.dataStart`} />
              {org === "all" && (
                <CumulativeStat label="클럽 수" value={data.cumulative.clubCount} helpKey={`${INFO_HELP}.summary.clubCount`} />
              )}
              <CumulativeStat label="누적 클러빙" value={data.cumulative.cumulativeClubbing} helpKey={`${INFO_HELP}.summary.cumulativeClubbing`} />
              <CumulativeStat label="누적 엘리트" value={data.cumulative.cumulativeElite} helpKey={`${INFO_HELP}.summary.cumulativeElite`} />
              <CumulativeStat label="누적 활동 중단" value={data.cumulative.cumulativeSuspended} helpKey={`${INFO_HELP}.summary.cumulativeSuspended`} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* [섹션.1-B] 주차별 데이터 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
          <div className="space-y-1.5">
            <CardTitle className="inline-flex items-center gap-1.5 text-base">
              주차별 데이터
              <AdminHelpIconButton helpKey={`${INFO_HELP}.section.weekly`} title="주차별 데이터" size="sm" />
            </CardTitle>
            <CardDescription>
              최신 주차 상단 · 페이지당 {WEEKS_PER_PAGE}주차. 미확정(현재/미검수) 주차는 “-”.
            </CardDescription>
          </div>
          {data && data.partialFailure && (
            <span className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-1 text-xs text-amber-800">
              일부 크루({data.partialFailure.snapshotUnavailable.toLocaleString()}) 스냅샷 미조회 — 집계 누락 가능
              <AdminHelpIconButton helpKey={`${INFO_HELP}.status.partialFailure`} title="스냅샷 미조회 안내" />
            </span>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : loading || !data ? (
            <div className="py-10 text-center text-sm text-muted-foreground">불러오는 중...</div>
          ) : (
            <>
              <div className="overflow-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {columns.map((col) => (
                        <SortableHeader
                          key={col.key}
                          label={col.label}
                          help={{ helpKey: col.helpKey, title: col.label }}
                          dir={sort?.key === col.key ? sort.dir : null}
                          priority={null}
                          showPriority={false}
                          onSort={() => cycleSort(col.key)}
                          className="whitespace-nowrap"
                        />
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((w) => (
                      <InfoWeekTableRow key={w.weekId} w={w} showPoints={showPoints} />
                    ))}
                    {pageRows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={showPoints ? 16 : 13} className="py-10 text-center text-muted-foreground">
                          표시할 주차가 없습니다.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* 페이지네이션 — 20주차/page */}
              <div className="flex items-center justify-end gap-3 text-sm">
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <span>
                    {weeks.length.toLocaleString()}주차 · {page + 1} / {totalPages}
                  </span>
                  <AdminHelpIconButton helpKey={`${INFO_HELP}.action.pagination`} title="페이지 이동 · 주차 수" />
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page <= 0}
                >
                  이전
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                >
                  다음
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// 누적 지표 칸 — 숫자(2xl tabular)·문자(데이터 시작 주차명, lg)·null("-") 모두 지원.
function CumulativeStat({ label, value, helpKey }: { label: string; value: string | number | null; helpKey?: string }) {
  const isNum = typeof value === "number";
  const display = value == null ? "-" : isNum ? value.toLocaleString() : value;
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <span>{label}</span>
        {helpKey ? <AdminHelpIconButton helpKey={helpKey} title={label} /> : null}
      </span>
      <span
        className={cn(
          "font-semibold text-foreground",
          isNum ? "text-2xl tabular-nums" : "whitespace-nowrap text-lg",
        )}
      >
        {display}
      </span>
    </div>
  );
}

// Po.A/B/C 셀 — 종류별 1위 크루 "이름 님 (N개)". 없으면 "-".
function fmtPointLeader(c: { name: string; points: number } | null | undefined): string {
  return c ? `${c.name} 님 (${c.points.toLocaleString()}개)` : "-";
}

function InfoWeekTableRow({ w, showPoints }: { w: InfoWeekRow; showPoints: boolean }) {
  const oldest = w.oldest
    ? `${w.oldest.startWeekLabel ?? "-"}, ${w.oldest.name}(${w.oldest.clubLabel})`
    : "-";
  const pl = w.weeklyPointLeaders;
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-center align-middle">
        <StatusBadge
          label={w.clubStatus}
          size="sm"
          appearance="soft"
          tone={w.clubStatus === "공식 휴식" ? "warning" : "success"}
        />
      </TableCell>
      <TableCell className="whitespace-nowrap text-center align-middle font-medium">
        {w.seasonWeekName}
      </TableCell>
      <TableCell className="text-center align-middle tabular-nums">{fmtNumCell(w.clubCount)}</TableCell>
      <TableCell className="text-center align-middle tabular-nums">{fmtNumCell(w.clubbing)}</TableCell>
      <TableCell className="text-center align-middle tabular-nums">{fmtNumCell(w.seasonalRest)}</TableCell>
      <TableCell className="text-center align-middle tabular-nums">{fmtNumCell(w.elite)}</TableCell>
      <TableCell className="text-center align-middle tabular-nums">{fmtNumCell(w.suspended)}</TableCell>
      <TableCell className="text-center align-middle tabular-nums">{fmtNumCell(w.weeklyRest)}</TableCell>
      <TableCell className="text-center align-middle tabular-nums">{fmtNumCell(w.growthSuccess)}</TableCell>
      <TableCell className="text-center align-middle tabular-nums">{fmtNumCell(w.growthFail)}</TableCell>
      <TableCell className="text-center align-middle tabular-nums">{fmtPctCell(w.growthSuccessRate)}</TableCell>
      <TableCell className="text-center align-middle tabular-nums">{fmtPctCell(w.weeklyGrowthRate)}</TableCell>
      <TableCell className="whitespace-nowrap text-center align-middle">{oldest}</TableCell>
      {showPoints && (
        <>
          <TableCell className="whitespace-nowrap text-center align-middle">{fmtPointLeader(pl?.poA)}</TableCell>
          <TableCell className="whitespace-nowrap text-center align-middle">{fmtPointLeader(pl?.poB)}</TableCell>
          <TableCell className="whitespace-nowrap text-center align-middle">{fmtPointLeader(pl?.poC)}</TableCell>
        </>
      )}
    </TableRow>
  );
}

function SortableHeader({
  label,
  help,
  dir,
  priority,
  showPriority,
  onSort,
  className,
}: {
  label: string;
  help?: { helpKey: string; title?: string };
  dir: "asc" | "desc" | null;
  priority: number | null;
  showPriority: boolean;
  onSort: () => void;
  className?: string;
}) {
  const active = dir != null;
  return (
    <TableHead
      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
      className={cn("text-center align-middle", className)}
    >
      {/* 정렬 트리거(button) 와 도움말(button) 은 형제로 둔다 — 버튼 중첩(무효 HTML) 방지. */}
      <span className="inline-flex w-full items-center justify-center gap-1">
        <button
          type="button"
          onClick={onSort}
          aria-label={`${label} 기준 정렬`}
          className={cn(
            "inline-flex cursor-pointer items-center justify-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground",
            active && "text-foreground",
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
          {active && showPriority && priority != null && (
            <span className="rounded-full bg-foreground/10 px-1 text-[9px] font-semibold text-foreground">
              {priority}
            </span>
          )}
        </button>
        {help && (
          <AdminHelpIconButton
            helpKey={help.helpKey}
            title={help.title}
            size="xs"
          />
        )}
      </span>
    </TableHead>
  );
}
