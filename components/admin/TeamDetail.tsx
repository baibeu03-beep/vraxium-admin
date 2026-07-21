"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { AdminDetailTitle } from "@/components/admin/AdminRouteTitleProvider";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import { ORGANIZATION_LABEL_KO, type OrganizationSlug } from "@/lib/organizations";
import { buildAdminContextHref } from "@/lib/adminOrgContext";
import { useActionToast } from "@/lib/actionToast";
import { adminDialog } from "@/components/ui/admin-dialog";
import {
  dash,
  toTeamBreadcrumbLabel,
  TeamLeaderProfileRow,
  TeamCurrentCrewStrip,
  TeamPartWeekMatrix,
  type TeamCrewLike,
  type PartWeekColumnLike,
  type PartWeekMatrixLike,
} from "@/components/admin/teamCardShared";
import type { CrewRow, TeamSelectedWeekSummary } from "@/lib/adminTeamSelectedWeekSummary";
import {
  validateWeekPositionRows,
  type PositionDraftRow,
} from "@/lib/teamWeekPositionValidation";
import type { PositionCode } from "@/lib/positionHistory";
import { SortableTh } from "@/components/admin/SortableTh";
import { cycleSort, type SortDirection } from "@/shared/detailLogSort";

const CLASS_OPTIONS: { code: PositionCode; label: string }[] = [
  { code: "regular", label: "정규" },
  { code: "advanced_agent", label: "심화(에이전트)" },
  { code: "advanced_part_leader", label: "심화(파트장)" },
];

// ── [B] 크루 표 정렬 — 컬럼(렌더 순서와 1:1) · 값 추출 · null 최하단 comparator(순수) ──────────
//   정렬은 base 행(weekSummary.crewRows)만 대상으로 하고 draft(편집값)에 의존하지 않는다 → 편집 중
//   행이 튀지 않고, 정렬을 눌러도 draft 는 userId 기준으로 매핑되어 다른 크루에 붙지 않는다(요구 §6).
type CrewSortKey =
  | "part"
  | "name"
  | "gender"
  | "birth"
  | "class"
  | "school"
  | "residence"
  | "grade"
  | "weekResult"
  | "growthSuccess"
  | "lineRate"
  | "actRate";

// 컬럼 정의(렌더/헤더 순서 SoT) — 기존 표 컬럼 순서 그대로.
const CREW_COLUMNS: { key: CrewSortKey; label: string }[] = [
  { key: "part", label: "소속 파트" },
  { key: "name", label: "이름" },
  { key: "gender", label: "성별" },
  { key: "birth", label: "년생" },
  { key: "class", label: "클래스" },
  { key: "school", label: "학적" },
  { key: "residence", label: "거주" },
  { key: "grade", label: "품계" },
  { key: "weekResult", label: "주차 결과" },
  { key: "growthSuccess", label: "성장 성공" },
  { key: "lineRate", label: "라인 강화율" },
  { key: "actRate", label: "액트 체크율" },
];

function crewSchoolText(r: CrewRow): string | null {
  return r.school ? (r.major ? `${r.school}, ${r.major}` : r.school) : null;
}
function crewBirthYear(r: CrewRow): number | null {
  if (!r.birth6 || r.birth6.length < 2) return null;
  const n = Number(r.birth6.slice(0, 2));
  return Number.isFinite(n) ? n : null;
}

// 문자열 비교 — null/빈값은 방향 무관 항상 최하단. ko-KR 자연 정렬(numeric).
function cmpTextNullLast(a: string | null, b: string | null, dir: SortDirection): number {
  const ae = a == null || a.trim() === "";
  const be = b == null || b.trim() === "";
  if (ae && be) return 0;
  if (ae) return 1;
  if (be) return -1;
  const c = a!.localeCompare(b!, "ko-KR", { numeric: true, sensitivity: "base" });
  return dir === "asc" ? c : -c;
}
// 숫자 비교 — null/NaN 은 방향 무관 항상 최하단("-"= 미검수 결과 처리).
function cmpNumNullLast(a: number | null, b: number | null, dir: SortDirection): number {
  const an = a == null || Number.isNaN(a) ? null : a;
  const bn = b == null || Number.isNaN(b) ? null : b;
  if (an == null && bn == null) return 0;
  if (an == null) return 1;
  if (bn == null) return -1;
  return dir === "asc" ? an - bn : bn - an;
}

