"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronRight, X } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { adminDialog } from "@/components/ui/admin-dialog";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { AdminDetailTitle } from "@/components/admin/AdminRouteTitleProvider";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import { type OrganizationSlug } from "@/lib/organizations";
import type { ClubCurrentSummaryRow } from "@/lib/adminClubSummaryData";
import { parseHalfKey } from "@/lib/teamHalf";
import { useActionToast } from "@/lib/actionToast";
import { buildAdminContextHref } from "@/lib/adminOrgContext";
import {
  dash,
  formatBirth6,
  TeamLeaderProfileRow,
  TeamPartsRow,
  TeamCurrentCrewStrip,
  type TeamCrewLike,
} from "@/components/admin/teamCardShared";

// ── 클럽 상세 하위 페이지(`/admin/team-parts/info/[clubId]`) — 선택 클럽의 팀·파트 상세 ──
//   상위 목록의 클럽명을 눌러 진입한다. 클럽은 URL(clubId=org slug)로 이미 결정되므로 조직 탭이 없다.
//   기존 팀 내역(§2) 편집 기능을 그대로 보존한다 — 클럽 탭 선택을 URL parameter 로 바꾼 것뿐.
//   데이터 원천/DTO/로더/저장·수정·삭제 액션은 통합/개별·일반/test 모두 동일(기존 API 재사용).

const MAX_TEAMS_PER_CLUB = 10;
const MAX_TEAM_NAME = 12;
const MAX_TEAM_DESC = 200;

type TeamDto = {
  teamHalfId: string;
  teamName: string;
  teamId: string | null;
  displayOrder: number;
  isActive: boolean;
  description: string | null;
  leaderUserId: string | null;
  leaderCrewCode: string | null;
  leaderName: string | null;
  leaderBirth6: string | null;
  leaderGender: string | null;
  leaderSchool: string | null;
  leaderMajor: string | null;
  leaderResidence: string | null;
  leaderClassLabel: string | null;
  leaderGradeLabel: string | null;
  partCount: number;
  partNames: string[];
  partWeekMatrix: PartWeekMatrix | null;
  currentCrew?: TeamCrewLike;
};

type PartWeekColumn = {
  weekStartDate: string;
  seasonKey: string;
  seasonLabel: string;
  weekNumber: number | null;
  label: string;
  isRest: boolean;
};

type PartWeekMatrix = {
  partNames: string[];
  present: boolean[][];
};

type HalfOption = {
  halfKey: string;
  label: string;
  lastSeasonKey: string | null;
  isCurrent: boolean;
  editable: boolean;
};

type InfoDto = {
  organization: string;
  currentHalfKey: string | null;
  selectedHalfKey: string | null;
  editable: boolean;
  halves: HalfOption[];
  teams: TeamDto[];
  weekColumns: PartWeekColumn[];
};

type LeaderCandidate = {
  userId: string;
  crewCode: string | null;
  organizationSlug: string | null;
  name: string | null;
  gender: string | null;
  birth6: string | null;
  residence: string | null;
  school: string | null;
  major: string | null;
  classLabel: string | null;
  teamName: string | null;
  partName: string | null;
  successWeeks: number | null;
  gradeLabel: string | null;
};

type Banner = { kind: "success" | "error"; message: string } | null;

const CLUB_LABEL: Record<OrganizationSlug, string> = {
  encre: "엥크레",
  oranke: "오랑캐",
  phalanx: "팔랑크스",
};
const CHIP_CLS: Record<OrganizationSlug, string> = {
  encre: "bg-red-500 text-white border-red-600",
  oranke: "bg-yellow-300 text-zinc-900 border-yellow-400",
  phalanx: "bg-green-500 text-white border-green-600",
};

const SELECT_CLS =
  "rounded-md border border-input bg-background px-3 py-2 text-sm";

// 해당 시기 드롭다운 고정 옵션(2022 상반기 ~ 2026 하반기). 편집 가능/현재 여부는 백엔드 SoT.
const HALF_OPTIONS = [
  "2022-H1",
  "2022-H2",
  "2023-H1",
  "2023-H2",
  "2024-H1",
  "2024-H2",
  "2025-H1",
  "2025-H2",
  "2026-H1",
  "2026-H2",
] as const;

