"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Eye, CheckCircle2, XCircle, Upload, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { adminDialog } from "@/components/ui/admin-dialog";
import { useToast } from "@/components/ui/toast";
import { useActionToast } from "@/lib/actionToast";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { ADMIN_SHARED_HELP_KEYS } from "@/lib/adminSharedHelpKeys";
import { LoadingState } from "@/components/ui/loading-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { LINE_OPENING_RESULT, lineOpenSuccessMessage } from "@/lib/lineOpeningResultMessages";
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
import {
  OPENING_INVALID_HIGHLIGHT,
  OPENING_INVALID_HIGHLIGHT_MS,
  scrollFocusInvalidTarget,
} from "@/lib/openingInvalidHighlight";
import type { ScopeMode } from "@/lib/userScopeShared";
import {
  EXPERIENCE_OVERALL_CATEGORIES,
  OVERALL_APPLICATION_INCOMPLETE_MESSAGE,
  OVERALL_NO_TARGET_PARTS_MESSAGE,
  OVERALL_CELL_DEFAULT,
  OVERALL_LEADER_CATEGORIES,
  OVERALL_PART_CATEGORIES,
  EMPTY_OVERALL_LINE_OPTIONS,
  canEditOverallManagement,
  isOverallCellFail,
  resolveOverallApplicationReadiness,
  validateOverallOutputRequirements,
  validatePartLeaderLineRequirements,
  type ExperienceOverallCategory,
  type ExperienceTeamOverallBoard as BoardDto,
  type OverallBoardCrew,
  type OverallCell,
  type OverallLeaderCellDto,
  type OverallLineSelectionDto,
} from "@/lib/experienceTeamOverallTypes";
import {
  displayCrewStatusLabel,
  experienceScoreState,
  type ExperiencePartLineType,
} from "@/lib/experiencePartInputTypes";
import { confirmReinforcementFailure } from "@/lib/experienceReinforcementFailureConfirm";
import ExperienceLineSelect from "@/components/admin/cluster4/ExperienceLineSelect";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";

// 실무 경험 [팀 총괄] — 개설 검수/완료/취소 편집 보드.
//   행=전 파트 크루(+파트장), 열=도출/분석/견문(파트신청 라이브, 읽기전용) + 관리/확장(팀장 입력).
//   확장은 확장 주간에만 활성. 카테고리별 아웃풋 링크/설명 입력(이미지는 라인 등록값 자동).
//   버튼 4종: [개설 검수](검수 완료, 고객 미반영) · [초기화](프론트 전용) · [개설 완료](팀장, 고객 반영) · [개설 취소](완료 원복).

const leaderKey = (userId: string, category: ExperienceOverallCategory) =>
  `${userId}::${category}`;

// 카테고리 열 헤더 도움말 키 — 카테고리의 안정적 id(key)로 매핑(배열 인덱스 금지).
//   도출/분석/견문/관리/확장. helpKey 는 helpKey SoT 로 절대 변경 금지.
const OVERALL_CATEGORY_HELP_KEY: Record<ExperienceOverallCategory, string> = {
  derivation: "admin.lineOpening.experience.overallColumn.derivation",
  analysis: "admin.lineOpening.experience.overallColumn.analysis",
  evaluation: "admin.lineOpening.experience.overallColumn.evaluation",
  management: "admin.lineOpening.experience.overallColumn.management",
  extension: "admin.lineOpening.experience.overallColumn.extension",
};

// 표 컬럼 폭 — table-layout: fixed 와 함께 헤더/바디 폭을 정확히 고정한다.
//   좌측(이름/파트/클래스)은 텍스트 길이에 맞게 축소하고, 남는 폭을 5개 평가 컬럼(도출/분석/견문/관리/확장)에
//   배분해 라인명 드롭다운(트리거=열폭 채움)이 더 넓게 보이도록 한다. 합 = 7.5 + 7 + 8 + 15.5×5 = 100%.
//
//   ⚠ 축소 하한(floor) — 표 폭 1340px(min-w) 기준 브라우저 실측값. 이 아래로 줄이면 레이아웃이 깨진다:
//     · 이름   100px(7.46%) — 본문 최장 이름("T강민지" 68px) + 셀 padding 32px. 미만이면 이름이 2줄로 접힌다.
//     · 파트    92px(6.87%) — 헤더 "파트"+도움말 아이콘(nowrap) 60px + padding 32px. 미만이면 헤더가 옆 칸을 침범.
//     · 클래스 111px(8.28%) — 헤더 "클래스"+도움말 아이콘(nowrap) 79px + padding 32px.
//   → 파트/클래스는 자기 헤더가 하한이라 더 줄일 수 없다(클래스는 8%=107px 로 이미 floor 미달 = 4px 침범 상태.
//     더 줄이면 악화되므로 유지). 실질 여유가 있는 이름만 9%→7.5%(100.5px, floor 바로 위)로 축소하고
//     확보한 1.5% 를 평가 5열에 균등 배분(15.2%→15.5%)했다.
//   ⚠ 폰트 스케일(표 텍스트 21px)이 바뀌면 위 floor 도 함께 바뀐다 —
//     scripts/browser-verify-experience-name-col-widths.mjs 로 재측정할 것.
const NAME_COL_W = "7.5%";
const PART_COL_W = "7%";
const CLASS_COL_W = "8%";
const CAT_COL_W = "15.5%";

// 평가 셀 공통 2단 레이아웃 SoT — 5개 컬럼(도출/분석/견문/관리/확장) 라인명 드롭다운의
//   시작 Y좌표를 한 행 안에서 모두 일치시키기 위한 공통 상수.
//   · 1단(점수/상태 슬롯): 내용이 배지(도출/분석/견문)든, 체크박스+점수 박스(관리/확장)든,
//     "파트장/에이전트 전용" 안내(일반 크루 관리)든 관계없이 동일한 최소 높이를 확보한다.
//     가장 큰 컨텐츠(체크박스+점수 select 박스 = 실측 47px)를 감싸도록 min-h-[48px] 로 통일 —
//     이 값 미만이면 관리/확장의 점수 박스가 슬롯을 밀어올려 배지 컬럼(도출/분석/견문)보다 아래에서
//     라인명이 시작한다(회귀 원인). 브라우저 실측(Δ≤2px)으로 검증.
//   · 2단(라인명 슬롯): 1단 바로 아래 고정 간격(mt-2). 라인명 자체에 개별 margin 을 주지 않는다.
//   ⚠ 관리·확장만 translateY 로 보정하거나 Select 별 margin-top 을 다르게 주지 말 것 — 정렬은
//     오로지 1단 슬롯 높이 통일로만 달성한다(라인명 2~3줄 줄바꿈에 따른 셀 높이 증가는 허용).
const OVERALL_CELL_TOP_SLOT_CLASS =
  "flex min-h-[48px] w-full items-center justify-center";
const OVERALL_CELL_LINE_SLOT_CLASS = "mt-2 w-full";

function BoardColgroup() {
  return (
    <colgroup>
      <col style={{ width: NAME_COL_W }} />
      <col style={{ width: PART_COL_W }} />{/* 파트 */}
      <col style={{ width: CLASS_COL_W }} />{/* 클래스(구 '크루 상태') */}
      {EXPERIENCE_OVERALL_CATEGORIES.map((c) => (
        <col key={c.key} style={{ width: CAT_COL_W }} />
      ))}
    </colgroup>
  );
}

