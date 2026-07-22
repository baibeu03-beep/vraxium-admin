"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  ExternalLink,
  NotebookPen,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { ADMIN_SHARED_HELP_KEYS } from "@/lib/adminSharedHelpKeys";
import { AdminDetailTitle } from "@/components/admin/AdminRouteTitleProvider";
import { LoadingState } from "@/components/ui/loading-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { cn } from "@/lib/utils";
import { pointColorClass } from "@/components/ui/point-value";
import { type ScopeMode } from "@/lib/userScopeShared";
import {
  buildAdminContextHref,
  resolveAdminOrgFocus,
} from "@/lib/adminOrgContext";
import { buildCustomerClusterUrl } from "@/lib/customerAppUrl";
import { getProcessPointLabels } from "@/lib/pointLabels";
import {
  CrewIdentityCards,
  Field,
  dash,
} from "@/components/admin/crew/CrewIdentityCards";
import { CrewNoteDialog, type CrewNote } from "@/components/admin/crew/CrewNoteDialog";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";

type CrewDetailDto = {
  userId: string;
  displayName: string | null;
  organizationSlug: string | null;
  isTestUser: boolean;
  // 인적사항
  profilePhotoUrl: string | null;
  gender: string | null;
  birthDate: string | null;
  age: number | null;
  address: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  schoolName: string | null;
  departmentName: string | null;
  admissionPeriod: string | null;
  // 클럽 소속
  crewCode: string | null;
  statusLabel: string;
  activityStartDate: string;
  activityStartWeek: string;
  activityEndDate: string;
  activityEndWeek: string;
  classLabel: string;
  teamName: string | null;
  partName: string | null;
  clubSummary: CrewClubSummary;
  seasonSummary: CrewSeasonSummary;
  seasonResults: CrewSeasonResultRow[];
  weekSummary: CrewWeekSummary;
  weeklyResults: CrewWeeklyResultRow[];
  note: CrewNote;
};

type CrewWeeklyResultRow = {
  weekId: string | null;
  weekName: string;
  userWeekStatus: string;
  growthResultLabel: string;
  cumulativeSuccessWeeks: number | null;
  teamName: string | null;
  partName: string | null;
  classLabel: string;
  points: { poA: number; poB: number; poC: number };
  hubRates: {
    info: number | null;
    experience: number | null;
    ability: number | null;
    career: number | null;
  };
};

type CrewSeasonResultRow = {
  seasonKey: string;
  seasonNameShort: string;
  seasonResultLabel: "진행 중" | "시즌 성공" | "시즌 휴식" | "시즌 중단";
  poA: number;
  poB: number;
  poC: number;
  hubRates: {
    info: number | null;
    experience: number | null;
    ability: number | null;
    career: number | null;
  };
  memberships: Array<{ teamName: string | null; partName: string | null; classLabel: string }>;
};

type CrewClubSummary = {
  successWeeks: number | null;
  poA: number;
  poB: number;
  poC: number;
  scheduleReliability: number | null;
  activityCompletion: number | null;
  infoCount: number;
  experienceCount: number;
  abilityUnitCount: number;
  careerProjectCount: number;
};

type CrewSeasonSummary = {
  startSeason: string;
  endSeason: string;
  currentSeason: string;
  availableSeasons: number;
  successSeasons: number;
  restSeasons: number;
};

type CrewWeekSummary = {
  startWeek: string;
  endWeek: string;
  currentWeek: string;
  availableWeeks: number;
  successWeeks: number;
  failWeeks: number;
  restWeeks: number;
};

// 숫자 — null/undefined 만 "-"(0 은 실값으로 표기). 이력서 카드 skill-num/포인트는 0 도 의미값.
function dashNum(value: number | null | undefined): string {
  return value == null ? "-" : String(value);
}

// 퍼센트 — null/undefined "-", 그 외 "NN%".
function dashPct(value: number | null | undefined): string {
  return value == null ? "-" : `${value}%`;
}

// 시즌 결과(4종)·주차 성장 결과(7종) 배지 색은 lib/statusBadge 레지스트리(단일 SoT)가
// 담당한다 — 같은 상태=같은 색을 전 페이지에서 보장. 여기서 별도 색 맵을 두지 않는다.

const WEEKLY_PAGE_SIZE = 15;

