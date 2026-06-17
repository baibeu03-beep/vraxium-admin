"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import { cn } from "@/lib/utils";
import { classLabel } from "@/lib/adminMembersTypes";
import {
  BUCKET_LABEL,
  statusBucket,
  type MemberStatusBucket,
} from "@/lib/memberStatusBucket";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";

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
    text: (m) => BUCKET_LABEL[statusBucket(m.displayGrowthStatus)],
  },
  { key: "class", label: "클래스", type: "string", text: (m) => classLabel(m.role, m.membershipLevel) },
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
  { key: "team", label: "팀", type: "string", clamp: "max-w-[120px]", text: (m) => fmtStr(m.teamName) },
  { key: "part", label: "파트", type: "string", clamp: "max-w-[120px]", text: (m) => fmtStr(m.partName) },
  {
    key: "rank",
    label: "품계",
    type: "rank",
    text: (m) => fmtStr(m.rankGradeLabel),
    // 정승=1(최상위) → 높은 순 = grade 오름차순. null 은 정렬 시 항상 뒤로.
    num: (m) => m.rankGradeNumber,
  },
  {
    key: "success",
    label: "성장 성공",
    type: "number",
    align: "right",
    text: (m) => fmtNum(m.successWeeks),
    num: (m) => m.successWeeks,
  },
  {
    key: "growable",
    label: "성장 가능",
    type: "number",
    align: "right",
    text: (m) => fmtNum(m.growableWeeks),
    num: (m) => m.growableWeeks,
  },
  { key: "poA", label: "Po.A", type: "number", align: "right", text: (m) => fmtNum(m.poA), num: (m) => m.poA },
  { key: "poB", label: "Po.B", type: "number", align: "right", text: (m) => fmtNum(m.poB), num: (m) => m.poB },
  { key: "poC", label: "Po.C", type: "number", align: "right", text: (m) => fmtNum(m.poC), num: (m) => m.poC },
  {
    key: "schedule",
    label: "일정 신뢰도",
    type: "number",
    align: "right",
    text: (m) => fmtPct(m.scheduleReliability),
    num: (m) => m.scheduleReliability,
  },
  {
    key: "activity",
    label: "활동 완료율",
    type: "number",
    align: "right",
    text: (m) => fmtPct(m.activityCompletion),
    num: (m) => m.activityCompletion,
  },
];

const COLUMN_MAP: Record<ColKey, Column> = Object.fromEntries(
  COLUMNS.map((c) => [c.key, c]),
) as Record<ColKey, Column>;

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

