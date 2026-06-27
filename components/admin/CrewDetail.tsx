"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, NotebookPen, User, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { cn } from "@/lib/utils";
import { appendModeQuery, type ScopeMode } from "@/lib/userScopeShared";
import { buildCustomerClusterUrl } from "@/lib/customerAppUrl";

type CrewNote = {
  note: string;
  updatedAt: string | null;
  updatedBy: string | null;
};

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

const CLUB_LABEL_KO: Record<string, string> = {
  encre: "엥크레",
  oranke: "오랑캐",
  phalanx: "팔랑크스",
};

function dash(value: string | null | undefined): string {
  return value && value.trim() ? value : "-";
}

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

export default function CrewDetail({
  userId,
  mode,
}: {
  userId: string;
  mode: ScopeMode;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<CrewDetailDto | null>(null);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);
  // 프로필 사진 로드 실패 시 placeholder 폴백(크루 전환마다 재시도하도록 load 에서 리셋).
  const [photoError, setPhotoError] = useState(false);

  // 클럽 관리 기록 모달.
  const [noteOpen, setNoteOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPhotoError(false);
    try {
      const res = await fetch(`/api/admin/members/${userId}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "크루 상세를 불러오지 못했습니다.");
      }
      setDetail(json.data as CrewDetailDto);
    } catch (err) {
      setError(err instanceof Error ? err.message : "크루 상세를 불러오지 못했습니다.");
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
    // 목록 조건(클럽/필터/검색/정렬)은 MembersList 가 sessionStorage 로 복원한다.
    // 모집단 모드만 URL 로 유지(operating 은 쿼리 생략).
    router.push(appendModeQuery("/admin/members", mode));
  }, [router, mode]);

  const openCareerResume = useCallback(() => {
    if (!detail) return;
    // 고객 페이지 SoT 경로(/cluster-4-<suffix>) 재사용. 새 탭.
    //   테스트 유저(test_user_markers) → demoUserId+mode=test(테스트 유저 모드 배너·여름 시뮬).
    //   일반(운영) 크루 → userId 만(배너 없음·실제 사용자 cluster-4 카드). 모집단 모드(list)와
    //   무관하게 "그 크루가 테스트 유저인가"로만 결정한다(operating 탭의 일반 크루에 배너 금지).
    const url = buildCustomerClusterUrl(detail.organizationSlug, detail.userId, {
      test: detail.isTestUser,
      name: detail.displayName,
    });
    if (!url) {
      setError(
        "고객 앱 URL이 설정되지 않았습니다. 환경변수 NEXT_PUBLIC_CUSTOMER_APP_URL 을 확인해 주세요.",
      );
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }, [detail]);

  // 내용 폭: 좁은 화면은 full(px-4) 유지, 넓은 화면은 1600px 캡으로 가로 공간 적극 활용.
  //   1920 에선 꽉 차게·2560 에선 좌우 여백 확보(100% 확장 금지). 모바일은 기존 방식.
  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 px-4 py-6 sm:px-6">
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
        {/* 1행 2열 그리드 — 왼쪽: 인적사항(넓음) / 오른쪽: 클럽 소속(보조 패널). 좁은 화면 1열. */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(360px,1fr)]">
          {/* 인적사항 — [사진][이름·성별·생년월일 / 거주지 / 연락처·메일 / 학교·전공·입학시기] */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">인적사항</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex gap-5">
                {/* 프로필 사진 — Cluster2 첫 번째 슬롯. URL 은 백엔드(resolveProfilePhotoUrl)가
                    고객 앱 절대 경로로 정규화해 내려준다. 그래도 로드 실패(404/깨짐)하면
                    onError 로 placeholder(이니셜 아이콘)로 안정 폴백한다. */}
                <div className="shrink-0">
                  {detail.profilePhotoUrl && !photoError ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={detail.profilePhotoUrl}
                      alt={`${dash(detail.displayName)} 프로필 사진`}
                      className="h-36 w-28 rounded-lg object-cover ring-1 ring-foreground/10"
                      onError={() => setPhotoError(true)}
                    />
                  ) : (
                    <div className="flex h-36 w-28 items-center justify-center rounded-lg bg-muted ring-1 ring-foreground/10">
                      <User className="h-10 w-10 text-muted-foreground" />
                    </div>
                  )}
                </div>
                {/* 인적 정보 — 와이어프레임 행/열 그리드(3열 기준, 좁으면 1열). */}
                <dl className="grid min-w-0 flex-1 grid-cols-1 gap-x-3 gap-y-3 sm:grid-cols-3">
                  <Field label="이름">{dash(detail.displayName)}</Field>
                  <Field label="성별">{dash(detail.gender)}</Field>
                  <Field label="생년월일">
                    {detail.birthDate
                      ? `${detail.birthDate}${detail.age != null ? ` (만 ${detail.age})` : ""}`
                      : "-"}
                  </Field>
                  <Field label="거주지" className="sm:col-span-3">
                    {dash(detail.address)}
                  </Field>
                  <Field label="연락처">{dash(detail.contactPhone)}</Field>
                  <Field label="메일" className="sm:col-span-2">
                    {dash(detail.contactEmail)}
                  </Field>
                  <Field label="학교">{dash(detail.schoolName)}</Field>
                  <Field label="전공">{dash(detail.departmentName)}</Field>
                  <Field label="입학 시기">{dash(detail.admissionPeriod)}</Field>
                </dl>
              </div>
            </CardContent>
          </Card>

          {/* 클럽 소속 — [크루코드·클럽명·상태 / 활동시작일·시작주차 / 활동종료일·종료주차 / 클래스·소속팀·파트] */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">클럽 소속</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 gap-x-3 gap-y-3 sm:grid-cols-3">
                <Field label="크루 코드" mono>
                  {detail.crewCode ?? (
                    <span className="font-sans text-muted-foreground">미생성</span>
                  )}
                </Field>
                <Field label="클럽명">
                  {detail.organizationSlug
                    ? CLUB_LABEL_KO[detail.organizationSlug] ?? detail.organizationSlug
                    : "공통"}
                </Field>
                <Field label="상태">{dash(detail.statusLabel)}</Field>
                <Field label="활동 시작일">{detail.activityStartDate}</Field>
                <Field label="활동 시작 주차" className="sm:col-span-2">
                  {detail.activityStartWeek}
                </Field>
                <Field label="활동 종료일">{detail.activityEndDate}</Field>
                <Field label="활동 종료 주차" className="sm:col-span-2">
                  {detail.activityEndWeek}
                </Field>
                <Field label="클래스">{dash(detail.classLabel)}</Field>
                <Field label="소속 팀">{dash(detail.teamName)}</Field>
                <Field label="파트">{dash(detail.partName)}</Field>
              </dl>
            </CardContent>
          </Card>
        </div>

        {/* 클럽 결과(종합) — 인적사항/클럽 소속 바로 아래. 라벨/값 칸 그리드(2행×6열). */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">클럽 결과(종합)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
              {/* 1행 */}
              <SummaryCell label="이름" value={dash(detail.displayName)} />
              <SummaryCell
                label="크루 코드"
                value={detail.crewCode ?? "-"}
                mono
              />
              <SummaryCell label="성장 성공 주차" value={dashNum(detail.clubSummary.successWeeks)} />
              <SummaryCell label="포인트 A" value={dashNum(detail.clubSummary.poA)} />
              <SummaryCell label="포인트 B" value={dashNum(detail.clubSummary.poB)} />
              <SummaryCell label="포인트 C" value={dashNum(detail.clubSummary.poC)} />
              {/* 2행 */}
              <SummaryCell label="일정 신뢰도" value={dashPct(detail.clubSummary.scheduleReliability)} />
              <SummaryCell label="활동 완료율" value={dashPct(detail.clubSummary.activityCompletion)} />
              <SummaryCell label="실무 정보" value={dashNum(detail.clubSummary.infoCount)} />
              <SummaryCell label="실무 경험" value={dashNum(detail.clubSummary.experienceCount)} />
              <SummaryCell label="실무 역량" value={dashNum(detail.clubSummary.abilityUnitCount)} />
              <SummaryCell label="실무 경력" value={dashNum(detail.clubSummary.careerProjectCount)} />
            </div>
          </CardContent>
        </Card>

        {/* 클럽 결과(시즌) — 클럽 결과(종합) 아래. 상단부=시즌 요약(2열 그리드). */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">클럽 결과(시즌)</CardTitle>
          </CardHeader>
          <CardContent>
            {/* 상단부: 시즌 요약 — 좌(시작/종료/현재) · 우(가능/성공/휴식). */}
            <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <Field label="성장 시작 시즌">{detail.seasonSummary.startSeason}</Field>
              <Field label="성장 가능 시즌">{`${detail.seasonSummary.availableSeasons}개 시즌`}</Field>
              <Field label="성장 종료 시즌">{detail.seasonSummary.endSeason}</Field>
              <Field label="성장 성공 시즌">{`${detail.seasonSummary.successSeasons}개 시즌`}</Field>
              <Field label="현재 시즌">{detail.seasonSummary.currentSeason}</Field>
              <Field label="성장 휴식 시즌">{`${detail.seasonSummary.restSeasons}개 시즌`}</Field>
            </div>

            {/* 하단부: 시즌별 결과 표 — 최신순(진행 중 맨 위), 페이지네이션 없음. */}
            <SeasonResultsTable rows={detail.seasonResults} />
          </CardContent>
        </Card>

        {/* 클럽 결과(주차) — 클럽 결과(시즌) 아래. 상단부=주차 요약(2열: 좌 시작/종료/현재·우 가능/성공/휴식/실패). */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">클럽 결과(주차)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              {/* 좌: 시작/종료/현재 주차 */}
              <div className="flex flex-col gap-3">
                <Field label="성장 시작 주차">{detail.weekSummary.startWeek}</Field>
                <Field label="성장 종료 주차">{detail.weekSummary.endWeek}</Field>
                <Field label="현재 주차">{detail.weekSummary.currentWeek}</Field>
              </div>
              {/* 우: 가능/성공/휴식/실패 주차 */}
              <div className="flex flex-col gap-3">
                <Field label="성장 가능 주차">{`${detail.weekSummary.availableWeeks}개 주차`}</Field>
                <Field label="성장 성공 주차">{`${detail.weekSummary.successWeeks}개 주차`}</Field>
                <Field label="성장 휴식 주차">{`${detail.weekSummary.restWeeks}개 주차`}</Field>
                <Field label="성장 실패 주차">{`${detail.weekSummary.failWeeks}개 주차`}</Field>
              </div>
            </div>

            {/* 하단부: 주차 결과 표 — 최신→오래된, 15개/페이지·기본 1페이지(최신). */}
            <WeeklyResultsTable rows={detail.weeklyResults} />
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

// 시즌별 결과 표 — 시즌명/결과/Po.A·B·C/허브 강화율 4종/소속&클래스. 페이지네이션 없음.
function SeasonResultsTable({ rows }: { rows: CrewSeasonResultRow[] }) {
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
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th className="whitespace-nowrap px-2 py-2 text-left font-medium">시즌명</th>
            <th className="whitespace-nowrap px-2 py-2 text-left font-medium">시즌 결과</th>
            <th className="whitespace-nowrap px-2 py-2 font-medium">Po.A</th>
            <th className="whitespace-nowrap px-2 py-2 font-medium">Po.B</th>
            <th className="whitespace-nowrap px-2 py-2 font-medium">Po.C</th>
            <th className="whitespace-nowrap px-2 py-2 font-medium">실무 정보</th>
            <th className="whitespace-nowrap px-2 py-2 font-medium">실무 경험</th>
            <th className="whitespace-nowrap px-2 py-2 font-medium">실무 역량</th>
            <th className="whitespace-nowrap px-2 py-2 font-medium">실무 경력</th>
            <th className="whitespace-nowrap px-2 py-2 text-left font-medium">소속 &amp; 클래스</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.seasonKey} className="border-b align-top last:border-0">
              <td className="whitespace-nowrap px-2 py-2 font-medium">{r.seasonNameShort}</td>
              <td className="whitespace-nowrap px-2 py-2">
                <StatusBadge label={r.seasonResultLabel} size="sm" />
              </td>
              <td className="whitespace-nowrap px-2 py-2 tabular-nums">{r.poA}</td>
              <td className="whitespace-nowrap px-2 py-2 tabular-nums">{r.poB}</td>
              <td className="whitespace-nowrap px-2 py-2 tabular-nums">{r.poC}</td>
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

// 주차 결과 표 — 13컬럼. 최신→오래된 표시(맨 위=가장 최신), 15개/페이지·기본 1페이지.
function WeeklyResultsTable({ rows }: { rows: CrewWeeklyResultRow[] }) {
  const totalPages = Math.max(1, Math.ceil(rows.length / WEEKLY_PAGE_SIZE));
  // 기본 = 1페이지(최신 주차). rows.length 변화 시 1페이지로 리셋.
  const [page, setPage] = useState(1);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(1);
  }, [totalPages]);

  if (rows.length === 0) {
    return (
      <p className="mt-4 rounded-md border bg-muted/20 px-3 py-4 text-center text-sm text-muted-foreground">
        활동한 주차 기록이 없습니다.
      </p>
    );
  }

  // 백엔드 배열은 오래된→최신(누적 계산순). 표시는 최신→오래된 — reverse 후 15개씩.
  //   1페이지 = 최신 15(맨 위 = 가장 최신 주차). 진행/집계 중 주차는 최신이라 1페이지 맨 위.
  const displayRows = [...rows].reverse();
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = (safePage - 1) * WEEKLY_PAGE_SIZE;
  const pageRows = displayRows.slice(start, start + WEEKLY_PAGE_SIZE);
  const pct = (v: number | null) => (v == null ? "-" : `${v}%`);
  const num = (v: number | null) => (v == null ? "-" : String(v));

  return (
    <div className="mt-4">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="whitespace-nowrap px-2 py-2 text-left font-medium">주차명</th>
              <th className="whitespace-nowrap px-2 py-2 text-left font-medium">성장 결과</th>
              <th className="whitespace-nowrap px-2 py-2 font-medium">성장 성공 주차</th>
              <th className="whitespace-nowrap px-2 py-2 text-left font-medium">팀</th>
              <th className="whitespace-nowrap px-2 py-2 text-left font-medium">파트</th>
              <th className="whitespace-nowrap px-2 py-2 text-left font-medium">클래스</th>
              <th className="whitespace-nowrap px-2 py-2 font-medium">Po.A</th>
              <th className="whitespace-nowrap px-2 py-2 font-medium">Po.B</th>
              <th className="whitespace-nowrap px-2 py-2 font-medium">Po.C</th>
              <th className="whitespace-nowrap px-2 py-2 font-medium">실무 정보</th>
              <th className="whitespace-nowrap px-2 py-2 font-medium">실무 경험</th>
              <th className="whitespace-nowrap px-2 py-2 font-medium">실무 역량</th>
              <th className="whitespace-nowrap px-2 py-2 font-medium">실무 경력</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((r, i) => (
              <tr key={r.weekId ?? `${r.weekName}-${start + i}`} className="border-b last:border-0">
                <td className="whitespace-nowrap px-2 py-2 font-medium">{r.weekName}</td>
                <td className="whitespace-nowrap px-2 py-2">
                  <StatusBadge label={r.growthResultLabel} size="sm" />
                </td>
                <td className="whitespace-nowrap px-2 py-2 tabular-nums">{num(r.cumulativeSuccessWeeks)}</td>
                <td className="max-w-[120px] truncate px-2 py-2" title={r.teamName ?? "-"}>{r.teamName ?? "-"}</td>
                <td className="max-w-[120px] truncate px-2 py-2" title={r.partName ?? "-"}>{r.partName ?? "-"}</td>
                <td className="max-w-[120px] truncate px-2 py-2" title={r.classLabel}>{r.classLabel || "-"}</td>
                <td className="whitespace-nowrap px-2 py-2 tabular-nums">{r.points.poA}</td>
                <td className="whitespace-nowrap px-2 py-2 tabular-nums">{r.points.poB}</td>
                <td className="whitespace-nowrap px-2 py-2 tabular-nums">{r.points.poC}</td>
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

// 와이어프레임 필드 — 라벨 + bordered 값 박스(input 느낌). col-span 등은 className 으로.
function Field({
  label,
  children,
  className,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
  mono?: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "flex min-h-[2.25rem] items-center break-words rounded-md border bg-muted/40 px-2.5 py-1.5 text-sm text-foreground",
          mono && "font-mono",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

// 클럽 결과(종합) 한 칸 — 라벨 위, 값은 작은 박스(field) 형태로 정렬.
function SummaryCell({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "flex h-9 items-center justify-center rounded-md border bg-muted/30 px-2 text-sm font-medium text-foreground",
          mono && "font-mono",
        )}
      >
        {value}
      </span>
    </div>
  );
}

// 클럽 관리 기록 모달 — 이름·크루 코드 표시 + 관리자 메모(취소/저장). autosave 없음.
function CrewNoteDialog({
  userId,
  displayName,
  crewCode,
  initialNote,
  onClose,
  onSaved,
}: {
  userId: string;
  displayName: string | null;
  crewCode: string | null;
  initialNote: CrewNote;
  onClose: () => void;
  onSaved: (saved: CrewNote) => void;
}) {
  const [note, setNote] = useState(initialNote.note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/members/${userId}/note`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "메모를 저장하지 못했습니다.");
      }
      onSaved(json.data as CrewNote);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "메모를 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }, [userId, note, onSaved, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">클럽 관리 기록</h2>
          <button type="button" onClick={onClose} disabled={saving} className="hover:opacity-70">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">이름</span>
            <span className="font-medium">{dash(displayName)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">크루 코드</span>
            <span className="font-mono">{crewCode ?? "미생성"}</span>
          </div>
        </div>

        <label className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
          관리자 메모
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={6}
            placeholder="관리 메모를 입력하세요."
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
          />
        </label>

        {error && (
          <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            취소
          </Button>
          <Button type="button" size="sm" loading={saving} disabled={saving} onClick={save}>
            저장
          </Button>
        </div>
      </div>
    </div>
  );
}