// ── 요소 단위 도움말 키(org/mode/test 무관 공통) ──────────────────────────────
//   · SoT 는 admin_page_help_contents(page_path=키, content) — 여기선 "키 문자열"만 중앙화.
//   · 크루(회원) 정체성 항목(이름/코드/클럽)은 전 어드민 공용 레지스트리(ADMIN_SHARED_HELP_KEYS)
//     를 재사용해 다른 페이지와 같은 도움말 레코드를 공유한다.
//   · 상세 전용(섹션/시즌·주차 표 컬럼)은 admin.members.detail.* 로 페이지 스코프를 둔다.
//   · 키 형식 /^admin(\.[a-zA-Z0-9]+)+$/ — 하이픈 금지, camelCase 세그먼트만.
const DETAIL_HELP = {
  section: {
    personalInfo: "admin.members.detail.section.personalInfo",
    clubAffiliation: "admin.members.detail.section.clubAffiliation",
    clubSummary: "admin.members.detail.section.clubSummary",
    seasonResults: "admin.members.detail.section.seasonResults",
    weeklyResults: "admin.members.detail.section.weeklyResults",
  },
  // 시즌 표·주차 표가 공유하는 지표 컬럼(같은 의미=같은 도움말).
  metric: {
    poA: "admin.members.detail.metric.poA",
    poB: "admin.members.detail.metric.poB",
    poC: "admin.members.detail.metric.poC",
    hubInfo: "admin.members.detail.metric.hubInfo",
    hubExperience: "admin.members.detail.metric.hubExperience",
    hubAbility: "admin.members.detail.metric.hubAbility",
    hubCareer: "admin.members.detail.metric.hubCareer",
    team: "admin.members.detail.metric.team",
    part: "admin.members.detail.metric.part",
    classLabel: "admin.members.detail.metric.classLabel",
  },
  // 클럽 결과(종합) 지표 칸.
  summary: {
    successWeeks: "admin.members.detail.summary.successWeeks",
    scheduleReliability: "admin.members.detail.summary.scheduleReliability",
    activityCompletion: "admin.members.detail.summary.activityCompletion",
    infoCount: "admin.members.detail.summary.infoCount",
    experienceCount: "admin.members.detail.summary.experienceCount",
    abilityUnitCount: "admin.members.detail.summary.abilityUnitCount",
    careerProjectCount: "admin.members.detail.summary.careerProjectCount",
  },
  // 클럽 결과(시즌) 상단 요약 6칸.
  seasonSummary: {
    startSeason: "admin.members.detail.seasonSummary.startSeason",
    endSeason: "admin.members.detail.seasonSummary.endSeason",
    currentSeason: "admin.members.detail.seasonSummary.currentSeason",
    availableSeasons: "admin.members.detail.seasonSummary.availableSeasons",
    successSeasons: "admin.members.detail.seasonSummary.successSeasons",
    restSeasons: "admin.members.detail.seasonSummary.restSeasons",
  },
  // 클럽 결과(주차) 상단 요약 7칸.
  weekSummary: {
    startWeek: "admin.members.detail.weekSummary.startWeek",
    endWeek: "admin.members.detail.weekSummary.endWeek",
    currentWeek: "admin.members.detail.weekSummary.currentWeek",
    availableWeeks: "admin.members.detail.weekSummary.availableWeeks",
    successWeeks: "admin.members.detail.weekSummary.successWeeks",
    restWeeks: "admin.members.detail.weekSummary.restWeeks",
    failWeeks: "admin.members.detail.weekSummary.failWeeks",
  },
  season: {
    name: "admin.members.detail.season.name",
    result: "admin.members.detail.season.result",
    membership: "admin.members.detail.season.membership",
  },
  week: {
    name: "admin.members.detail.week.name",
    growthResult: "admin.members.detail.week.growthResult",
    cumulativeSuccess: "admin.members.detail.week.cumulativeSuccess",
    enhancementStatus: "admin.members.detail.week.enhancementStatus",
  },
} as const;

// ── 공통 3단계 정렬(오름 → 내림 → 기본=원본 표시 순서) ─────────────────────────
//   다른 어드민 표(MembersList 주차별 데이터 등)와 동일한 UX·비교 규칙(빈값 최하단·ko-KR numeric).
type SortDir = "asc" | "desc";

// 숫자 비교 — null(미확정/미집계)은 방향 무관 항상 최하단.
function cmpNum(a: number | null, b: number | null, dir: SortDir): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return dir === "asc" ? a - b : b - a;
}

// 문자 비교 — 빈값("", "-", "—")은 방향 무관 항상 최하단. ko-KR + numeric(주차/시즌명 자연 정렬).
function cmpText(a: string, b: string, dir: SortDir): number {
  const ae = !a || a === "-" || a === "—";
  const be = !b || b === "-" || b === "—";
  if (ae && be) return 0;
  if (ae) return 1;
  if (be) return -1;
  const c = a.localeCompare(b, "ko-KR", { numeric: true, sensitivity: "base" });
  return dir === "asc" ? c : -c;
}

// 정렬 가능한 <th> — 정렬 버튼 + 도움말 아이콘(형제). onSort 미지정 = 정렬 불가(라벨+도움말만).
//   버튼 중첩(무효 HTML) 방지를 위해 정렬 버튼과 도움말 버튼을 형제로 둔다.
function SortTh({
  label,
  help,
  dir,
  onSort,
  align = "center",
  className,
}: {
  label: string;
  help: string;
  dir: SortDir | null;
  onSort?: () => void;
  align?: "left" | "center";
  className?: string;
}) {
  return (
    <th
      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
      className={cn(
        "px-2 py-2 font-medium",
        align === "left" ? "text-left" : "text-center",
        className,
      )}
    >
      <span
        className={cn(
          "inline-flex items-center gap-1",
          align === "left" ? "justify-start" : "w-full justify-center",
        )}
      >
        {onSort ? (
          <button
            type="button"
            onClick={onSort}
            aria-label={`${label} 기준 정렬`}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1 hover:text-foreground",
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
          <span>{label}</span>
        )}
        <AdminHelpIconButton helpKey={help} title={label} />
      </span>
    </th>
  );
}