export default function MembersList() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const mode = readScopeMode(searchParams);

  // 탭은 글로벌 헤더(Header.tsx)의 ?tab 으로 구동된다 — 본문은 URL 만 읽는다.
  const tab: MemberTab = searchParams?.get("tab") === "info" ? "info" : "list";

  // pending = 입력 중 · applied = 확인으로 적용된 값.
  const [pendingClub, setPendingClub] = useState<ClubValue>(DEFAULT_CLUB);
  const [pendingFilter, setPendingFilter] = useState<FilterValue>(DEFAULT_FILTER);
  const [pendingSearch, setPendingSearch] = useState("");
  const [appliedClub, setAppliedClub] = useState<ClubValue>(DEFAULT_CLUB);
  const [appliedFilter, setAppliedFilter] = useState<FilterValue>(DEFAULT_FILTER);
  const [appliedSearch, setAppliedSearch] = useState("");
  const lastEditedRef = useRef<"search" | "condition">("condition");

  const [roster, setRoster] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 일부 사용자의 성장 지표(snapshot)를 못 읽은 부분 실패 — 전체는 정상 표시하되 안내만.
  const [partialFailure, setPartialFailure] = useState<RosterPartialFailureClient | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const rosterCache = useRef<Map<string, RosterCacheEntry>>(new Map());

  // 정렬 스택 — 맨 앞이 1순위. 새 클릭이 항상 1순위가 되고 직전 조건은 후순위로 밀린다.
  const [sortStack, setSortStack] = useState<SortEntry[]>([]);

  // ── 조건/정렬 유지(상세 페이지 왕복) ──────────────────────────────────
  // [이동] → /admin/members/[userId] → [목록으로 돌아가기] 시 클럽/필터/검색/정렬을
  // sessionStorage 로 복원한다(모집단 모드별 분리 키). URL 마이그레이션 없이 "최대한 유지".
  const storageKey = `members-list-state:${mode}`;
  const persistSkip = useRef(false);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return;
      const s = JSON.parse(raw) as Partial<PersistedState>;
      // 복원이 유발하는 첫 persist 1회 스킵 — 기본값이 저장값을 덮어쓰지 않게.
      persistSkip.current = true;
      // 마운트 시 1회 sessionStorage → state 동기화(상세 페이지 왕복 복원). 외부 저장소
      // 복원은 effect 가 정석이며 cascading 의도된 동작이라 규칙을 좁게 끈다.
      /* eslint-disable react-hooks/set-state-in-effect */
      if (s.pendingClub) setPendingClub(s.pendingClub);
      if (s.pendingFilter) setPendingFilter(s.pendingFilter);
      if (typeof s.pendingSearch === "string") setPendingSearch(s.pendingSearch);
      if (s.appliedClub) setAppliedClub(s.appliedClub);
      if (s.appliedFilter) setAppliedFilter(s.appliedFilter);
      if (typeof s.appliedSearch === "string") setAppliedSearch(s.appliedSearch);
      if (s.lastEdited) lastEditedRef.current = s.lastEdited;
      if (Array.isArray(s.sortStack)) setSortStack(s.sortStack);
      /* eslint-enable react-hooks/set-state-in-effect */
    } catch {
      // 손상된 스냅샷은 무시(기본값 유지).
    }
  }, [storageKey]);

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
  const cacheKey = `${mode}:${fetchOrg ?? "__ALL__"}`;

  useEffect(() => {
    let cancelled = false;
    const cached = rosterCache.current.get(cacheKey);
    if (cached) {
      setRoster(cached.members);
      setPartialFailure(cached.partialFailure);
      setLoading(false);
      setError(null);
      return;
    }
    const load = async () => {
      setLoading(true);
      setError(null);
      setPartialFailure(null);
      try {
        const params = new URLSearchParams();
        if (fetchOrg) params.set("organization", fetchOrg);
        const url = appendModeQuery(
          `/api/admin/members/roster${params.toString() ? `?${params}` : ""}`,
          mode,
        );
        const res = await fetch(url, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to load roster.");
        }
        if (cancelled) return;
        const members = (json.data?.members ?? []) as Member[];
        const partial = (json.data?.partialFailure ?? null) as RosterPartialFailureClient | null;
        rosterCache.current.set(cacheKey, { members, partialFailure: partial });
        setRoster(members);
        setPartialFailure(partial);
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
  }, [cacheKey, fetchOrg, mode, refreshTick]);

  // 표 A 행 — 필터(상태 버킷) + 검색(표시값 부분검색) + 다중 정렬.
  const rows = useMemo(() => {
    const buckets = FILTER_BUCKETS[appliedFilter];
    const q = appliedSearch.trim().toLowerCase();
    let out = roster.filter((m) => {
      if (buckets && !buckets.includes(statusBucket(m.displayGrowthStatus))) return false;
      if (q && !rowSearchText(m).includes(q)) return false;
      return true;
    });
    if (sortStack.length > 0) {
      out = [...out].sort((a, b) => {
        for (const s of sortStack) {
          const c = compareCol(a, b, COLUMN_MAP[s.key], s.dir);
          if (c !== 0) return c;
        }
        return a.userId.localeCompare(b.userId);
      });
    }
    return out;
  }, [roster, appliedFilter, appliedSearch, sortStack]);

  const applyConditions = useCallback(() => {
    if (lastEditedRef.current === "search" && pendingSearch.trim() !== "") {
      setPendingClub("none");
      setPendingFilter("none");
      setAppliedClub("none");
      setAppliedFilter("none");
      setAppliedSearch(pendingSearch.trim());
    } else {
      setAppliedClub(pendingClub);
      setAppliedFilter(pendingFilter);
      setAppliedSearch("");
      setPendingSearch("");
    }
  }, [pendingSearch, pendingClub, pendingFilter]);

  const resetConditions = useCallback(() => {
    lastEditedRef.current = "condition";
    setPendingClub(DEFAULT_CLUB);
    setPendingFilter(DEFAULT_FILTER);
    setPendingSearch("");
    setAppliedClub(DEFAULT_CLUB);
    setAppliedFilter(DEFAULT_FILTER);
    setAppliedSearch("");
  }, []);

  const reload = () => {
    rosterCache.current.delete(cacheKey);
    setRefreshTick((n) => n + 1);
  };

  // 헤더 클릭 — 3-state: 기본방향 → 반대방향 → 정렬 해제. 그 외 컬럼 클릭은 1순위로.
  const handleSort = useCallback((key: ColKey) => {
    const col = COLUMN_MAP[key];
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
    <div className="flex w-full flex-col gap-6 px-4 py-6">
      {tab === "info" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">크루 정보</CardTitle>
            <CardDescription>준비 중입니다.</CardDescription>
          </CardHeader>
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            준비 중입니다.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2">
            <div className="space-y-1.5">
              <CardTitle className="text-base">크루 목록</CardTitle>
              <CardDescription>
                클럽·필터를 고른 뒤 <b>확인</b>을 눌러야 목록에 반영됩니다. 검색은
                클럽/필터와 중첩되지 않습니다. 헤더 클릭으로 다중 정렬(클릭 순서 = 우선순위).
              </CardDescription>
            </div>
            <Button variant="outline" onClick={reload} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              새로고침
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {/* 조건 영역 */}
            <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/30 p-3">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                클럽
                <select
                  value={pendingClub}
                  onChange={(e) => {
                    lastEditedRef.current = "condition";
                    setPendingClub(e.target.value as ClubValue);
                  }}
                  className="h-9 w-36 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                >
                  {CLUB_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                필터
                <select
                  value={pendingFilter}
                  onChange={(e) => {
                    lastEditedRef.current = "condition";
                    setPendingFilter(e.target.value as FilterValue);
                  }}
                  className="h-9 w-36 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                >
                  {FILTER_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                검색
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

              {/* 우측 그룹: [확인] · 결과 값 n · [초기화] */}
              <div className="ml-auto flex items-center gap-4">
                <Button onClick={applyConditions} disabled={loading}>
                  확인
                </Button>

                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  결과 값
                  <span className="rounded-full border border-foreground/20 bg-foreground/5 px-3 py-1 font-mono text-sm text-foreground">
                    {loading ? "…" : rows.length.toLocaleString()}
                  </span>
                </div>

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
                일부 snapshot 조회 실패 — {partialFailure.growthUnavailable.toLocaleString()}명의 성장
                성공/성장 가능/활동 완료율을 불러오지 못해 “-”로 표시합니다. 잠시 후 새로고침하면
                복구될 수 있습니다.
              </div>
            )}

            <div className="overflow-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {COLUMNS.map((c, idx) => {
                      const priority = sortStack.findIndex((s) => s.key === c.key);
                      const entry = priority >= 0 ? sortStack[priority] : null;
                      return (
                        <SortableHeader
                          key={c.key}
                          label={c.label}
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
                    {/* 이동 — 정렬/검색 비대상. 행별 상세 페이지 진입 버튼 컬럼. */}
                    <TableHead className="text-center align-middle text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      이동
                    </TableHead>
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
                            {c.clamp ? (
                              <div className={cn("mx-auto truncate", c.clamp)} title={val}>
                                {val}
                              </div>
                            ) : (
                              val
                            )}
                          </TableCell>
                        );
                      })}
                      {/* 행 우측 [이동] — 행 전체 클릭 아님(버튼만). 현재 모집단 모드 유지. */}
                      <TableCell className="whitespace-nowrap text-center align-middle">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            router.push(appendModeQuery(`/admin/members/${m.userId}`, mode))
                          }
                        >
                          이동
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!loading && rows.length === 0 && !error && (
                    <TableRow>
                      <TableCell
                        colSpan={COLUMNS.length + 1}
                        className="py-10 text-center text-muted-foreground"
                      >
                        조회된 크루가 없습니다.
                      </TableCell>
                    </TableRow>
                  )}
                  {loading && (
                    <TableRow>
                      <TableCell
                        colSpan={COLUMNS.length + 1}
                        className="py-10 text-center text-muted-foreground"
                      >
                        불러오는 중...
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SortableHeader({
  label,
  dir,
  priority,
  showPriority,
  onSort,
  className,
}: {
  label: string;
  dir: "asc" | "desc" | null;
  priority: number | null;
  showPriority: boolean;
  onSort: () => void;
  className?: string;
}) {
  const active = dir != null;
  return (
    <TableHead className={cn("text-center align-middle", className)}>
      <button
        type="button"
        onClick={onSort}
        className={cn(
          "inline-flex w-full items-center justify-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground",
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
    </TableHead>
  );
}
