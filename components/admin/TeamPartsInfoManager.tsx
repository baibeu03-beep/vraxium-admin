"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { readOrgParam } from "@/lib/adminOrgContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";
import { parseHalfKey } from "@/lib/teamHalf";

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
const TAB_ACTIVE_CLS = CHIP_CLS;

const SELECT_CLS =
  "rounded-md border border-input bg-background px-3 py-2 text-sm";

// 해당 시기 드롭다운 고정 옵션(2022 상반기 ~ 2026 하반기). 표시=formatHalf, 현재 반기 기본 선택.
//   편집 가능/현재 여부는 백엔드 SoT(isEditableHalf·currentHalfKey)로만 판정한다(프론트 재정의 금지).
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
function dash(v: string | number | null | undefined): string {
  return v === null || v === undefined || v === "" ? "-" : String(v);
}
function formatBirth6(b: string | null): string {
  if (!b || b.length < 6) return "-";
  return `${b.slice(0, 2)}. ${b.slice(2, 4)}. ${b.slice(4, 6)}`;
}

export default function TeamPartsInfoManager() {
  const searchParams = useSearchParams();
  const orgFromUrl = readOrgParam(searchParams);
  // QA 모드(?mode=test) — 팀 정보 조회에 전파(백엔드 filterTeamsByScope 와 정합: 테스트 (T)팀만).
  const mode = readScopeMode(searchParams);
  // 스코프 조직 = 상단 요약·집계(클럽 수/전체 팀 수)·하단 조직 탭이 공유하는 조회 대상.
  //   · 개별 경로(?org={slug}): URL org 1개.
  //   · 통합 경로(org 없음): 엥크레/오랑캐/팔랑크스 전체 — 상단에서 3개 클럽 팀 현황을 동시 조회한다.
  const scopeOrgs = useMemo(
    () => (orgFromUrl ? [orgFromUrl] : [...ORGANIZATIONS]),
    [orgFromUrl],
  );
  // 하단 관리 영역의 활성 조직: 개별=URL org 고정, 통합=페이지 내부 상태(기본 엥크레).
  //   조직 탭 클릭은 이 상태만 바꾸고 URL 에 org 를 붙이지 않는다(재진입 없음·배지=URL 기준 [통합] 유지).
  //   탭 전환은 재조회 없이 byOrg 캐시로 즉시 표시. 데이터/DTO/로더/저장·수정·삭제 액션은 개별·통합 동일.
  const [selectedOrg, setSelectedOrg] = useState<OrganizationSlug>(
    ORGANIZATIONS[0],
  );
  const activeOrg: OrganizationSlug = orgFromUrl ?? selectedOrg;

  const [half, setHalf] = useState<string | null>(null);
  const [currentHalfKey, setCurrentHalfKey] = useState<string | null>(null);
  // 편집 가능 = 백엔드 SoT(base.editable = isEditableHalf: 현재/다음 반기). 프론트 재정의 없음.
  const [editable, setEditable] = useState(false);
  const [byOrg, setByOrg] = useState<Record<string, TeamDto[]>>({});
  const [colsByOrg, setColsByOrg] = useState<Record<string, PartWeekColumn[]>>(
    {},
  );
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [banner, setBanner] = useState<Banner>(null);

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

  // 삭제 확인 팝업(삭제 대기 전환 대상).
  const [deleteTarget, setDeleteTarget] = useState<TeamDto | null>(null);
  const [deleting, setDeleting] = useState(false);

  const isEditMode = editingTeam != null;

  const load = useCallback(
    async (halfKey: string | null) => {
      setLoading(true);
      setBanner(null);
      try {
        // 스코프 조직(개별=1·통합=3)을 동일 로더로 조회 — 통합은 상단 요약에 3개 클럽 동시 표시.
        const results = await Promise.all(
          scopeOrgs.map(async (org) => {
            const params = new URLSearchParams({ organization: org });
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
            return json.data as InfoDto;
          }),
        );

        // 반기/편집가능은 조직 무관(isEditableHalf) → 첫 결과 기준. 조직별 팀·존재표는 map 으로 캐시.
        const base = results[0];
        setCurrentHalfKey(base.currentHalfKey);
        setHalf(base.selectedHalfKey);
        setEditable(base.editable);

        const map: Record<string, TeamDto[]> = {};
        const cols: Record<string, PartWeekColumn[]> = {};
        scopeOrgs.forEach((org, i) => {
          map[org] = results[i].teams;
          cols[org] = results[i].weekColumns ?? [];
        });
        setByOrg(map);
        setColsByOrg(cols);
      } catch (e) {
        setByOrg({});
        setColsByOrg({});
        setBanner({
          kind: "error",
          message: e instanceof Error ? e.message : "조회 실패",
        });
      } finally {
        setLoading(false);
      }
    },
    [mode, scopeOrgs],
  );

  useEffect(() => {
    // 스코프(orgFromUrl)·mode 변경 시 재조회. 하단 조직 탭 전환은 재조회 없이 byOrg 캐시로 즉시.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(null);
  }, [load]);

  const onHalfChange = (value: string) => {
    void load(value);
  };
  const isCurrentHalf = half != null && half === currentHalfKey;

  const clubCount = useMemo(
    () => scopeOrgs.filter((o) => (byOrg[o]?.length ?? 0) > 0).length,
    [byOrg, scopeOrgs],
  );
  const totalTeams = useMemo(
    () => scopeOrgs.reduce((sum, o) => sum + (byOrg[o]?.length ?? 0), 0),
    [byOrg, scopeOrgs],
  );
  // 하단 관리 = 활성 조직 팀(개별=URL org, 통합=내부 선택 조직). byOrg 캐시로 탭 전환 즉시.
  const activeTeams = byOrg[activeOrg] ?? [];
  // 파트×주차 x축 = 활성 조직 weekColumns(탭 전환 시 재조회 없이 즉시). 없으면 첫 비어있지 않은 것.
  const weekColumns = useMemo(
    () =>
      colsByOrg[activeOrg]?.length
        ? colsByOrg[activeOrg]
        : (scopeOrgs.map((o) => colsByOrg[o]).find((c) => c && c.length) ?? []),
    [colsByOrg, activeOrg, scopeOrgs],
  );
  const atLimit = activeTeams.length >= MAX_TEAMS_PER_CLUB;

  // ── 팝업 제어 ──
  const resetForm = () => {
    setTeamName("");
    setDescription("");
    setCrewCode("");
    setLeader(null);
    setLookupError(null);
  };
  // 크루코드로 팀장 정보 호출. 인자 code 우선(수정 모드 프리필), 없으면 입력값.
  const lookupCrew = async (code: string): Promise<LeaderCandidate | null> => {
    const c = code.trim();
    if (!c) return null;
    setLookingUp(true);
    setLookupError(null);
    setLeader(null);
    try {
      const res = await fetch(
        appendModeQuery(
          `/api/admin/team-parts/crew-lookup?code=${encodeURIComponent(c)}`,
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
      setLookupError(e instanceof Error ? e.message : "크루 조회 실패");
      return null;
    } finally {
      setLookingUp(false);
    }
  };
  const callCrew = () => lookupCrew(crewCode);

  const openModal = () => {
    if (!editable) return;
    setEditingTeam(null);
    resetForm();
    setModalOpen(true);
  };
  // [수정] — 같은 팝업을 수정 모드로. 기존 값 프리필 + 팀장 정보 자동 호출.
  const openEditModal = (t: TeamDto) => {
    if (!editable) return;
    setEditingTeam(t);
    setTeamName(t.teamName);
    setDescription(t.description ?? "");
    setCrewCode(t.leaderCrewCode ?? "");
    setLeader(null);
    setLookupError(null);
    setModalOpen(true);
    if (t.leaderCrewCode) void lookupCrew(t.leaderCrewCode);
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
    setBanner(null);
    try {
      const res = await fetch(
        appendModeQuery(`/api/admin/team-parts/info`, mode),
        {
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
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(
          json?.error ?? `${isEditMode ? "수정" : "등록"} 실패 (${res.status})`,
        );
      }
      setBanner({
        kind: "success",
        message: isEditMode ? "팀이 수정되었습니다." : "팀이 등록되었습니다.",
      });
      closeModal();
      await load(half);
    } catch (e) {
      // 팝업은 유지하고 오류 노출(재시도 가능).
      setLookupError(
        e instanceof Error ? e.message : isEditMode ? "수정 실패" : "등록 실패",
      );
    } finally {
      setRegistering(false);
    }
  };

  // [삭제] 확인 → 삭제 대기(is_active=false) 전환.
  const confirmDelete = async () => {
    if (!half || !deleteTarget) return;
    setDeleting(true);
    setBanner(null);
    try {
      const res = await fetch(
        appendModeQuery(`/api/admin/team-parts/info`, mode),
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            organization: activeOrg,
            halfKey: half,
            teamHalfId: deleteTarget.teamHalfId,
          }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? `삭제 실패 (${res.status})`);
      }
      setBanner({
        kind: "success",
        message: "팀이 삭제 대기 상태로 전환되었습니다.",
      });
      setDeleteTarget(null);
      await load(half);
    } catch (e) {
      setBanner({
        kind: "error",
        message: e instanceof Error ? e.message : "삭제 실패",
      });
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle>팀 내역</CardTitle>
          <AdminHelp />
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
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

        {/* ── [섹션.1] 요약 ─────────────────────────────── */}
        <section className="rounded-lg border border-dashed border-red-300 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
            {/* 좌: 조회 조건(해당 시기) */}
            <div className="flex items-center gap-2 text-sm font-semibold">
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
            {/* 우: 요약 지표 */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <span className="inline-flex items-center gap-1 text-sm">
                · 클럽 수{" "}
                <strong id="team-parts-club-count" className="text-base">
                  {clubCount}
                </strong>
                <AdminHelpIconButton
                  helpKey="admin.teamParts.info.summary.clubCount"
                  title="클럽 수"
                />
              </span>
              <span className="inline-flex items-center gap-1 text-sm">
                · 전체 팀 수{" "}
                <strong id="team-parts-total-team-count" className="text-base">
                  {totalTeams}
                </strong>
                <AdminHelpIconButton
                  helpKey="admin.teamParts.info.summary.totalTeams"
                  title="전체 팀 수"
                />
              </span>
            </div>
          </div>

          {loading ? (
            <LoadingState active />
          ) : (
            <div className="space-y-4 rounded-md bg-sky-50 p-4">
              {scopeOrgs.map((org) => {
                const teams = byOrg[org] ?? [];
                return (
                  <div
                    key={org}
                    data-club-row={org}
                    className="flex items-start gap-4"
                  >
                    <div className="w-20 shrink-0 pt-1 text-sm font-bold">
                      {CLUB_LABEL[org]}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-3">
                      {teams.length === 0 ? (
                        <span className="text-sm text-muted-foreground">
                          팀 없음
                        </span>
                      ) : (
                        teams.map((t) => (
                          <div
                            key={t.teamName}
                            className="flex flex-col items-center gap-1"
                          >
                            <span
                              className={
                                "rounded-md border px-3 py-1 text-sm font-bold " +
                                CHIP_CLS[org]
                              }
                            >
                              {t.teamName}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {dash(t.leaderName)}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── [섹션.2] 조직 탭 + 팀 등록 박스 ── */}
        {!loading ? (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
              {/* 좌: 조직 선택(탭) */}
              <div className="flex flex-wrap items-center gap-3">
                {/* 조직 탭 = 페이지 내부 상태 전환(버튼). 통합 경로=엥크레/오랑캐/팔랑크스 클릭 시
                    URL 불변으로 활성 조직만 전환. 개별 경로=현재 조직 탭 1개(고정·전환 불가). */}
                <div className="flex gap-1">
                  {scopeOrgs.map((org) => {
                    const active = activeOrg === org;
                    return (
                      <button
                        key={org}
                        type="button"
                        data-org-tab={org}
                        aria-current={active ? "page" : undefined}
                        aria-pressed={active}
                        onClick={() => {
                          // 개별 경로(URL org 고정)는 전환하지 않는다 — 통합 경로만 내부 상태 변경.
                          if (!orgFromUrl) setSelectedOrg(org);
                        }}
                        className={
                          "rounded-md border px-3 py-1.5 text-sm font-bold transition-colors " +
                          (active
                            ? TAB_ACTIVE_CLS[org]
                            : "border-input bg-background text-muted-foreground hover:bg-muted")
                        }
                      >
                        {CLUB_LABEL[org]}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* 우: 팀 수 · 반기 편집 상태 — 활성 조직 기준(개별=URL org, 통합=내부 선택). */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <span className="inline-flex items-center gap-1 text-sm">
                  · 팀 수{" "}
                  <strong
                    id="team-parts-active-team-count"
                    className="text-base"
                  >
                    {activeTeams.length}
                  </strong>
                  <span className="text-muted-foreground">
                    {" "}
                    / {MAX_TEAMS_PER_CLUB}
                  </span>
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

            {/* 등록된 팀 box 누적(위) — 시안 [4]. 하단 주차별 내역 영역은 범위 제외. */}
            {activeTeams.map((t) => (
              <div
                key={t.teamHalfId}
                data-team-box={t.teamName}
                className="space-y-3 rounded-lg border border-zinc-300 bg-white p-4"
              >
                {/* Row 1: 팀명 · 개요 · 수정/삭제 */}
                <div className="flex items-start gap-3">
                  <span
                    className={
                      "shrink-0 rounded-md border px-3 py-1 text-sm font-bold " +
                      CHIP_CLS[activeOrg]
                    }
                  >
                    {t.teamName}
                  </span>
                  <span className="flex-1 rounded-md border border-input bg-muted/30 px-3 py-1.5 text-sm">
                    {dash(t.description)}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="inline-flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        data-team-edit={t.teamName}
                        disabled={!editable}
                        onClick={() => openEditModal(t)}
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
                        data-team-delete={t.teamName}
                        disabled={!editable}
                        onClick={() => setDeleteTarget(t)}
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

                {/* Row 2: 팀장 기본정보 · 파트 수 · 파트 칩 */}
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span
                    data-team-leader-name={t.teamName}
                    className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 font-medium"
                  >
                    {dash(t.leaderName)}
                  </span>
                  <span className="text-muted-foreground">
                    {formatBirth6(t.leaderBirth6)}
                  </span>
                  <span className="text-muted-foreground">
                    {dash(t.leaderGender)}
                  </span>
                  <span className="text-muted-foreground">
                    {dash(t.leaderSchool)}
                    {t.leaderMajor ? `, ${t.leaderMajor}` : ""}
                  </span>
                  <span className="text-muted-foreground">
                    {dash(t.leaderResidence)}
                  </span>
                  <span
                    data-team-leader-class={t.teamName}
                    className="text-muted-foreground"
                  >
                    {dash(t.leaderClassLabel)}
                  </span>
                  <span
                    data-team-leader-grade={t.teamName}
                    className="text-muted-foreground"
                  >
                    {dash(t.leaderGradeLabel)}
                  </span>
                  <span className="ml-2">
                    · 파트 수{" "}
                    <strong data-team-partcount={t.teamName}>
                      {t.partCount}
                    </strong>
                  </span>
                  <span
                    className="flex flex-wrap gap-1"
                    data-team-parts={t.teamName}
                  >
                    {t.partNames.map((p) => (
                      <span
                        key={p}
                        className="rounded-md border border-input bg-background px-2 py-0.5 text-xs font-medium"
                      >
                        {p}
                      </span>
                    ))}
                  </span>
                </div>

                {/* Row 3: 파트 × 주차 존재표 — 시안 [5]. 가로 스크롤. */}
                {t.partWeekMatrix && weekColumns.length > 0 ? (
                  <div className="space-y-1">
                    <div
                      className="overflow-x-auto rounded-md border border-zinc-200"
                      data-part-week-table={t.teamName}
                    >
                      <table className="border-collapse text-xs">
                        <thead>
                          <tr>
                            <th className="sticky left-0 z-10 border-b border-r bg-zinc-50 px-2 py-1 text-left font-semibold whitespace-nowrap">
                              <span className="inline-flex items-center gap-1">
                                파트 \ 주차
                                <AdminHelpIconButton
                                  helpKey="admin.teamParts.info.column.partWeekMatrix"
                                  title="파트 × 주차 존재표"
                                />
                              </span>
                            </th>
                            {weekColumns.map((c) => (
                              <th
                                key={c.weekStartDate}
                                className={
                                  "border-b border-r px-1.5 py-1 text-center font-medium whitespace-nowrap " +
                                  (c.isRest
                                    ? "bg-zinc-100 text-zinc-400"
                                    : "bg-zinc-50")
                                }
                              >
                                {c.label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {t.partWeekMatrix.partNames.map((p, pi) => (
                            <tr key={p} data-pw-row={p}>
                              <td className="sticky left-0 z-10 border-b border-r bg-white px-2 py-1 font-medium whitespace-nowrap">
                                {p}
                              </td>
                              {weekColumns.map((c, wi) => {
                                const on = Boolean(
                                  t.partWeekMatrix?.present[pi]?.[wi],
                                );
                                return (
                                  <td
                                    key={c.weekStartDate}
                                    data-pw-cell={on ? "1" : "0"}
                                    className={
                                      "border-b border-r px-1.5 py-1 text-center " +
                                      (c.isRest ? "bg-zinc-50/60" : "")
                                    }
                                  >
                                    {on ? (
                                      <span className="text-emerald-600">
                                        ●
                                      </span>
                                    ) : (
                                      ""
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}

            {/* 빈 박스 — 클릭 시 팀 등록 팝업(현재·다음 반기). 과거 반기=비활성.
                활성 조직(개별=URL org, 통합=내부 선택) 기준으로 등록. */}
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
        ) : null}
      </CardContent>

      {/* ── 삭제 확인 팝업 ─────────────────────────────────── */}
      {deleteTarget ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !deleting)
              setDeleteTarget(null);
          }}
        >
          <div
            id="team-parts-delete-modal"
            className="modal-w-sm rounded-lg bg-white p-6 shadow-xl"
          >
            <p className="mb-5 text-sm font-medium">
              이 팀을 삭제하시겠습니까?
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
              >
                취소
              </Button>
              <Button
                type="button"
                id="team-parts-delete-confirm"
                size="sm"
                disabled={deleting}
                onClick={confirmDelete}
              >
                {deleting ? "삭제 중…" : "확인"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

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
                {isEditMode ? "팀 수정" : "팀 등록"} · {CLUB_LABEL[activeOrg]} ·{" "}
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
                한 클럽에는 최대 {MAX_TEAMS_PER_CLUB}개 팀까지만 등록할 수
                있습니다.
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