function compareCrewRows(a: CrewRow, b: CrewRow, key: CrewSortKey, dir: SortDirection): number {
  let c = 0;
  switch (key) {
    case "part":
      c = cmpTextNullLast(a.rawPart, b.rawPart, dir);
      break;
    case "name":
      c = cmpTextNullLast(a.name, b.name, dir);
      break;
    case "gender":
      c = cmpTextNullLast(a.gender, b.gender, dir);
      break;
    case "birth":
      c = cmpNumNullLast(crewBirthYear(a), crewBirthYear(b), dir);
      break;
    case "class":
      c = cmpTextNullLast(a.classLabel, b.classLabel, dir);
      break;
    case "school":
      c = cmpTextNullLast(crewSchoolText(a), crewSchoolText(b), dir);
      break;
    case "residence":
      c = cmpTextNullLast(a.residence, b.residence, dir);
      break;
    case "grade":
      // 품계는 문자열("10품"<"2품" 오류) 대신 숫자 등급(1=정승 최상위 … 10=정9품) 기준.
      c = cmpNumNullLast(a.gradeRank, b.gradeRank, dir);
      break;
    case "weekResult":
      c = cmpTextNullLast(a.weekResult, b.weekResult, dir);
      break;
    case "growthSuccess":
      c = cmpNumNullLast(a.growthSuccessCount, b.growthSuccessCount, dir);
      break;
    case "lineRate":
      c = cmpNumNullLast(a.lineEnhancementRate, b.lineEnhancementRate, dir);
      break;
    case "actRate":
      c = cmpNumNullLast(a.actCheckRate, b.actCheckRate, dir);
      break;
  }
  if (c !== 0) return c;
  return a.userId.localeCompare(b.userId); // 결정적 tie-break(방향 무관)
}

// ── 팀 상세(클럽 상세 → 팀 상세) ──────────────────────────────────────────────
//   두 시점 기준을 분리한다:
//     · 현재 접속 시점(상단): 날짜/주차 · 팀 기본정보/팀장 · 크루 수 · 생성 파트 목록 · 운용 파트 수.
//     · 선택 반기(하단): 파트×주차 존재표(반기 select 만 이걸 바꾼다). 현재 주차 운용 행은 강조.
//   데이터 원천/DTO 는 loadTeamPartsInfo 와 동일 SoT(팀 상세 API가 한 팀만 추출) — 진입 위치별 복제 없음.

type TeamLike = {
  teamHalfId: string;
  teamName: string;
  description: string | null;
  leaderName: string | null;
  leaderBirth6: string | null;
  leaderGender: string | null;
  leaderSchool: string | null;
  leaderMajor: string | null;
  leaderResidence: string | null;
  leaderClassLabel: string | null;
  leaderGradeLabel: string | null;
  partWeekMatrix: PartWeekMatrixLike | null;
};

type HalfOption = { halfKey: string; label: string; isCurrent: boolean; editable: boolean };

type TeamDetailData = {
  organization: string;
  teamName: string;
  currentHalfKey: string | null;
  selectedHalfKey: string | null;
  editable: boolean;
  halves: HalfOption[];
  currentDate: string;
  currentWeek: { label: string } | null;
  currentWeekStartDate: string | null;
  team: TeamLike | null;
  currentCrew: TeamCrewLike;
  generatedParts: string[];
  operatedPartCount: number;
  maxCreatedParts: number;
  selectedTeam: TeamLike | null;
  weekColumns: PartWeekColumnLike[];
};

const CHIP_CLS: Record<OrganizationSlug, string> = {
  encre: "bg-red-500 text-white border-red-600",
  oranke: "bg-yellow-300 text-zinc-900 border-yellow-400",
  phalanx: "bg-green-500 text-white border-green-600",
};

const MAX_PART_NAME = 12;
const WEEK_SELECT_CLS =
  "min-w-[230px] rounded-md border border-input bg-background px-4 py-2.5 text-base font-medium";

// 주차 옵션 표시명 — 연도+시즌+주차(예: "26년, 여름, 4주차 (현재)"). 값(week.id)·정렬·필터는 불변.
//   year/seasonLabel/weekNumber 는 서비스가 공식 주차 데이터에서 파생해 넘긴 값(재계산 없음).
function weekOptionLabel(w: TeamSelectedWeekSummary["selectableWeeks"][number]): string {
  // 연도 = week 의 공식 연도 필드(w.year) — seasonLabel 문자열에서 재파싱하지 않음(전환주차 연도 어긋남 방지).
  const yy = String(((w.year % 100) + 100) % 100).padStart(2, "0");
  const season = normalizeSeasonLabel(w.seasonLabel);
  const parts = [`${yy}년`];
  if (season) parts.push(season);
  parts.push(w.weekNumber != null ? `${w.weekNumber}주차` : w.label);
  return `${parts.join(", ")}${w.isCurrent ? " (현재)" : ""}`;
}