export default function CrewDetail({
  userId,
}: {
  userId: string;
  // 진입 컨텍스트(스코프)용 — 페이지 계약 유지. 현재 본문에서 직접 사용하는 곳은 없음.
  mode?: ScopeMode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // 진입 컨텍스트(통합/개별) — URL 의 ?org(크루 목록에서 승격돼 넘어온 값)로 판정한다.
  //   상세 경로(/admin/members/{id})에는 org path 세그먼트가 없으므로 ?org 가 SoT.
  const orgFocus = resolveAdminOrgFocus(pathname, searchParams);
  const [detail, setDetail] = useState<CrewDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);

  // 클럽 관리 기록 모달.
  const [noteOpen, setNoteOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/members/${userId}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw apiErrorFrom(res, json, "크루 상세를 불러오지 못했습니다.");
      }
      setDetail(json.data as CrewDetailDto);
    } catch (err) {
      console.error("[crews] detail load failed", err);
      setError(getApiErrorMessage(err, "크루 상세를 불러오지 못했습니다."));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    // 마운트 시 상세 1회 fetch(표준 데이터 로딩 effect). load 내부 setState 는 의도된 동작.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const goBack = useCallback(() => {
    // 진입 컨텍스트로 정확히 복귀한다:
    //   · 개별(orgFocus 있음) → 그 조직 크루 목록 /admin/crews/{org} (사이드바 [개별] 유지,
    //     MembersList sessionStorage 키 members-list-state:{org}:{mode} 와도 일치해 조건/정렬 복원).
    //   · 통합(orgFocus 없음) → /admin/members (기존 동작 그대로).
    // 모집단 모드·테스트 대행/데모 등 컨텍스트 파라미터는 공통 유틸이 함께 유지한다(operating=쿼리 생략).
    const targetPath = orgFocus ? `/admin/crews/${orgFocus}` : "/admin/members";
    router.push(buildAdminContextHref({ targetPath, pathname, searchParams }));
  }, [router, orgFocus, pathname, searchParams]);

  // 주차 결과 표의 주차명 → 회원별·주차별 상세(관리) 페이지 링크. URL 의 userId 는 이 페이지 진입
  //   식별자(레거시 route param)를 그대로 이어붙이고, 진입 컨텍스트(org/mode/test/demo)를 보존한다.
  const weekDetailHref = useCallback(
    (weekId: string) =>
      buildAdminContextHref({
        targetPath: `/admin/members/${userId}/weeks/${weekId}`,
        pathname,
        searchParams,
      }),
    [userId, pathname, searchParams],
  );

  const openCareerResume = useCallback(() => {
    if (!detail) return;
    // 크루 페이지 SoT 경로(/cluster-4-<suffix>) 재사용. 새 탭.
    //   테스트 유저(test_user_markers) → demoUserId+mode=test(테스트 유저 모드 배너·여름 시뮬).
    //   일반(운영) 크루 → userId 만(배너 없음·실제 사용자 cluster-4 카드). 모집단 모드(list)와
    //   무관하게 "그 크루가 테스트 유저인가"로만 결정한다(operating 탭의 일반 크루에 배너 금지).
    const url = buildCustomerClusterUrl(detail.organizationSlug, detail.userId, {
      test: detail.isTestUser,
      name: detail.displayName,
    });
    if (!url) {
      setError(
        "크루 페이지 URL이 설정되지 않았습니다. 환경변수 NEXT_PUBLIC_CUSTOMER_APP_URL 을 확인해 주세요.",
      );
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }, [detail]);

  // po.A/B/C 표시명 — 단일 크루 상세는 query org 무관, 크루의 organizationSlug 기준.
  //   detail 미로딩 시 중립이지만 아래 블록은 detail 확정 후에만 렌더된다.
  const poLabels = getProcessPointLabels(detail?.organizationSlug ?? null);

  // 내용 폭: 좁은 화면은 full(px-4) 유지, 넓은 화면은 1600px 캡으로 가로 공간 적극 활용.
  //   1920 에선 꽉 차게·2560 에선 좌우 여백 확보(100% 확장 금지). 모바일은 기존 방식.
  return (
    <div className="flex w-full min-w-0 flex-col gap-6 px-4 py-6 sm:px-6">
      {/* 전역 헤더 경로에 실제 회원 표시명 공급(중복 조회 없음) — 이름 > 크루 코드 순, 로딩 중="불러오는 중". */}
      <AdminDetailTitle
        title={loading ? "불러오는 중" : detail?.displayName?.trim() || detail?.crewCode || undefined}
      />
      <div className="flex justify-end">
        <AdminHelp />
      </div>
      {/* 상단 3버튼 헤더 — 1행 3열 그리드 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Button variant="outline" onClick={goBack} className="justify-center">
          <ArrowLeft className="h-4 w-4" />
          목록으로 돌아가기
        </Button>
        <Button
          variant="outline"
          onClick={openCareerResume}
          disabled={loading || !detail}
          className="justify-center"
        >
          <ExternalLink className="h-4 w-4" />
          크루 : 커리어레쥬메
        </Button>
        <Button
          variant="outline"
          onClick={() => setNoteOpen(true)}
          disabled={loading || !detail}
          className="justify-center"
        >
          <NotebookPen className="h-4 w-4" />
          클럽 관리 기록
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <Card>
          <CardContent>
            <LoadingState active />
          </CardContent>
        </Card>
      ) : detail ? (
        <>
        {/* 상단 공통 카드(인적사항 · 클럽 소속) — 회원 상세/주차 상세가 동일 컴포넌트를 소비한다. */}
        <CrewIdentityCards member={detail} />

        {/* 클럽 결과(종합) — 인적사항/클럽 소속 바로 아래. 라벨/값 칸 그리드(2행×6열). */}
        <Card>
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-1.5 text-base">
              클럽 결과(종합)
              <AdminHelpIconButton helpKey={DETAIL_HELP.section.clubSummary} title="클럽 결과(종합)" size="sm" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
              {/* 1행 */}
              <SummaryCell label="이름" value={dash(detail.displayName)} helpKey={ADMIN_SHARED_HELP_KEYS.crew.name} />
              <SummaryCell
                label="크루 코드"
                value={detail.crewCode ?? "-"}
                mono
                helpKey={ADMIN_SHARED_HELP_KEYS.crew.code}
              />
              <SummaryCell label="성장 성공 주차" value={dashNum(detail.clubSummary.successWeeks)} helpKey={DETAIL_HELP.summary.successWeeks} />
              <SummaryCell label={poLabels.a} value={dashNum(detail.clubSummary.poA)} valueClassName={pointColorClass("a")} helpKey={DETAIL_HELP.metric.poA} />
              <SummaryCell label={poLabels.b} value={dashNum(detail.clubSummary.poB)} valueClassName={pointColorClass("b")} helpKey={DETAIL_HELP.metric.poB} />
              <SummaryCell label={poLabels.c} value={dashNum(detail.clubSummary.poC)} valueClassName={pointColorClass("c")} helpKey={DETAIL_HELP.metric.poC} />
              {/* 2행 */}
              <SummaryCell label="일정 신뢰도" value={dashPct(detail.clubSummary.scheduleReliability)} helpKey={DETAIL_HELP.summary.scheduleReliability} />
              <SummaryCell label="활동 완료율" value={dashPct(detail.clubSummary.activityCompletion)} helpKey={DETAIL_HELP.summary.activityCompletion} />
              <SummaryCell label="실무 정보" value={dashNum(detail.clubSummary.infoCount)} helpKey={DETAIL_HELP.summary.infoCount} />
              <SummaryCell label="실무 경험" value={dashNum(detail.clubSummary.experienceCount)} helpKey={DETAIL_HELP.summary.experienceCount} />
              <SummaryCell label="실무 역량" value={dashNum(detail.clubSummary.abilityUnitCount)} helpKey={DETAIL_HELP.summary.abilityUnitCount} />
              <SummaryCell label="실무 경력" value={dashNum(detail.clubSummary.careerProjectCount)} helpKey={DETAIL_HELP.summary.careerProjectCount} />
            </div>
          </CardContent>
        </Card>

        {/* 클럽 결과(시즌) — 클럽 결과(종합) 아래. 상단부=시즌 요약(2열 그리드). */}
        <Card>
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-1.5 text-base">
              클럽 결과(시즌)
              <AdminHelpIconButton helpKey={DETAIL_HELP.section.seasonResults} title="클럽 결과(시즌)" size="sm" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* 상단부: 시즌 요약 — 좌(시작/종료/현재) · 우(가능/성공/휴식). */}
            <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <Field label="성장 시작 시즌" helpKey={DETAIL_HELP.seasonSummary.startSeason}>{detail.seasonSummary.startSeason}</Field>
              <Field label="성장 가능 시즌" helpKey={DETAIL_HELP.seasonSummary.availableSeasons}>{`${detail.seasonSummary.availableSeasons}개 시즌`}</Field>
              <Field label="성장 종료 시즌" helpKey={DETAIL_HELP.seasonSummary.endSeason}>{detail.seasonSummary.endSeason}</Field>
              <Field label="성장 성공 시즌" helpKey={DETAIL_HELP.seasonSummary.successSeasons}>{`${detail.seasonSummary.successSeasons}개 시즌`}</Field>
              <Field label="현재 시즌" helpKey={DETAIL_HELP.seasonSummary.currentSeason}>{detail.seasonSummary.currentSeason}</Field>
              <Field label="성장 휴식 시즌" helpKey={DETAIL_HELP.seasonSummary.restSeasons}>{`${detail.seasonSummary.restSeasons}개 시즌`}</Field>
            </div>

            {/* 하단부: 시즌별 결과 표 — 최신순(진행 중 맨 위), 페이지네이션 없음. */}
            <SeasonResultsTable rows={detail.seasonResults} orgSlug={detail.organizationSlug} />
          </CardContent>
        </Card>

        {/* 클럽 결과(주차) — 클럽 결과(시즌) 아래. 상단부=주차 요약(2열: 좌 시작/종료/현재·우 가능/성공/휴식/실패). */}
        <Card>
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-1.5 text-base">
              클럽 결과(주차)
              <AdminHelpIconButton helpKey={DETAIL_HELP.section.weeklyResults} title="클럽 결과(주차)" size="sm" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              {/* 좌: 시작/종료/현재 주차 */}
              <div className="flex flex-col gap-3">
                <Field label="성장 시작 주차" helpKey={DETAIL_HELP.weekSummary.startWeek}>{detail.weekSummary.startWeek}</Field>
                <Field label="성장 종료 주차" helpKey={DETAIL_HELP.weekSummary.endWeek}>{detail.weekSummary.endWeek}</Field>
                <Field label="현재 주차" helpKey={DETAIL_HELP.weekSummary.currentWeek}>{detail.weekSummary.currentWeek}</Field>
              </div>
              {/* 우: 가능/성공/휴식/실패 주차 */}
              <div className="flex flex-col gap-3">
                <Field label="성장 가능 주차" helpKey={DETAIL_HELP.weekSummary.availableWeeks}>{`${detail.weekSummary.availableWeeks}개 주차`}</Field>
                <Field label="성장 성공 주차" helpKey={DETAIL_HELP.weekSummary.successWeeks}>{`${detail.weekSummary.successWeeks}개 주차`}</Field>
                <Field label="성장 휴식 주차" helpKey={DETAIL_HELP.weekSummary.restWeeks}>{`${detail.weekSummary.restWeeks}개 주차`}</Field>
                <Field label="성장 실패 주차" helpKey={DETAIL_HELP.weekSummary.failWeeks}>{`${detail.weekSummary.failWeeks}개 주차`}</Field>
              </div>
            </div>

            {/* 하단부: 주차 결과 표 — 최신→오래된, 15개/페이지·기본 1페이지(최신).
                주차명 클릭 → 주차 상세(라인 강화 내역 탭)에서 라인별 강화 결과·제출을 수정한다. */}
            <WeeklyResultsTable
              rows={detail.weeklyResults}
              orgSlug={detail.organizationSlug}
              weekDetailHref={weekDetailHref}
            />
          </CardContent>
        </Card>
        </>
      ) : (
        <Card>
          <CardContent>
            <p className="py-8 text-sm text-muted-foreground">크루를 찾을 수 없습니다.</p>
          </CardContent>
        </Card>
      )}

      {noteOpen && detail && (
        <CrewNoteDialog
          userId={detail.userId}
          displayName={detail.displayName}
          crewCode={detail.crewCode}
          initialNote={detail.note}
          onClose={() => setNoteOpen(false)}
          onSaved={(saved) =>
            setDetail((prev) => (prev ? { ...prev, note: saved } : prev))
          }
        />
      )}
    </div>
  );
}