function formatHalf(halfKey: string): string {
  const p = parseHalfKey(halfKey);
  if (!p) return halfKey;
  return `${p.year}년 ${p.period === "H1" ? "상반기" : "하반기"}`;
}

// ── 조직별 현재 시점 현황 스트립 ────────────────────────────────────────────
//   상위 목록 표(ClubSummaryList)의 해당 조직 행과 **동일 DTO/집계**(loadClubCurrentSummary,
//   /api/admin/team-parts/info/summary?organization={org})를 재사용해 9개 수치만 가로로 표시한다.
//   ⚠ 모든 값 = 현재 접속 시점 기준 — 상세의 `해당 시기`(selectedHalf) 변경과 무관하다.
//   ⚠ 표시는 현재 조직 값 하나뿐 — 클럽명 컬럼·다른 클럽 행·합계 행은 포함하지 않는다(org scope).
//   도움말 키는 상위 목록과 동일 키(admin.teamPartsInfoClubs.column.*) 재사용(중복 정의 금지).
type SummaryNumKey = Exclude<
  keyof ClubCurrentSummaryRow,
  "clubId" | "clubSlug" | "clubName"
>;
const SUMMARY_ITEMS: { key: SummaryNumKey; label: string; helpKey: string }[] = [
  { key: "staffCount", label: "운영진", helpKey: "admin.teamPartsInfoClubs.column.staff" },
  { key: "teamLeaderCount", label: "팀장 수", helpKey: "admin.teamPartsInfoClubs.column.team" },
  { key: "ambassadorCount", label: "앰배서더", helpKey: "admin.teamPartsInfoClubs.column.ambassador" },
  { key: "clubbingCount", label: "클러빙", helpKey: "admin.teamPartsInfoClubs.column.clubbing" },
  { key: "regularCrewCount", label: "정규 크루", helpKey: "admin.teamPartsInfoClubs.column.regular" },
  { key: "advancedCrewCount", label: "심화 크루", helpKey: "admin.teamPartsInfoClubs.column.advanced" },
  { key: "partCount", label: "파트 수", helpKey: "admin.teamPartsInfoClubs.column.part" },
  { key: "partLeaderCount", label: "파트장 수", helpKey: "admin.teamPartsInfoClubs.column.partLeader" },
  { key: "agentCount", label: "에이전트 수", helpKey: "admin.teamPartsInfoClubs.column.agent" },
];

