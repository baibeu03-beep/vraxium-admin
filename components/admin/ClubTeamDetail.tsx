"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
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
import { parseHalfKey } from "@/lib/teamHalf";
import { useActionToast } from "@/lib/actionToast";

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
function dash(v: string | number | null | undefined): string {
  return v === null || v === undefined || v === "" ? "-" : String(v);
}
function formatBirth6(b: string | null): string {
  if (!b || b.length < 6) return "-";
  return `${b.slice(0, 2)}. ${b.slice(2, 4)}. ${b.slice(4, 6)}`;
}

// 팀장 메타 정보 행 — 표시 가능한 항목만 배열로 모아 "항목 사이에만" | 구분자를 렌더한다(기존 로직 보존).
function TeamLeaderMeta({ team }: { team: TeamDto }) {
  const schoolMajor = team.leaderSchool
    ? team.leaderMajor
      ? `${team.leaderSchool}, ${team.leaderMajor}`
      : team.leaderSchool
    : null;
  const birth =
    team.leaderBirth6 && team.leaderBirth6.length >= 6
      ? formatBirth6(team.leaderBirth6)
      : null;

  const items: { key: string; node: ReactNode }[] = [];
  items.push({
    key: "name",
    node: (
      <span
        data-team-leader-name={team.teamName}
        className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 font-medium"
      >
        {dash(team.leaderName)}
      </span>
    ),
  });
  const pushText = (
    key: string,
    value: string | null,
    dataAttr?: Record<string, string>,
  ) => {
    if (!value) return;
    items.push({
      key,
      node: (
        <span className="text-muted-foreground" {...dataAttr}>
          {value}
        </span>
      ),
    });
  };
  pushText("birth", birth);
  pushText("gender", team.leaderGender);
  pushText("school", schoolMajor);
  pushText("residence", team.leaderResidence);
  pushText("class", team.leaderClassLabel, { "data-team-leader-class": team.teamName });
  pushText("grade", team.leaderGradeLabel, { "data-team-leader-grade": team.teamName });
  items.push({
    key: "partcount",
    node: (
      <span className="text-muted-foreground">
        파트 수{" "}
        <strong data-team-partcount={team.teamName} className="text-foreground">
          {team.partCount}
        </strong>
      </span>
    ),
  });
  items.push({
    key: "parts",
    node: (
      <span className="flex flex-wrap gap-1" data-team-parts={team.teamName}>
        {team.partNames.map((p) => (
          <span
            key={p}
            className="rounded-md border border-input bg-background px-2 py-0.5 text-xs font-medium"
          >
            {p}
          </span>
        ))}
      </span>
    ),
  });

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {items.map((item, i) => (
        <span key={item.key} className="inline-flex items-center gap-2">
          {i > 0 ? (
            <span aria-hidden className="select-none text-muted-foreground/50">
              |
            </span>
          ) : null}
          {item.node}
        </span>
      ))}
    </div>
  );
}

export default function ClubTeamDetail({ clubId }: { clubId: OrganizationSlug }) {
  const searchParams = useSearchParams();
  // QA 모드(?mode=test) — 팀 정보 조회에 전파(백엔드 filterTeamsByScope 와 정합).
  const mode = readScopeMode(searchParams);
  const activeOrg = clubId;
  const clubName = CLUB_LABEL[clubId];

  const [half, setHalf] = useState<string | null>(null);
  const [currentHalfKey, setCurrentHalfKey] = useState<string | null>(null);
  const [editable, setEditable] = useState(false);
  const [teams, setTeams] = useState<TeamDto[]>([]);
  const [weekColumns, setWeekColumns] = useState<PartWeekColumn[]>([]);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [banner, setBanner] = useState<Banner>(null);
  const t = useActionToast();

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
        setWeekColumns(dto.weekColumns ?? []);
      } catch (e) {
        setTeams([]);
        setWeekColumns([]);
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

  const onHalfChange = (value: string) => {
    void load(value);
  };
  const isCurrentHalf = half != null && half === currentHalfKey;
  const atLimit = teams.length >= MAX_TEAMS_PER_CLUB;

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
          {/* 상세 페이지 breadcrumb — 목록 복귀 링크 + 실제 클럽명. 클럽 탭은 URL 로 대체되어 없음. */}
          <nav
            aria-label="현재 위치"
            className="flex min-w-0 items-center gap-1.5"
          >
            <Link
              href="/admin/team-parts/info"
              className="truncate rounded-sm text-sm font-medium text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring sm:text-base"
            >
              클럽 정보
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
                {/* Row 1: 팀명 · 개요 · 수정/삭제 */}
                <div className="flex items-start gap-3">
                  <span
                    className={
                      "shrink-0 rounded-md border px-3 py-1 text-sm font-bold " +
                      CHIP_CLS[activeOrg]
                    }
                  >
                    {team.teamName}
                  </span>
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

                {/* Row 2: 팀장 기본정보 · 파트 수 · 파트 칩 */}
                <TeamLeaderMeta team={team} />

                {/* Row 3: 파트 × 주차 존재표 — 가로 스크롤 */}
                {team.partWeekMatrix && weekColumns.length > 0 ? (
                  <div className="space-y-1">
                    <div
                      className="overflow-x-auto rounded-md border border-zinc-200"
                      data-part-week-table={team.teamName}
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
                          {team.partWeekMatrix.partNames.map((p, pi) => (
                            <tr key={p} data-pw-row={p}>
                              <td className="sticky left-0 z-10 border-b border-r bg-white px-2 py-1 font-medium whitespace-nowrap">
                                {p}
                              </td>
                              {weekColumns.map((c, wi) => {
                                const on = Boolean(
                                  team.partWeekMatrix?.present[pi]?.[wi],
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
                                      <span className="text-emerald-600">●</span>
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