// 시즌 결과 배지 업무 순서(진행 → 성공 → 휴식 → 중단). enum 라벨 가나다순 금지.
const SEASON_RESULT_RANK: Record<CrewSeasonResultRow["seasonResultLabel"], number> = {
  "진행 중": 0,
  "시즌 성공": 1,
  "시즌 휴식": 2,
  "시즌 중단": 3,
};

type SeasonSortKey =
  | "seasonName"
  | "result"
  | "poA"
  | "poB"
  | "poC"
  | "info"
  | "experience"
  | "ability"
  | "career";

function compareSeason(
  a: CrewSeasonResultRow,
  b: CrewSeasonResultRow,
  key: SeasonSortKey,
  dir: SortDir,
): number {
  switch (key) {
    case "seasonName":
      return cmpText(a.seasonNameShort, b.seasonNameShort, dir);
    case "result":
      return cmpNum(SEASON_RESULT_RANK[a.seasonResultLabel], SEASON_RESULT_RANK[b.seasonResultLabel], dir);
    case "poA":
      return cmpNum(a.poA, b.poA, dir);
    case "poB":
      return cmpNum(a.poB, b.poB, dir);
    case "poC":
      return cmpNum(a.poC, b.poC, dir);
    case "info":
      return cmpNum(a.hubRates.info, b.hubRates.info, dir);
    case "experience":
      return cmpNum(a.hubRates.experience, b.hubRates.experience, dir);
    case "ability":
      return cmpNum(a.hubRates.ability, b.hubRates.ability, dir);
    case "career":
      return cmpNum(a.hubRates.career, b.hubRates.career, dir);
  }
}