function ClubCurrentSummaryStrip({
  orgSlug,
  summary,
}: {
  orgSlug: OrganizationSlug;
  summary: ClubCurrentSummaryRow | null;
}) {
  return (
    <div
      data-club-current-summary={orgSlug}
      className="rounded-md border bg-muted/20 px-5 py-4"
    >
      <div className="mb-4 text-sm font-semibold text-muted-foreground">
        현재 시점 현황
      </div>
      {/* 반응형 4열 그리드 — 데스크톱 4열 / 태블릿 2열 / 모바일 1열. 9개 항목이라 큰 화면에서
          4×2 + 마지막(에이전트 수) 1칸(3행 첫 열). 억지 정렬/전체폭 확장 없음. */}
      <div className="grid grid-cols-1 gap-x-10 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        {SUMMARY_ITEMS.map((item) => (
          <div
            key={item.key}
            data-club-current-cell={item.key}
            className="flex items-center gap-2 whitespace-nowrap"
          >
            <span className="text-base font-medium text-muted-foreground">
              · {item.label}
            </span>
            <strong className="text-lg font-bold tabular-nums text-foreground">
              {summary ? summary[item.key] : "–"}
            </strong>
            <AdminHelpIconButton helpKey={item.helpKey} title={item.label} />
          </div>
        ))}
      </div>
    </div>
  );
}
export default function ClubTeamDetail({ clubId }: { clubId: OrganizationSlug }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // QA 모드(?mode=test) — 팀 정보 조회에 전파(백엔드 filterTeamsByScope 와 정합).
  const mode = readScopeMode(searchParams);
  const activeOrg = clubId;
  const clubName = CLUB_LABEL[clubId];

  const [half, setHalf] = useState<string | null>(null);
  const [currentHalfKey, setCurrentHalfKey] = useState<string | null>(null);
  const [editable, setEditable] = useState(false);
  const [teams, setTeams] = useState<TeamDto[]>([]);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [banner, setBanner] = useState<Banner>(null);
  const t = useActionToast();

  // 조직별 현재 시점 현황(상위 목록과 동일 DTO/집계). ⚠ selectedHalf 무관 — half 변경 시 재조회하지
  //   않는다. clubId·mode 변경 시에만 한 번 로드한다(현재 접속 시점 고정).
  const [summary, setSummary] = useState<ClubCurrentSummaryRow | null>(null);

  // 팀 등록/수정 팝업(같은 컴포넌트, editingTeam 으로 모드 구분).
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTeam, setEditingTeam] = useState<TeamDto | null>(null);
  const [teamName, setTeamName] = useState("");
  const [description, setDescription] = useState("");
  const [crewCode, setCrewCode] = useState("");
  const [leader, setLeader] = useState<LeaderCandidate | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  const isEditMode = editingTeam != null;

  const load = useCallback(
    async (halfKey: string | null) => {
      setLoading(true);
      setBanner(null);
      // 다른 클럽/반기로 전환 시 이전 데이터가 잠깐 남지 않도록 비운다.
      try {
        const params = new URLSearchParams({ organization: clubId });
        if (halfKey) params.set("half", halfKey);
        if (mode === "test") params.set("mode", "test");
        const res = await fetch(
          `/api/admin/team-parts/info?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? `조회 실패 (${res.status})`);
        }
        const dto = json.data as InfoDto;
        setCurrentHalfKey(dto.currentHalfKey);
        setHalf(dto.selectedHalfKey);
        setEditable(dto.editable);
        setTeams(dto.teams);
      } catch (e) {
        setTeams([]);
        setBanner({
          kind: "error",
          message: e instanceof Error ? e.message : "조회 실패",
        });
      } finally {
        setLoading(false);
      }
    },
    [clubId, mode],
  );

  useEffect(() => {
    // clubId·mode 변경 시 재조회.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(null);
  }, [load]);

  // 현재 시점 현황 요약 — /summary?organization={org} (상위 목록과 동일 함수·DTO). half 와 독립적으로
  //   clubId·mode 에만 반응한다(과거 반기 선택 시에도 숫자 불변). 실패해도 팀 상세는 정상 렌더.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const params = new URLSearchParams({ organization: clubId });
        if (mode === "test") params.set("mode", "test");
        const res = await fetch(
          `/api/admin/team-parts/info/summary?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (cancelled) return;
        if (res.ok && json.success) {
          const rows = (json.data?.rows ?? []) as ClubCurrentSummaryRow[];
          setSummary(rows.find((r) => r.clubId === clubId) ?? rows[0] ?? null);
        }
      } catch {
        // 현황 스트립은 보조 정보 — 조회 실패 시 값만 비운다(팀 상세는 그대로).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clubId, mode]);

  const onHalfChange = (value: string) => {
    void load(value);
  };
  const isCurrentHalf = half != null && half === currentHalfKey;
  const atLimit = teams.length >= MAX_TEAMS_PER_CLUB;

  // 팀 배지 → 팀 상세 링크. path 로 org+teamHalfId, ?half 로 선택 반기 전달(직접 진입=현재 반기).
  //   org/mode/actAs/demo 컨텍스트는 buildAdminContextHref 로 보존(진입 컨텍스트 유실 방지).
  const teamDetailHref = useMemo(
    () => (teamHalfId: string) =>
      buildAdminContextHref({
        targetPath: `/admin/team-parts/info/${clubId}/${teamHalfId}${half ? `?half=${half}` : ""}`,
        pathname,
        searchParams,
      }),
    [clubId, half, pathname, searchParams],
  );

  // ── 팝업 제어 ──
  const resetForm = () => {
    setTeamName("");
    setDescription("");
    setCrewCode("");
    setLeader(null);
    setLookupError(null);
  };
  const lookupCrew = async (
    code: string,
    notifyOnFail = false,
  ): Promise<LeaderCandidate | null> => {
    const c = code.trim();
    if (!c) return null;
    setLookingUp(true);
    setLookupError(null);
    setLeader(null);
    try {
      const res = await fetch(
        appendModeQuery(
          `/api/admin/team-parts/crew-lookup?code=${encodeURIComponent(c)}&organization=${encodeURIComponent(activeOrg)}`,
          mode,
        ),
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? `조회 실패 (${res.status})`);
      }
      const cand = json.data as LeaderCandidate;
      setLeader(cand);
      return cand;
    } catch (e) {
      setLeader(null);
      const message = e instanceof Error ? e.message : "크루 조회 실패";
      setLookupError(message);
      if (notifyOnFail) {
        void adminDialog.alert({
          variant: "warning",
          title: "크루 호출 불가",
          description: message,
        });
      }
      return null;
    } finally {
      setLookingUp(false);
    }
  };
  const callCrew = () => lookupCrew(crewCode, true);

  const openModal = () => {
    if (!editable) return;
    setEditingTeam(null);
    resetForm();
    setModalOpen(true);
  };
  const openEditModal = (team: TeamDto) => {
    if (!editable) return;
    setEditingTeam(team);
    setTeamName(team.teamName);
    setDescription(team.description ?? "");
    setCrewCode(team.leaderCrewCode ?? "");
    setLeader(null);
    setLookupError(null);
    setModalOpen(true);
    if (team.leaderCrewCode) void lookupCrew(team.leaderCrewCode);
  };
  const closeModal = () => {
    setModalOpen(false);
    setEditingTeam(null);
    resetForm();
  };

  const canSubmit =
    teamName.trim().length > 0 &&
    teamName.trim().length <= MAX_TEAM_NAME &&
    description.trim().length > 0 &&
    description.trim().length <= MAX_TEAM_DESC &&
    leader != null &&
    (isEditMode || !atLimit) &&
    !registering;

  const submitTeam = async () => {
    if (!half || !leader) return;
    setRegistering(true);
    try {
      const res = await fetch(appendModeQuery(`/api/admin/team-parts/info`, mode), {
        method: isEditMode ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organization: activeOrg,
          halfKey: half,
          ...(isEditMode ? { teamHalfId: editingTeam!.teamHalfId } : {}),
          teamName: teamName.trim(),
          description: description.trim(),
          leaderCrewCode: (leader.crewCode ?? crewCode).trim(),
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(
          json?.error ?? `${isEditMode ? "수정" : "등록"} 실패 (${res.status})`,
        );
      }
      t.success(
        isEditMode ? "update" : "create",
        isEditMode ? "팀이 수정되었습니다." : "팀이 등록되었습니다.",
      );
      closeModal();
      await load(half);
    } catch (e) {
      setLookupError(
        e instanceof Error ? e.message : isEditMode ? "수정 실패" : "등록 실패",
      );
    } finally {
      setRegistering(false);
    }
  };

  const confirmDelete = async (target: TeamDto) => {
    if (!half) return;
    try {
      const res = await fetch(appendModeQuery(`/api/admin/team-parts/info`, mode), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organization: activeOrg,
          halfKey: half,
          teamHalfId: target.teamHalfId,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? `삭제 실패 (${res.status})`);
      }
      t.success("delete", "팀이 삭제 대기 상태로 전환되었습니다.");
      await load(half);
    } catch (e) {
      console.error("[team-parts/info] 팀 삭제 실패", e);
      t.error("delete");
    }
  };

  const requestDelete = (target: TeamDto) =>
    adminDialog.confirm({
      variant: "danger",
      title: "팀 삭제",
      description: `이 팀(${target.teamName})을 삭제하시겠습니까?`,
      confirmLabel: "삭제",
      onConfirm: () => confirmDelete(target),
    });

  return (
    <Card>
      {/* 전역 헤더 breadcrumb 마지막 칸을 실제 클럽명으로 교체(중복 조회 없음·slug 미노출). */}
      <AdminDetailTitle title={clubName} />
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          {/* 상세 페이지 breadcrumb(3단계) — 클럽 정보 > 팀 내역(목록 복귀) > 실제 클럽명.
              클럽 정보·팀 내역은 별도 인덱스 라우트가 없어 둘 다 기존 팀 내역 목록(/admin/team-parts/info)
              으로 이동한다(신규 경로 생성 금지). 마지막 클럽명은 현재 페이지이므로 링크 아님. */}
          <nav
            aria-label="현재 위치"
            className="flex min-w-0 items-center gap-1.5"
          >
            <Link
              href="/admin/team-parts/info"
              className="truncate rounded-sm text-sm text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:text-base"
            >
              클럽 정보
            </Link>
            <ChevronRight
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <Link
              href="/admin/team-parts/info"
              className="truncate rounded-sm text-sm text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:text-base"
            >
              팀 내역
            </Link>
            <ChevronRight
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span
              data-club-detail-name
              className="truncate text-sm font-semibold text-foreground sm:text-base"
            >
              {clubName}
            </span>
          </nav>
          <AdminHelp />
        </div>
      </CardHeader>
      <CardContent className="admin-section-stack-lg">
        {banner ? (
          <div
            className={
              "rounded-md px-3 py-2 text-sm " +
              (banner.kind === "success"
                ? "bg-emerald-50 text-emerald-700"
                : "bg-red-50 text-red-700")
            }
          >
            {banner.message}
          </div>
        ) : null}

        {/* 상단 조회 조건(해당 시기) + 팀 수·반기 편집 상태 */}
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
          <div className="flex shrink-0 items-center gap-2 text-sm font-semibold">
            <span className="inline-flex items-center gap-1">
              <span>● 해당 시기</span>
              <AdminHelpIconButton
                helpKey="admin.teamParts.info.filter.half"
                title="해당 시기"
              />
            </span>
            <select
              id="team-parts-half-select"
              className={SELECT_CLS}
              value={half ?? ""}
              onChange={(e) => onHalfChange(e.target.value)}
              disabled={loading}
            >
              {HALF_OPTIONS.map((hk) => (
                <option key={hk} value={hk}>
                  {formatHalf(hk)}
                  {hk === currentHalfKey ? " (현재)" : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="inline-flex items-center gap-1 text-sm">
              · 팀 수{" "}
              <strong id="team-parts-active-team-count" className="text-base">
                {teams.length}
              </strong>
              <span className="text-muted-foreground"> / {MAX_TEAMS_PER_CLUB}</span>
              <AdminHelpIconButton
                helpKey="admin.teamParts.info.summary.activeTeamCount"
                title="팀 수"
              />
            </span>
            <span className="inline-flex items-center gap-1">
              <span
                className={
                  "rounded-md px-2 py-1 text-xs " +
                  (editable
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-muted text-muted-foreground")
                }
              >
                {isCurrentHalf
                  ? "현재 반기 · 수정 가능"
                  : editable
                    ? "다음 반기 · 수정 가능"
                    : "과거 반기 · 조회 전용"}
              </span>
              <AdminHelpIconButton
                helpKey="admin.teamParts.info.summary.editableStatus"
                title="반기 편집 상태"
              />
            </span>
          </div>
        </div>

        {/* 조직별 현재 시점 현황(운영진·팀장 수·앰배서더·클러빙·정규/심화·파트/파트장·에이전트).
            ⚠ 위 '해당 시기' select 와 무관한 현재 접속 시점 값 — half 변경 시 이 숫자는 바뀌지 않는다.
            위 '· 팀 수 3 / 10'(선택 반기 실제 팀 entity 현황)과는 다른 의미다. */}
        <ClubCurrentSummaryStrip orgSlug={activeOrg} summary={summary} />

        {loading ? (
          <LoadingState active />
        ) : (
          <section className="space-y-3">
            {/* 등록된 팀 box 누적 */}
            {teams.map((team) => (
              <div
                key={team.teamHalfId}
                data-team-box={team.teamName}
                className="space-y-3 rounded-lg border border-zinc-300 bg-white p-4"
              >
                {/* Row 1: 팀명(→ 팀 상세 링크) · 개요 · 수정/삭제.
                    ⚠ 카드 전체가 아니라 팀 배지만 링크다. 수정·삭제 버튼은 기존 동작 유지(상세 이동 X). */}
                <div className="flex items-start gap-3">
                  <Link
                    href={teamDetailHref(team.teamHalfId)}
                    data-team-detail-link={team.teamHalfId}
                    className={
                      "shrink-0 rounded-md border px-3 py-1 text-sm font-bold outline-none transition hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring " +
                      CHIP_CLS[activeOrg]
                    }
                  >
                    {team.teamName}
                  </Link>
                  <span className="flex-1 rounded-md border border-input bg-muted/30 px-3 py-1.5 text-sm">
                    {dash(team.description)}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="inline-flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-team-edit={team.teamName}
                        disabled={!editable}
                        onClick={() => openEditModal(team)}
                      >
                        수정
                      </Button>
                      <AdminHelpIconButton
                        helpKey="admin.teamParts.info.action.edit"
                        title="팀 수정"
                      />
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-team-delete={team.teamName}
                        disabled={!editable}
                        onClick={() => void requestDelete(team)}
                      >
                        삭제
                      </Button>
                      <AdminHelpIconButton
                        helpKey="admin.teamParts.info.action.delete"
                        title="팀 삭제"
                      />
                    </span>
                  </div>
                </div>

                {/* Row 2: 팀장 프로필(프로필 정보만) */}
                <TeamLeaderProfileRow team={team} />

                {/* Row 3: 파트 목록 */}
                <TeamPartsRow
                  teamHalfId={team.teamHalfId}
                  teamName={team.teamName}
                  partCount={team.partCount}
                  partNames={team.partNames}
                />

                {/* Row 4: 현재 시점 크루 수(클러빙/정규/심화) — selectedHalf 무관. */}
                <TeamCurrentCrewStrip
                  teamHalfId={team.teamHalfId}
                  crew={team.currentCrew}
                />

                {/* 파트×주차 존재표는 클럽 상세에서 제거 — 팀 상세 페이지로 이동(데이터·API 무변경). */}
              </div>
            ))}

            {/* 빈 박스 — 클릭 시 팀 등록 팝업(현재·다음 반기). 과거 반기=비활성. */}
            <div className="relative">
              <button
                type="button"
                id="team-parts-register-box"
                onClick={openModal}
                disabled={!editable}
                aria-label="팀 등록"
                className={
                  "flex min-h-[140px] w-full items-center justify-center rounded-lg border-2 border-dashed text-lg font-bold transition-colors " +
                  (editable
                    ? "cursor-pointer border-zinc-300 text-zinc-600 hover:border-zinc-400 hover:bg-zinc-50"
                    : "cursor-not-allowed border-zinc-200 text-zinc-300")
                }
              >
                + 팀 등록
              </button>
              <div className="absolute right-2 top-2">
                <AdminHelpIconButton
                  helpKey="admin.teamParts.info.action.register"
                  title="팀 등록"
                  size="sm"
                />
              </div>
            </div>
          </section>
        )}
      </CardContent>

      {/* ── 팀 등록/수정 팝업 ─────────────────────────────── */}
      {modalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div
            id="team-parts-register-modal"
            className="max-h-[90vh] modal-w-xl overflow-y-auto rounded-xl bg-orange-50 p-6 shadow-xl ring-1 ring-foreground/10"
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold">
                {isEditMode ? "팀 수정" : "팀 등록"} · {clubName} ·{" "}
                {half ? formatHalf(half) : ""}
              </h2>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1">
                  <Button
                    type="button"
                    id="team-parts-register-submit"
                    onClick={submitTeam}
                    disabled={!canSubmit}
                  >
                    {registering
                      ? isEditMode
                        ? "확인 중…"
                        : "등록 중…"
                      : isEditMode
                        ? "확인"
                        : "등록"}
                  </Button>
                  <AdminHelpIconButton
                    helpKey="admin.teamParts.info.action.submit"
                    title="팀 등록·수정 저장"
                  />
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={closeModal}
                  aria-label="닫기"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {!isEditMode && atLimit ? (
              <div className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                한 클럽에는 최대 {MAX_TEAMS_PER_CLUB}개 팀까지만 등록할 수 있습니다.
              </div>
            ) : null}

            {/* 팀 명 / 팀 개요 */}
            <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="inline-flex items-center gap-1 font-semibold">
                  ● 팀 명
                  <AdminHelpIconButton
                    helpKey="admin.teamParts.info.field.teamName"
                    title="팀 명"
                  />
                </span>
                <Input
                  id="team-parts-name-input"
                  value={teamName}
                  maxLength={MAX_TEAM_NAME}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder={`팀 명 (최대 ${MAX_TEAM_NAME}자)`}
                />
                <span className="text-xs text-muted-foreground">
                  {teamName.length}/{MAX_TEAM_NAME}
                </span>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="inline-flex items-center gap-1 font-semibold">
                  ● 팀 개요
                  <AdminHelpIconButton
                    helpKey="admin.teamParts.info.field.description"
                    title="팀 개요"
                  />
                </span>
                <textarea
                  id="team-parts-desc-input"
                  value={description}
                  maxLength={MAX_TEAM_DESC}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={`팀 개요 (최대 ${MAX_TEAM_DESC}자)`}
                  rows={3}
                  className="rounded-md border border-input bg-background px-3 py-2 text-sm"
                />
                <span className="text-xs text-muted-foreground">
                  {description.length}/{MAX_TEAM_DESC}
                </span>
              </label>
            </div>

            {/* 팀장 - 크루코드 + 호출 + [6] 크루 정보 */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-[260px_1fr]">
              <div className="flex flex-col gap-2 text-sm">
                <span className="inline-flex items-center gap-1 font-semibold">
                  ● 팀장 · 크루 코드
                  <AdminHelpIconButton
                    helpKey="admin.teamParts.info.field.leaderCrewCode"
                    title="팀장 · 크루 코드"
                  />
                </span>
                <Input
                  id="team-parts-crewcode-input"
                  value={crewCode}
                  onChange={(e) => setCrewCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void callCrew();
                    }
                  }}
                  placeholder="크루 코드"
                />
                <div className="inline-flex items-center gap-1 self-start">
                  <Button
                    type="button"
                    id="team-parts-call-button"
                    variant="outline"
                    onClick={callCrew}
                    disabled={lookingUp || !crewCode.trim()}
                  >
                    {lookingUp ? "호출 중…" : "호출"}
                  </Button>
                  <AdminHelpIconButton
                    helpKey="admin.teamParts.info.action.lookupCrew"
                    title="크루 호출"
                  />
                </div>
                {lookupError ? (
                  <span className="text-xs text-red-600">{lookupError}</span>
                ) : null}
              </div>

              {/* [6] 크루 정보 */}
              <div
                id="team-parts-leader-info"
                className="min-h-[110px] rounded-md border border-sky-200 bg-sky-50 p-3 text-sm"
              >
                {leader ? (
                  <div className="space-y-1">
                    <div>
                      {dash(leader.name)} | {dash(leader.gender)} |{" "}
                      {formatBirth6(leader.birth6)} | {dash(leader.residence)}
                    </div>
                    <div>
                      {dash(leader.school)} 학교 | {dash(leader.major)} 학과
                    </div>
                    <div>
                      {dash(leader.classLabel)} | {dash(leader.teamName)} 팀 |{" "}
                      {dash(leader.partName)} 파트 |{" "}
                      {leader.successWeeks != null
                        ? `${leader.successWeeks} 주차`
                        : "-"}{" "}
                      | {dash(leader.gradeLabel)}
                    </div>
                  </div>
                ) : (
                  <span className="text-muted-foreground">
                    크루 코드를 입력하고 [호출]을 누르면 팀장 정보가 표시됩니다.
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