export default function ExperienceTeamOverallBoard({
  organization,
  teamId,
  teamName,
  weekId,
  mode = "operating",
  actAsTestUserId = null,
  actorMemberRole = null,
  onActivity,
}: {
  organization: string;
  teamId: string;
  teamName: string;
  weekId: string;
  // 모집단 모드(operating=실사용자만 / test=테스트 유저만). GET/POST(open) 에 전파.
  mode?: ScopeMode;
  // 임퍼소네이션 대상(write POST 에 전파 → 서버 가드 활성). null=비임퍼.
  actAsTestUserId?: string | null;
  // 임퍼 액터 역할(버튼 노출 UX 게이팅). agent=검수만, team_leader=검수+개설.
  actorMemberRole?: "team_leader" | "part_leader" | "agent" | "member" | null;
  // 검수/완료/취소 직후 상위(상태창·로그창)를 갱신하라는 신호.
  onActivity?: () => void;
}) {
  const [board, setBoard] = useState<BoardDto | null>(null);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [saving, setSaving] = useState(false);
  // 검수 차단(미신청 파트 등) 안내는 화면 하단 고정 Toast(<ToastViewport /> · Layout)로 표시.
  const { toast, loading: showLoadingToast, dismiss: dismissToast } = useToast();
  const t = useActionToast();
  const outputSectionRef = useRef<HTMLDivElement>(null);
  // 포커스 대상(링크 Input / 이미지 업로드 버튼) — key=`${category}:link` | `${category}:image`.
  const outputFieldRefs = useRef(new Map<string, HTMLElement>());
  // 스크롤/강조 대상 wrapper(필드 묶음 div) — 같은 key. 붉은 ring+깜빡임을 이 wrapper 에 입힌다.
  const outputWrapRefs = useRef(new Map<string, HTMLElement>());
  // 누락 강조 자동 해제 타이머(약 1.6s 후). 무한 깜빡임 방지 + 언마운트 시 정리.
  const invalidTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lineSelectionSectionRef = useRef<HTMLDivElement>(null);
  const lineSelectionRefs = useRef(new Map<string, HTMLButtonElement>());

  // 팀장 직접 입력(관리/확장) 로컬 편집값.
  const [leaderCells, setLeaderCells] = useState<Map<string, OverallCell>>(new Map());
  // 카테고리별 아웃풋 링크/설명 로컬 편집값.
  const [outputs, setOutputs] = useState<
    Map<ExperienceOverallCategory, { link: string; description: string; imageUrl: string; imageDescription: string }>
  >(new Map());
  // 도출/분석/견문 라인명 로컬 편집값 — key=`crewUserId::category`(part 카테고리만). 저장=파트 신청 셀 SoT.
  const [lineSelections, setLineSelections] = useState<Map<string, string | null>>(
    new Map(),
  );
  // 필수 입력 누락 강조(일시) — validateOutputsAndGuide 가 스크롤/포커스하는 첫 누락 필드 키
  //   (`${category}:link` | `${category}:image`). 해당 필드에 aria-invalid + 붉은 테두리를 표시하고,
  //   사용자가 아웃풋을 편집하거나 다음 검증을 통과하면 해제한다.
  const [invalidOutputKey, setInvalidOutputKey] = useState<string | null>(null);

  // 누락 강조 즉시 해제(타이머 정리 포함) — 아웃풋 편집·검증 통과·언마운트 시 호출.
  const clearInvalidHighlight = useCallback(() => {
    if (invalidTimerRef.current) {
      clearTimeout(invalidTimerRef.current);
      invalidTimerRef.current = null;
    }
    setInvalidOutputKey((k) => (k === null ? k : null));
  }, []);

  // 언마운트 시 강조 타이머 정리.
  useEffect(
    () => () => {
      if (invalidTimerRef.current) clearTimeout(invalidTimerRef.current);
    },
    [],
  );

  const allCrews = useMemo<OverallBoardCrew[]>(
    () => (board?.parts ?? []).flatMap((p) => p.crews),
    [board],
  );

  // 라인명 드롭다운 옵션(5카테고리) — 개설 신청과 동일 원천(board.lineOptions).
  const lineOptions = board?.lineOptions ?? EMPTY_OVERALL_LINE_OPTIONS;

  const opened = board?.status === "opened";
  const extensionActive = board?.extensionActive ?? false;
  // 개설 기간 판정(단일 SoT = board.canOpen ← cluster4_week_opening_configs). fail-closed:
  //   board 미수신(null·조회 실패)·구버전 응답(필드 없음)이면 false → 개설 검수/완료 차단(개설 가능으로 오처리 금지).
  const canOpen = board?.canOpen ?? false;
  const openBlockedReason =
    board?.openBlockedReason ??
    (board ? null : "개설 가능 기간을 확인하지 못했습니다. 다시 시도해 주세요.");
  // 개설 검수 이미 완료(reviewed 또는 opened) — 재실행 방지(멱등 안내).
  const reviewCompleted = board?.status === "reviewed" || board?.status === "opened";

  // [개설 검수] 사전조건 — 공통 SoT(board.application)만 소비. 프론트가 카드 수/파트명 문자열을
  //   자체 집계하지 않는다. 구버전 응답 대비 parts 파생 폴백(신규 서버는 항상 application 제공).
  //   필드: totalPartCount(대상 파트 수) · appliedPartCount(신청 완료) · unappliedParts(미신청명) ·
  //         allPartsApplied(대상>=1 && 전부 신청). 대상 0개면 allPartsApplied=false.
  const application = useMemo(
    () =>
      board ? board.application ?? resolveOverallApplicationReadiness(board.parts) : null,
    [board],
  );
  const allPartsApplied = application?.allPartsApplied ?? false;
  // 버튼 비활성(시각) 기준 — 개설 기간 아님(!canOpen)·개설완료·검수완료·미신청/대상0 중 하나라도면 disabled.
  //   ⚠ !canOpen 을 최우선으로 둔다(개설 기간이 아니면 검수/완료 모두 불가) — 서버 409 게이트와 동일 판정.
  const reviewBlocked = !canOpen || opened || reviewCompleted || !allPartsApplied;

  // 미개설(=[개설 신청] 미완료) 파트 집합 — 공통 SoT(board.parts[].submitted)로만 판정.
  //   파트명 문자열이 아니라 DTO 의 파트별 submitted 플래그 기준(개설된 파트=활성 유지, 미개설=행 시각 비활성).
  const inactivePartNames = useMemo(() => {
    const s = new Set<string>();
    for (const p of board?.parts ?? []) if (!p.submitted) s.add(p.partName);
    return s;
  }, [board]);

  // 업무 흐름(Process)상 "현재 상태에서 권장되는 다음 액션" — 시각적 강조(안내)용일 뿐, 권한을 막지 않는다.
  //   none(검수 전) → 개설 검수, reviewed(검수 완료) → 개설 완료, opened(완료) → 없음.
  //   ⚠ 팀장 권한은 상태와 무관 — 검수 전이라도 개설 완료 버튼은 활성(강조만 안 될 뿐).
  const recommendedNext: "review" | "open" | null =
    board?.status === "reviewed" ? "open" : board?.status === "opened" ? null : "review";

  // 보드를 로컬 편집 state 로 흡수(저장값/기본값).
  const hydrate = useCallback((b: BoardDto) => {
    const lc = new Map<string, OverallCell>();
    const ls = new Map<string, string | null>();
    for (const part of b.parts) {
      for (const crew of part.crews) {
        for (const cat of OVERALL_LEADER_CATEGORIES) {
          lc.set(leaderKey(crew.userId, cat), { ...crew.cells[cat] });
        }
        // 파트장은 도출/분석/견문 점수도 [개설 검수]에서 직접 편집한다(일반/에이전트는 개설 신청 셀
        //   SoT 라 읽기전용). 저장된/기본 셀을 로컬 편집 state 로 흡수해 라운드트립을 보존한다.
        if (crew.isPartLeader) {
          for (const cat of OVERALL_PART_CATEGORIES) {
            lc.set(leaderKey(crew.userId, cat), { ...crew.cells[cat] });
          }
        }
        // 선택 라인 — 5카테고리 전부 초기화(도출/분석/견문=파트 셀, 관리/확장=팀장 셀 미러).
        for (const cat of EXPERIENCE_OVERALL_CATEGORIES) {
          ls.set(leaderKey(crew.userId, cat.key), crew.cells[cat.key]?.selectedLineId ?? null);
        }
      }
    }
    setLeaderCells(lc);
    setLineSelections(ls);
    const out = new Map<ExperienceOverallCategory, { link: string; description: string; imageUrl: string; imageDescription: string }>();
    for (const o of b.outputs) {
      out.set(o.category, { link: o.link, description: o.description, imageUrl: o.imageUrl, imageDescription: o.imageDescription });
    }
    setOutputs(out);
  }, []);

  const fetchBoard = useCallback(async () => {
    if (!organization || !teamId || !teamName || !weekId) {
      setBoard(null);
      return;
    }
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        organization,
        week_id: weekId,
        team_id: teamId,
        team_name: teamName,
      });
      if (mode === "test") qs.set("mode", "test");
      const res = await fetch(
        `/api/admin/cluster4/experience/team-overall?${qs.toString()}`,
      );
      const json = await res.json();
      if (json?.success) {
        const b = json.data as BoardDto;
        setBoard(b);
        hydrate(b);
      } else {
        setBoard(null);
        throw apiErrorFrom(res, json, "팀 총괄 데이터를 불러오지 못했습니다");
      }
    } catch (err) {
      console.error("[experience] team-overall load failed", err);
      setBoard(null);
      toast("error", getApiErrorMessage(err, "팀 총괄 데이터를 불러오지 못했습니다"));
    } finally {
      setLoading(false);
    }
  }, [organization, teamId, teamName, weekId, mode, hydrate, toast]);

  useEffect(() => {
    // setState 는 effect 본문이 아닌 async 콜백 안에서 호출(동기 cascading 렌더 방지 — 프로젝트 표준 패턴).
    void (async () => {
      await fetchBoard();
    })();
  }, [fetchBoard]);

  // ── 셀 편집(관리/확장) — 체크/점수 연동 ──
  const getLeaderCell = useCallback(
    (userId: string, category: ExperienceOverallCategory): OverallCell =>
      leaderCells.get(leaderKey(userId, category)) ?? { ...OVERALL_CELL_DEFAULT },
    [leaderCells],
  );

  const setLeaderCell = useCallback(
    (userId: string, category: ExperienceOverallCategory, next: OverallCell) => {
      setLeaderCells((prev) => {
        const m = new Map(prev);
        m.set(leaderKey(userId, category), next);
        return m;
      });
    },
    [],
  );

  const toggleLeaderCheck = useCallback(
    async (userId: string, crewName: string, category: ExperienceOverallCategory) => {
      const cur = getLeaderCell(userId, category);
      const nextChecked = !cur.checked;
      // 체크 해제 → <강화 실패>(활동 인정 불가). 개설 신청 단계와 **동일한** 확인 팝업(공용 SoT).
      //   취소 시 setLeaderCell 미호출 → 컨트롤드 체크박스가 기존 상태로 복구된다.
      if (!nextChecked && !(await confirmReinforcementFailure(crewName))) return;
      // 체크 해제 → 점수 0. 재체크(점수 0이었으면) → 기본 7.
      const nextScore = nextChecked ? (cur.score === 0 ? 7 : cur.score) : 0;
      setLeaderCell(userId, category, { checked: nextChecked, score: nextScore });
    },
    [getLeaderCell, setLeaderCell],
  );

  const setLeaderScore = useCallback(
    async (
      userId: string,
      crewName: string,
      category: ExperienceOverallCategory,
      score: number,
    ) => {
      // 점수 선택 → 체크 자동 ON. 4점 미만(강화 실패=활동 인정 불가)이면 개설 신청과 동일한 확인 팝업.
      //   판정 SoT = experienceScoreState().isReinforcementSuccess(점수 ≥ 4). 취소 시 컨트롤드 select 복구.
      if (
        !experienceScoreState(score).isReinforcementSuccess &&
        !(await confirmReinforcementFailure(crewName))
      )
        return;
      setLeaderCell(userId, category, { checked: true, score });
    },
    [setLeaderCell],
  );

  // ── 라인명(도출/분석/견문) 편집 — 파트 신청 셀 SoT 로 write-back(저장 시) ──
  const getLineSel = useCallback(
    (userId: string, category: ExperienceOverallCategory): string | null =>
      lineSelections.get(leaderKey(userId, category)) ?? null,
    [lineSelections],
  );

  const setLineSel = useCallback(
    (userId: string, category: ExperienceOverallCategory, id: string | null) => {
      setLineSelections((prev) => {
        const m = new Map(prev);
        m.set(leaderKey(userId, category), id);
        return m;
      });
    },
    [],
  );

  const getOutput = useCallback(
    (category: ExperienceOverallCategory) =>
      outputs.get(category) ?? { link: "", description: "", imageUrl: "", imageDescription: "" },
    [outputs],
  );

  const setOutput = useCallback(
    (category: ExperienceOverallCategory, patch: { link?: string; description?: string; imageUrl?: string; imageDescription?: string }) => {
      // 편집 시작 = 누락 강조 해제(다음 검증에서 다시 판정). 링크/설명/이미지 어느 것이든 편집이면 해제한다.
      clearInvalidHighlight();
      setOutputs((prev) => {
        const m = new Map(prev);
        const cur = m.get(category) ?? { link: "", description: "", imageUrl: "", imageDescription: "" };
        m.set(category, { ...cur, ...patch });
        return m;
      });
    },
    [clearInvalidHighlight],
  );

  // ── payload 빌더 ──
  const buildPayload = useCallback(() => {
    const cells: OverallLeaderCellDto[] = [];
    for (const crew of allCrews) {
      for (const cat of OVERALL_LEADER_CATEGORIES) {
        // 확장은 확장 주간에만 저장.
        if (cat === "extension" && !extensionActive) continue;
        // 관리(management) 류는 파트장/에이전트 전용 — 일반 크루 셀은 payload 에서 제외(백엔드 가드와 정합).
        if (cat === "management" && !canEditOverallManagement(crew)) continue;
        const c = getLeaderCell(crew.userId, cat);
        cells.push({
          crewUserId: crew.userId,
          category: cat as "management" | "extension",
          checked: c.checked,
          score: c.score,
          // 관리/확장 라인명 — 팀장 셀 SoT(team_overall_cells)에 함께 저장. 서버가 보이드/유형 검증.
          selectedLineId: getLineSel(crew.userId, cat),
        });
      }
    }
    const outs = EXPERIENCE_OVERALL_CATEGORIES.filter(
      (c) => !(c.key === "extension" && !extensionActive),
    ).map((c) => {
      const o = getOutput(c.key);
      return { category: c.key, link: o.link, description: o.description, imageUrl: o.imageUrl, imageDescription: o.imageDescription };
    });
    // 도출/분석/견문 라인명 편집값 — 파트 카테고리 전 크루. 서버가 보이드/유형 검증·null 정규화.
    //   파트장은 점수/체크를 검수 화면에서 직접 선택하므로 함께 실어 보낸다(서버가 파트장만 반영).
    const lineSels: OverallLineSelectionDto[] = [];
    for (const crew of allCrews) {
      for (const cat of OVERALL_PART_CATEGORIES) {
        const sel: OverallLineSelectionDto = {
          crewUserId: crew.userId,
          lineType: cat as ExperiencePartLineType,
          selectedLineId: getLineSel(crew.userId, cat),
        };
        if (crew.isPartLeader) {
          const lc = getLeaderCell(crew.userId, cat);
          sel.checked = lc.checked;
          sel.score = lc.score;
        }
        lineSels.push(sel);
      }
    }
    return { cells, outs, lineSels };
  }, [allCrews, extensionActive, getLeaderCell, getOutput, getLineSel]);

  const post = useCallback(
    async (action: "review" | "open" | "cancel") => {
      const { cells, outs, lineSels } = buildPayload();
      const res = await fetch("/api/admin/cluster4/experience/team-overall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          organization,
          week_id: weekId,
          team_id: teamId,
          team_name: teamName,
          leaderCells: action === "cancel" ? [] : cells,
          outputs: action === "cancel" ? [] : outs,
          lineSelections: action === "cancel" ? [] : lineSels,
          mode,
          // 임퍼소네이션 write 가드 활성용(서버가 mode=test+test_user_markers 검증).
          ...(actAsTestUserId ? { actAsTestUserId } : {}),
        }),
      });
      // status 를 호출부까지 전달해야 4xx 업무 사유를 그대로 안내할 수 있다.
      return { res, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    },
    [buildPayload, organization, weekId, teamId, teamName, mode, actAsTestUserId],
  );

  // 첫 누락 필드로 스크롤/포커스 — practical-info 와 동일한 공용 helper 재사용.
  //   wrap = 강조/스크롤 대상(필드 wrapper), target = 포커스 대상(링크 Input / 이미지 업로드 버튼).
  const scrollFocusInvalidKey = useCallback((key: string) => {
    scrollFocusInvalidTarget(
      outputWrapRefs.current.get(key) ?? null,
      outputFieldRefs.current.get(key) ?? null,
    );
  }, []);

  const validateOutputsAndGuide = useCallback(async (): Promise<boolean> => {
    const { outs } = buildPayload();
    const issue = validateOverallOutputRequirements(outs, extensionActive);
    if (!issue) {
      clearInvalidHighlight();
      return true;
    }
    // 공통 검증이 돌려준 첫 누락 필드(firstMissingCategory:firstMissingField)를 스크롤/포커스/강조의 단일 대상으로 삼는다.
    const targetKey = `${issue.firstMissingCategory}:${issue.firstMissingField}`;
    // ⚠ practical-info 와 동일: 팝업을 열기 전에 먼저 강조 + 스크롤/포커스한다. 이렇게 하면 팝업이 닫힐 때
    //    포커스 복원 대상이 [개설 검수]/[개설 완료] 버튼이 아니라 이 필드가 되어, 스크롤이 버튼 쪽으로 되돌지 않는다.
    if (invalidTimerRef.current) {
      clearTimeout(invalidTimerRef.current);
      invalidTimerRef.current = null;
    }
    setInvalidOutputKey(targetKey);
    scrollFocusInvalidKey(targetKey);
    await adminDialog.alert({
      variant: "warning",
      title: "필수 입력 안내",
      description: issue.message,
      confirmLabel: "확인",
    });
    // 닫힌 뒤 한 번 더 확정(포커스 복원 대비) + 약 1.6s 후 강조 해제(무한 깜빡임 금지).
    requestAnimationFrame(() => scrollFocusInvalidKey(targetKey));
    invalidTimerRef.current = setTimeout(
      () => setInvalidOutputKey(null),
      OPENING_INVALID_HIGHLIGHT_MS,
    );
    return false;
  }, [buildPayload, extensionActive, clearInvalidHighlight, scrollFocusInvalidKey]);

  const validatePartLeaderLinesAndGuide = useCallback(async (): Promise<boolean> => {
    const { lineSels } = buildPayload();
    const issue = validatePartLeaderLineRequirements(
      lineSels,
      allCrews.filter((crew) => crew.isPartLeader).map((crew) => crew.userId),
    );
    if (!issue) return true;
    await adminDialog.alert({
      variant: "warning",
      title: "필수 입력 안내",
      description: issue.message,
      confirmLabel: "확인",
    });
    lineSelectionSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => {
      lineSelectionRefs.current
        .get(`${issue.crewUserId}:${issue.category}`)
        ?.focus({ preventScroll: true });
    }, 350);
    return false;
  }, [allCrews, buildPayload]);

  // ── 버튼 핸들러 ──
  const onReview = useCallback(async () => {
    setSaving(true);
    try {
      const { res, json } = await post("review");
      if (!json?.success) {
        const rawError = typeof json?.error === "string" ? json.error : "";
        console.error("[experience] team-overall review failed", json?.error);
        // 미신청 파트 등 검수 차단 사유는 하단 고정 Toast 로 안내(파트명만·UUID 없음).
        //   미신청/대상없음(정상 사용자 안내) = warning, 그 외 오류 = error. 상시 인라인 경고/모달 없음.
        if (rawError.startsWith(OVERALL_NO_TARGET_PARTS_MESSAGE)) {
          toast("warning", OVERALL_NO_TARGET_PARTS_MESSAGE);
        } else if (rawError.startsWith(OVERALL_APPLICATION_INCOMPLETE_MESSAGE)) {
          toast("warning", OVERALL_APPLICATION_INCOMPLETE_MESSAGE);
        } else {
          // 그 외 4xx 업무 사유는 서버 문구 그대로(5xx·네트워크는 안전 문구로 치환).
          t.apiError("review", apiErrorFrom(res, json, "개설 검수에 실패했습니다"));
        }
        return;
      }
      // 성공 안내는 하단 고정 Toast 로만(성공 배너/카드 추가 금지). 검수 완료는 크루 미반영이라
      //   "N명 반영" 문구는 붙이지 않는다(실제 반영은 팀장 [개설 완료] 단계).
      toast("success", LINE_OPENING_RESULT.reviewSuccess);
      await fetchBoard();
      onActivity?.();
    } catch (err) {
      console.error("[experience] team-overall review error", err);
      toast("error", getApiErrorMessage(err, "개설 검수 중 오류가 발생했습니다"));
    } finally {
      setSaving(false);
    }
  }, [post, fetchBoard, onActivity, toast]);

  // [개설 검수] 버튼 클릭 라우터 — 버튼이 disabled(시각)여도 wrapper 클릭으로 여기 진입한다.
  //   비활성 사유별 하단 Toast 안내(실행 차단), 진행 가능 상태에서만 실제 검수(onReview) 실행.
  //   키보드/직접 이벤트 호출도 이 라우터를 통과해야 하며, 최종 방어선은 서버 가드(409/422/403).
  const handleReviewClick = useCallback(async () => {
    if (saving) return;
    if (!canOpen) {
      toast("warning", openBlockedReason ?? "선택한 주차는 실무 경험 라인의 개설 기간이 아닙니다.");
      return;
    }
    if (opened) {
      toast("warning", "이미 개설 완료된 상태입니다. [개설 취소] 후 다시 검수할 수 있습니다.");
      return;
    }
    if (reviewCompleted) {
      toast("warning", "이미 개설 검수가 완료된 상태입니다.");
      return;
    }
    if ((application?.totalPartCount ?? 0) === 0) {
      toast("warning", OVERALL_NO_TARGET_PARTS_MESSAGE);
      return;
    }
    if (!allPartsApplied) {
      const n = application?.unappliedParts.length ?? 0;
      toast(
        "warning",
        n > 0
          ? `아직 ${n}개 파트의 개설 신청이 필요합니다.`
          : OVERALL_APPLICATION_INCOMPLETE_MESSAGE,
      );
      return;
    }
    if (!(await validatePartLeaderLinesAndGuide())) return;
    if (!(await validateOutputsAndGuide())) return;
    void onReview();
  }, [saving, canOpen, openBlockedReason, opened, reviewCompleted, application, allPartsApplied, validatePartLeaderLinesAndGuide, validateOutputsAndGuide, onReview, toast]);

  const onReset = useCallback(() => {
    // DB 통신 없음 — 프론트 화면 입력값만 기본값으로 복원.
    const lc = new Map<string, OverallCell>();
    const ls = new Map<string, string | null>();
    for (const crew of allCrews) {
      for (const cat of OVERALL_LEADER_CATEGORIES) {
        lc.set(leaderKey(crew.userId, cat), { ...OVERALL_CELL_DEFAULT });
      }
      // 파트장 도출/분석/견문 점수는 라인명과 함께 로드된 값(미러)으로 되돌린다 — 저장된 파트장
      //   점수를 프론트 초기화가 임의로 기본값(7)으로 덮어써 유실하지 않도록(라인명과 동일 처리).
      if (crew.isPartLeader) {
        for (const cat of OVERALL_PART_CATEGORIES) {
          lc.set(leaderKey(crew.userId, cat), { ...crew.cells[cat] });
        }
      }
      // 라인명은 5카테고리 전부 로드된 값(미러)으로 되돌린다 — 선택 유실 방지.
      for (const cat of EXPERIENCE_OVERALL_CATEGORIES) {
        ls.set(leaderKey(crew.userId, cat.key), crew.cells[cat.key]?.selectedLineId ?? null);
      }
    }
    setLeaderCells(lc);
    setLineSelections(ls);
    setOutputs(new Map());
    toast("success", LINE_OPENING_RESULT.resetSuccess);
  }, [allCrews, toast]);

  const onOpen = useCallback(async () => {
    // 개설 기간 게이트(프론트 1차) — 서버 openTeamOverall 이 동일 판정으로 409 재검증한다(UI 우회 대비).
    if (!canOpen) {
      toast("warning", openBlockedReason ?? "선택한 주차는 실무 경험 라인의 개설 기간이 아닙니다.");
      return;
    }
    // ⑪ 개설 검수 완료 전에는 개설 완료 불가(팀장 포함) — 서버 openTeamOverall 409 게이트와 동일 판정.
    if (!reviewCompleted) {
      toast("warning", "모든 필수 개설 검수가 완료되어야 개설 완료할 수 있습니다.");
      return;
    }
    if (!(await validatePartLeaderLinesAndGuide())) return;
    if (!(await validateOutputsAndGuide())) return;
    if (
      !(await adminDialog.confirm({
        title: "개설 완료",
        description: "현재 입력값으로 개설 완료하시겠습니까?\n크루 페이지에 실제 반영됩니다.",
        confirmLabel: "개설 완료",
      }))
    )
      return;
    setSaving(true);
    // 실제 개설은 대상 인원 수에 따라 오래 걸릴 수 있으므로, 요청을 시작하기 직전에
    // 진행 중(로딩) 토스트를 먼저 띄운다. 요청 완료(성공/실패) 시 finally 에서 정리한다.
    // ⚠ UI 피드백 전용 — payload/API/DTO/서버 처리(post("open"))는 일절 변경하지 않는다.
    const progressToastId = showLoadingToast(
      "라인 개설을 처리하고 있습니다. 대상 인원에 따라 완료까지 다소 시간이 걸릴 수 있으니 잠시만 기다려 주세요.",
    );
    try {
      const { res, json } = await post("open");
      if (!json?.success) {
        console.error("[experience] team-overall open failed", json?.error);
        t.apiError("open", apiErrorFrom(res, json, "개설 완료에 실패했습니다"));
        return;
      }
      const d = json.data as {
        linesCreated: number;
        targetsCreated: number;
        evaluationsCreated: number;
      };
      const warnings = (json.warnings ?? []) as string[];
      console.warn("[line-opening] open result", { linesCreated: d.linesCreated, targetsCreated: d.targetsCreated, evaluationsCreated: d.evaluationsCreated, warnings });
      toast("success", lineOpenSuccessMessage(warnings.length > 0));
      await fetchBoard();
      onActivity?.();
    } catch (err) {
      console.error("[experience] team-overall open error", err);
      toast("error", getApiErrorMessage(err, "개설 완료 중 오류가 발생했습니다"));
    } finally {
      dismissToast(progressToastId);
      setSaving(false);
    }
  }, [canOpen, openBlockedReason, reviewCompleted, validatePartLeaderLinesAndGuide, validateOutputsAndGuide, post, fetchBoard, onActivity, toast, showLoadingToast, dismissToast]);

  const onCancel = useCallback(async () => {
    if (
      !(await adminDialog.confirm({
        variant: "warning",
        title: "개설 취소",
        description: "이미 개설 완료된 정보를 모두 취소하고 크루 페이지 반영을 원복하시겠습니까?",
        confirmLabel: "개설 취소",
      }))
    )
      return;
    setSaving(true);
    try {
      const { res, json } = await post("cancel");
      if (!json?.success) {
        console.error("[experience] team-overall cancel failed", json?.error);
        t.apiError("cancel", apiErrorFrom(res, json, "개설 취소에 실패했습니다"));
        return;
      }
      const d = json.data as { linesRemoved: number };
      console.warn("[line-opening] cancel result", { linesRemoved: d.linesRemoved });
      toast("success", LINE_OPENING_RESULT.cancelSuccess);
      await fetchBoard();
      onActivity?.();
    } catch (err) {
      console.error("[experience] team-overall cancel error", err);
      toast("error", getApiErrorMessage(err, "개설 취소 중 오류가 발생했습니다"));
    } finally {
      setSaving(false);
    }
  }, [post, fetchBoard, onActivity, toast]);

  if (loading) {
    return <LoadingState active />;
  }
  if (!board) {
    // fail-closed: 보드(개설 기간 판정 포함) 조회 실패 시 개설 UI 자체를 렌더하지 않는다.
    //   개설 검수/완료 버튼이 없으므로 개설 불가 기간이 '개설 가능'으로 표시되는 일이 없다.
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        개설 가능 기간을 확인하지 못했습니다. 다시 시도해 주세요.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {/* 개설 기간 아님(!canOpen) 안내 — 개설되지 않은 상태(needs-opening)와 명확히 구분한다.
          이 주차·팀이 실무 경험 라인의 개설 기간이 아님(cluster4_week_opening_configs SoT). 개설 검수/완료 비활성. */}
      {!canOpen && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span className="font-semibold">미오픈</span> ·{" "}
          {openBlockedReason ?? "선택한 주차는 실무 경험 라인의 개설 기간이 아닙니다."}
        </div>
      )}
      {/* 상태 헤더 */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {/* 확장 주간일 때만 안내(확장 비활성 배지는 노이즈라 제거 — 대체 문구/placeholder 없음). */}
        {extensionActive && (
          <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
            확장 주간 · {board.extensionKind === "online" ? "온라인" : "오프라인"}
          </span>
        )}
        {opened && (
          <span className="text-xs text-muted-foreground">
            개설 완료됨 — 수정하려면 [개설 취소] 후 진행하세요.
          </span>
        )}
      </div>

      {/* 데스크톱(lg+): 좌측 콘텐츠(그리드+아웃풋) + 우측 고정 액션 컬럼. 모바일: 세로 stack.
          파트 선택(PartGrid) 화면의 우측 액션 영역과 동일 구조. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1 space-y-4">
      {/* 전 파트 통합 그리드 — 파트 구분은 [파트] 컬럼 값으로만 표시(파트별 그룹 헤더 제거). */}
      {allCrews.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          이 팀에 평가 대상 크루가 없습니다.
        </p>
      ) : (
        <div ref={lineSelectionSectionRef} className="overflow-x-auto">
          <Table className="min-w-[1340px] table-fixed">
            <BoardColgroup />
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    이름
                    <AdminHelpIconButton
                      size="xs"
                      helpKey={ADMIN_SHARED_HELP_KEYS.crew.name}
                      title="이름"
                    />
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    파트
                    <AdminHelpIconButton
                      size="xs"
                      helpKey="admin.lineOpening.experience.overallColumn.part"
                      title="파트"
                    />
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    클래스
                    <AdminHelpIconButton
                      size="xs"
                      helpKey="admin.lineOpening.experience.overallColumn.crewStatus"
                      title="클래스"
                    />
                  </span>
                </TableHead>
                {EXPERIENCE_OVERALL_CATEGORIES.map((c) => (
                  <TableHead key={c.key} className="text-center">
                    <span className="inline-flex items-center gap-1">
                      {c.label}
                      <AdminHelpIconButton
                        size="xs"
                        helpKey={OVERALL_CATEGORY_HELP_KEY[c.key]}
                        title={c.label}
                      />
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {allCrews.map((crew) => {
                // 미개설 파트 행 = 시각적 비활성(데이터/편집 로직은 불변, 표현만 변경).
                const partInactive =
                  crew.partName != null && inactivePartNames.has(crew.partName);
                return (
                <TableRow
                  key={crew.userId}
                  aria-disabled={partInactive || undefined}
                  title={
                    partInactive
                      ? "아직 [개설 신청]이 완료되지 않은 파트입니다"
                      : undefined
                  }
                  className={cn(
                    // 행 세로 여백 확대(라인명 드롭다운 위아래 숨통) — 모든 셀 py 동시 확대.
                    "[&>td]:py-4",
                    partInactive
                      ? // 미개설 비활성 행: muted 배경 + muted 텍스트 + hover 제거 + 컨트롤 not-allowed 커서.
                        //   행 opacity(0.6)·행 not-allowed 커서는 전역 [aria-disabled="true"] 플로어(globals.css)가 부여.
                        "text-muted-foreground hover:bg-transparent [&>td]:bg-muted/60 [&_input]:cursor-not-allowed [&_select]:cursor-not-allowed"
                      : // 활성 행: 테이블 기본 배경 유지 — 장식용 zebra/hover 배경 제거(상태 오인 방지).
                        //   (전역 table.tsx 는 그대로 두고 이 표에서만 무력화: td 에 기본 배경을 덧칠.)
                        "hover:bg-transparent [&>td]:bg-background",
                  )}
                >
                  {/* 이름 열은 이름만 표기 — 역할(파트장)은 [클래스] 열이 단일 표기처이므로 중복 표기하지 않는다.
                      (crew.isPartLeader 는 DTO 에 그대로 존재 — 표시에서만 쓰지 않는다.) */}
                  <TableCell className="font-medium whitespace-normal break-words">
                    {crew.displayName}
                  </TableCell>
                  <TableCell className="whitespace-normal break-words text-xs text-muted-foreground">
                    {crew.partName ?? "-"}
                  </TableCell>
                  <TableCell className="whitespace-normal break-words text-xs">
                    {displayCrewStatusLabel(crew.statusLabel)}
                  </TableCell>
                  {EXPERIENCE_OVERALL_CATEGORIES.map((c) => {
                    const isLeader = (OVERALL_LEADER_CATEGORIES as string[]).includes(
                      c.key,
                    );
                    if (!isLeader) {
                      const partLineType = c.key as ExperiencePartLineType;
                      // 파트장 — 도출/분석/견문 점수를 직접 선택(입력 경로가 여기뿐). 일반/에이전트는 개설
                      //   신청 셀 SoT 라 아래 읽기전용 배지 유지. 체크박스+점수 select 컴포넌트·허용 점수
                      //   (1~10)·보이드 규칙은 관리/확장 leader 셀과 동일 — 파트장 전용 임의 UI/기본값 없음.
                      if (crew.isPartLeader) {
                        const cell = getLeaderCell(crew.userId, c.key);
                        const fail = isOverallCellFail(cell);
                        // 개설완료·저장중·미개설 파트면 잠금(검수 진행 중 입력 차단 = saving).
                        const disabled = opened || saving || partInactive;
                        // 라인명 선택은 평점과 분리(2026-07-24) — 평점 0점에서도 선택 가능(잠금은 개설완료/저장중/미개설만).
                        const lineDisabled = disabled;
                        return (
                          <TableCell key={c.key} className="text-center align-top">
                            <div className="flex flex-col items-center">
                              {/* 1단: 체크박스+점수 박스(공통 높이 슬롯) — leader 셀과 동일 구조. */}
                              <div className={OVERALL_CELL_TOP_SLOT_CLASS}>
                                <div
                                  className={cn(
                                    "inline-flex items-center gap-2 rounded-md border px-2 py-1.5",
                                    fail ? "border-red-400 bg-red-50" : "border-input bg-background",
                                    checkedRowClass(cell.checked && !fail),
                                  )}
                                >
                                  <Checkbox
                                    checked={cell.checked}
                                    disabled={disabled}
                                    onChange={() => toggleLeaderCheck(crew.userId, crew.displayName, c.key)}
                                    aria-label={`${crew.displayName} ${c.label} 체크`}
                                  />
                                  <select
                                    className="rounded border border-input bg-background px-1.5 py-0.5 text-sm disabled:opacity-60"
                                    // 평점은 0~10 선택 가능(2026-07-24 — 0점 지원). 미체크(=미선택)면 '-' 표시로 실제 0점과 구분.
                                    value={cell.checked ? String(cell.score) : ""}
                                    disabled={disabled}
                                    onChange={(e) =>
                                      setLeaderScore(crew.userId, crew.displayName, c.key, Number(e.target.value))
                                    }
                                    aria-label={`${crew.displayName} ${c.label} 점수`}
                                  >
                                    <option value="" disabled>
                                      -
                                    </option>
                                    {Array.from({ length: 11 }, (_, i) => i).map((n) => (
                                      <option key={n} value={n}>
                                        {n}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              </div>
                              {/* 2단: 라인명 드롭다운 — 검수 편집(파트 신청 셀 SoT 로 write-back). */}
                              <div className={OVERALL_CELL_LINE_SLOT_CLASS}>
                                <ExperienceLineSelect
                                  value={getLineSel(crew.userId, c.key)}
                                  options={lineOptions[partLineType]}
                                  onChange={(id) => setLineSel(crew.userId, c.key, id)}
                                  disabled={lineDisabled}
                                  ariaLabel={`${crew.displayName} ${c.label} 라인명`}
                                  triggerRef={(element) => {
                                    const key = `${crew.userId}:${c.key}`;
                                    if (element) lineSelectionRefs.current.set(key, element);
                                    else lineSelectionRefs.current.delete(key);
                                  }}
                                />
                              </div>
                            </div>
                          </TableCell>
                        );
                      }
                      // 도출/분석/견문 — 체크/점수는 파트신청 라이브(읽기 전용).
                      const cell = crew.cells[c.key];
                      const fail = isOverallCellFail(cell);
                      // ⑩ 검수 단계 수정 권한: 파트장을 제외한 모든 크루의 라인명/평점은 [개설 신청]에서
                      //   확정된 값으로 고정(읽기전용) — 파트장만 검수에서 직접 수정 가능(위 분기).
                      //   (점수는 원래 읽기전용 배지였고, 라인명도 읽기전용으로 통일한다.)
                      const lineDisabled = true;
                      return (
                        <TableCell key={c.key} className="text-center align-top">
                          <div className="flex flex-col items-center">
                            {/* 1단: 점수/상태 슬롯(공통 높이). */}
                            <div className={OVERALL_CELL_TOP_SLOT_CLASS}>
                              <span
                                className={cn(
                                  "inline-block rounded-md border px-2 py-1 text-xs",
                                  fail
                                    ? "border-red-400 bg-red-50 text-red-700"
                                    : "border-green-300 bg-green-50 text-green-800",
                                )}
                              >
                                {cell.checked && cell.score >= 1
                                  ? `✓ ${cell.score}`
                                  : "✕ -"}
                              </span>
                            </div>
                            {/* 2단: 라인명 드롭다운 — 검수 편집(파트 신청 셀 SoT 로 write-back). */}
                            <div className={OVERALL_CELL_LINE_SLOT_CLASS}>
                              <ExperienceLineSelect
                                value={getLineSel(crew.userId, c.key)}
                                options={lineOptions[partLineType]}
                                onChange={(id) => setLineSel(crew.userId, c.key, id)}
                                disabled={lineDisabled}
                                ariaLabel={`${crew.displayName} ${c.label} 라인명`}
                              />
                            </div>
                          </div>
                        </TableCell>
                      );
                    }
                    // 관리/확장 — 팀장 직접 입력(편집).
                    // 관리(management)는 파트장/에이전트 전용 — 일반 크루는 비활성(자격 부재).
                    const mgmtLocked =
                      c.key === "management" && !canEditOverallManagement(crew);
                    if (mgmtLocked) {
                      // 일반 크루 관리 셀 — 점수/라인명 없이 안내 배지 하나뿐. 다른 셀은 상단 정렬(2단 구조)이지만
                      //   이 셀은 배지를 셀(행) 세로 중앙에 둔다: table-cell vertical-align(align-middle)로 중앙 정렬해
                      //   같은 행 다른 컬럼의 체크박스·점수+라인명 묶음의 중심선과 시각적으로 맞춘다.
                      //   ⚠ margin/translateY 로 억지 이동하지 않는다 — 셀 자체 정렬만으로 달성.
                      return (
                        <TableCell key={c.key} className="text-center align-middle">
                          <div className="flex items-center justify-center">
                            <span
                              // 비활성 안내지만 읽히도록 — text-xs(다른 안내 배지와 동일 가독성).
                              //   과도한 축소·흐림 없이 muted 색으로만 비활성 표현.
                              className="inline-block rounded-md border border-dashed border-input bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
                              title="관리 류는 파트장/에이전트 전용입니다 (일반 크루 비활성)"
                            >
                              파트장/에이전트 전용
                            </span>
                          </div>
                        </TableCell>
                      );
                    }
                    const cell = getLeaderCell(crew.userId, c.key);
                    const fail = isOverallCellFail(cell);
                    const disabled =
                      opened || saving || (c.key === "extension" && !extensionActive);
                    // ⑨ 관리(management) 류 라인명은 클래스(파트장/에이전트)에 따라 서버가 고정한다 —
                    //   사용자가 변경할 수 없다(읽기전용). 확장(extension)은 기존대로 팀장이 편집한다.
                    //   ⚠ 점수/체크는 관리도 그대로 편집 가능(⑨는 라인명 고정만) — lineDisabled 만 분기.
                    //   확장 라인명 선택은 평점과 분리(2026-07-24) — 평점 0점에서도 선택 가능(잠금은 개설완료/저장중/확장 비활성만).
                    const lineDisabled =
                      c.key === "management" ? true : disabled;
                    return (
                      <TableCell key={c.key} className="text-center align-top">
                        <div className="flex flex-col items-center">
                          {/* 1단: 체크박스+점수 박스(공통 높이 슬롯). */}
                          <div className={OVERALL_CELL_TOP_SLOT_CLASS}>
                            <div
                              className={cn(
                                "inline-flex items-center gap-2 rounded-md border px-2 py-1.5",
                                disabled && c.key === "extension" && !extensionActive
                                  ? "border-dashed border-input bg-muted/40 opacity-60"
                                  : fail
                                    ? "border-red-400 bg-red-50"
                                    : "border-input bg-background",
                                checkedRowClass(
                                  cell.checked &&
                                    !fail &&
                                    !(disabled && c.key === "extension" && !extensionActive),
                                ),
                              )}
                            >
                              <Checkbox
                                checked={cell.checked}
                                disabled={disabled}
                                onChange={() => toggleLeaderCheck(crew.userId, crew.displayName, c.key)}
                                aria-label={`${crew.displayName} ${c.label} 체크`}
                              />
                              <select
                                className="rounded border border-input bg-background px-1.5 py-0.5 text-sm disabled:opacity-60"
                                // 평점은 0~10 선택 가능(2026-07-24 — 0점 지원). 미체크(=미선택)면 '-' 표시로 실제 0점과 구분.
                                value={cell.checked ? String(cell.score) : ""}
                                disabled={disabled}
                                onChange={(e) =>
                                  setLeaderScore(crew.userId, crew.displayName, c.key, Number(e.target.value))
                                }
                                aria-label={`${crew.displayName} ${c.label} 점수`}
                              >
                                <option value="" disabled>
                                  -
                                </option>
                                {Array.from({ length: 11 }, (_, i) => i).map((n) => (
                                  <option key={n} value={n}>
                                    {n}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                          {/* 2단: 라인명 드롭다운 — 관리/확장도 동일 구조(팀장 셀 SoT 로 저장). */}
                          <div className={OVERALL_CELL_LINE_SLOT_CLASS}>
                            <ExperienceLineSelect
                              value={getLineSel(crew.userId, c.key)}
                              options={lineOptions[c.key]}
                              onChange={(id) => setLineSel(crew.userId, c.key, id)}
                              disabled={lineDisabled}
                              ariaLabel={`${crew.displayName} ${c.label} 라인명`}
                            />
                          </div>
                        </div>
                      </TableCell>
                    );
                  })}
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* 아웃풋 링크 & 이미지 — 카테고리별 [○○ 류] 라인명 + (링크 6 : 설명 4) 한 줄 입력 */}
      <div ref={outputSectionRef} className="space-y-4 rounded-md border p-3">
        <p className="inline-flex items-center gap-1 text-sm font-semibold">
          아웃풋 링크 &amp; 이미지
          <span className="text-destructive" aria-hidden="true">*</span>
          <AdminHelpIconButton
            size="sm"
            helpKey="admin.lineOpening.experience.section.outputLinks"
            title="아웃풋 링크 & 이미지"
          />
        </p>
        <p className="text-xs text-muted-foreground">
          <span className="text-destructive">*</span> 활성 류별 링크 1개와 이미지 1개는 필수 입력입니다.
        </p>
        {EXPERIENCE_OVERALL_CATEGORIES.map((c) => {
          const o = getOutput(c.key);
          const disabled = opened || saving || (c.key === "extension" && !extensionActive);
          return (
            <div key={c.key} className="space-y-1.5">
              {/* 라인 종류 제목만 유지 — 선택된 라인명(예: "[실무 기획] 니즈의 파악 (1/4)") 설명 문구는 표시하지 않는다. */}
              <p className="text-sm font-medium">
                <span className="text-muted-foreground">[{c.label} 류]</span>
                {c.key === "extension" && !extensionActive && (
                  <span className="ml-1 text-xs text-muted-foreground">(확장 주간 외)</span>
                )}
              </p>
              {/* [아웃풋 링크][링크 설명][아웃풋 이미지][이미지 설명] — 한 행 4열(데스크톱), 태블릿 2열, 모바일 1열.
                  이미지 열은 fr(늘어나는 비율)이 아니라 콘텐츠 폭 고정 — 미리보기 박스(w-40=160px) + gap(8) +
                  아이콘 버튼열(size-8=32px) = 200px 만 차지한다. 이렇게 하면 이미지와 이미지 설명 사이의 큰 빈 공간이
                  사라지고, 남는 폭은 이미지 설명 열(1.6fr, 최소 320px)로 넘어가 textarea 가 넓어진다.
                  링크(1.1fr)·링크 설명(1fr)은 충분한 입력 폭 유지. 상단 정렬(items-start)로 시작선 통일. */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-[minmax(240px,1.1fr)_minmax(220px,1fr)_minmax(200px,auto)_minmax(320px,1.6fr)] lg:items-start">
                {/* 아웃풋 링크 */}
                <div
                  ref={(element) => {
                    const key = `${c.key}:link`;
                    if (element) outputWrapRefs.current.set(key, element);
                    else outputWrapRefs.current.delete(key);
                  }}
                  className={cn(
                    "space-y-1.5",
                    invalidOutputKey === `${c.key}:link` && OPENING_INVALID_HIGHLIGHT,
                  )}
                >
                  <Label className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-muted-foreground">
                    링크1
                    {!(c.key === "extension" && !extensionActive) && (
                      <span className="text-destructive" aria-hidden="true">*</span>
                    )}
                    <AdminHelpIconButton
                      size="xs"
                      helpKey="admin.lineOpening.field.outputLink"
                      title="링크1"
                    />
                  </Label>
                  <Input
                    ref={(element) => {
                      const key = `${c.key}:link`;
                      if (element) outputFieldRefs.current.set(key, element);
                      else outputFieldRefs.current.delete(key);
                    }}
                    className="w-full"
                    value={o.link}
                    disabled={disabled}
                    placeholder="URL 입력"
                    // 누락 강조 — Input 은 aria-invalid 에 붉은 테두리+링을 자동 적용(ui/input.tsx).
                    aria-invalid={invalidOutputKey === `${c.key}:link` || undefined}
                    onChange={(e) => setOutput(c.key, { link: e.target.value })}
                  />
                </div>
                {/* 링크 설명 */}
                <div className="space-y-1.5">
                  <Label className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-muted-foreground">
                    설명1
                    <AdminHelpIconButton
                      size="xs"
                      helpKey="admin.lineOpening.field.outputLinkDescription"
                      title="설명1"
                    />
                  </Label>
                  <Input
                    className="w-full"
                    value={o.description}
                    disabled={disabled}
                    placeholder="설명 입력"
                    onChange={(e) => setOutput(c.key, { description: e.target.value })}
                  />
                </div>
                {/* 아웃풋 이미지(자체 라벨 포함) */}
                <OutputImageInput
                  value={o.imageUrl}
                  disabled={disabled}
                  invalid={invalidOutputKey === `${c.key}:image`}
                  onChange={(imageUrl) => setOutput(c.key, { imageUrl })}
                  focusRef={(element) => {
                    const key = `${c.key}:image`;
                    if (element) outputFieldRefs.current.set(key, element);
                    else outputFieldRefs.current.delete(key);
                  }}
                  wrapRef={(element) => {
                    const key = `${c.key}:image`;
                    if (element) outputWrapRefs.current.set(key, element);
                    else outputWrapRefs.current.delete(key);
                  }}
                  required={!(c.key === "extension" && !extensionActive)}
                />
                {/* 이미지 설명 */}
                <div className="space-y-1.5">
                  <Label>아웃풋 이미지 1 설명</Label>
                  <textarea
                    className="flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                    rows={3}
                    value={o.imageDescription}
                    disabled={disabled}
                    onChange={(e) => setOutput(c.key, { imageDescription: e.target.value })}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
        </div>
        {/* 우측 고정 액션 컬럼(lg+) — 1열 4행 세로 버튼 그룹. 모바일: 콘텐츠 하단 stack.
            파트 선택 화면의 우측 액션 영역과 동일 구조. 동작/색상/disabled 조건 무변경. */}
        <div className="flex flex-col gap-2 lg:w-44 lg:shrink-0 lg:self-start lg:border-l lg:pl-3">
          {/* 권장 다음 액션 안내(업무 흐름) — 현재 상태 기준. 권한 제한이 아니라 UX 힌트. */}
          {!opened && (
            <p className="text-xs leading-tight text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                권장 다음 단계
                <AdminHelpIconButton
                  size="xs"
                  helpKey="admin.lineOpening.experience.info.recommendedNext"
                  title="권장 다음 단계"
                />
              </span>
              {": "}
              <span className="font-semibold text-foreground">
                {recommendedNext === "open" ? "개설 완료" : "개설 검수"}
              </span>
            </p>
          )}
          {/* 역할 게이팅(UX) — 비임퍼(actorMemberRole=null)=전체 노출(기존 동작).
              검수=agent/team_leader · 개설/취소=team_leader 만. 서버 가드(403)가 실제 권한 경계.
              variant(강조)는 "권장 다음 액션"에 따라 동적 — 권한/활성 여부와는 별개(팀장은 상태 무관 가능). */}
          {(!actorMemberRole || actorMemberRole === "agent" || actorMemberRole === "team_leader") && (
            <span className="flex w-full items-center gap-1">
              {/* 비활성 상태에서도 실행 시도 시 하단 Toast 안내가 필요하므로 wrapper 클릭 패턴 사용:
                  버튼은 native disabled(시각 비활성·pointer-events-none)로 두고, 감싼 span 이 클릭을
                  받아 handleReviewClick 로 라우팅한다(비활성이면 Toast, 활성이면 실제 검수). */}
              <span
                className="flex min-w-0 flex-1"
                onClick={handleReviewClick}
                title={
                  reviewBlocked
                    ? opened
                      ? "이미 개설 완료됨 — [개설 취소] 후 검수할 수 있습니다."
                      : reviewCompleted
                        ? "이미 개설 검수가 완료된 상태입니다."
                        : (application?.totalPartCount ?? 0) === 0
                          ? OVERALL_NO_TARGET_PARTS_MESSAGE
                          : OVERALL_APPLICATION_INCOMPLETE_MESSAGE
                    : undefined
                }
              >
                <Button
                  variant={recommendedNext === "review" ? "default" : "outline"}
                  className="w-full justify-center"
                  loading={saving}
                  // 미신청/대상없음/검수완료/개설완료면 시각적 비활성(native disabled).
                  //   클릭은 wrapper span 이 받아 사유별 Toast 로 안내(레이아웃 불변·경고 패널 없음).
                  disabled={saving || reviewBlocked}
                  aria-disabled={reviewBlocked || undefined}
                >
                  <Eye className="mr-1.5 h-4 w-4" />
                  개설 검수
                </Button>
              </span>
              <AdminHelpIconButton
                size="xs"
                className="shrink-0"
                helpKey="admin.lineOpening.experience.action.overallReview"
                title="개설 검수"
              />
            </span>
          )}
          <span className="flex w-full items-center gap-1">
            <Button
              variant="outline"
              className="min-w-0 flex-1 justify-center"
              onClick={onReset}
              disabled={saving || opened}
            >
              <RotateCcw className="mr-1.5 h-4 w-4" /> 초기화
            </Button>
            <AdminHelpIconButton
              size="xs"
              className="shrink-0"
              helpKey="admin.lineOpening.experience.action.overallReset"
              title="초기화"
            />
          </span>
          {(!actorMemberRole || actorMemberRole === "team_leader") && (
            <span className="flex w-full items-center gap-1">
              <Button
                // ⑪ 개설 검수 완료(status=reviewed) 후에만 개설 완료 가능 — 팀장도 동일하게 적용한다.
                //   서버 openTeamOverall 이 status!=reviewed 를 409 로 차단(UI 우회 대비 — 동일 판정).
                variant={recommendedNext === "open" ? "default" : "outline"}
                className="min-w-0 flex-1 justify-center"
                onClick={onOpen}
                loading={saving}
                // 개설 기간 아님(!canOpen)·이미 완료(opened)·검수 미완료(!reviewCompleted) 중 하나라도면 비활성.
                disabled={saving || opened || !canOpen || !reviewCompleted}
                title={
                  !canOpen
                    ? openBlockedReason ?? "선택한 주차는 실무 경험 라인의 개설 기간이 아닙니다."
                    : opened
                      ? "이미 개설 완료됨 — 수정하려면 [개설 취소] 후 진행하세요."
                      : !reviewCompleted
                        ? "모든 필수 개설 검수가 완료되어야 개설 완료할 수 있습니다."
                        : undefined
                }
              >
                <CheckCircle2 className="mr-1.5 h-4 w-4" /> 개설 완료
              </Button>
              <AdminHelpIconButton
                size="xs"
                className="shrink-0"
                helpKey="admin.lineOpening.experience.action.overallOpen"
                title="개설 완료"
              />
            </span>
          )}
          {(!actorMemberRole || actorMemberRole === "team_leader") && (
            <span className="flex w-full items-center gap-1">
              <Button
                variant="outline"
                className="min-w-0 flex-1 justify-center border-red-300 text-red-700 hover:bg-red-50"
                onClick={onCancel}
                loading={saving}
                disabled={saving || !opened}
                title={!opened ? "개설 완료 후에만 취소할 수 있습니다" : undefined}
              >
                <XCircle className="mr-1.5 h-4 w-4" /> 개설 취소
              </Button>
              <AdminHelpIconButton
                size="xs"
                className="shrink-0"
                helpKey="admin.lineOpening.experience.action.overallCancel"
                title="개설 취소"
              />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function OutputImageInput({ value, disabled, invalid, onChange, focusRef, wrapRef, required }: { value: string; disabled: boolean; invalid?: boolean; onChange: (url: string) => void; focusRef?: (element: HTMLButtonElement | null) => void; wrapRef?: (element: HTMLDivElement | null) => void; required?: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  const upload = async (file: File) => {
    setUploading(true);
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/admin/cluster4/upload-image", { method: "POST", body });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json?.success || typeof json?.data?.url !== "string") {
        throw apiErrorFrom(response, json, "이미지 업로드에 실패했습니다.");
      }
      onChange(json.data.url);
    } catch (cause) {
      console.error("[experience] output image upload failed", cause);
      setError(getApiErrorMessage(cause, "이미지 업로드에 실패했습니다."));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    // wrapRef + 누락 강조(붉은 ring + 깜빡임) — 링크 필드 wrapper 와 동일한 공용 클래스로 시각 일치.
    <div ref={wrapRef} className={cn("space-y-1.5", invalid && OPENING_INVALID_HIGHLIGHT)}>
      <Label className="inline-flex items-center gap-1">
        아웃풋 이미지 1
        {required && <span className="text-destructive" aria-hidden="true">*</span>}
      </Label>
      <input ref={fileRef} className="hidden" type="file" accept="image/jpeg,image/png,image/webp,image/gif" disabled={disabled || uploading} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
      {/* 미리보기 박스(좌) + 업로드/제거 버튼 스택(우, 2행 1열 그리드) — 한 행 가로 배치.
          박스: 항상 정사각형(aspect-square w-40). 클릭=업로드/교체(기존 hidden input 로직 재사용).
            이미지 없음=점선 "미리보기", 있음=동일 박스 안 object-cover(기존 정책 유지).
          버튼: [업로드/교체][제거] 세로 2행. 클릭 로직은 기존 그대로(fileRef.click / onChange("")).
          업로드 API·저장·disabled·확장 잠금 로직은 무변경 — 이미지 입력 UI만 변경. */}
      <div className="flex items-start gap-2">
        <button
          ref={focusRef}
          type="button"
          disabled={disabled || uploading}
          onClick={() => fileRef.current?.click()}
          aria-label={value ? "아웃풋 이미지 교체" : "아웃풋 이미지 업로드"}
          className={cn(
            "flex aspect-square w-40 shrink-0 items-center justify-center overflow-hidden rounded-md border text-xs text-muted-foreground transition-colors",
            "hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60",
            value ? "border-solid bg-background p-1" : "border-dashed",
          )}
        >
          {value ? (
            <img src={value} alt="아웃풋 이미지 미리보기" className="h-full w-full rounded object-cover" />
          ) : uploading ? (
            "업로드 중…"
          ) : (
            "미리보기"
          )}
        </button>
        {/* 우측 업로드/제거 — 2행 1열 그리드. 아이콘 전용(텍스트 없음), 접근성은 aria-label/title 로. */}
        <div className="grid grid-cols-1 grid-rows-2 gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            loading={uploading}
            disabled={disabled || uploading}
            onClick={() => fileRef.current?.click()}
            aria-label={value ? "이미지 교체" : "이미지 업로드"}
            title={value ? "이미지 교체" : "이미지 업로드"}
          >
            <Upload className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            // 제거 로직(onChange(""))은 기존 그대로. 이미지 없음/비활성/업로드중이면 비활성.
            disabled={disabled || uploading || !value}
            onClick={() => onChange("")}
            aria-label="이미지 제거"
            title="이미지 제거"
          >
            {/* 휴지통 아이콘은 빨간색(파괴적 동작 시각화). disabled 시 Button opacity 로 톤다운. */}
            <Trash2 className="h-4 w-4 text-red-600" />
          </Button>
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