// 시즌별 결과 표 — 시즌명/결과/po.A·B·C(조직별 명칭)/허브 강화율 4종/소속&클래스. 페이지네이션 없음.
//   헤더 클릭 3단계 정렬(오름 → 내림 → 기본=최신순). "소속 & 클래스"는 복합 셀이라 정렬 제외(도움말만).
function SeasonResultsTable({
  rows,
  orgSlug,
}: {
  rows: CrewSeasonResultRow[];
  orgSlug: string | null;
}) {
  const poLabels = getProcessPointLabels(orgSlug);
  const [sort, setSort] = useState<{ key: SeasonSortKey; dir: SortDir } | null>(null);
  const cycleSort = useCallback((key: SeasonSortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
  }, []);
  // 기본(sort=null) = API 원본 순서(최신순, 진행 중 맨 위). 원본 배열 mutate 금지(복사본 정렬).
  const sortedRows = useMemo(
    () => (sort ? [...rows].sort((a, b) => compareSeason(a, b, sort.key, sort.dir)) : rows),
    [rows, sort],
  );
  const dirOf = (key: SeasonSortKey): SortDir | null => (sort?.key === key ? sort.dir : null);

  if (rows.length === 0) {
    return (
      <p className="mt-4 rounded-md border bg-muted/20 px-3 py-4 text-center text-sm text-muted-foreground">
        활동한 시즌 기록이 없습니다.
      </p>
    );
  }
  const pct = (v: number | null) => (v == null ? "-" : `${v}%`);
  return (
    <div className="mt-4 overflow-x-auto">
      {/* 헤더·셀 전부 가운데 정렬(예외 없음) — table text-center 상속, 셀은 override 금지. */}
      <table className="w-full border-collapse text-center text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <SortTh label="시즌명" help={DETAIL_HELP.season.name} dir={dirOf("seasonName")} onSort={() => cycleSort("seasonName")} className="whitespace-nowrap" />
            <SortTh label="시즌 결과" help={DETAIL_HELP.season.result} dir={dirOf("result")} onSort={() => cycleSort("result")} className="whitespace-nowrap" />
            <SortTh label={poLabels.a} help={DETAIL_HELP.metric.poA} dir={dirOf("poA")} onSort={() => cycleSort("poA")} className="whitespace-nowrap" />
            <SortTh label={poLabels.b} help={DETAIL_HELP.metric.poB} dir={dirOf("poB")} onSort={() => cycleSort("poB")} className="whitespace-nowrap" />
            <SortTh label={poLabels.c} help={DETAIL_HELP.metric.poC} dir={dirOf("poC")} onSort={() => cycleSort("poC")} className="whitespace-nowrap" />
            <SortTh label="실무 정보" help={DETAIL_HELP.metric.hubInfo} dir={dirOf("info")} onSort={() => cycleSort("info")} className="whitespace-nowrap" />
            <SortTh label="실무 경험" help={DETAIL_HELP.metric.hubExperience} dir={dirOf("experience")} onSort={() => cycleSort("experience")} className="whitespace-nowrap" />
            <SortTh label="실무 역량" help={DETAIL_HELP.metric.hubAbility} dir={dirOf("ability")} onSort={() => cycleSort("ability")} className="whitespace-nowrap" />
            <SortTh label="실무 경력" help={DETAIL_HELP.metric.hubCareer} dir={dirOf("career")} onSort={() => cycleSort("career")} className="whitespace-nowrap" />
            <SortTh label="소속 & 클래스" help={DETAIL_HELP.season.membership} dir={null} className="whitespace-nowrap" />
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((r) => (
            <tr key={r.seasonKey} className="border-b align-top last:border-0">
              <td className="whitespace-nowrap px-2 py-2 font-medium">{r.seasonNameShort}</td>
              <td className="whitespace-nowrap px-2 py-2">
                <StatusBadge label={r.seasonResultLabel} size="sm" />
              </td>
              <td className={cn("whitespace-nowrap px-2 py-2 tabular-nums", pointColorClass("a"))}>{r.poA}</td>
              <td className={cn("whitespace-nowrap px-2 py-2 tabular-nums", pointColorClass("b"))}>{r.poB}</td>
              <td className={cn("whitespace-nowrap px-2 py-2 tabular-nums", pointColorClass("c"))}>{r.poC}</td>
              <td className="whitespace-nowrap px-2 py-2 tabular-nums">{pct(r.hubRates.info)}</td>
              <td className="whitespace-nowrap px-2 py-2 tabular-nums">{pct(r.hubRates.experience)}</td>
              <td className="whitespace-nowrap px-2 py-2 tabular-nums">{pct(r.hubRates.ability)}</td>
              <td className="whitespace-nowrap px-2 py-2 tabular-nums">{pct(r.hubRates.career)}</td>
              <td className="px-2 py-2">
                <SeasonMembershipCell memberships={r.memberships} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 소속 & 클래스 — 한 셀 안에 복수 줄(팀명 | 파트명 | 클래스). 너비 정렬 + truncate + hover title.
function SeasonMembershipCell({
  memberships,
}: {
  memberships: CrewSeasonResultRow["memberships"];
}) {
  if (memberships.length === 0) {
    return <span className="text-muted-foreground">- | - | -</span>;
  }
  return (
    <div className="flex flex-col gap-1">
      {memberships.map((m, i) => {
        const team = m.teamName ?? "-";
        const part = m.partName ?? "-";
        const cls = m.classLabel || "-";
        return (
          <div
            key={`${team}/${part}/${cls}/${i}`}
            className="flex items-center gap-1 text-xs"
            title={`${team} | ${part} | ${cls}`}
          >
            <span className="w-20 truncate rounded bg-muted/50 px-1.5 py-0.5">{team}</span>
            <span className="text-muted-foreground">|</span>
            <span className="w-20 truncate rounded bg-muted/50 px-1.5 py-0.5">{part}</span>
            <span className="text-muted-foreground">|</span>
            <span className="w-28 truncate rounded bg-muted/50 px-1.5 py-0.5">{cls}</span>
          </div>
        );
      })}
    </div>
  );
}

type WeekSortKey =
  | "weekName"
  | "growthResult"
  | "cumulativeSuccess"
  | "team"
  | "part"
  | "classLabel"
  | "poA"
  | "poB"
  | "poC"
  | "info"
  | "experience"
  | "ability"
  | "career";

function compareWeek(
  a: CrewWeeklyResultRow,
  b: CrewWeeklyResultRow,
  key: WeekSortKey,
  dir: SortDir,
): number {
  switch (key) {
    case "weekName":
      return cmpText(a.weekName, b.weekName, dir);
    case "growthResult":
      return cmpText(a.growthResultLabel, b.growthResultLabel, dir);
    case "cumulativeSuccess":
      return cmpNum(a.cumulativeSuccessWeeks, b.cumulativeSuccessWeeks, dir);
    case "team":
      return cmpText(a.teamName ?? "", b.teamName ?? "", dir);
    case "part":
      return cmpText(a.partName ?? "", b.partName ?? "", dir);
    case "classLabel":
      return cmpText(a.classLabel, b.classLabel, dir);
    case "poA":
      return cmpNum(a.points.poA, b.points.poA, dir);
    case "poB":
      return cmpNum(a.points.poB, b.points.poB, dir);
    case "poC":
      return cmpNum(a.points.poC, b.points.poC, dir);
    case "info":
      return cmpNum(a.hubRates.info, b.hubRates.info, dir);
    case "experience":
      return cmpNum(a.hubRates.experience, b.hubRates.experience, dir);
    case "ability":
      return cmpNum(a.hubRates.ability, b.hubRates.ability, dir);
    case "career":
      return cmpNum(a.hubRates.career, b.hubRates.career, dir);
  }
}

// 주차 결과 표 — 최신→오래된 표시(맨 위=가장 최신), 15개/페이지·기본 1페이지.
//   헤더 클릭 3단계 정렬(오름 → 내림 → 기본=최신순). 라인별 강화 결과·제출 수정은 주차 상세의
//   "라인 강화 내역" 탭 팝업으로 이동(구 주차 단위 "강화 상태 수정" 버튼/모달 제거 — 2026-07).
function WeeklyResultsTable({
  rows,
  orgSlug,
  weekDetailHref,
}: {
  rows: CrewWeeklyResultRow[];
  orgSlug: string | null;
  weekDetailHref: (weekId: string) => string;
}) {
  const poLabels = getProcessPointLabels(orgSlug);
  const totalPages = Math.max(1, Math.ceil(rows.length / WEEKLY_PAGE_SIZE));
  // 기본 = 1페이지(최신 주차). rows.length 변화 시 1페이지로 리셋.
  const [page, setPage] = useState(1);
  // 헤더 클릭 정렬(오름 → 내림 → 기본=최신순). 정렬 변경 시 1페이지로.
  const [sort, setSort] = useState<{ key: WeekSortKey; dir: SortDir } | null>(null);
  const cycleSort = useCallback((key: WeekSortKey) => {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null;
    });
    setPage(1);
  }, []);
  const dirOf = (key: WeekSortKey): SortDir | null => (sort?.key === key ? sort.dir : null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(1);
  }, [totalPages]);

  // 백엔드 배열은 오래된→최신(누적 계산순). 표시 기본은 최신→오래된 — reverse.
  //   정렬 지정 시 그 복사본을 비교기로 정렬(원본 mutate 금지). 1페이지 = 상단 15.
  const displayRows = useMemo(() => {
    const base = [...rows].reverse();
    return sort ? base.sort((a, b) => compareWeek(a, b, sort.key, sort.dir)) : base;
  }, [rows, sort]);

  if (rows.length === 0) {
    return (
      <p className="mt-4 rounded-md border bg-muted/20 px-3 py-4 text-center text-sm text-muted-foreground">
        활동한 주차 기록이 없습니다.
      </p>
    );
  }

  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * WEEKLY_PAGE_SIZE;
  const pageRows = displayRows.slice(start, start + WEEKLY_PAGE_SIZE);
  const pct = (v: number | null) => (v == null ? "-" : `${v}%`);
  const num = (v: number | null) => (v == null ? "-" : String(v));

  return (
    <div className="mt-4">
      <div className="overflow-x-auto">
        {/* 헤더·셀 전부 가운데 정렬(예외 없음) — table text-center 상속, 셀은 override 금지. */}
        <table className="w-full border-collapse text-center text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <SortTh label="주차명" help={DETAIL_HELP.week.name} dir={dirOf("weekName")} onSort={() => cycleSort("weekName")} className="whitespace-nowrap" />
              <SortTh label="성장 결과" help={DETAIL_HELP.week.growthResult} dir={dirOf("growthResult")} onSort={() => cycleSort("growthResult")} className="whitespace-nowrap" />
              <SortTh label="성장 성공 주차" help={DETAIL_HELP.week.cumulativeSuccess} dir={dirOf("cumulativeSuccess")} onSort={() => cycleSort("cumulativeSuccess")} className="whitespace-nowrap" />
              <SortTh label="팀" help={DETAIL_HELP.metric.team} dir={dirOf("team")} onSort={() => cycleSort("team")} className="whitespace-nowrap" />
              <SortTh label="파트" help={DETAIL_HELP.metric.part} dir={dirOf("part")} onSort={() => cycleSort("part")} className="whitespace-nowrap" />
              <SortTh label="클래스" help={DETAIL_HELP.metric.classLabel} dir={dirOf("classLabel")} onSort={() => cycleSort("classLabel")} className="whitespace-nowrap" />
              <SortTh label={poLabels.a} help={DETAIL_HELP.metric.poA} dir={dirOf("poA")} onSort={() => cycleSort("poA")} className="whitespace-nowrap" />
              <SortTh label={poLabels.b} help={DETAIL_HELP.metric.poB} dir={dirOf("poB")} onSort={() => cycleSort("poB")} className="whitespace-nowrap" />
              <SortTh label={poLabels.c} help={DETAIL_HELP.metric.poC} dir={dirOf("poC")} onSort={() => cycleSort("poC")} className="whitespace-nowrap" />
              <SortTh label="실무 정보" help={DETAIL_HELP.metric.hubInfo} dir={dirOf("info")} onSort={() => cycleSort("info")} className="whitespace-nowrap" />
              <SortTh label="실무 경험" help={DETAIL_HELP.metric.hubExperience} dir={dirOf("experience")} onSort={() => cycleSort("experience")} className="whitespace-nowrap" />
              <SortTh label="실무 역량" help={DETAIL_HELP.metric.hubAbility} dir={dirOf("ability")} onSort={() => cycleSort("ability")} className="whitespace-nowrap" />
              <SortTh label="실무 경력" help={DETAIL_HELP.metric.hubCareer} dir={dirOf("career")} onSort={() => cycleSort("career")} className="whitespace-nowrap" />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r, i) => (
              <tr key={r.weekId ?? `${r.weekName}-${start + i}`} className="border-b last:border-0">
                <td className="whitespace-nowrap px-2 py-2 font-medium">
                  {/* 주차명 클릭 → 회원별·주차별 상세(관리) 페이지. 텍스트만 클릭(행 전체 아님).
                      키보드 포커스·hover/focus-visible 표시. weekId 없으면 링크 없이 텍스트만. */}
                  {r.weekId ? (
                    <Link
                      href={weekDetailHref(r.weekId)}
                      className="rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {r.weekName}
                    </Link>
                  ) : (
                    r.weekName
                  )}
                </td>
                <td className="whitespace-nowrap px-2 py-2">
                  <StatusBadge label={r.growthResultLabel} size="sm" />
                </td>
                <td className="whitespace-nowrap px-2 py-2 tabular-nums">{num(r.cumulativeSuccessWeeks)}</td>
                <td className="max-w-[120px] truncate px-2 py-2" title={r.teamName ?? "-"}>{r.teamName ?? "-"}</td>
                <td className="max-w-[120px] truncate px-2 py-2" title={r.partName ?? "-"}>{r.partName ?? "-"}</td>
                <td className="max-w-[120px] truncate px-2 py-2" title={r.classLabel}>{r.classLabel || "-"}</td>
                <td className={cn("whitespace-nowrap px-2 py-2 tabular-nums", pointColorClass("a"))}>{r.points.poA}</td>
                <td className={cn("whitespace-nowrap px-2 py-2 tabular-nums", pointColorClass("b"))}>{r.points.poB}</td>
                <td className={cn("whitespace-nowrap px-2 py-2 tabular-nums", pointColorClass("c"))}>{r.points.poC}</td>
                <td className="whitespace-nowrap px-2 py-2 tabular-nums">{pct(r.hubRates.info)}</td>
                <td className="whitespace-nowrap px-2 py-2 tabular-nums">{pct(r.hubRates.experience)}</td>
                <td className="whitespace-nowrap px-2 py-2 tabular-nums">{pct(r.hubRates.ability)}</td>
                <td className="whitespace-nowrap px-2 py-2 tabular-nums">{pct(r.hubRates.career)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 페이지네이션 — 1페이지가 최신 주차. */}
      {totalPages > 1 && (
        <div className="mt-3 flex items-center justify-center gap-1.5 text-sm">
          <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
            이전
          </Button>
          <span className="px-2 text-muted-foreground">
            {safePage} / {totalPages} 페이지 ({rows.length}주차)
          </span>
          <Button variant="outline" size="sm" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>
            다음
          </Button>
        </div>
      )}
    </div>
  );
}

// 클럽 결과(종합) 한 칸 — 라벨 위, 값은 작은 박스(field) 형태로 정렬.
function SummaryCell({
  label,
  value,
  mono = false,
  valueClassName,
  helpKey,
}: {
  label: string;
  value: string;
  mono?: boolean;
  valueClassName?: string;
  helpKey?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <span>{label}</span>
        {helpKey ? <AdminHelpIconButton helpKey={helpKey} title={label} /> : null}
      </span>
      <span
        className={cn(
          "flex h-9 items-center justify-center rounded-md border bg-muted/30 px-2 text-sm font-medium text-foreground",
          mono && "font-mono",
          valueClassName,
        )}
      >
        {value}
      </span>
    </div>
  );
}

