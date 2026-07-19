"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, RotateCcw, Send, User } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { adminDialog } from "@/components/ui/admin-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import ExperienceOpeningProgressSteps from "@/components/admin/ExperienceOpeningProgressSteps";
import {
  resolveExperienceOpeningProgress,
  type ExperienceOpeningProgress,
} from "@/lib/experienceOpeningProgress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { Checkbox, checkedRowClass } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/toast";
import { LINE_OPENING_RESULT } from "@/lib/lineOpeningResultMessages";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { ADMIN_SHARED_HELP_KEYS } from "@/lib/adminSharedHelpKeys";
import { LoadingState } from "@/components/ui/loading-state";
import { readOrgParam } from "@/lib/adminOrgContext";
import { readScopeMode } from "@/lib/userScopeShared";
import { formatSeasonWeekLabel } from "@/lib/practicalInfoSection0Format";
import { formatTeamTabLabel } from "@/lib/teamLabel";
import ExperienceTeamOverallBoard from "@/components/admin/ExperienceTeamOverallBoard";
import type {
  ExperienceLineManageSummary,
  LineManageTeamLeader,
} from "@/lib/experienceLineManageTypes";
import {
  EMPTY_PART_INPUT_LINE_OPTIONS,
  EXPERIENCE_PART_LINE_TYPES,
  PART_CELL_DEFAULT,
  TEAM_OVERALL,
  displayCrewStatusLabel,
  isPartCellFail,
  experienceScoreState,
  type ExperiencePartLineType,
  type PartInputActor,
  type PartInputCell,
  type PartInputCellDto,
  type PartInputGetData,
  type PartInputLineOptions,
} from "@/lib/experiencePartInputTypes";
import ExperienceLineSelect from "@/components/admin/cluster4/ExperienceLineSelect";
import type { ExperienceTeamOverallBoard as OverallBoardDto } from "@/lib/experienceTeamOverallTypes";

// 실무 경험 [라인 개설] — 파트장 입력 그리드(additive).
//   팀 탭(동적) + 개설 주차(openable) + 파트 드롭다운(팀 총괄+parts) + 크루×라인 체크/점수 + 신청/취소.
//   기존 [라인 관리]·experience_drafts·snapshot 무관 — 신규 전용 저장.

type Team = { id: string; teamName: string };
type WeekOption = {
  id: string;
  label: string;
  weekNumber: number;
  seasonName: string;
  year: number;
  startDate: string;
  endDate: string;
  canOpen: boolean;
  isCurrent: boolean;
  isOpenTarget: boolean;
};

const cellKey = (crewUserId: string, lineType: ExperiencePartLineType) =>
  `${crewUserId}:${lineType}`;

// 완료 옵션 배경 강조. focus/hover(bg-accent)는 pseudo-class 우선순위로 이 위를 덮으므로
//   완료 배경과 현재 hover/선택 강조가 서로 잡아먹지 않는다(색상만 의존 금지 → 체크 아이콘 병기).
const COMPLETED_ITEM_CLS = "bg-emerald-50 dark:bg-emerald-950/30";

// 파트 드롭다운 옵션 라벨 — 완료 시 라벨 좌측에 체크(현재 선택 체크와 위치 분리).
//   체크는 aria-hidden(색상 무의존) — 접근성 문구는 SelectItem aria-label 로 전달한다.
function PartOptionLabel({
  label,
  completed,
}: {
  label: string;
  completed: boolean;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {completed && (
        <Check
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
        />
      )}
      <span className="min-w-0 break-words">{label}</span>
    </span>
  );
}