// [A] 크루 수·성장 결과 카드의 한 셀(라벨+값 가로 중앙 정렬). 카드는 3열 그리드. testAttr = data-* 선택자.
function SummaryCell({
  label,
  value,
  testAttr,
}: {
  label: string;
  value: number;
  testAttr: string;
}) {
  return (
    <div className="flex items-center justify-center gap-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <strong className="text-lg text-foreground" {...{ [testAttr]: "" }}>
        {value}
      </strong>
    </div>
  );
}

// 시즌 라벨 정규화 — 원본이 "2026년도 여름시즌"처럼 들어와도 UI 는 "여름/봄/가을/겨울"만 표시.
function normalizeSeasonLabel(raw: string | null): string {
  const s = raw ?? "";
  if (s.includes("봄")) return "봄";
  if (s.includes("여름")) return "여름";
  if (s.includes("가을")) return "가을";
  if (s.includes("겨울")) return "겨울";
  return s;
}

export default function TeamDetail({
  orgSlug,
  teamHalfId,
}: {
  orgSlug: OrganizationSlug;
  teamHalfId: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const mode = readScopeMode(searchParams);
  const halfParam = searchParams.get("half");
  const clubName = ORGANIZATION_LABEL_KO[orgSlug];

  const [data, setData] = useState<TeamDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useReportLoading(loading);
  const t = useActionToast();

  // 파트 생성 다이얼로그.
  const [createOpen, setCreateOpen] = useState(false);
  const [partName, setPartName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // [A] 선택 주차 요약 — 주차별 파트 운용 상태표와 독립. weekId 변경 시 이 영역만 재조회(요청 버저닝).
  const [weekSummary, setWeekSummary] = useState<TeamSelectedWeekSummary | null>(null);
  const [weekLoading, setWeekLoading] = useState(true);
  const [selectedWeekId, setSelectedWeekId] = useState<string | null>(null);
  const weekReqRef = useRef(0);
  // [B] 편집 draft(userId → {rawPart, positionCode}). weekSummary.crewRows 로 초기화, 저장 후 재조회로 리셋.
  const [draft, setDraft] = useState<Map<string, { rawPart: string | null; positionCode: PositionCode }>>(
    new Map(),
  );
  const [savingRows, setSavingRows] = useState(false);
  const [weekReloadTick, setWeekReloadTick] = useState(0); // 저장 후 [A]/[B]/매트릭스 재조회 트리거.
  // [B] 표 정렬 — null=기본(서버 순서: 소속 파트 ASC → 이름 ASC). 헤더 3단계 순환(없음→asc→desc→기본).
  //   저장(재조회)에도 유지된다(sort 는 weekSummary 변경으로 리셋되지 않는 독립 상태).
  const [sort, setSort] = useState<{ key: CrewSortKey; dir: SortDirection } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNotFound(false);
    try {
      const params = new URLSearchParams({ organization: orgSlug, teamHalfId });
      if (halfParam) params.set("half", halfParam);
      if (mode === "test") params.set("mode", "test");
      const res = await fetch(
        `/api/admin/team-parts/info/team-detail?${params.toString()}`,
        { cache: "no-store" },
      );
      if (res.status === 404) {
        setData(null);
        setNotFound(true);
        return;
      }
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? `조회 실패 (${res.status})`);
      }
      setData(json.data as TeamDetailData);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "조회 실패");
    } finally {
      setLoading(false);
    }
  }, [orgSlug, teamHalfId, halfParam, mode]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // [A] 선택 주차 요약 로드 — selectedWeekId(미지정=현재 주차) 변경 시 이 영역만 갱신. 요청 버저닝으로
  //   연속 선택 시 이전 응답이 최신을 덮어쓰지 않게 한다. 상단 상세/매트릭스와 독립(전체 깜빡임 없음).
  useEffect(() => {
    const reqId = ++weekReqRef.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWeekLoading(true);
    void (async () => {
      try {
        const params = new URLSearchParams({ organization: orgSlug, teamHalfId });
        if (selectedWeekId) params.set("weekId", selectedWeekId);
        if (mode === "test") params.set("mode", "test");
        const res = await fetch(
          `/api/admin/team-parts/info/team-detail/week-summary?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (weekReqRef.current !== reqId) return; // 최신 요청만 반영(stale drop)
        if (res.ok && json.success) setWeekSummary(json.data as TeamSelectedWeekSummary);
      } catch {
        // [A]는 보조 영역 — 실패해도 상단 상세는 유지.
      } finally {
        if (weekReqRef.current === reqId) setWeekLoading(false);
      }
    })();
  }, [orgSlug, teamHalfId, mode, selectedWeekId, weekReloadTick]);

  // [B] draft 초기화/리셋 — weekSummary(주차 변경·저장 후 재조회) 바뀌면 crewRows 로 다시 채운다.
  useEffect(() => {
    const m = new Map<string, { rawPart: string | null; positionCode: PositionCode }>();
    for (const r of weekSummary?.crewRows ?? [])
      m.set(r.userId, { rawPart: r.rawPart, positionCode: r.positionCode });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(m);
  }, [weekSummary]);

  const clubHref = useMemo(
    () =>
      buildAdminContextHref({
        targetPath: `/admin/team-parts/info/${orgSlug}`,
        pathname,
        searchParams,
      }),
    [orgSlug, pathname, searchParams],
  );
  const teamLabel = data ? toTeamBreadcrumbLabel(data.teamName) : "팀 상세";

  // 주차별 파트 운용 상태표 — ① 0주차(전환) 컬럼 제외(이 페이지 표시 필터·DB 무변경). present 는 컬럼
  //   인덱스와 정렬되므로 남길 인덱스로 각 행을 슬라이스해 정합 유지. ② 선택 주차 컬럼은 [A] operatedParts
  //   (effective = override ?? UPH)로 덮어써 [A]==[B]==표 정합을 보장(저장 후 재조회하면 즉시 반영).
  const matrixRender = useMemo(() => {
    if (!data) return { cols: [] as PartWeekColumnLike[], matrix: null as PartWeekMatrixLike | null };
    const raw = data.weekColumns;
    const keep = raw.map((c, i) => ((c.weekNumber ?? 0) > 0 ? i : -1)).filter((i) => i >= 0);
    const cols = keep.map((i) => raw[i]);
    const rm = data.selectedTeam?.partWeekMatrix ?? null;
    let matrix = rm
      ? { partNames: rm.partNames, present: rm.present.map((row) => keep.map((i) => row[i])) }
      : null;
    const selWeekStart = weekSummary?.week?.weekStartDate ?? null;
    if (matrix && selWeekStart) {
      const colIdx = cols.findIndex((c) => c.weekStartDate === selWeekStart);
      if (colIdx >= 0) {
        const opSet = new Set((weekSummary?.operatedParts ?? []).map((p) => p.partName));
        const m = matrix;
        matrix = {
          partNames: m.partNames,
          present: m.present.map((row, pi) =>
            row.map((v, ci) => (ci === colIdx ? opSet.has(m.partNames[pi]) : v)),
          ),
        };
      }
    }
    return { cols, matrix };
  }, [data, weekSummary]);

  // [B] 편집 파생값 — base(저장본) 대비 dirty 판정, 파트 옵션, 변경/저장 핸들러.
  const baseByUser = useMemo(() => {
    const m = new Map<string, { rawPart: string | null; positionCode: PositionCode }>();
    for (const r of weekSummary?.crewRows ?? [])
      m.set(r.userId, { rawPart: r.rawPart, positionCode: r.positionCode });
    return m;
  }, [weekSummary]);
  const isRowDirty = (uid: string): boolean => {
    const b = baseByUser.get(uid);
    const d = draft.get(uid);
    return !!b && !!d && (b.rawPart !== d.rawPart || b.positionCode !== d.positionCode);
  };
  const dirtyCount = [...draft.keys()].filter(isRowDirty).length;
  const partOptions = useMemo(
    () => ["일반", ...(data?.generatedParts ?? [])],
    [data?.generatedParts],
  );
  const weekEditable = (weekSummary?.week?.canEdit ?? false) && !weekLoading;

  // [B] 정렬된 행 — sort=null 이면 서버 순서 그대로(안정). base(crewRows)만 정렬 → draft 편집으로 재정렬되지
  //   않는다. 렌더는 이 순서를 돌며 draft.get(userId) 로 편집값을 찾아 붙인다(정렬↔편집 독립).
  const sortedCrewRows = useMemo(() => {
    const rows = weekSummary?.crewRows ?? [];
    if (!sort) return rows;
    return [...rows].sort((a, b) => compareCrewRows(a, b, sort.key, sort.dir));
  }, [weekSummary, sort]);
  const dirOf = (key: CrewSortKey): SortDirection | null => (sort?.key === key ? sort.dir : null);
  const onSortKey = (key: CrewSortKey) => setSort((s) => cycleSort(s, key));

  const onCellChange = (
    userId: string,
    patch: Partial<{ rawPart: string | null; positionCode: PositionCode }>,
  ) => {
    const cur = draft.get(userId);
    if (!cur) return;
    const next = new Map(draft);
    next.set(userId, { ...cur, ...patch });
    // draft 전체 기준으로 즉시 검증(파트장≤1/파트 · 심화≤정규). 위반이면 적용하지 않고 안내.
    const rows: PositionDraftRow[] = [...next.entries()].map(([u, v]) => ({
      userId: u,
      rawPart: v.rawPart,
      positionCode: v.positionCode,
    }));
    const verdict = validateWeekPositionRows(rows);
    if (!verdict.ok) {
      void adminDialog.alert({ variant: "warning", title: "변경 불가", description: verdict.message });
      return;
    }
    setDraft(next);
  };

  const saveRows = async () => {
    if (!weekSummary?.week || savingRows || dirtyCount === 0 || !data) return;
    const changes = [...draft.entries()]
      .filter(([u]) => isRowDirty(u))
      .map(([u, v]) => ({ userId: u, rawPart: v.rawPart, positionCode: v.positionCode }));
    setSavingRows(true);
    try {
      const res = await fetch(
        appendModeQuery(`/api/admin/team-parts/info/team-detail/week-position`, mode),
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organization: orgSlug,
            weekId: weekSummary.week.weekId,
            rawTeam: data.teamName,
            changes,
          }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json?.error ?? `저장 실패 (${res.status})`);
      t.success("update", "파트·클래스가 저장되었습니다.");
      setWeekReloadTick((x) => x + 1); // [A]/[B]/매트릭스 재조회 → dirty 리셋.
    } catch (e) {
      await adminDialog.alert({
        variant: "danger",
        title: "저장 실패",
        description: e instanceof Error ? e.message : "저장에 실패했습니다.",
      });
    } finally {
      setSavingRows(false);
    }
  };

  const normalizedName = partName.trim();
  const openCreate = () => {
    setPartName("");
    setCreateError(null);
    setCreateOpen(true);
  };
  const submitCreate = async () => {
    if (normalizedName.length === 0 || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch(
        appendModeQuery(`/api/admin/team-parts/info/team-detail/parts`, mode),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ organization: orgSlug, teamHalfId, name: normalizedName }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? `생성 실패 (${res.status})`);
      }
      t.success("create", "파트가 생성되었습니다.");
      setCreateOpen(false);
      setPartName("");
      await load(); // 서버 재조회 — 생성 파트 목록·표 행 반영(운용 파트 수는 불변).
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "생성 실패");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Card>
      {/* 전역 헤더 breadcrumb 공급(화면엔 아무것도 안 그림). 카드 내부 중복 breadcrumb·도움말(CardHeader)은
          상단 공통 Header 와 겹쳐 제거했다 — 본문이 바로 시작한다. */}
      <AdminDetailTitle
        items={[{ label: clubName, href: clubHref }, { label: teamLabel }]}
      />

      <CardContent className="admin-section-stack-lg">
        {error ? (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        ) : null}

        {notFound ? (
          <div data-team-detail-notfound className="rounded-md border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-muted-foreground">
            팀을 찾을 수 없습니다. 삭제되었거나 이 클럽에 속하지 않은 팀입니다.
            <div className="mt-3">
              <Link href={clubHref} className="rounded-sm font-medium text-foreground underline underline-offset-2">
                {clubName} 클럽 상세로 돌아가기
              </Link>
            </div>
          </div>
        ) : loading && !data ? (
          <LoadingState active />
        ) : data ? (
          <>
            {/* [1] 오늘 날짜 · 현재 주차 안내(접속 시점 기준·공통 SoT). */}
            <div
              data-team-detail-today
              className="rounded-md border border-orange-200 bg-orange-50 px-4 py-2.5 text-sm"
            >
              ✓ 오늘은 <strong className="text-foreground">{data.currentDate}</strong>이며, 이번
              주는{" "}
              <strong data-team-detail-week className="text-foreground">
                {data.currentWeek?.label ?? "-"}
              </strong>
              입니다.
            </div>

            {/* [2] 현재 시점 상태 구간 — 팀 기본정보·팀장·크루(현재 반기 기준·selectedHalf 무관).
                파트 관리 행은 아래 표 영역으로 이동(표 바로 위 주요 행). */}
            <section className="space-y-4 rounded-lg border-2 border-dashed border-emerald-300 p-4">
              <div className="text-base font-bold text-emerald-700">
                * 우리 팀의 &lsquo;현재&rsquo; 상태를 보여주는 구간입니다.
              </div>

              {/* 팀 기본 정보(팀 배지 + 개요) */}
              <div className="flex items-start gap-3">
                <span className={"shrink-0 rounded-md border px-3 py-1 text-sm font-bold " + CHIP_CLS[orgSlug]}>
                  {data.team?.teamName ?? data.teamName}
                </span>
                <span className="flex-1 rounded-md border border-input bg-muted/30 px-3 py-1.5 text-sm">
                  {dash(data.team?.description)}
                </span>
              </div>

              {/* 팀장 프로필 */}
              {data.team ? <TeamLeaderProfileRow team={data.team} /> : null}

              {/* 현재 시점 크루 수(전체 크루/정규/심화) — 문구만 "전체 크루"(집계·값 동일). */}
              <TeamCurrentCrewStrip
                teamHalfId={teamHalfId}
                crew={data.currentCrew}
                clubbingLabel="전체 크루"
              />
            </section>

            {/* 파트 관리 + 주차별 파트 운용 상태표.
                ① [파트 수 N │ 생성 파트 목록](좌) | [N / 6 · 파트 생성](우) → ② 표(제목·반기 select 없음). */}
            <section className="space-y-3">
              {/* ① 좌: 파트 수 N │ 생성 파트 배지 · 우: N / 6 · 파트 생성. 좁은 화면 자연 줄바꿈. */}
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
                <div className="flex flex-wrap items-center gap-2" data-team-detail-generated-parts>
                  <span className="text-sm font-medium text-muted-foreground">
                    파트 수
                    <strong
                      data-team-detail-operated-part-count
                      className="ml-1 text-base text-foreground"
                    >
                      {data.operatedPartCount}
                    </strong>
                    <span className="mx-2 text-muted-foreground">|</span>
                  </span>
                  {data.generatedParts.length === 0 ? (
                    <span className="text-sm text-muted-foreground">생성된 파트 없음</span>
                  ) : (
                    data.generatedParts.map((p) => (
                      <span
                        key={p}
                        data-generated-part={p}
                        className="rounded-md border border-input bg-background px-2.5 py-1 text-sm font-medium"
                      >
                        {p}
                      </span>
                    ))
                  )}
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-3">
                  <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                    <strong className="text-base text-foreground">{data.operatedPartCount}</strong>
                    <span>/ {data.maxCreatedParts}</span>
                    <AdminHelpIconButton
                      helpKey="admin.teamParts.info.summary.operatedPartCount"
                      title="파트 수"
                    />
                  </span>
                  <Button
                    type="button"
                    data-create-team-part-button
                    onClick={openCreate}
                    disabled={!data.editable}
                    title={!data.editable ? "현재·다음 반기에서만 파트를 생성할 수 있습니다." : undefined}
                  >
                    + 파트 생성
                  </Button>
                </div>
              </div>

              {/* ② 파트×주차 존재표 — 제목/반기 select 없이 바로 표 시작. 현재 주차 운용은 파트명 셀만 강조.
                  (선택 반기는 ?half 로만 결정 — UI select 는 제거됨. 기본=현재 반기.) */}
              <TeamPartWeekMatrix
                teamName={data.selectedTeam?.teamName ?? data.teamName}
                matrix={matrixRender.matrix}
                weekColumns={matrixRender.cols}
                currentWeekStartDate={data.currentWeekStartDate}
              />
            </section>

            {/* [A] 선택 주차 요약 — 위 상태표와 독립(주차 select 로만 갱신). 구분선 후 중립 카드. */}
            <div className="my-2 border-t" />
            <section
              data-team-detail-week-summary
              className="space-y-5 rounded-lg border bg-muted/20 p-5"
            >
              {/* 주차 select(좌) + 안내 문구(우) */}
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-semibold">● 주차명</span>
                  <select
                    id="team-detail-week-select"
                    className={WEEK_SELECT_CLS}
                    value={weekSummary?.week?.weekId ?? ""}
                    disabled={weekLoading && !weekSummary}
                    onChange={(e) => setSelectedWeekId(e.target.value)}
                  >
                    {(weekSummary?.selectableWeeks ?? []).map((w) => (
                      <option key={w.weekId} value={w.weekId}>
                        {weekOptionLabel(w)}
                      </option>
                    ))}
                  </select>
                  {weekSummary?.week ? (
                    <span
                      data-selected-week-review
                      className={
                        "rounded-md px-2 py-1 text-xs " +
                        (weekSummary.week.canEdit
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-muted text-muted-foreground")
                      }
                    >
                      {weekSummary.week.canEdit ? "수정 가능" : "검수 완료 · 조회만 가능"}
                    </span>
                  ) : null}
                </div>
                <p className="text-base font-bold text-emerald-700">
                  * 우리 팀의 &lsquo;해당 주차&rsquo; 상태를 보여주는 구간입니다.
                </p>
              </div>

              {weekLoading && !weekSummary ? (
                <LoadingState active />
              ) : weekSummary ? (
                <>
                  {/* 크루 수(좌) · 성장 결과(우) — 각 카드 3행. */}
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="grid grid-cols-1 gap-4 rounded-md border bg-background p-4 sm:grid-cols-3">
                      <SummaryCell label="전체 크루" value={weekSummary.crew.total} testAttr="data-selected-week-total-crew-count" />
                      <SummaryCell label="정규 크루" value={weekSummary.crew.regular} testAttr="data-selected-week-regular-crew-count" />
                      <SummaryCell label="심화 크루" value={weekSummary.crew.advanced} testAttr="data-selected-week-advanced-crew-count" />
                    </div>
                    <div className="grid grid-cols-1 gap-4 rounded-md border bg-background p-4 sm:grid-cols-3">
                      <SummaryCell label="성장 성공" value={weekSummary.growth.success} testAttr="data-selected-week-growth-success-count" />
                      <SummaryCell label="성장 실패" value={weekSummary.growth.failure} testAttr="data-selected-week-growth-failure-count" />
                      <SummaryCell label="성장 휴식" value={weekSummary.growth.rest} testAttr="data-selected-week-growth-rest-count" />
                    </div>
                  </div>

                  {/* 운용 파트 개수 + 파트별 크루 수 배지(배정 크루 ≥1, '일반' 포함). */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">● 운용 파트 개수</span>
                      <strong data-selected-week-operated-part-count className="text-lg text-foreground">
                        {weekSummary.operatedParts.length}
                      </strong>
                    </div>
                    {weekSummary.operatedParts.length === 0 ? (
                      <p className="text-sm text-muted-foreground">해당 주차에 운용된 파트가 없습니다.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2" data-selected-week-operated-parts>
                        {weekSummary.operatedParts.map((p) => (
                          <span
                            key={p.partName}
                            data-selected-week-operated-part={p.partName}
                            className="inline-flex min-w-24 items-center justify-between gap-3 rounded-md border bg-background px-3 py-1.5 text-sm font-medium"
                          >
                            <span>{p.partName}</span>
                            <strong className="text-foreground">{p.crewCount}</strong>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ) : null}
            </section>

            {/* [B] 선택 주차 · 현재 팀 크루 편집표 — 소속 파트·클래스만 편집(나머지 조회전용).
                결과류(품계/주차결과/성장성공/강화율/체크율)는 검수 완료 후만 표시(그 전 "-"). */}
            {weekSummary && weekSummary.crewRows.length >= 0 ? (
              <section data-team-detail-crew-table className="space-y-3">
                <div className="flex items-center justify-end">
                  <Button
                    type="button"
                    data-save-team-week-part-class
                    onClick={saveRows}
                    disabled={!weekEditable || dirtyCount === 0 || savingRows}
                    title={
                      !weekEditable
                        ? "검수 완료 주차는 수정할 수 없습니다."
                        : dirtyCount === 0
                          ? "변경 사항이 없습니다."
                          : undefined
                    }
                  >
                    {savingRows ? "저장 중…" : "[파트 & 클래스] 정보 저장"}
                  </Button>
                </div>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full min-w-[1500px] border-collapse text-sm">
                    <thead>
                      <tr className="bg-muted/60">
                        {CREW_COLUMNS.map((col) => (
                          <SortableTh
                            key={col.key}
                            label={col.label}
                            dir={dirOf(col.key)}
                            onSort={() => onSortKey(col.key)}
                            align="center"
                            className="border-b border-r px-4 py-3 text-sm font-semibold whitespace-nowrap"
                          />
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedCrewRows.length === 0 ? (
                        <tr>
                          <td colSpan={12} className="px-4 py-6 text-center text-muted-foreground">
                            해당 주차·팀에 크루가 없습니다.
                          </td>
                        </tr>
                      ) : (
                        sortedCrewRows.map((r) => {
                          const d = draft.get(r.userId) ?? { rawPart: r.rawPart, positionCode: r.positionCode };
                          const dirty = isRowDirty(r.userId);
                          const partOpts = [...new Set([...(d.rawPart ? [d.rawPart] : []), ...partOptions])];
                          return (
                            <tr
                              key={r.userId}
                              data-crew-row={r.userId}
                              data-dirty={dirty ? "1" : "0"}
                              className={dirty ? "bg-amber-50/50" : ""}
                            >
                              <td className="border-b border-r px-4 py-3">
                                <select
                                  data-crew-part-select={r.userId}
                                  className="min-w-24 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                                  value={d.rawPart ?? ""}
                                  disabled={!weekEditable}
                                  onChange={(e) => onCellChange(r.userId, { rawPart: e.target.value })}
                                >
                                  {partOpts.map((p) => (
                                    <option key={p} value={p}>
                                      {p}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="border-b border-r px-4 py-3 whitespace-nowrap">{dash(r.name)}</td>
                              <td className="border-b border-r px-4 py-3">{dash(r.gender)}</td>
                              <td className="border-b border-r px-4 py-3">{r.birth6 ? r.birth6.slice(0, 2) : "-"}</td>
                              <td className="border-b border-r px-4 py-3">
                                <select
                                  data-crew-class-select={r.userId}
                                  className="min-w-32 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                                  value={d.positionCode}
                                  disabled={!weekEditable}
                                  onChange={(e) => onCellChange(r.userId, { positionCode: e.target.value as PositionCode })}
                                >
                                  {CLASS_OPTIONS.map((o) => (
                                    <option key={o.code} value={o.code}>
                                      {o.label}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="border-b border-r px-4 py-3 whitespace-nowrap">
                                {r.school ? (r.major ? `${r.school}, ${r.major}` : r.school) : "-"}
                              </td>
                              <td className="border-b border-r px-4 py-3 whitespace-nowrap">{dash(r.residence)}</td>
                              <td className="border-b border-r px-4 py-3">{dash(r.gradeLabel)}</td>
                              <td className="border-b border-r px-4 py-3 whitespace-nowrap">{dash(r.weekResult)}</td>
                              <td className="border-b border-r px-4 py-3 tabular-nums">{r.growthSuccessCount ?? "-"}</td>
                              <td className="border-b border-r px-4 py-3 tabular-nums">
                                {r.lineEnhancementRate == null ? "-" : `${r.lineEnhancementRate}%`}
                              </td>
                              <td className="border-b border-r px-4 py-3 tabular-nums">
                                {r.actCheckRate == null ? "-" : `${r.actCheckRate}%`}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}
          </>
        ) : null}
      </CardContent>

      {/* ── 파트 생성 다이얼로그 ─────────────────────────────── */}
      {createOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !creating) setCreateOpen(false);
          }}
        >
          <div className="modal-w-sm w-full max-w-md rounded-xl bg-background p-6 shadow-xl ring-1 ring-foreground/10">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold">파트 생성</h2>
              <Button type="button" variant="ghost" size="icon" onClick={() => !creating && setCreateOpen(false)} aria-label="닫기">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-semibold">● 파트명</span>
              {/* 어느 클럽·팀의 파트를 만드는지 안내(입력란 위·현재 페이지 조회 실제 값). */}
              <span className="text-sm font-normal text-muted-foreground">
                {clubName} 클럽 &gt; {teamLabel}의{" "}
                <span className="font-semibold">&lsquo;파트&rsquo;</span>를 생성합니다.
              </span>
              <Input
                data-create-team-part-input
                value={partName}
                maxLength={MAX_PART_NAME}
                autoFocus
                placeholder="생성할 파트명을 입력하세요."
                onChange={(e) => setPartName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submitCreate();
                  }
                }}
              />
              <span className="text-xs text-muted-foreground">
                {partName.length}/{MAX_PART_NAME}
              </span>
            </label>
            {createError ? (
              <div data-create-team-part-error className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {createError}
              </div>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => !creating && setCreateOpen(false)}>
                취소
              </Button>
              <Button
                type="button"
                data-create-team-part-submit
                onClick={submitCreate}
                disabled={creating || normalizedName.length === 0}
              >
                {creating ? "생성 중…" : "확인"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