export default function ExperiencePartLeadInput({
  onActivity,
}: {
  // 신청/취소·팀총괄 검수/완료/취소 직후 상위(상태창·로그창) 갱신 신호.
  onActivity?: () => void;
} = {}) {
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const org = readOrgParam(searchParams);
  // 모집단 모드(operating 기본 / ?mode=test). 운영 화면은 mode 미부착이라 기존 동작 불변.
  const mode = readScopeMode(searchParams);
  // 임퍼소네이션 대상(mode=test 동반 시에만 서버가 인정). actor 가 이 유저 기준으로 내려온다.
  const actAsTestUserId =
    mode === "test" ? searchParams?.get("actAsTestUserId")?.trim() || null : null;
  // line-manage(팀장 표시) 등 mode 전파용 suffix. teams 목록엔 actAs 불필요(모드 스코프).
  const modeQs = mode === "test" ? "&mode=test" : "";

  const [teams, setTeams] = useState<Team[]>([]);
  const [weekOptions, setWeekOptions] = useState<WeekOption[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  // 선택 주차는 URL(?week)에 보존 — 새로고침 후에도 유지되고, 로그창(ExperienceOpeningLogPanel)이
  //   같은 주차를 조회하도록 SoT 를 URL 로 통일한다. 초기값 = URL 의 ?week(있으면).
  const [selectedWeekId, setSelectedWeekId] = useState<string>(
    () => searchParams?.get("week")?.trim() || "",
  );
  // 기본 파트는 부트 후 parts 효과에서 실제 파트로 설정된다(팀 총괄은 사용자가 명시 선택 시에만).
  const [part, setPart] = useState<string>("");
  const [actor, setActor] = useState<PartInputActor | null>(null);
  const [parts, setParts] = useState<string[]>([]);

  const [data, setData] = useState<PartInputGetData | null>(null);
  const [localCells, setLocalCells] = useState<Map<string, PartInputCell>>(
    new Map(),
  );

  const [bootLoading, setBootLoading] = useState(true);
  const [partsLoading, setPartsLoading] = useState(false);
  const [gridLoading, setGridLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── 개설 신청 상태(SoT = team-overall 서버 응답) ──
  //   상단 상태 UI + 파트 드롭다운 체크가 공유하는 단일 원천. (org, team, week) 스코프이며
  //   part/모드/임퍼소네이션과 무관하게 동일 — 운영/테스트/actAs 경로가 같은 값을 본다.
  //     · partSubmitted[partName] = 해당 파트 [개설 신청] 완료 여부(OverallBoardPart.submitted).
  //     · opened                  = 팀 총괄 최종 [개설 완료] 여부(board.status === "opened").
  //   신청/완료/취소 API 성공(onActivity) 후 statusKey 를 올려 서버에서 재조회한다(낙관적 갱신 금지).
  const [openingStatus, setOpeningStatus] = useState<{
    partSubmitted: Record<string, boolean>;
    boardStatus: OverallBoardDto["status"];
    allPartsApplied: boolean;
    // 선택 주차·팀이 실무 경험 라인 개설 기간인가(SoT = team-overall board.canOpen). false 면 개설 신청/완료 차단.
    canOpen: boolean;
    openBlockedReason: string | null;
  } | null>(null);
  const [statusKey, setStatusKey] = useState(0);
  // 신청/취소·검수/완료/취소 직후: 상단 상태 재조회(statusKey) + 상위(상태창/로그) 갱신.
  const handleActivity = useCallback(() => {
    setStatusKey((k) => k + 1);
    onActivity?.();
  }, [onActivity]);

  const selectedTeam = useMemo(
    () => teams.find((t) => t.id === selectedTeamId) ?? null,
    [teams, selectedTeamId],
  );

  // ── 임퍼소네이션 게이팅(프론트 UX) ──
  //   actor.impersonating=true 면 actor 의 memberRole/team/part 로 접근을 좁힌다.
  //   owner/admin(임퍼 없음)은 impersonating=false → 게이팅 미적용(전체 접근 유지).
  //   ⚠ UX 차단일 뿐 — 실제 보안 경계(write 가드)는 Phase C 서버에서.
  const impersonating = actor?.impersonating === true;
  const lockedTeamName = impersonating ? actor?.teamName ?? null : null;
  const actorMemberRole = impersonating ? actor?.memberRole ?? null : null;
  // part_leader 만 자기 파트로 고정. team_leader/agent 는 팀 범위(파트 자유).
  const lockedPartName =
    impersonating && actorMemberRole === "part_leader" ? actor?.partName ?? null : null;
  const teamAllowed = useCallback(
    (teamName: string) => !lockedTeamName || teamName === lockedTeamName,
    [lockedTeamName],
  );

  // 팀 활동 책임자(팀장) — 라인 관리 DTO(teamLeader)를 SoT 로 재사용. 팀명 → 팀장 맵(org 1회 조회).
  //   teamLeader 는 현재 멤버십 기준(주차 무관) — 선택 팀이 바뀌면 맵 조회로 즉시 갱신(하드코딩 없음).
  const [teamLeaders, setTeamLeaders] = useState<Map<string, LineManageTeamLeader>>(
    new Map(),
  );
  useEffect(() => {
    if (!org) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/admin/cluster4/experience/line-manage?organization=${encodeURIComponent(org)}${modeQs}`,
        );
        const json = await res.json();
        if (cancelled || !json?.success) return;
        const m = new Map<string, LineManageTeamLeader>();
        for (const t of (json.data as ExperienceLineManageSummary).teams) {
          if (t.teamLeader) m.set(t.teamName, t.teamLeader);
        }
        setTeamLeaders(m);
      } catch {
        /* 조회 실패 — 책임자 미표시(미지정). */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org, modeQs]);

  // 현재 선택 팀의 팀장 표시 문구. 없으면 "미지정".
  const selectedLeaderText = useMemo(() => {
    const leader = selectedTeam ? teamLeaders.get(selectedTeam.teamName) : null;
    if (!leader) return "미지정";
    const academic = [leader.school, leader.department]
      .filter((v): v is string => !!v && v.trim() !== "")
      .join(" ");
    return `${leader.name} 팀장${academic ? ` (${academic})` : ""}`;
  }, [selectedTeam, teamLeaders]);

  // ── 부트스트랩: teams + weeks-options + actor(org만) ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) setBootLoading(true);
      try {
        const qsOrg = org ? `?organization=${encodeURIComponent(org)}` : "";
        // 팀 목록·part-input 모두 mode 전파(operating=운영 팀/실사용자, test=(T) 팀/테스트 유저).
        const modeParam = mode === "test" ? (qsOrg ? "&mode=test" : "?mode=test") : "";
        // actor 조회엔 actAsTestUserId 까지 부착 → 임퍼소네이션 액터(role/team/part) 수신.
        //   actAsParam('&...')는 항상 qsOrg('?...') 또는 modeParam('?mode=test') 의 '?' 뒤에 온다.
        const actAsParam = actAsTestUserId ? `&actAsTestUserId=${actAsTestUserId}` : "";
        const [teamsRes, weeksRes, statusRes, actorRes] = await Promise.all([
          fetch(`/api/admin/cluster4/teams${qsOrg}${modeParam}`),
          // weeks-options 는 공용 SoT — ?mode 전달로 테스트 휴식꼬리에서 W13 을 드롭다운 목록에
          // 포함시킨다(operating 은 미부착=byte-identical). 개설 대상 주차 권위는 아래 opening-status.
          //   ?org·?hub=experience 전달 → line_opening_windows 예외를 org+경험 스코프로만 드롭다운에 노출.
          fetch(
            `/api/admin/cluster4/weeks-options?limit=3${modeQs}${
              org ? `&org=${encodeURIComponent(org)}` : ""
            }&hub=experience`,
          ),
          fetch(`/api/admin/cluster4/experience/opening-status${qsOrg}${modeParam}`),
          fetch(`/api/admin/cluster4/experience/part-input${qsOrg}${modeParam}${actAsParam}`),
        ]);
        const teamsJson = await teamsRes.json();
        const weeksJson = await weeksRes.json();
        const statusJson = await statusRes.json();
        const actorJson = await actorRes.json();
        if (cancelled) return;

        const teamList: Team[] = teamsJson?.success
          ? (teamsJson.data ?? []).map((t: { id: string; teamName: string }) => ({
              id: t.id,
              teamName: t.teamName,
            }))
          : [];
        setTeams(teamList);

        const opts: WeekOption[] = weeksJson?.success
          ? weeksJson.data?.weeks ?? []
          : [];

        // 서버 권위 개설 대상 주차(테스트 모드+encre W13 예외 반영). targetWeekId 가 정규 limit=3
        // 윈도우 밖(예: 휴식 꼬리에서 W13)이면 드롭다운에 합성 옵션으로 추가하고 그 주차만 "개설대상"으로
        // 표기한다. 운영·타 조직은 target=정규 금요일경계 주차라 이미 opts 에 있으므로 회귀 0.
        const tw = statusJson?.success ? statusJson.data?.targetWeek ?? null : null;
        const targetWeekId: string | null = statusJson?.success
          ? statusJson.data?.targetWeekId ?? null
          : null;
        const targetOption: WeekOption | null =
          tw && targetWeekId
            ? {
                id: targetWeekId,
                label: `${tw.year} ${tw.seasonName} W${tw.weekNumber}`,
                weekNumber: tw.weekNumber,
                seasonName: tw.seasonName,
                year: tw.year,
                startDate: tw.startDate,
                endDate: tw.endDate,
                canOpen: !tw.isOfficialRest,
                isCurrent: false,
                isOpenTarget: true,
              }
            : null;

        let mergedOpts = opts;
        if (targetOption && !opts.some((o) => o.id === targetOption.id)) {
          // 예외 대상이 정규 윈도우 밖 → 정규 isOpenTarget 라벨은 지우고 예외 주차만 개설대상 표기.
          mergedOpts = [
            ...opts.map((o) => ({ ...o, isOpenTarget: false })),
            targetOption,
          ].sort((a, b) => b.startDate.localeCompare(a.startDate));
        }
        setWeekOptions(mergedOpts);

        // 기본 개설 주차 = 서버 권위 target(예외 반영) 우선, 실패 시 정규 isOpenTarget/현재/첫 주차.
        const fallbackWeek =
          opts.find((o) => o.isOpenTarget) ??
          opts.find((o) => o.isCurrent) ??
          opts[0];
        // ⚠ 시즌 경계 보정: 개설 대상 주차(금요일 경계 N-1)가 공식 휴식 주차(canOpen=false)면 —
        //   예: 여름 W1 진입 직후 수요일엔 N-1 이 이전 시즌 휴식주(봄 W17)로 떨어진다 — 실제 활동
        //   주차(현재 주차·canOpen)를 기본값으로 잡는다. 이렇게 해야 파트장 [개설 신청]과 에이전트
        //   [개설 검수]가 수동 선택 없이 같은 활동 주차(여름 W1)를 기본으로 보게 되어 정렬된다.
        //   (target 이 정상 개설 가능 주차면 기존 동작 그대로 — 회귀 없음.)
        const currentUsable = opts.find((o) => o.isCurrent && o.canOpen) ?? null;
        const targetUsable = targetOption && targetOption.canOpen ? targetOption : null;
        const defaultWeekId =
          targetUsable?.id ??
          currentUsable?.id ??
          targetOption?.id ??
          fallbackWeek?.id ??
          "";
        setSelectedWeekId((prev) => prev || defaultWeekId);

        const actorData: PartInputActor | null = actorJson?.success
          ? actorJson.data?.actor ?? null
          : null;
        setActor(actorData);
        // 기본 팀 = actor 팀(있으면) → 없으면 첫 팀. (기본 파트는 parts 효과에서 실제 파트로 설정)
        const defaultTeam =
          teamList.find((t) => t.teamName === actorData?.teamName) ?? teamList[0];
        setSelectedTeamId((prev) => prev || (defaultTeam?.id ?? ""));
      } catch {
        if (!cancelled) toast("error", "초기 데이터를 불러오지 못했습니다");
      } finally {
        if (!cancelled) setBootLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // org/mode 변경 시 재부트.
  }, [org, mode]);

  // ── 파트 목록 + 기본 파트(실제 파트 우선) — 팀 변경 시마다 ──
  // 기본 파트 = (actor 팀 & 파트장 & 본인 파트 존재) ? 본인 파트 : 첫 번째 실제 파트.
  //   → 진입 즉시 입력 그리드가 보인다. 팀 총괄(집계)은 사용자가 드롭다운에서 명시 선택할 때만.
  useEffect(() => {
    if (bootLoading) return;
    let cancelled = false;
    // setState 는 async 콜백 안에서만 호출(동기 cascading 렌더 방지).
    void (async () => {
      const team = teams.find((t) => t.id === selectedTeamId);
      if (!team) {
        if (!cancelled) setParts([]);
        return;
      }
      if (!cancelled) setPartsLoading(true);
      try {
        const qs = new URLSearchParams();
        if (org) qs.set("organization", org);
        qs.set("team_id", team.id);
        qs.set("team_name", team.teamName);
        if (mode === "test") qs.set("mode", "test");
        if (actAsTestUserId) qs.set("actAsTestUserId", actAsTestUserId);
        const res = await fetch(
          `/api/admin/cluster4/experience/part-input?${qs.toString()}`,
        );
        const json = await res.json();
        if (cancelled) return;
        const ps: string[] = json?.success ? json.data?.parts ?? [] : [];
        setParts(ps);
        // 기본 파트(요구사항 #5):
        //   파트장(본인 팀 & 본인 파트가 해당 팀에 존재) → 본인 파트
        //   팀장/에이전트 → 팀 총괄
        //   그 외(운영자/미지정) → 첫 실제 파트(진입 즉시 입력 그리드 노출)
        const isActorTeam = team.teamName === actor?.teamName;
        let defaultPart: string;
        if (
          isActorTeam &&
          actor?.role === "part_leader" &&
          actor?.partName &&
          ps.includes(actor.partName)
        ) {
          defaultPart = actor.partName;
        } else if (actor?.role === "team_leader" || actor?.role === "agent") {
          defaultPart = TEAM_OVERALL;
        } else {
          defaultPart = ps[0] ?? TEAM_OVERALL;
        }
        // 기존 선택이 새 팀에서도 유효하면 보존, 아니면 기본값으로 초기화(#5).
        setPart((prev) =>
          prev === TEAM_OVERALL || (prev && ps.includes(prev)) ? prev : defaultPart,
        );
      } catch {
        if (!cancelled) setParts([]);
      } finally {
        if (!cancelled) setPartsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootLoading, org, mode, selectedTeamId, teams, actor]);

  // part_leader 임퍼소네이션: 파트를 자기 파트로 강제(드롭다운 비활성 + 다른 값 방지).
  useEffect(() => {
    if (lockedPartName && part !== lockedPartName) setPart(lockedPartName);
  }, [lockedPartName, part]);

  // ── 그리드 데이터: (team, week, part) 조회 ──
  const fetchGrid = useCallback(async () => {
    // part 가 아직 정해지지 않은(부트 직후) 동안은 조회하지 않는다.
    if (!selectedTeam || !part) {
      setData(null);
      return;
    }
    setGridLoading(true);
    try {
      const qs = new URLSearchParams();
      if (org) qs.set("organization", org);
      if (selectedWeekId) qs.set("week_id", selectedWeekId);
      qs.set("team_id", selectedTeam.id);
      qs.set("team_name", selectedTeam.teamName);
      qs.set("part", part);
      if (mode === "test") qs.set("mode", "test");
      const res = await fetch(
        `/api/admin/cluster4/experience/part-input?${qs.toString()}`,
      );
      const json = await res.json();
      const d: PartInputGetData | null = json?.success ? json.data : null;
      setData(d);
      // localCells 초기화 — 저장된 셀 우선, 없으면 기본값(checked=true/score=7).
      if (d && part !== TEAM_OVERALL) {
        const saved = new Map<string, PartInputCell>();
        for (const c of d.cells) {
          saved.set(cellKey(c.crewUserId, c.lineType), {
            checked: c.checked,
            score: c.score,
            selectedLineId: c.selectedLineId ?? null,
          });
        }
        const next = new Map<string, PartInputCell>();
        for (const crew of d.crews) {
          for (const line of EXPERIENCE_PART_LINE_TYPES) {
            const k = cellKey(crew.userId, line.key);
            next.set(k, saved.get(k) ?? { ...PART_CELL_DEFAULT });
          }
        }
        setLocalCells(next);
      } else {
        setLocalCells(new Map());
      }
    } catch {
      setData(null);
      toast("error", "그리드 데이터를 불러오지 못했습니다");
    } finally {
      setGridLoading(false);
    }
  }, [org, mode, selectedTeam, selectedWeekId, part]);

  useEffect(() => {
    if (bootLoading) return;
    // setState 는 effect 본문이 아닌 async 콜백 안에서 호출(동기 cascading 렌더 방지).
    void (async () => {
      await fetchGrid();
    })();
  }, [bootLoading, fetchGrid]);

  // ── 개설 신청 상태 조회: (org, team, week) — part 무관 ──
  //   team-overall GET 을 SoT 로 재사용(추가 API/DTO 없음). 파트별 submitted + 팀총괄 opened 를 한 번에.
  //   GET 은 org/team/week 스코프라 mode=test/actAsTestUserId 여부와 무관하게 동일값 → 경로 공용 SoT.
  //   팀/주차 변경 시 자동 재조회(deps), 신청/완료/취소 성공 시 statusKey 로 재조회.
  useEffect(() => {
    if (bootLoading) return;
    let cancelled = false;
    // setState 는 effect 본문이 아닌 async 콜백 안에서 호출(동기 cascading 렌더 방지 — 파일 표준 패턴).
    void (async () => {
      if (!org || !selectedTeam || !selectedWeekId) {
        if (!cancelled) setOpeningStatus(null);
        return;
      }
      try {
        const qs = new URLSearchParams({
          organization: org,
          week_id: selectedWeekId,
          team_id: selectedTeam.id,
          team_name: selectedTeam.teamName,
        });
        if (mode === "test") qs.set("mode", "test");
        const res = await fetch(
          `/api/admin/cluster4/experience/team-overall?${qs.toString()}`,
        );
        const json = await res.json();
        if (cancelled) return;
        if (json?.success) {
          const b = json.data as OverallBoardDto;
          const map: Record<string, boolean> = {};
          for (const p of b.parts ?? []) map[p.partName] = p.submitted;
          setOpeningStatus({
            partSubmitted: map,
            boardStatus: b.status,
            allPartsApplied: b.application.allPartsApplied,
            // fail-closed: 구버전 응답(필드 없음)이면 false → 개설 신청/완료 UI 차단.
            canOpen: b.canOpen ?? false,
            openBlockedReason: b.openBlockedReason ?? null,
          });
        } else {
          setOpeningStatus(null);
        }
      } catch {
        // 조회 실패 — 상태 미표시(낙관적 완료 금지). 다음 조회에서 복구.
        if (!cancelled) setOpeningStatus(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootLoading, org, mode, actAsTestUserId, selectedTeam, selectedWeekId, statusKey]);

  // 팀 변경 — parts 효과가 그 팀의 기본 파트(실제 파트 우선)를 다시 정한다.
  //   임퍼소네이션 중에는 자기 팀 외 탭 클릭 시 팝업 후 차단(이동 안 함).
  const onSelectTeam = useCallback(
    (teamId: string) => {
      const target = teams.find((t) => t.id === teamId);
      if (target && !teamAllowed(target.teamName)) {
        void adminDialog.alert({
          variant: "warning",
          title: "입장 권한 없음",
          description: "해당 팀 입장 권한이 없습니다.",
        });
        return; // 차단 — 팀 전환하지 않음.
      }
      setSelectedTeamId(teamId);
    },
    [teams, teamAllowed],
  );

  const onSelectPart = useCallback((p: string) => {
    setPart(p);
  }, []);

  // 주차 변경 — 상태 + URL(?week) 동기화. URL 을 SoT 로 삼아 (a) 새로고침 후 선택 주차 유지,
  //   (b) 형제 로그창이 같은 주차의 개설 로그를 조회하게 한다(개설 대상 밖 예외 주차 포함).
  //   mode/org/actAs/tab 등 기존 쿼리는 보존하고 week 만 갱신. 소프트 네비게이션(상태 유지).
  const onSelectWeek = useCallback(
    (weekId: string) => {
      setSelectedWeekId(weekId);
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (weekId) params.set("week", weekId);
      else params.delete("week");
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [searchParams, pathname, router],
  );

  // 선택 주차를 URL(?week)에 반영 — 형제 상태창(LineOpeningStatusBoard)·로그창(ExperienceOpeningLogPanel)이
  //   같은 주차를 조회하도록 개설 탭 화면 단일 SoT 를 URL 로 통일한다. 최초 기본 주차(부트에서 결정)도
  //   이 효과가 URL 에 심어, 진입 직후부터 상태창·로그창이 그리드와 같은 선택 주차를 본다.
  //   (이전에는 기본 주차가 로컬 state 에만 설정돼 ?week 가 비어, 상태창이 오늘 기준 대상 주차로 어긋났다.)
  useEffect(() => {
    if (!selectedWeekId) return;
    const urlWeek = searchParams?.get("week")?.trim() || "";
    if (urlWeek === selectedWeekId) return;
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("week", selectedWeekId);
    router.replace(`${pathname}?${params.toString()}`);
  }, [selectedWeekId, searchParams, pathname, router]);

  // ── 셀 편집(체크/점수 연동) ──
  const updateCell = useCallback(
    (crewUserId: string, lineType: ExperiencePartLineType, next: PartInputCell) => {
      setLocalCells((prev) => {
        const m = new Map(prev);
        m.set(cellKey(crewUserId, lineType), next);
        return m;
      });
    },
    [],
  );

  const toggleCheck = useCallback(
    async (
      crewUserId: string,
      crewName: string,
      lineType: ExperiencePartLineType,
      cur: PartInputCell,
    ) => {
      // 체크 해제 → 점수 0. 재체크(점수 0이었으면) → 기본 7.
      const nextChecked = !cur.checked;
      const nextScore = nextChecked ? (cur.score === 0 ? 7 : cur.score) : 0;
      if (
        !nextChecked &&
        !(await adminDialog.confirm({
          title: "강화 실패 확인",
          description: `${crewName} 크루의 해당 라인이 <강화 실패>가 됩니다.\n이상이 없으신가요?`,
          confirmLabel: "확인",
          cancelLabel: "취소",
        }))
      ) return; // 취소 시 updateCell 미호출 → 기존 체크·점수·라인명 원상 복구.
      // 체크 해제 → 점수 0 + 라인 '-'(null). 재체크는 기존 라인 유지(해제 시 이미 null).
      updateCell(crewUserId, lineType, {
        checked: nextChecked,
        score: nextScore,
        selectedLineId: nextChecked ? cur.selectedLineId : null,
      });
    },
    [updateCell],
  );

  const setScore = useCallback(
    async (
      crewUserId: string,
      crewName: string,
      lineType: ExperiencePartLineType,
      score: number,
      cur: PartInputCell,
    ) => {
      // 점수 선택 → 체크 자동 ON.
      const next = experienceScoreState(score);
      if (
        !next.isReinforcementSuccess &&
        !(await adminDialog.confirm({
          title: "강화 실패 확인",
          description: `${crewName} 크루의 해당 라인이 <강화 실패>가 됩니다.\n이상이 없으신가요?`,
          confirmLabel: "확인",
          cancelLabel: "취소",
        }))
      ) return; // 취소 시 updateCell 미호출 → 기존 체크·점수·라인명 원상 복구.
      // 0점 → 라인 '-'(null). 1점 이상(1~3 강화실패 포함)은 선택 라인 유지(§4).
      updateCell(crewUserId, lineType, {
        checked: next.checked,
        score: next.score,
        selectedLineId: next.score >= 1 ? cur.selectedLineId : null,
      });
    },
    [updateCell],
  );

  // 라인명만 변경 — 체크/점수는 보존.
  const setLine = useCallback(
    (
      crewUserId: string,
      lineType: ExperiencePartLineType,
      selectedLineId: string | null,
      cur: PartInputCell,
    ) => {
      updateCell(crewUserId, lineType, { ...cur, selectedLineId });
    },
    [updateCell],
  );

  const getCell = useCallback(
    (crewUserId: string, lineType: ExperiencePartLineType): PartInputCell =>
      localCells.get(cellKey(crewUserId, lineType)) ?? { ...PART_CELL_DEFAULT },
    [localCells],
  );

  // ── 버튼 ──
  const resetLocal = useCallback(() => {
    if (!data) return;
    const next = new Map<string, PartInputCell>();
    for (const crew of data.crews) {
      for (const line of EXPERIENCE_PART_LINE_TYPES) {
        next.set(cellKey(crew.userId, line.key), { ...PART_CELL_DEFAULT });
      }
    }
    setLocalCells(next);
    toast("success", LINE_OPENING_RESULT.resetSuccess);
  }, [data]);

  const submit = useCallback(async () => {
    if (!selectedTeam || !selectedWeekId || part === TEAM_OVERALL) return;
    setSaving(true);
    try {
      const cells: PartInputCellDto[] = [];
      for (const crew of data?.crews ?? []) {
        for (const line of EXPERIENCE_PART_LINE_TYPES) {
          const c = getCell(crew.userId, line.key);
          cells.push({
            crewUserId: crew.userId,
            lineType: line.key,
            checked: c.checked,
            score: c.score,
            selectedLineId: c.selectedLineId,
          });
        }
      }
      const res = await fetch("/api/admin/cluster4/experience/part-input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization: org,
          week_id: selectedWeekId,
          team_id: selectedTeam.id,
          team_name: selectedTeam.teamName,
          part,
          cells,
          mode,
          // 임퍼소네이션 write 가드 활성용(서버가 mode=test+test_user_markers 검증).
          ...(actAsTestUserId ? { actAsTestUserId } : {}),
        }),
      });
      const json = await res.json();
      if (!json?.success) {
        toast("error", "신청에 실패했습니다");
        return;
      }
      toast("success", LINE_OPENING_RESULT.applySuccess);
      await fetchGrid();
      handleActivity();
    } catch {
      toast("error", "신청 중 오류가 발생했습니다");
    } finally {
      setSaving(false);
    }
  }, [selectedTeam, selectedWeekId, part, data, getCell, org, mode, actAsTestUserId, fetchGrid, handleActivity]);

  const cancelSubmission = useCallback(async () => {
    if (!selectedTeam || !selectedWeekId || part === TEAM_OVERALL) return;
    if (!data?.submitted) return; // 연속 2회 취소 방지(신청 상태에서만 가능)
    setSaving(true);
    try {
      const qs = new URLSearchParams();
      if (org) qs.set("organization", org);
      qs.set("week_id", selectedWeekId);
      qs.set("team_id", selectedTeam.id);
      qs.set("part", part);
      // 로그 실행자(파트장) 해석용 — POST 와 동일하게 mode/actAsTestUserId 전파.
      if (mode === "test") qs.set("mode", "test");
      if (actAsTestUserId) qs.set("actAsTestUserId", actAsTestUserId);
      const res = await fetch(
        `/api/admin/cluster4/experience/part-input?${qs.toString()}`,
        { method: "DELETE" },
      );
      const json = await res.json();
      if (!json?.success) {
        toast("error", "신청 취소에 실패했습니다");
        return;
      }
      toast("success", LINE_OPENING_RESULT.applyCancelSuccess);
      await fetchGrid();
      handleActivity();
    } catch {
      toast("error", "취소 중 오류가 발생했습니다");
    } finally {
      setSaving(false);
    }
  }, [selectedTeam, selectedWeekId, part, data, org, mode, actAsTestUserId, fetchGrid, handleActivity]);

  const isOverall = part === TEAM_OVERALL;
  const submitted = data?.submitted ?? false;

  // 개설 신청 상태 파생(SoT = openingStatus) — 상단 UI + 드롭다운 체크 공용.
  const overallCompleted = openingStatus?.boardStatus === "opened";
  const isPartCompleted = useCallback(
    (partName: string) => openingStatus?.partSubmitted[partName] ?? false,
    [openingStatus],
  );
  // 현재 선택(팀 총괄/파트)의 완료 여부 → 상단 상태 UI state.
  const currentProgress: ExperienceOpeningProgress = resolveExperienceOpeningProgress({
    // Team progress belongs to the team-overall tab only. A part remains at its
    // own submitted/not-submitted stage even after the team is reviewed/opened.
    opened: isOverall && openingStatus?.boardStatus === "opened",
    reviewCompleted: isOverall && openingStatus?.boardStatus === "reviewed",
    applicationCompleted: isOverall
      ? openingStatus?.allPartsApplied ?? false
      : isPartCompleted(part),
  });
  // 트리거의 "업무 완료" 체크 — 드롭다운 옵션과 동일한 완료 기준을 사용한다(진행 단계 ≠ 완료).
  //   · 팀 총괄: 최종 [개설 완료] 성공(boardStatus === "opened")일 때만. 신청 완료/검수 완료/임시저장은 완료 아님.
  //   · 개별 파트: 해당 파트 [개설 신청] 완료(submitted).
  //   ⚠ currentProgress(신청/검수 단계 포함)로 판정하면 팀 총괄을 "선택"만 해도 체크가 붙어 혼동 → 금지.
  //     상단 진행 단계(ExperienceOpeningProgressSteps)는 currentProgress 를 그대로 쓰되, 여기 완료 체크는 분리한다.
  const selectionCompleted = isOverall ? overallCompleted : isPartCompleted(part);

  // 개설 기간 판정(선택 주차·팀) — SoT=openingStatus.canOpen(team-overall board.canOpen ← 주차 운영 설정).
  //   openingStatus 를 수신했고 canOpen=false 일 때만 "개설 기간 아님"으로 확정 차단한다(로딩/미선택 중
  //   조기 비활성 방지 — 서버 assertExperienceLineOpenable 이 최종 권위). 공식 휴식(isRest)과 별개 상태.
  const openPeriodBlocked = openingStatus != null && !openingStatus.canOpen;
  const openBlockedReason =
    openingStatus?.openBlockedReason ?? "선택한 주차는 실무 경험 라인의 개설 기간이 아닙니다.";

  // 개설 주차 라벨(트리거/옵션 공유) — 공통 Select 로 파트 드롭다운과 동일 높이 규칙(h-9) 적용.
  const renderWeekLabel = useCallback(
    (w: WeekOption) =>
      formatSeasonWeekLabel({
        year: w.year,
        seasonName: w.seasonName,
        weekNumber: w.weekNumber,
        isOpenTarget: w.isOpenTarget,
        isCurrent: w.isCurrent,
        isRest: !w.canOpen,
      }),
    [],
  );
  const selectedWeekOption = useMemo(
    () => weekOptions.find((w) => w.id === selectedWeekId) ?? null,
    [weekOptions, selectedWeekId],
  );

  if (!org) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="inline-flex items-center gap-1.5 text-base">
            파트장 입력
            <AdminHelpIconButton
              helpKey="admin.lineOpening.experience.title.partLeadInput"
              title="파트장 입력"
              size="xs"
            />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            클럽 분기 모드(?org)에서만 표시됩니다.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        {bootLoading ? (
          <LoadingState active variant="inline" />
        ) : (
          <>
            {/* 팀 탭(동적) */}
            <div role="tablist" className="flex flex-wrap gap-2 border-b pb-px">
              {teams.length === 0 ? (
                <span className="text-sm text-muted-foreground">
                  등록된 팀이 없습니다.
                </span>
              ) : (
                teams.map((t) => {
                  // 임퍼소네이션 중 자기 팀 외 탭은 잠금 표시(클릭 시 팝업 후 차단).
                  const locked = !teamAllowed(t.teamName);
                  const selected = selectedTeamId === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      onClick={() => onSelectTeam(t.id)}
                      aria-selected={selected}
                      aria-disabled={locked || undefined}
                      title={locked ? "해당 팀 입장 권한이 없습니다." : undefined}
                      className={cn(
                        "relative -mb-px rounded-t-md border border-b-0 px-4 py-2 text-sm transition-colors",
                        selected
                          ? // 선택 탭: 강조 배경 + 강조 테두리/글자색 + 굵기 + 하단 강조선(비선택과 명확히 구분, 다크 대응).
                            "border-primary bg-primary/10 font-semibold text-primary shadow-sm after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary"
                          : // 비선택 탭: 기존 muted 유지.
                            "border-transparent bg-muted/40 font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
                        locked && "cursor-not-allowed opacity-40",
                      )}
                    >
                      {formatTeamTabLabel(t.teamName)}
                      {locked && " 🔒"}
                    </button>
                  );
                })
              )}
              <AdminHelpIconButton
                helpKey="admin.lineOpening.experience.filter.team"
                title="팀 선택"
                size="xs"
                className="ml-auto self-center"
              />
            </div>

            {/* 개설 주차 + 파트 선택 */}
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-1">
                  <Label className="text-xs text-muted-foreground">개설 주차</Label>
                  <AdminHelpIconButton
                    helpKey="admin.lineOpening.experience.filter.week"
                    title="개설 주차"
                    size="xs"
                  />
                </div>
                {/* 파트 드롭다운과 동일한 공통 Select(base-ui) — h-9 flex 세로중앙 규칙 공유(텍스트 잘림 방지).
                    native select + 고정 높이는 content-box 압축으로 하단 잘림이 생겨 공통 컴포넌트로 통일. */}
                <Select
                  value={selectedWeekId}
                  onValueChange={(v: string | null) => {
                    if (v) onSelectWeek(v);
                  }}
                >
                  <SelectTrigger className="min-w-[16rem] max-w-full">
                    <SelectValue placeholder="개설 주차 선택">
                      {selectedWeekOption ? (
                        <span className="line-clamp-1">
                          {renderWeekLabel(selectedWeekOption)}
                        </span>
                      ) : undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {weekOptions.map((w) => (
                      <SelectItem key={w.id} value={w.id} disabled={!w.canOpen}>
                        {renderWeekLabel(w)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-1">
                  <Label className="text-xs text-muted-foreground">파트</Label>
                  <AdminHelpIconButton
                    helpKey="admin.lineOpening.experience.filter.part"
                    title="파트"
                    size="xs"
                  />
                </div>
                {/* 파트별 [개설 신청]/[개설 완료] 상태를 옵션에 표시(체크+배경) — SoT=openingStatus.
                    현재 선택 체크(우측, base-ui 기본)와 완료 체크(라벨 옆)는 위치가 달라 혼동되지 않는다. */}
                <Select
                  value={part}
                  onValueChange={(v: string | null) => {
                    if (v) onSelectPart(v);
                  }}
                  // part_leader 임퍼소네이션은 자기 파트로 고정(드롭다운 disable).
                  disabled={Boolean(lockedPartName)}
                >
                  <SelectTrigger className="w-56">
                    <SelectValue placeholder="파트 선택">
                      {part ? (
                        <span className="inline-flex min-w-0 items-center gap-1.5">
                          {selectionCompleted && (
                            <Check
                              aria-hidden
                              className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                            />
                          )}
                          <span className="line-clamp-1">
                            {isOverall ? "팀 총괄" : part}
                          </span>
                        </span>
                      ) : undefined}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {/* part_leader 고정 시 팀 총괄 옵션 숨김(자기 파트만). */}
                    {!lockedPartName && (
                      <SelectItem
                        value={TEAM_OVERALL}
                        aria-label={overallCompleted ? "팀 총괄, 완료" : "팀 총괄"}
                        className={overallCompleted ? COMPLETED_ITEM_CLS : undefined}
                      >
                        <PartOptionLabel label="팀 총괄" completed={overallCompleted} />
                      </SelectItem>
                    )}
                    {(lockedPartName
                      ? parts.filter((p) => p === lockedPartName)
                      : parts
                    ).map((p) => {
                      const done = isPartCompleted(p);
                      return (
                        <SelectItem
                          key={p}
                          value={p}
                          aria-label={done ? `${p}, 완료` : p}
                          className={done ? COMPLETED_ITEM_CLS : undefined}
                        >
                          <PartOptionLabel label={p} completed={done} />
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              {/* 팀 활동 책임자(팀장) — 같은 행 우측 정렬(ml-auto). 모바일에선 아래 줄로 wrap.
                  선택 팀 기준(direct DTO teamLeader), 팀 탭 변경 시 자동 갱신. */}
              <div className="ml-auto self-center">
                <div className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                  <User className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    <span className="inline-flex items-center gap-1">
                      팀 활동 책임 / 관리
                      <AdminHelpIconButton
                        size="xs"
                        helpKey="admin.lineOpening.experience.info.teamLeader"
                        title="팀 활동 책임 / 관리"
                      />
                    </span>
                    {" : "}
                    <span className="font-medium text-foreground">
                      {selectedLeaderText}
                    </span>
                  </span>
                </div>
              </div>
            </div>

            {/* 개설 진행 단계 — 4단계 전체를 항상 노출하고 현재 도달 단계만 강조(단일 pill 대체).
                SoT=currentProgress(서버 team-overall 상태). 파트 선택 시엔 신청까지만 도달, 이후 단계는
                비활성 유지. 팀 총괄 선택 시 4단계 전체를 팀 상태 기준으로 판정. */}
            {part && <ExperienceOpeningProgressSteps progress={currentProgress} />}

            {gridLoading || partsLoading ? (
              <LoadingState active />
            ) : isOverall ? (
              selectedTeam && selectedWeekId ? (
                <ExperienceTeamOverallBoard
                  organization={org}
                  teamId={selectedTeam.id}
                  teamName={selectedTeam.teamName}
                  weekId={selectedWeekId}
                  mode={mode}
                  actAsTestUserId={actAsTestUserId}
                  actorMemberRole={actorMemberRole}
                  onActivity={handleActivity}
                />
              ) : (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  팀과 개설 주차를 선택해주세요.
                </p>
              )
            ) : (
              <PartGrid
                data={data}
                getCell={getCell}
                toggleCheck={toggleCheck}
                setScore={setScore}
                setLine={setLine}
                lineOptions={data?.lineOptions ?? EMPTY_PART_INPUT_LINE_OPTIONS}
                saving={saving}
                submitted={submitted}
                openPeriodBlocked={openPeriodBlocked}
                openBlockedReason={openBlockedReason}
                onReset={resetLocal}
                onSubmit={submit}
                onCancel={cancelSubmission}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── 파트 그리드(편집) ──
function PartGrid({
  data,
  getCell,
  toggleCheck,
  setScore,
  setLine,
  lineOptions,
  saving,
  submitted,
  openPeriodBlocked,
  openBlockedReason,
  onReset,
  onSubmit,
  onCancel,
}: {
  data: PartInputGetData | null;
  getCell: (u: string, l: ExperiencePartLineType) => PartInputCell;
  toggleCheck: (u: string, name: string, l: ExperiencePartLineType, cur: PartInputCell) => void;
  setScore: (u: string, name: string, l: ExperiencePartLineType, score: number, cur: PartInputCell) => void;
  setLine: (u: string, l: ExperiencePartLineType, id: string | null, cur: PartInputCell) => void;
  lineOptions: PartInputLineOptions;
  saving: boolean;
  submitted: boolean;
  // 선택 주차·팀이 개설 기간이 아님(SoT=board.canOpen). true 면 [개설 신청] 비활성 + 안내 배너.
  openPeriodBlocked: boolean;
  openBlockedReason: string;
  onReset: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const crews = data?.crews ?? [];
  return (
    <div className="space-y-3">
      {/* 개설 기간 아님(!canOpen) 안내 — 개설되지 않은 상태와 구분. [개설 신청] 비활성(서버 409 게이트와 동일 판정). */}
      {openPeriodBlocked && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span className="font-semibold">미오픈</span> · {openBlockedReason}
        </div>
      )}
      {/* 데스크톱: [그리드][오른쪽 세로 액션 컬럼] / 모바일: 세로 stack */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1 overflow-x-auto">
        {/* 좌측(이름/파트명/클래스) 축소 + 라인 컬럼(도출/분석/견문) 확대 — 라인명 드롭다운(트리거=열폭 채움)
            을 넓게 확보. 합 = 9.1 + 8 + 10 + 24.3×3 = 100%. table-fixed 로 col 폭 고정(보드와 동일 규칙).
            ⚠ 축소 하한(floor) — 표 폭 1124px 기준 브라우저 실측값. 이 아래로 줄이면 레이아웃이 깨진다:
              · 이름   100px(8.90%) — 본문 최장 이름("T이채성" 68px) + 셀 padding 32px. 미만이면 이름이 2줄로 접힌다.
              · 파트명 111px(9.88%) — 헤더 "파트명"+도움말 아이콘(nowrap). 현재 8%(90px)로 이미 floor 미달이라
                더 줄이면 옆 칸 침범이 악화된다 → 유지.
              · 클래스 111px(9.88%) — 헤더 "클래스"+도움말 아이콘(nowrap). 현재 10%(112px)로 floor 바로 위 → 유지.
            → 실질 여유가 있는 이름만 10%→9.1%(102.3px)로 축소하고 확보한 0.9% 를 라인 3열에 균등 배분(24%→24.3%).
            ⚠ 폰트 스케일(표 텍스트 21px)이 바뀌면 floor 도 바뀐다 —
              scripts/browser-verify-experience-name-col-widths.mjs 로 재측정할 것. */}
        <Table className="min-w-[900px] table-fixed">
          <colgroup>
            <col style={{ width: "9.1%" }} />{/* 이름 */}
            <col style={{ width: "8%" }} />{/* 파트명 */}
            <col style={{ width: "10%" }} />{/* 클래스(구 '크루 상태') */}
            {EXPERIENCE_PART_LINE_TYPES.map((l) => (
              <col key={l.key} style={{ width: "24.3%" }} />
            ))}
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead>
                <span className="inline-flex items-center gap-1">
                  이름
                  <AdminHelpIconButton
                    helpKey={ADMIN_SHARED_HELP_KEYS.crew.name}
                    title="이름"
                    size="xs"
                  />
                </span>
              </TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1">
                  파트명
                  <AdminHelpIconButton
                    helpKey="admin.lineOpening.experience.partGrid.column.part"
                    title="파트명"
                    size="xs"
                  />
                </span>
              </TableHead>
              <TableHead>
                <span className="inline-flex items-center gap-1">
                  클래스
                  <AdminHelpIconButton
                    helpKey="admin.lineOpening.experience.partGrid.column.crewStatus"
                    title="클래스"
                    size="xs"
                  />
                </span>
              </TableHead>
              {EXPERIENCE_PART_LINE_TYPES.map((l) => (
                <TableHead key={l.key} className="text-center">
                  <span className="inline-flex items-center justify-center gap-1">
                    {l.label}
                    <AdminHelpIconButton
                      helpKey={`admin.lineOpening.experience.partGrid.column.${l.key}`}
                      title={l.label}
                      size="xs"
                    />
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {crews.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={3 + EXPERIENCE_PART_LINE_TYPES.length}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  이 파트에 평가 대상 크루가 없습니다.
                </TableCell>
              </TableRow>
            ) : (
              crews.map((crew) => (
                // 행 세로 여백 확대(라인명 드롭다운 위아래 숨통) — 모든 셀 py 동시 확대(className).
                <TableRow key={crew.userId} className="[&>td]:py-4">
                  <TableCell className="whitespace-normal break-words font-medium">
                    {crew.displayName}
                  </TableCell>
                  <TableCell className="whitespace-normal break-words text-xs text-muted-foreground">
                    {crew.partName ?? "-"}
                  </TableCell>
                  <TableCell className="whitespace-normal break-words text-xs">
                    {displayCrewStatusLabel(crew.statusLabel)}
                  </TableCell>
                  {EXPERIENCE_PART_LINE_TYPES.map((line) => {
                    const cell = getCell(crew.userId, line.key);
                    const fail = isPartCellFail(cell);
                    // 라인명은 체크&1점 이상에서만 편집 가능(0점/미체크 = 강화 실패 → '-' 고정).
                    const lineDisabled = !cell.checked || cell.score < 1;
                    return (
                      <TableCell key={line.key} className="text-center align-top">
                        <div className="flex flex-col items-center gap-1">
                          <div
                            className={cn(
                              "inline-flex items-center gap-2 rounded-md border px-2 py-1.5",
                              fail
                                ? "border-red-400 bg-red-50"
                                : "border-input bg-background",
                              checkedRowClass(cell.checked && !fail),
                            )}
                          >
                            <Checkbox
                              checked={cell.checked}
                              onChange={() =>
                                toggleCheck(crew.userId, crew.displayName, line.key, cell)
                              }
                              aria-label={`${crew.displayName} ${line.label} 체크`}
                            />
                            <select
                              className="rounded border border-input bg-background px-1.5 py-0.5 text-sm"
                              value={cell.score}
                              onChange={(e) =>
                                setScore(
                                  crew.userId,
                                  crew.displayName,
                                  line.key,
                                  Number(e.target.value),
                                  cell,
                                )
                              }
                              aria-label={`${crew.displayName} ${line.label} 점수`}
                            >
                              {Array.from({ length: 11 }, (_, i) => i).map((n) => (
                                <option key={n} value={n}>
                                  {n}
                                </option>
                              ))}
                            </select>
                          </div>
                          {/* 라인명 드롭다운 — 체크박스·점수 바로 아래. 유형(도출/분석/견문)별 옵션. */}
                          <ExperienceLineSelect
                            value={cell.selectedLineId}
                            options={lineOptions[line.key]}
                            onChange={(id) => setLine(crew.userId, line.key, id, cell)}
                            disabled={lineDisabled}
                            ariaLabel={`${crew.displayName} ${line.label} 라인명`}                          />
                        </div>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        </div>

        {/* 액션 버튼 — 데스크톱: 그리드 오른쪽 세로 컬럼(고정), 모바일: 하단 stack.
            3행 1열·동일 width·좁은 간격. 동작/상태 로직은 그대로(배치만 변경). */}
        <div className="flex flex-col gap-2 lg:w-36 lg:shrink-0 lg:self-start lg:border-l lg:pl-3">
          <div className="flex items-center justify-between gap-1">
            <span className="text-xs font-medium text-muted-foreground">초기화</span>
            <AdminHelpIconButton
              helpKey="admin.lineOpening.experience.action.reset"
              title="초기화"
              size="xs"
            />
          </div>
          <Button
            variant="outline"
            className="w-full justify-center"
            onClick={onReset}
            disabled={saving || crews.length === 0}
          >
            <RotateCcw className="mr-1.5 h-4 w-4" /> 초기화
          </Button>
          <div className="flex items-center justify-between gap-1">
            <span className="text-xs font-medium text-muted-foreground">개설 신청</span>
            <AdminHelpIconButton
              helpKey="admin.lineOpening.experience.action.submit"
              title="개설 신청"
              size="xs"
            />
          </div>
          <Button
            className="w-full justify-center"
            onClick={onSubmit}
            loading={saving}
            // 개설 기간 아님(openPeriodBlocked)·이미 신청(submitted)·대상 0명이면 비활성.
            //   ⚠ openPeriodBlocked 는 서버 assertExperienceLineOpenable(409)와 동일 판정(UI 우회 대비).
            //   재신청 방지: 서버는 upsert(멱등)라 중복 행을 만들지 않지만 UI 에서도 재신청을 막는다.
            disabled={saving || crews.length === 0 || submitted || openPeriodBlocked}
            title={
              openPeriodBlocked
                ? openBlockedReason
                : submitted
                  ? "이미 개설 신청이 완료된 파트입니다. 수정하려면 [신청 취소] 후 다시 신청하세요."
                  : undefined
            }
          >
            <Send className="mr-1.5 h-4 w-4" />
            개설 신청
          </Button>
          <div className="flex items-center justify-between gap-1">
            <span className="text-xs font-medium text-muted-foreground">신청 취소</span>
            <AdminHelpIconButton
              helpKey="admin.lineOpening.experience.action.cancel"
              title="신청 취소"
              size="xs"
            />
          </div>
          <Button
            variant="outline"
            className="w-full justify-center border-red-300 text-red-700 hover:bg-red-50"
            onClick={onCancel}
            loading={saving}
            disabled={saving || !submitted}
            title={!submitted ? "신청 후에만 취소할 수 있습니다" : undefined}
          >
            신청 취소
          </Button>
        </div>
      </div>
      {submitted && (
        <p className="text-right text-xs text-green-700">
          개설 신청 완료 상태입니다.
        </p>
      )}
    </div>
  );
}

// 팀 총괄(집계)은 ExperienceTeamOverallBoard(편집 보드)로 대체됨 — 위 isOverall 분기에서 렌더.
