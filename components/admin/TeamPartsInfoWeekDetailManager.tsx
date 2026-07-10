"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, AlarmClock } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import AdminHelp from "@/components/admin/AdminHelp";
import { ActionControl } from "@/components/admin/ActionControl";
import { ACTION_CONTROL_REGISTRY } from "@/lib/actionControl/registry";
import { LoadingState } from "@/components/ui/loading-state";
import { useToast } from "@/components/ui/toast";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import type { ReviewReadiness } from "@/lib/adminWeekReviewReadiness";
import { readOrgParam } from "@/lib/adminOrgContext";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";
import type {
  TeamPartsInfoWeekDetailData,
  ExperienceLineType,
} from "@/lib/adminTeamPartsInfoWeekDetailData";
import type {
  ActCheckManagementData,
  ActCheckSummary,
  ActCheckActDto,
  ActCheckVariableActDto,
  ActCheckStatus,
} from "@/lib/adminTeamPartsInfoActCheckData";
import type { LineOpeningManagementData } from "@/lib/adminTeamPartsInfoLineOpeningData";

const EXP_TYPE_LABEL: Record<ExperienceLineType, string> = {
  derive: "도출",
  analysis: "분석",
  research: "견문",
  management: "관리",
  expansion: "확장",
};
const EXP_TYPES: ExperienceLineType[] = [
  "derive",
  "analysis",
  "research",
  "management",
  "expansion",
];

// 허브별 카드 색상(기존 팔레트 재사용·신규 색 없음) — 실무 정보=sky · 실무 경험=amber · 실무 역량=violet · 클럽 총괄=emerald.
//   같은 허브의 라인급(체크)·라인(개설) 카드는 동일 색을 공유한다.
const HUB_CARD_CLASS = {
  info: "border-sky-200 bg-sky-50/50",
  experience: "border-amber-200 bg-amber-50/50",
  competency: "border-violet-200 bg-violet-50/50",
  club: "border-emerald-200 bg-emerald-50/40",
} as const;
const HUB_TITLE_CLASS = {
  info: "text-sky-900",
  experience: "text-amber-900",
  competency: "text-violet-900",
  club: "text-emerald-900",
} as const;

type BoolMap = Record<string, boolean>;
// 라인 개설(4) — 팀 × 5카테고리(도출·분석·견문·관리·확장).
type ExpChecked = Record<string, Record<ExperienceLineType, boolean>>;
// 액트 체크(3) — 팀 × 라인급(process_line_groups id).
type TeamGroupChecked = Record<string, Record<string, boolean>>;

type DayKey = keyof ActCheckManagementData["practicalInfo"]["lines"][number]["regularActsByDay"];
type DayCol = { key: DayKey; label: string };

// 요일 2행 배치: [월·화·수·목] / [금·토·일].
const DAY_GROUPS: DayCol[][] = [
  [
    { key: "mon", label: "월" },
    { key: "tue", label: "화" },
    { key: "wed", label: "수" },
    { key: "thu", label: "목" },
  ],
  [
    { key: "fri", label: "금" },
    { key: "sat", label: "토" },
    { key: "sun", label: "일" },
  ],
];
// 두 행의 요일 컬럼 width 를 동일하게 맞추기 위해 요일 칸 수를 4 로 고정한다.
//   금·토·일 행은 남는 1칸을 빈 셀로 채워(내용 없음) 균등 4등분 폭을 공유한다.
const DAY_COLS_PER_ROW = 4;

// 요약 위계: 1=주차 전체(최상위·진한 배경·큰 제목), 2=허브 급(중간), 3=팀(하위·연한 라인 박스).
type SummaryLevel = 1 | 2 | 3;
const SUMMARY_STYLE: Record<SummaryLevel, { box: string; title: string; num: string; label: string }> = {
  1: {
    box: "rounded-lg border-2 border-emerald-800 bg-emerald-600 px-4 py-3 text-emerald-50 shadow-sm",
    title: "text-lg font-extrabold text-white",
    num: "text-lg text-white",
    label: "text-emerald-50/90",
  },
  2: {
    box: "rounded-md border border-emerald-300 bg-emerald-100/80 px-4 py-2.5 text-emerald-900",
    title: "text-base font-bold text-emerald-900",
    num: "text-base text-emerald-950",
    label: "text-emerald-800",
  },
  3: {
    box: "ml-4 rounded border border-emerald-200 border-l-4 border-l-emerald-400 bg-white px-4 py-1.5 text-foreground",
    title: "text-sm font-semibold text-emerald-700",
    num: "text-sm text-foreground",
    label: "text-muted-foreground",
  },
};

function ActSummaryRow({ title, s, level = 2 }: { title: string; s: ActCheckSummary; level?: SummaryLevel }) {
  const st = SUMMARY_STYLE[level];
  const item = (label: string, value: number | string) => (
    <span className={"whitespace-nowrap " + st.label}>
      · {label} <strong className={st.num}>{value}</strong>
    </span>
  );
  return (
    <div className={"flex flex-wrap items-center gap-x-4 gap-y-1 text-sm " + st.box}>
      <span className={st.title}>{title}</span>
      {item("전체", s.totalActs)}
      {item("가동", s.activeActs)}
      {item("체크", s.checkedActs)}
      {item("미체크", s.uncheckedActs)}
      {item("변동", s.variableActs)}
      {item("액트 체크율", `${s.actCheckRate}%`)}
    </div>
  );
}

// 라인 개설 관리 요약(라인칸 개설율) — 액트 요약과 동일 위계(1=주차 전체, 2=허브 급).
function LineSummaryRow({
  title,
  s,
  level = 1,
}: {
  title: string;
  s: LineOpeningManagementData["summary"];
  level?: SummaryLevel;
}) {
  const st = SUMMARY_STYLE[level];
  const item = (label: string, value: number | string) => (
    <span className={"whitespace-nowrap " + st.label}>
      · {label} <strong className={st.num}>{value}</strong>
    </span>
  );
  return (
    <div className={"flex flex-wrap items-center gap-x-4 gap-y-1 text-sm " + st.box}>
      <span className={st.title}>{title}</span>
      {item("전체", s.totalLines)}
      {item("오픈", s.openLines)}
      {item("개설", s.createdLines)}
      {item("미개설", s.notCreatedLines)}
      {item("라인칸 개설율", `${s.lineOpenRate}%`)}
    </div>
  );
}

// 진행 상태 배지 — not_required(개설 불가)/required(개설 필요)/crew_submitting(크루 기입 중)/crew_submission_closed(크루 기입 종료).
type InfoLineRow = LineOpeningManagementData["practicalInfo"]["lines"][number];
// 진행 상태 배지 정책:
//   개설 불가(not_required)   = 에러 아님, "개설 대상 아님" → 회색(빛바램)
//   개설 필요(required)       = 오픈됐으나 미개설 → 빨강/주황(경고)
//   크루 기입 중(submitting)  = 개설 완료·기입 가능 → 초록
//   크루 기입 종료(closed)    = 검수 이후 → 중립/완료(슬레이트)
const PROGRESS_META: Record<InfoLineRow["progressStatus"], { label: string; cls: string }> = {
  not_required: { label: "개설 불가", cls: "bg-zinc-200 text-zinc-500" },
  required: { label: "개설 필요", cls: "bg-orange-500 text-white" },
  crew_submitting: { label: "크루 기입 중", cls: "bg-emerald-600 text-white" },
  crew_submission_closed: { label: "크루 기입 종료", cls: "bg-slate-500 text-white" },
};
function ProgressBadge({ status }: { status: InfoLineRow["progressStatus"] }) {
  const m = PROGRESS_META[status];
  return (
    <span className={"inline-block rounded px-2 py-0.5 text-xs font-bold whitespace-nowrap " + m.cls}>
      {m.label}
    </span>
  );
}

// 라인칸 4상태(액트 카드와 동일한 "상태가 한눈에" 정책 — 데이터/산식 불변, 표시만):
//   not_open       = 이번 주 오픈 안 됨(isOpenThisWeek=false)        → 회색/빛바랜·라인명 외 "-"
//   open_uncreated = 오픈됐으나 미개설(created 아님)                 → 경고색(연한 주황)·개설 후 정보 "-"
//   created_ontime = 오픈·제시간 개설(월 23:59 이전)                 → 초록·✅ 아이콘·전체 정보
//   created_late   = 오픈·지연 개설(월 23:59 이후)                   → 초록(유지)·⏰ 아이콘으로 지연 구분
type InfoLineCardState = "not_open" | "open_uncreated" | "created_ontime" | "created_late";
function resolveInfoLineState(l: InfoLineRow): InfoLineCardState {
  if (!l.isOpenThisWeek) return "not_open";
  const created =
    l.progressStatus === "crew_submitting" || l.progressStatus === "crew_submission_closed";
  if (!created) return "open_uncreated";
  return l.createdTimingStatus === "late" ? "created_late" : "created_ontime";
}
// 상태 표현은 "행 전체 배경"이 아니라 라인명 칩(액트 카드처럼 상태 카드)에만 적용한다.
//   → 표 구조/가독성 유지. 미오픈은 빨강 아님·회색 빛바램(개설 대상 아님).
const INFO_NAME_CHIP_CLASS: Record<InfoLineCardState, string> = {
  not_open: "border-zinc-200 bg-zinc-100 text-zinc-400",
  open_uncreated: "border-orange-300 bg-orange-50 text-orange-900",
  created_ontime: "border-emerald-300 bg-emerald-50 text-emerald-900",
  created_late: "border-emerald-300 bg-emerald-50 text-emerald-900",
};

// 개설 시점 셀 — 라벨 + 타이밍 아이콘(정상=✅ 초록·지연=⏰ 빨강). 미개설=빈칸("-"은 셀에서 처리).
function CreatedAtCell({ row }: { row: InfoLineRow }) {
  if (!row.createdAtLabel) return <span className="text-muted-foreground">-</span>;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span>{row.createdAtLabel}</span>
      {row.createdTimingStatus === "late" ? (
        <AlarmClock className="h-4 w-4 shrink-0 text-rose-500" aria-label="지연 개설" />
      ) : (
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-label="정상 개설" />
      )}
    </span>
  );
}

// 라인칸 개설 상태 표(실무 정보·실무 경험 팀 공용) — 7컬럼·상태별 라인명 칩·"-" 정책.
//   lineAttr = 행 식별 data 속성명(정보=data-info-open-line, 경험=data-exp-open-line).
function LineOpeningTable({ lines, lineAttr }: { lines: InfoLineRow[]; lineAttr: string }) {
  const dash = <span className="text-muted-foreground">-</span>;
  return (
    <div className="overflow-x-auto rounded-md border bg-background">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-zinc-50 text-center">
            <th className="border px-2 py-2 font-semibold">라인명</th>
            <th className="border px-2 py-2 font-semibold">운영진</th>
            <th className="border px-2 py-2 font-semibold">운영</th>
            <th className="border px-2 py-2 font-semibold">개설 시점</th>
            <th className="border px-2 py-2 font-semibold">개설 크루</th>
            <th className="border px-2 py-2 font-semibold">기입 크루</th>
            <th className="border px-2 py-2 font-semibold">진행 상태</th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td colSpan={7} className="border px-2 py-4 text-center text-xs text-muted-foreground">
                표시할 라인이 없습니다.
              </td>
            </tr>
          ) : (
            lines.map((l) => {
              const state = resolveInfoLineState(l);
              const created = state === "created_ontime" || state === "created_late";
              return (
                <tr key={l.lineId} {...{ [lineAttr]: l.lineId }} data-line-state={state} className="align-middle">
                  <td className="border px-2 py-1.5">
                    {/* 라인명 = 상태 카드(액트 카드처럼). 배경/색은 여기에만 적용. */}
                    <span className={"inline-block rounded border px-2 py-0.5 font-semibold " + INFO_NAME_CHIP_CLASS[state]}>
                      {l.lineName}
                    </span>
                  </td>
                  <td className="border px-2 py-1.5 whitespace-nowrap">
                    {created && l.operatorName ? `${l.operatorName} 님` : dash}
                  </td>
                  <td className="border px-2 py-1.5 text-center">
                    <span
                      className={
                        "inline-block rounded px-2 py-0.5 text-xs font-bold " +
                        (l.isOpenThisWeek ? "bg-emerald-700 text-white" : "bg-zinc-200 text-zinc-500")
                      }
                    >
                      {l.isOpenThisWeek ? "오픈" : "미오픈"}
                    </span>
                  </td>
                  <td className="border px-2 py-1.5">{created ? <CreatedAtCell row={l} /> : dash}</td>
                  <td className="border px-2 py-1.5 text-center tabular-nums whitespace-nowrap">
                    {created ? `${l.createdCrewCount} / ${l.eligibleCrewCount}` : dash}
                  </td>
                  <td className="border px-2 py-1.5 text-center tabular-nums whitespace-nowrap">
                    {created ? `${l.submittedCrewCount} / ${l.submissionEligibleCrewCount}` : dash}
                  </td>
                  <td className="border px-2 py-1.5 text-center">
                    <ProgressBadge status={l.progressStatus} />
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

// 허브 급 1: 실무 정보 — 허브 요약 + 라인별 표(요약 위계는 [액트 체크 관리]와 동일).
//   등록된 모든 라인은 항상 표시(오픈 여부로 숨기지 않음). 상태별 배경색으로 한눈에 구분.
function InfoLineOpeningSection({ data }: { data: LineOpeningManagementData["practicalInfo"] }) {
  return (
    <div className="space-y-3" data-hub-section="info-line-opening">
      <LineSummaryRow title="허브 급 1 : [실무 정보]" s={data.summary} level={2} />
      <LineOpeningTable lines={data.lines} lineAttr="data-info-open-line" />
    </div>
  );
}

// 허브 급 2: 실무 경험 — 허브 요약 + 팀 탭 + 선택 팀 요약/라인표. 집계는 선택 "팀 기준".
function ExperienceLineOpeningSection({ data }: { data: LineOpeningManagementData["practicalExperience"] }) {
  const teams = data.teams;
  const [teamId, setTeamId] = useState<string | null>(null);
  const selected = teams.find((t) => t.teamId === teamId) ?? teams[0] ?? null;
  return (
    <div className="space-y-3" data-hub-section="experience-line-opening">
      <LineSummaryRow title="허브 급 2 : [실무 경험]" s={data.summary} level={2} />
      {teams.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          이번 주 활동하는 팀이 없습니다.
        </p>
      ) : (
        <>
          {/* 팀 탭 */}
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="실무 경험 팀 선택">
            {teams.map((t) => (
              <button
                key={t.teamId}
                type="button"
                role="tab"
                aria-selected={selected?.teamId === t.teamId}
                data-exp-team-tab={t.teamId}
                onClick={() => setTeamId(t.teamId)}
                className={
                  "rounded-md border px-3 py-1.5 text-sm font-bold transition-colors " +
                  (selected?.teamId === t.teamId
                    ? "border-emerald-600 bg-emerald-600 text-white"
                    : "border-input bg-background text-muted-foreground hover:bg-muted")
                }
              >
                {t.teamName}
              </button>
            ))}
          </div>
          {selected ? (
            <>
              {/* 선택 팀 요약(하위 위계) + 라인표 */}
              <LineSummaryRow title={`[${selected.teamName}] 팀 요약`} s={selected.summary} level={3} />
              <LineOpeningTable lines={selected.lines} lineAttr="data-exp-open-line" />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

// 허브 급 3: 실무 역량 — 허브 요약 + 등록 라인(마스터)별 표. 구성은 [실무 정보]와 동일.
//   역량은 크루가 선택해 진행 → "개설 필요(required)" 상태 없음(미개설=개설 불가 회색·개설=크루 기입 중/종료).
//   등록 라인은 모두 표시(하드코딩 아님·마스터 조회). 상태 로직/색상은 공용 LineOpeningTable 그대로.
function CompetencyLineOpeningSection({ data }: { data: LineOpeningManagementData["practicalCompetency"] }) {
  return (
    <div className="space-y-3" data-hub-section="competency-line-opening">
      <LineSummaryRow title="허브 급 3 : [실무 역량]" s={data.summary} level={2} />
      <LineOpeningTable lines={data.lines} lineAttr="data-comp-open-line" />
    </div>
  );
}

// 카드 한 줄 렌더 — 존재하는 항목만 " │ " 구분자로 이어 붙인다. 각 항목은 min-w-0 로 셀 폭 안에서 줄바꿈.
function CardRow({ parts }: { parts: ReactNode[] }) {
  return (
    <>
      {parts.map((node, i) => (
        <span key={i} className="flex min-w-0 items-center gap-x-2">
          {i > 0 ? <span className="shrink-0 text-muted-foreground/30">│</span> : null}
          {node}
        </span>
      ))}
    </>
  );
}

// 액트 카드 4상태(현재 상태값만으로 표현 — 데이터/판정 로직 불변):
//   inactive    = 이번 주 가동 대상 아님   → 회색(빛바랜)·액트명만
//   pending     = 가동 대상·아직 미신청     → 기본색·신청시점/담당자·아이콘 없음
//   done_ontime = 제시간 체크 완료          → 초록·✔ 아이콘
//   done_late   = 지연 체크 완료            → 초록·⏰ 아이콘
type CardState = "inactive" | "pending" | "done_ontime" | "done_late";
function resolveCardState(active: boolean, checked: boolean, status: ActCheckStatus): CardState {
  if (!active) return "inactive";
  if (!checked) return "pending";
  return status === "late" ? "done_late" : "done_ontime";
}
const CARD_STATE_CLASS: Record<CardState, string> = {
  inactive: "border-zinc-200 bg-zinc-100 text-zinc-400",
  pending: "border-zinc-300 bg-white",
  done_ontime: "border-emerald-300 bg-emerald-50",
  done_late: "border-emerald-300 bg-emerald-50",
};
function StateIcon({ state }: { state: CardState }) {
  if (state === "done_ontime")
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" aria-label="제시간 체크 완료" />;
  if (state === "done_late")
    return <AlarmClock className="h-4 w-4 shrink-0 text-amber-500" aria-label="지연 체크 완료" />;
  return null;
}

// 정규/변동 공용 상태 카드.
function StateCard({
  state, actName, scheduledLabel, requesterLabel, dataAttrs, tag,
}: {
  state: CardState;
  actName: string;
  scheduledLabel: string | null;
  requesterLabel: string | null;
  dataAttrs: Record<string, string>;
  tag?: ReactNode;
}) {
  // 액트명·신청시점·담당자 모두 셀 폭 안에서 줄바꿈(말줄임 없음·무공백 롱토큰도 강제 줄바꿈).
  const wrapCls = "min-w-0 break-keep [overflow-wrap:anywhere]";
  const parts: ReactNode[] = [<span key="n" className={"font-semibold " + wrapCls}>{actName}</span>];
  if (state !== "inactive") {
    if (scheduledLabel) parts.push(<span key="s" className={"text-muted-foreground " + wrapCls}>{scheduledLabel}</span>);
    if (state === "done_ontime" || state === "done_late") parts.push(<StateIcon key="i" state={state} />);
    if (requesterLabel) parts.push(<span key="r" className={"text-muted-foreground " + wrapCls}>{requesterLabel}</span>);
  }
  return (
    <div
      {...dataAttrs}
      data-card-state={state}
      className={"flex w-full min-w-0 max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2 py-1.5 text-sm " + CARD_STATE_CLASS[state]}
    >
      <CardRow parts={parts} />
      {tag}
    </div>
  );
}

// 정규 액트 카드.
function ActCard({ act }: { act: ActCheckActDto }) {
  const state = resolveCardState(act.isActiveThisWeek, act.isChecked, act.checkStatus);
  return (
    <StateCard
      state={state}
      actName={act.actName}
      scheduledLabel={act.scheduledLabel}
      requesterLabel={act.requesterLabel}
      dataAttrs={{ "data-act": act.actId, "data-act-active": act.isActiveThisWeek ? "1" : "0" }}
    />
  );
}

// 변동 액트 카드 — 항상 신청분(가동), 완료 여부로 상태 결정 + "변동" 배지.
function VariableCard({ act }: { act: ActCheckVariableActDto }) {
  const state = resolveCardState(true, act.checkStatus != null, act.checkStatus);
  return (
    <StateCard
      state={state}
      actName={act.actName}
      scheduledLabel={act.scheduledLabel}
      requesterLabel={act.requesterLabel}
      dataAttrs={{ "data-variable-act": act.id }}
      tag={<span className="ml-auto shrink-0 rounded bg-orange-400 px-1.5 py-0.5 text-xs font-bold text-white">변동</span>}
    />
  );
}

// 허브 라인/변동 데이터 타입(실무 정보·실무 경험 팀 공용).
type HubLine = ActCheckManagementData["practicalInfo"]["lines"][number];
type HubVariableByDay = ActCheckManagementData["practicalInfo"]["variableActsByDay"];

// 요일 헤더 통계(전체·가동·체크·변동) — 표시 데이터로 프론트 산출.
function dayStats(lines: HubLine[], variableActsByDay: HubVariableByDay, key: DayKey) {
  const regular = lines.flatMap((l) => l.regularActsByDay[key]);
  const variable = variableActsByDay[key];
  return {
    total: regular.length + variable.length,
    active: regular.filter((a) => a.isActiveThisWeek).length,
    checked: regular.filter((a) => a.isChecked).length + variable.filter((v) => v.checkStatus != null).length,
    variable: variable.length,
  };
}

function DayHeader({ label, stats }: { label: string; stats: ReturnType<typeof dayStats> }) {
  return (
    <div className="flex items-center gap-2 whitespace-nowrap">
      <span className="rounded bg-slate-700 px-2 py-0.5 text-sm text-white">{label}</span>
      <span className="text-xs font-normal text-muted-foreground">
        전체 <strong className="text-foreground">{stats.total}</strong> · 가동{" "}
        <strong className="text-foreground">{stats.active}</strong> · 체크{" "}
        <strong className="text-foreground">{stats.checked}</strong> · 변동{" "}
        <strong className="text-foreground">{stats.variable}</strong>
      </span>
    </div>
  );
}

// 요일 그룹(월~목 / 금~일) 테이블 — 라인 급 컬럼은 최소폭(colgroup 고정), 요일 컬럼은 넓게 균등 분배.
//   행 내 셀 높이는 표가 자동 정렬(같은 행 = 가장 많은 액트 요일 높이에 맞춤).
function ActCheckGroupTable({ lines, variableActsByDay, cols }: { lines: HubLine[]; variableActsByDay: HubVariableByDay; cols: DayCol[] }) {
  // 요일 칸 수를 4 로 고정 — 부족한 칸은 빈 셀로 채워 두 행의 요일 컬럼 폭을 동일하게 맞춘다.
  const padCount = Math.max(0, DAY_COLS_PER_ROW - cols.length);
  const pads = Array.from({ length: padCount });
  return (
    <table className="w-full table-fixed border-collapse text-sm">
      <colgroup>
        {/* 라인 급 컬럼 고정 폭 — 라인명이 말줄임 없이 보이도록 충분히 확대(10rem=160px). 넘치면
            셀 안에서 줄바꿈(break-keep)으로 흐르되 텍스트는 생략하지 않는다. table-fixed + w-full 이라
            요일 컬럼이 남는 폭을 균등 분배 → 페이지 가로 스크롤이 생기지 않는다. */}
        <col style={{ width: "10rem" }} />
        {Array.from({ length: DAY_COLS_PER_ROW }).map((_, i) => (
          <col key={i} />
        ))}
      </colgroup>
      <thead>
        <tr className="bg-zinc-50">
          <th className="border px-1.5 py-2 text-center align-middle font-semibold whitespace-nowrap">라인 급</th>
          {cols.map((d) => (
            <th key={d.key} className="border px-2 py-2 text-left align-middle font-semibold">
              <DayHeader label={d.label} stats={dayStats(lines, variableActsByDay, d.key)} />
            </th>
          ))}
          {pads.map((_, i) => (
            <th key={`pad-${i}`} aria-hidden className="bg-background" />
          ))}
        </tr>
      </thead>
      <tbody>
        {lines.length === 0 ? (
          <tr>
            <td colSpan={1 + DAY_COLS_PER_ROW} className="border px-2 py-4 text-center text-xs text-muted-foreground">
              표시할 라인급이 없습니다.
            </td>
          </tr>
        ) : (
          lines.map((line) => (
            <tr key={line.lineId} data-info-line-row={line.lineId} className="align-top">
              {/* 라인 급 셀 — 라인명은 말줄임 없이 전부 노출한다. 한 줄 우선, 부족하면 셀 안에서
                  줄바꿈(break-keep=한글 단어 단위)으로 흐른다. truncate/overflow-hidden 미사용. */}
              <td className="border px-1.5 py-2 text-center font-bold">
                <span
                  title={line.lineName}
                  className={
                    "inline-block rounded px-1.5 py-0.5 align-middle text-sm leading-snug break-keep whitespace-normal " +
                    (line.isOpenThisWeek ? "bg-amber-200 text-amber-900" : "bg-zinc-100 text-zinc-500")
                  }
                >
                  {line.lineName}
                </span>
              </td>
              {cols.map((d) => (
                <td key={d.key} className="border px-1.5 py-1.5 align-top">
                  <div className="flex min-w-0 flex-col gap-1">
                    {line.regularActsByDay[d.key].length === 0 ? (
                      <span className="text-xs text-muted-foreground/40">–</span>
                    ) : (
                      line.regularActsByDay[d.key].map((act) => <ActCard key={act.actId} act={act} />)
                    )}
                  </div>
                </td>
              ))}
              {pads.map((_, i) => (
                <td key={`pad-${i}`} aria-hidden className="bg-background" />
              ))}
            </tr>
          ))
        )}
        {/* 변동 액트 행 — 항상 존재(요일별 실제 신청분만). */}
        <tr data-variable-row className="align-top">
          <td className="border bg-orange-50 px-1.5 py-2 text-center text-sm font-bold text-orange-900 whitespace-nowrap">변동 액트</td>
          {cols.map((d) => (
            <td key={d.key} className="border px-1.5 py-1.5 align-top">
              <div className="flex flex-col gap-1">
                {variableActsByDay[d.key].length === 0 ? (
                  <span className="text-xs text-muted-foreground/40">–</span>
                ) : (
                  variableActsByDay[d.key].map((v) => <VariableCard key={v.id} act={v} />)
                )}
              </div>
            </td>
          ))}
          {pads.map((_, i) => (
            <td key={`pad-${i}`} aria-hidden className="bg-background" />
          ))}
        </tr>
      </tbody>
    </table>
  );
}

// 허브 액트 표(실무 정보·실무 경험 팀 공용) — 요일 2행(월~목 / 금~일).
function HubActTable({ lines, variableActsByDay }: { lines: HubLine[]; variableActsByDay: HubVariableByDay }) {
  return (
    <div className="space-y-3">
      {DAY_GROUPS.map((cols, i) => (
        <div key={i} className="overflow-x-auto rounded-md border bg-background" data-day-group={i}>
          <ActCheckGroupTable lines={lines} variableActsByDay={variableActsByDay} cols={cols} />
        </div>
      ))}
    </div>
  );
}

function statusBadge(status: "official_activity" | "official_rest" | null) {
  if (!status) return null;
  const isRest = status === "official_rest";
  return (
    <span
      className={
        "rounded-md px-3 py-1 text-sm font-bold " +
        (isRest ? "bg-zinc-200 text-zinc-700" : "bg-fuchsia-200 text-fuchsia-900")
      }
    >
      {isRest ? "공식 휴식" : "공식 활동"}
    </span>
  );
}

function CheckV() {
  return (
    <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-emerald-600 text-xs font-bold text-white">
      V
    </span>
  );
}

// 조회 전용(개별 조직) 상태 배지 — 완료=초록 / 대기=회색·노랑. 통합 어드민에서 설정한
//   검수·오픈 확인 상태를 그대로 보여주기만 한다(입력 불가).
function ReadOnlyStatusPill({
  done,
  doneLabel,
  pendingLabel,
  dataAttr,
}: {
  done: boolean;
  doneLabel: string;
  pendingLabel: string;
  dataAttr?: string;
}) {
  return (
    <span
      {...(dataAttr ? { [dataAttr]: done ? "true" : "false" } : {})}
      className={
        "inline-flex items-center gap-1 rounded-md px-3 py-1 text-sm font-bold " +
        (done
          ? "bg-emerald-100 text-emerald-800"
          : "bg-amber-100 text-amber-800")
      }
    >
      {done ? <CheckV /> : null}
      {done ? doneLabel : pendingLabel}
    </span>
  );
}

export default function TeamPartsInfoWeekDetailManager({
  weekId,
  readOnly = false,
  listHrefBase = "/admin/team-parts/info/weeks",
}: {
  weekId: string;
  // readOnly=true(클럽 진행 · 개별 조직 운영진): 검수 완료 / 오픈 확인 / 허브·라인 체크박스를
  //   모두 비활성화하고 상태만 표시한다(통합 어드민에서 설정한 상태를 그대로 조회).
  //   통합 어드민(activity 관리)은 readOnly=false 기본값으로 기존 동작이 그대로 유지된다.
  readOnly?: boolean;
  // 상단 back-link( ← 주차 내역 )의 기준 경로.
  listHrefBase?: string;
}) {
  const searchParams = useSearchParams();
  const mode = readScopeMode(searchParams);
  const clubParam = searchParams.get("club");
  const club: OrganizationSlug | null = isOrganizationSlug(clubParam)
    ? clubParam
    : isOrganizationSlug(readOrgParam(searchParams))
      ? (readOrgParam(searchParams) as OrganizationSlug)
      : null;

  const [data, setData] = useState<TeamPartsInfoWeekDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useReportLoading(loading);

  // 편집 가능한 체크 상태(로드 시 DTO 로 초기화). 액트 체크(7)와 라인 개설(8)은 독립 상태다.
  //   액트 체크(1)(3)(6) = 라인급(process_line_groups) 선택 · 라인 개설(2)(4) = 실제 라인 선택.
  const [actInfoChecked, setActInfoChecked] = useState<BoolMap>({}); // (1)
  const [actExpChecked, setActExpChecked] = useState<TeamGroupChecked>({}); // (3)
  const [actClubChecked, setActClubChecked] = useState<BoolMap>({}); // (6)
  const [lineInfoChecked, setLineInfoChecked] = useState<BoolMap>({}); // (2)
  const [lineExpChecked, setLineExpChecked] = useState<ExpChecked>({}); // (4)
  const [compChecked, setCompChecked] = useState(true); // (5) 공유

  const [reviewed, setReviewed] = useState(false);
  const [openConfirmed, setOpenConfirmed] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // 검수 준비 상태 모달.
  const [showReadiness, setShowReadiness] = useState(false);
  const [readiness, setReadiness] = useState<ReviewReadiness | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [showReviewHelp, setShowReviewHelp] = useState(false);
  // 완료/실패 안내는 문서 흐름 배너가 아니라 화면 하단 고정 토스트(<ToastViewport /> · Layout)로.
  //   기존 호출부(setBanner({ kind, message }))를 그대로 재사용하기 위한 얇은 shim.
  //   setBanner(null) 은 "작업 전 배너 지우기"였는데 토스트는 각자 자동/수동 닫힘이라 no-op.
  const { toast } = useToast();
  const setBanner = useCallback(
    (b: { kind: "success" | "error"; message: string } | null) => {
      if (b) toast(b.kind, b.message);
    },
    [toast],
  );
  // 검수 완료/실행 취소 진행 단계 안내(단일 요청 동안 시간 기반 전환). 완료/실패는 요청 resolve
  //   시점에만 토스트로 표시한다(조기 성공 토스트 금지 — progress 는 "진행 중"만 나타낸다).
  const [progress, setProgress] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<"act" | "line">("act");
  // 실무 경험 선택 팀(탭). null 이면 렌더 시 첫 팀으로 폴백.
  const [expTeamId, setExpTeamId] = useState<string | null>(null);

  // [액트 체크 관리] 탭 데이터(탭 진입 시 로드·오픈 확인 후 갱신).
  const [actData, setActData] = useState<ActCheckManagementData | null>(null);
  const [actLoading, setActLoading] = useState(false);
  const [actError, setActError] = useState<string | null>(null);
  const [actRefresh, setActRefresh] = useState(0);

  // [라인 개설 관리] 탭 데이터(주차 전체 요약). 탭 진입/오픈 확인 후 로드.
  const [lineData, setLineData] = useState<LineOpeningManagementData | null>(null);
  const [lineLoading, setLineLoading] = useState(false);
  const [lineError, setLineError] = useState<string | null>(null);

  const listHref = appendModeQuery(
    club ? `${listHrefBase}?org=${club}` : listHrefBase,
    mode,
  );

  // 마운트/파라미터 변경 시 외부(API)와 동기화 — DTO 로 편집 상태를 초기화한다.
  useEffect(() => {
    if (!club) {
      // club 없이 진입한 경우 — 안내만 표시(외부 동기화 effect 의 정상 경로).
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setError("club 파라미터가 필요합니다. (주차 내역에서 진입해 주세요.)");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const params = new URLSearchParams({ club });
        if (mode === "test") params.set("mode", "test");
        const res = await fetch(
          `/api/admin/team-parts/info/weeks/${weekId}?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json?.error ?? `조회 실패 (${res.status})`);
        if (cancelled) return;
        const dto = json.data as TeamPartsInfoWeekDetailData;
        setData(dto);
        const oc = dto.openingConfig;
        setActInfoChecked(Object.fromEntries(oc.actCheck.info.map((g) => [g.lineGroupId, g.checked])));
        setActExpChecked(
          Object.fromEntries(
            oc.actCheck.experience.map((t) => [
              t.teamId,
              Object.fromEntries(t.lineGroups.map((g) => [g.lineGroupId, g.checked])),
            ]),
          ),
        );
        setActClubChecked(Object.fromEntries(oc.actCheck.club.map((g) => [g.lineGroupId, g.checked])));
        setLineInfoChecked(Object.fromEntries(oc.lineOpening.practicalInfo.map((l) => [l.lineId, l.checked])));
        setLineExpChecked(
          Object.fromEntries(
            oc.lineOpening.practicalExperience.map((t) => [
              t.teamId,
              Object.fromEntries(t.lines.map((l) => [l.type, l.checked])) as Record<ExperienceLineType, boolean>,
            ]),
          ),
        );
        setCompChecked(oc.practicalCompetency.checked);
        setReviewed(dto.managedWeek.reviewed);
        setOpenConfirmed(dto.managedWeek.openConfirmed);
      } catch (e) {
        if (cancelled) return;
        setData(null);
        setError(e instanceof Error ? e.message : "조회 실패");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [club, mode, weekId]);

  // [액트 체크 관리] 탭 활성 시(또는 오픈 확인 후) act-check-management 조회.
  useEffect(() => {
    if (activeTab !== "act" || !club) return;
    let cancelled = false;
    // 탭 진입/오픈확인 후 외부(API) 동기화 effect — 로딩표시 setState 는 의도된 동작.
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setActLoading(true);
    setActError(null);
    void (async () => {
      try {
        const params = new URLSearchParams({ club });
        if (mode === "test") params.set("mode", "test");
        const res = await fetch(
          `/api/admin/team-parts/info/weeks/${weekId}/act-check-management?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json?.error ?? `조회 실패 (${res.status})`);
        if (!cancelled) setActData(json.data as ActCheckManagementData);
      } catch (e) {
        if (!cancelled) { setActData(null); setActError(e instanceof Error ? e.message : "조회 실패"); }
      } finally {
        if (!cancelled) setActLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, club, mode, weekId, actRefresh]);

  // [라인 개설 관리] 탭 활성 시(또는 오픈 확인 후) line-opening-management 요약 조회.
  useEffect(() => {
    if (activeTab !== "line" || !club) return;
    let cancelled = false;
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setLineLoading(true);
    setLineError(null);
    void (async () => {
      try {
        const params = new URLSearchParams({ club });
        if (mode === "test") params.set("mode", "test");
        const res = await fetch(
          `/api/admin/team-parts/info/weeks/${weekId}/line-opening-management?${params.toString()}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json?.error ?? `조회 실패 (${res.status})`);
        if (!cancelled) setLineData(json.data as LineOpeningManagementData);
      } catch (e) {
        if (!cancelled) { setLineData(null); setLineError(e instanceof Error ? e.message : "조회 실패"); }
      } finally {
        if (!cancelled) setLineLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, club, mode, weekId, actRefresh]);

  // 저장 payload — 라인 개설(8) = practical* (기존 키·기존 동작 불변), 액트 체크(7) = actCheck(신설).
  //   두 선택은 서로 독립. competency(정상 진행) 는 (7)(8) 공유.
  const buildConfig = () => ({
    practicalInfo: lineInfoChecked,
    practicalExperience: lineExpChecked,
    practicalCompetency: { checked: compChecked },
    actCheck: {
      info: actInfoChecked,
      experience: actExpChecked,
      club: actClubChecked,
    },
  });

  const onOpenConfirm = async () => {
    if (!club || readOnly) return;
    setConfirming(true);
    setBanner(null);
    try {
      const res = await fetch(
        appendModeQuery(`/api/admin/team-parts/info/weeks/${weekId}/open-confirm?club=${club}`, mode),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config: buildConfig() }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json?.error ?? `저장 실패 (${res.status})`);
      setOpenConfirmed(true);
      setBanner({ kind: "success", message: "오픈 설정이 저장되었습니다." });
      // 액트 체크 관리 탭 "가동" 상태가 오픈 설정 기준으로 갱신되도록 재조회 트리거.
      setActRefresh((n) => n + 1);
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : "오픈 확인 실패" });
    } finally {
      setConfirming(false);
    }
  };

  // [초기화] — 상단 허브 선택 상태를 기본값으로 되돌린다(클라이언트 편집 상태만·서버 write 없음).
  //   실무 정보(라인급/라인)·실무 역량·클럽 총괄 = 전부 미선택 / 실무 경험 라인급 = 전체 체크 /
  //   실무 경험 라인(개설) = 현재 주차 기본값(도출·분석·견문·관리=true·확장=isExpansionWeek).
  //   저장 전 상태를 기본값으로 복원 → 이후 [오픈 확인] 을 누르면 이 기본값이 그대로 저장된다.
  const resetToDefaults = () => {
    if (!data || readOnly) return;
    const oc = data.openingConfig;
    setActInfoChecked(Object.fromEntries(oc.actCheck.info.map((g) => [g.lineGroupId, false])));
    setLineInfoChecked(Object.fromEntries(oc.lineOpening.practicalInfo.map((l) => [l.lineId, false])));
    setActExpChecked(
      Object.fromEntries(
        oc.actCheck.experience.map((t) => [t.teamId, Object.fromEntries(t.lineGroups.map((g) => [g.lineGroupId, true]))]),
      ),
    );
    setActClubChecked(Object.fromEntries(oc.actCheck.club.map((g) => [g.lineGroupId, false])));
    const expDef = data.managedWeek.isExpansionWeek;
    setLineExpChecked(
      Object.fromEntries(
        oc.lineOpening.practicalExperience.map((t) => [
          t.teamId,
          Object.fromEntries(EXP_TYPES.map((ty) => [ty, ty === "expansion" ? expDef : true])) as Record<ExperienceLineType, boolean>,
        ]),
      ),
    );
    setCompChecked(false);
    setBanner({ kind: "success", message: "허브 선택을 기본값으로 초기화했습니다. [오픈 확인]을 눌러 저장하세요." });
  };

  // 단일 요청(검수 완료/실행 취소) 동안 단계 안내를 시간 기반으로 전환한다. 서버 처리 순서
  //   (성적 rollback/확정 → 고객 카드 snapshot 재계산)를 반영하되, 실제 완료는 요청 resolve
  //   시점에만 banner 로 표시한다(조기 성공 토스트 금지). 반환한 stop() 을 finally 에서 호출해
  //   타이머를 정리하고 progress 를 반드시 해제한다(로딩 state 가 남지 않도록).
  const startStagedProgress = (stages: { label: string; afterMs: number }[]): (() => void) => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const s of stages) {
      if (s.afterMs <= 0) setProgress(s.label);
      else timers.push(setTimeout(() => setProgress(s.label), s.afterMs));
    }
    return () => {
      for (const t of timers) clearTimeout(t);
      setProgress(null);
    };
  };

  //   force=true (테스트 전용): 안전장치 bypass 요청. 서버가 scope 로 최종 판정하므로
  //   operating 실유저 경로에서는 무시된다(플래그를 보내도 거부). mode=test(QA)에서만 실효.
  const onReview = async (force = false) => {
    if (!club || readOnly) return;
    setReviewing(true);
    setBanner(null);
    // 단계 안내: 성적 확정 → 고객 카드 재계산(snapshot 다건이 벽시계를 지배).
    const stopProgress = startStagedProgress([
      { label: "성적 확정하는 중…", afterMs: 0 },
      { label: "크루 카드 다시 계산 중…", afterMs: 1200 },
    ]);
    try {
      const res = await fetch(
        appendModeQuery(`/api/admin/team-parts/info/weeks/${weekId}/review?club=${club}`, mode),
        force
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ allowIncompleteTestData: true }),
            }
          : { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json?.error ?? `검수 실패 (${res.status})`);
      setReviewed(true);
      setShowReadiness(false);
      setBanner({
        kind: "success",
        message: force
          ? "테스트 데이터 불완전 상태에서 강제로 검수 완료했습니다. (완료)"
          : "주차 검수가 완료되었습니다. (완료)",
      });
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : "주차 검수 실패" });
    } finally {
      // 성공/실패/예외 무관하게 progress·loading state 를 반드시 해제한다.
      stopProgress();
      setReviewing(false);
    }
  };

  // [주차 검수] 클릭 → 준비 상태 조회 후 모달 표시(읽기 전용). 조건 충족 시에만 실제 검수 완료.
  const openReadiness = async () => {
    if (!club || readOnly) return;
    setShowReadiness(true);
    setReadiness(null);
    setReadinessLoading(true);
    setBanner(null);
    try {
      const res = await fetch(
        appendModeQuery(
          `/api/admin/team-parts/info/weeks/${weekId}/review-readiness?club=${club}`,
          mode,
        ),
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json?.error ?? `준비 상태 조회 실패 (${res.status})`);
      setReadiness(json.data as ReviewReadiness);
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : "준비 상태 조회 실패" });
      setShowReadiness(false);
    } finally {
      setReadinessLoading(false);
    }
  };

  // ↩ 실행 취소 — 주차 검수(공표+검수) 실행 직전 상태로 복원(성장 성공/실패·고객 앱 표시 원복).
  //   확인 모달은 공용 ActionControl 이 담당(강한 확인 문구).
  const onReviewRevert = async () => {
    if (!club || readOnly) return;
    setReverting(true);
    setBanner(null);
    // 단계 안내: 성적 되돌리기(uws/공표·검수 rollback) → 고객 카드 재계산(snapshot 다건).
    const stopProgress = startStagedProgress([
      { label: "성적 되돌리는 중…", afterMs: 0 },
      { label: "크루 카드 다시 계산 중…", afterMs: 1200 },
    ]);
    try {
      const res = await fetch(
        appendModeQuery(`/api/admin/team-parts/info/weeks/${weekId}/review?club=${club}`, mode),
        { method: "DELETE" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json?.error ?? `실행 취소 실패 (${res.status})`);
      setReviewed(false);
      setBanner({
        kind: "success",
        message: json.data?.reverted
          ? "주차 검수를 실행 취소했습니다(‘검수 전·집계 중’ 상태로 복원). (완료)"
          : "이미 미확정(집계 중) 상태입니다. (완료)",
      });
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : "실행 취소 실패" });
    } finally {
      // 성공/실패/예외 무관하게 progress·loading state 를 반드시 해제한다.
      stopProgress();
      setReverting(false);
    }
  };

  // 액트 체크(7) 토글 — (1) 정보 라인급 · (3) 경험 팀×라인급 · (6) 클럽 라인급.
  const toggleActInfo = (lineGroupId: string) =>
    setActInfoChecked((p) => ({ ...p, [lineGroupId]: !p[lineGroupId] }));
  const toggleActExp = (teamId: string, lineGroupId: string) =>
    setActExpChecked((p) => ({
      ...p,
      [teamId]: { ...p[teamId], [lineGroupId]: !p[teamId]?.[lineGroupId] },
    }));
  const toggleActClub = (lineGroupId: string) =>
    setActClubChecked((p) => ({ ...p, [lineGroupId]: !p[lineGroupId] }));
  // 라인 개설(8) 토글 — (2) 정보 라인 · (4) 경험 팀×카테고리.
  const toggleLineInfo = (lineId: string) =>
    setLineInfoChecked((p) => ({ ...p, [lineId]: !p[lineId] }));
  const toggleLineExp = (teamId: string, type: ExperienceLineType) =>
    setLineExpChecked((p) => ({
      ...p,
      [teamId]: { ...p[teamId], [type]: !p[teamId]?.[type] },
    }));

  const currentWeek = data?.currentWeek ?? null;
  const managedWeek = data?.managedWeek ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>활동 관리</CardTitle>
        <div className="flex items-center gap-3">
          <Link
            href={listHref}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            ← 주차 내역
          </Link>
          <AdminHelp />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {progress ? (
          <div
            className="flex items-center gap-2 rounded-md bg-sky-50 px-3 py-2 text-sm text-sky-700"
            role="status"
            aria-live="polite"
          >
            <span
              className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-sky-300 border-t-sky-600"
              aria-hidden
            />
            <span>{progress}</span>
          </div>
        ) : null}
        {/* 완료/실패 안내는 하단 고정 토스트로 표시(문서 흐름 인라인 배너 제거).
            위 progress 는 "진행 중" 인디케이터라 인라인 유지. */}

        {error ? (
          <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        ) : loading ? (
          <LoadingState active />
        ) : data ? (
          <>
            {/* [1] 현재 주차 배너 */}
            <section
              data-current-week
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-dashed border-red-300 px-4 py-3 text-sm"
            >
              <span>
                오늘은, <strong className="text-base">{currentWeek?.todayLabel ?? "-"}</strong>
              </span>
              <span className="rounded bg-sky-50 px-2 py-0.5 font-semibold text-sky-800">
                {currentWeek?.seasonWeekName ?? "-"}
                {currentWeek?.seasonWeekName ? "입니다." : null}
              </span>
              <span className="text-muted-foreground">{currentWeek?.weekRangeLabel ?? "-"}</span>
              <span className="ml-auto">{statusBadge(currentWeek?.activityStatus ?? null)}</span>
            </section>

            {/* [2] 관리 주차 카드 + [3] 주차 검수 */}
            <section
              data-managed-week
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-sky-50/60 px-4 py-3 text-sm"
            >
              <span className="font-semibold">▷ 관리 주차</span>
              <span
                data-managed-week-name
                className="rounded-md bg-fuchsia-100 px-3 py-1 font-bold text-fuchsia-900"
              >
                {managedWeek?.weekName}
              </span>
              <span className="text-muted-foreground">{managedWeek?.weekRangeLabel}</span>
              {statusBadge(managedWeek?.activityStatus ?? null)}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {/* [주차 검수] — 클릭 시 "검수 준비 상태" 모달을 먼저 연다(바로 확정하지 않음). */}
                <Button
                  type="button"
                  data-review-button
                  onClick={openReadiness}
                  disabled={readOnly || reviewing || reviewed}
                  className="bg-slate-800 text-white hover:bg-slate-700"
                >
                  {reviewed ? "검수 완료" : reviewing ? "검수 중…" : "주차 검수"}
                </Button>
                {/* 검수 준비 상태 모달. */}
                {showReadiness && !readOnly && (
                  <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                    role="dialog"
                    aria-modal="true"
                    data-review-readiness-modal
                  >
                    <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
                      <div className="flex items-center justify-between">
                        <h3 className="text-base font-semibold text-slate-800">검수 준비 상태</h3>
                        <button
                          type="button"
                          onClick={() => setShowReviewHelp((v) => !v)}
                          className="text-xs text-slate-500 underline hover:text-slate-700"
                        >
                          {showReviewHelp ? "도움말 닫기" : "검수 완료란? (도움말)"}
                        </button>
                      </div>

                      {showReviewHelp && (
                        <div className="mt-3 rounded-md bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
                          <p className="font-medium text-slate-700">검수 완료를 하면 어떻게 되나요?</p>
                          <ul className="mt-1 list-disc pl-4">
                            <li>이번 주 활동 결과를 <b>최종 확정</b>합니다.</li>
                            <li>대상자별 결과가 <b>성공 · 실패 · 휴식</b>으로 결정됩니다.</li>
                            <li>크루 페이지에도 <b>확정된 결과가 바로 반영</b>됩니다.</li>
                            <li>잘못 확정한 경우에는 <b>실행 취소</b>로 이전 상태로 되돌릴 수 있습니다.</li>
                          </ul>
                        </div>
                      )}

                      {readinessLoading || !readiness ? (
                        <p className="mt-4 text-sm text-slate-500">준비 상태를 확인하는 중…</p>
                      ) : !readiness.applicable ? (
                        <p className="mt-4 text-sm text-slate-600">
                          {readiness.notApplicableReason ?? "이 주차는 준비 상태 점검 대상이 아닙니다."}
                        </p>
                      ) : (
                        <>
                          <ul className="mt-4 space-y-2">
                            {readiness.items.map((it) => (
                              <li key={it.key} className="flex items-start gap-2 text-sm">
                                <span className={it.ok ? "text-emerald-600" : "text-rose-500"}>
                                  {it.ok ? "✅" : "❌"}
                                </span>
                                <span className="flex-1">
                                  <span className={it.ok ? "text-slate-700" : "font-medium text-slate-800"}>
                                    {it.label}
                                  </span>
                                  <span className="ml-1 text-xs text-slate-500">— {it.detail}</span>
                                </span>
                              </li>
                            ))}
                          </ul>
                          {!readiness.ready && (
                            <p className="mt-3 rounded-md bg-rose-50 p-2 text-xs text-rose-700">
                              아직 검수 완료를 진행할 준비가 되지 않았습니다. ❌ 표시된 항목을 완료한 후
                              다시 검수 완료를 진행해주세요.
                            </p>
                          )}
                        </>
                      )}

                      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
                        <Button
                          type="button"
                          onClick={() => setShowReadiness(false)}
                          disabled={reviewing}
                          className="border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                        >
                          닫기
                        </Button>
                        {/* 테스트 전용 강제 진행 — mode=test 에서만. 운영 모드에선 렌더 안 됨. */}
                        {mode === "test" && (
                          <Button
                            type="button"
                            data-force-review-confirm
                            onClick={() => onReview(true)}
                            disabled={reviewing}
                            className="border border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100"
                            title="테스트 데이터가 불완전해도 안전장치를 건너뛰고 검수 완료합니다(테스트 모드 전용)."
                          >
                            {reviewing ? "진행 중…" : "테스트 데이터가 불완전하지만 강제로 검수 완료"}
                          </Button>
                        )}
                        <Button
                          type="button"
                          data-review-confirm
                          onClick={() => onReview(false)}
                          disabled={reviewing || readinessLoading || !readiness?.applicable || !readiness?.ready}
                          className="bg-slate-800 text-white hover:bg-slate-700 disabled:opacity-50"
                          title={
                            readiness && readiness.applicable && !readiness.ready
                              ? "부족한 항목을 먼저 완료해주세요."
                              : undefined
                          }
                        >
                          {reviewing ? "검수 중…" : "검수 완료"}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
                {/* 공용 수동 실행 — 기존 [주차 검수] 버튼이 이미 즉시 실행 역할을 하므로(중복 방지)
                    ⚡ 즉시 실행은 두지 않고, 옆에 ↩ 실행 취소(검수 실행 직전 복원)만 추가한다. */}
                {!readOnly && (
                  <div data-ac-week-review>
                    <ActionControl
                      hideInstant
                      onRollback={onReviewRevert}
                      rollbackBusy={reverting}
                      rollbackClass={ACTION_CONTROL_REGISTRY.weekResultPublish.rollback.class}
                      rollbackDisabled={!reviewed}
                      rollbackDisabledReason="주차 검수(확정)된 주차에서만 실행 취소할 수 있습니다."
                      rollbackConfirmDescription={
                        "이 작업은 주차 검수를 실행하기 전 상태로 되돌립니다.\n변경된 주차 결과와 크루 페이지 표시도 함께 이전 상태로 복원됩니다.\n정말 실행하시겠습니까?"
                      }
                      mode={mode === "test" ? "test" : "operating"}
                    />
                  </div>
                )}
                {readOnly ? (
                  <ReadOnlyStatusPill
                    done={reviewed}
                    doneLabel="주차 검수 완료"
                    pendingLabel="주차 검수 대기"
                    dataAttr="data-reviewed"
                  />
                ) : reviewed ? (
                  <span data-reviewed="true">
                    <CheckV />
                  </span>
                ) : null}
              </div>
            </section>

            {/* [4] 허브/라인 오픈 설정 + [9] 오픈 확인 */}
            <section className="space-y-3 rounded-lg border border-dashed border-red-300 p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="rounded bg-cyan-100 px-1 text-lg font-bold"># 이번 주 클럽에서 활동하는 허브와 라인</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    * 여기서 체크된 허브 &amp; 라인 들이, 아래 액트 체크와 라인 개설 여부에 반영됩니다.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {/* 기존 '오픈 확인' 버튼 — 그대로 유지(대체/이름변경 금지). */}
                  <Button
                    type="button"
                    data-open-confirm-button
                    onClick={onOpenConfirm}
                    disabled={readOnly || confirming}
                    className="bg-slate-800 text-white hover:bg-slate-700"
                  >
                    {confirming ? "저장 중…" : "오픈 확인"}
                  </Button>
                  {/* [초기화] — 상단 허브 선택을 기본값으로 되돌린다(클라이언트 상태만·이후 오픈 확인 시 저장). */}
                  {!readOnly && (
                    <Button
                      type="button"
                      data-hub-reset-button
                      onClick={resetToDefaults}
                      disabled={confirming}
                      className="border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                    >
                      초기화
                    </Button>
                  )}
                  {readOnly ? (
                    <ReadOnlyStatusPill
                      done={openConfirmed}
                      doneLabel="오픈 확인 완료"
                      pendingLabel="오픈 확인 전"
                      dataAttr="data-open-confirmed"
                    />
                  ) : openConfirmed ? (
                    <span data-open-confirmed="true">
                      <CheckV />
                    </span>
                  ) : null}
                </div>
              </div>

              {/* 허브별로 라인 급(체크)→(7) 액트 체크 / 라인(개설)→(8) 라인 개설 을 독립 열로 분리.
                  카드 배경색은 "허브 기준"으로 통일 — 실무 정보=sky · 실무 경험=amber · 실무 역량=violet · 클럽 총괄=emerald.
                  라벨은 카드 밖으로 넘치지 않도록 자연 줄바꿈(break-keep + overflow-wrap:anywhere)·말줄임 없음. */}
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {/* (1) [실무 정보] 라인 급(체크) → 액트 체크 */}
                <div data-hub="info-act" className={"rounded-md border p-3 " + HUB_CARD_CLASS.info}>
                  <p className={"mb-2 text-sm font-bold " + HUB_TITLE_CLASS.info}>[실무 정보] 라인 급(체크)</p>
                  <div className="grid grid-cols-1 gap-x-3 gap-y-1.5 sm:grid-cols-2">
                    {data.openingConfig.actCheck.info.length === 0 ? (
                      <span className="text-xs text-muted-foreground">라인급 없음 (프로세스 등록에서 추가)</span>
                    ) : (
                      data.openingConfig.actCheck.info.map((g) => (
                        <label
                          key={g.lineGroupId}
                          data-act-info-line={g.lineGroupId}
                          className={"flex min-w-0 items-start gap-2 text-sm " + (readOnly ? "cursor-not-allowed opacity-70" : "cursor-pointer")}
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4 shrink-0"
                            checked={actInfoChecked[g.lineGroupId] ?? false}
                            disabled={readOnly}
                            onChange={() => toggleActInfo(g.lineGroupId)}
                          />
                          <span className="min-w-0 break-keep [overflow-wrap:anywhere]">{g.name}</span>
                        </label>
                      ))
                    )}
                  </div>
                </div>

                {/* (2) [실무 정보] 라인(개설) → 라인 개설 */}
                <div data-hub="info-line" className={"rounded-md border p-3 " + HUB_CARD_CLASS.info}>
                  <p className={"mb-2 text-sm font-bold " + HUB_TITLE_CLASS.info}>[실무 정보] 라인(개설)</p>
                  <div className="grid grid-cols-1 gap-x-3 gap-y-1.5 sm:grid-cols-2">
                    {data.openingConfig.lineOpening.practicalInfo.length === 0 ? (
                      <span className="text-xs text-muted-foreground">라인 없음</span>
                    ) : (
                      data.openingConfig.lineOpening.practicalInfo.map((l) => (
                        <label
                          key={l.lineId}
                          data-line-info-line={l.lineId}
                          className={"flex min-w-0 items-start gap-2 text-sm " + (readOnly ? "cursor-not-allowed opacity-70" : "cursor-pointer")}
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4 shrink-0"
                            checked={lineInfoChecked[l.lineId] ?? false}
                            disabled={readOnly}
                            onChange={() => toggleLineInfo(l.lineId)}
                          />
                          <span className="min-w-0 break-keep [overflow-wrap:anywhere]">{l.lineName}</span>
                        </label>
                      ))
                    )}
                  </div>
                </div>

                {/* (3) [실무 경험] 라인 급(체크) → 액트 체크 : 팀 × 라인급 매트릭스 */}
                <div data-hub="exp-act" className={"rounded-md border p-3 " + HUB_CARD_CLASS.experience}>
                  <p className={"mb-2 text-sm font-bold " + HUB_TITLE_CLASS.experience}>[실무 경험] 라인 급(체크)</p>
                  {data.openingConfig.actCheck.experience.length === 0 ? (
                    <span className="text-xs text-muted-foreground">팀 없음</span>
                  ) : (
                    <table className="w-full table-fixed text-sm">
                      <thead>
                        <tr className="text-xs text-muted-foreground">
                          <th className="px-1 py-1 text-left">팀</th>
                          {(data.openingConfig.actCheck.experience[0]?.lineGroups ?? []).map((g) => (
                            <th key={g.lineGroupId} className="px-1 py-1 text-center font-medium break-keep [overflow-wrap:anywhere]">
                              {g.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.openingConfig.actCheck.experience.map((team) => (
                          <tr key={team.teamId} data-act-exp-team={team.teamId}>
                            <td className="px-1 py-1 font-medium break-keep [overflow-wrap:anywhere]">{team.teamName}</td>
                            {team.lineGroups.map((g) => (
                              <td key={g.lineGroupId} className="px-1 py-1 text-center">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4"
                                  data-act-exp-cell={`${team.teamId}:${g.lineGroupId}`}
                                  checked={actExpChecked[team.teamId]?.[g.lineGroupId] ?? false}
                                  disabled={readOnly}
                                  onChange={() => toggleActExp(team.teamId, g.lineGroupId)}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* (4) [실무 경험] 라인(오픈) → 라인 개설 : 팀 × 도출·분석·견문·관리·확장 */}
                <div data-hub="exp-line" className={"rounded-md border p-3 " + HUB_CARD_CLASS.experience}>
                  <p className={"mb-2 text-sm font-bold " + HUB_TITLE_CLASS.experience}>[실무 경험] 라인(오픈)</p>
                  {data.openingConfig.lineOpening.practicalExperience.length === 0 ? (
                    <span className="text-xs text-muted-foreground">팀 없음</span>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-muted-foreground">
                          <th className="px-1 py-1 text-left">팀</th>
                          {EXP_TYPES.map((t) => (
                            <th key={t} className="px-1 py-1 text-center font-medium">
                              {EXP_TYPE_LABEL[t]}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.openingConfig.lineOpening.practicalExperience.map((team) => (
                          <tr key={team.teamId} data-line-exp-team={team.teamId}>
                            <td className="px-1 py-1 font-medium break-keep [overflow-wrap:anywhere]">{team.teamName}</td>
                            {EXP_TYPES.map((type) => (
                              <td key={type} className="px-1 py-1 text-center">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4"
                                  data-line-exp-cell={`${team.teamId}:${type}`}
                                  checked={lineExpChecked[team.teamId]?.[type] ?? false}
                                  disabled={readOnly}
                                  onChange={() => toggleLineExp(team.teamId, type)}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* (5) [실무 역량] 정상 진행 — (7)(8) 공유 (기존 색상 유지) */}
                <div data-hub="competency" className={"rounded-md border p-3 " + HUB_CARD_CLASS.competency}>
                  <p className={"mb-2 text-sm font-bold " + HUB_TITLE_CLASS.competency}>[실무 역량] 체크/개설</p>
                  <label className={"flex min-w-0 items-center gap-2 text-sm " + (readOnly ? "cursor-not-allowed opacity-70" : "cursor-pointer")}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0"
                      data-competency-checkbox
                      checked={compChecked}
                      disabled={readOnly}
                      onChange={() => setCompChecked((v) => !v)}
                    />
                    <span className="min-w-0 break-keep [overflow-wrap:anywhere]">정상 진행</span>
                  </label>
                </div>

                {/* (6) [클럽 총괄] 라인 급(체크) → 액트 체크 (기존 색상 유지·라인 개설 없음) */}
                <div data-hub="club-act" className={"rounded-md border p-3 " + HUB_CARD_CLASS.club}>
                  <p className={"mb-2 text-sm font-bold " + HUB_TITLE_CLASS.club}>[클럽 총괄] 라인 급(체크)</p>
                  <div className="grid grid-cols-1 gap-x-3 gap-y-1.5 sm:grid-cols-2">
                    {data.openingConfig.actCheck.club.length === 0 ? (
                      <span className="text-xs text-muted-foreground">라인급 없음 (프로세스 등록에서 추가)</span>
                    ) : (
                      data.openingConfig.actCheck.club.map((g) => (
                        <label
                          key={g.lineGroupId}
                          data-act-club-line={g.lineGroupId}
                          className={"flex min-w-0 items-start gap-2 text-sm " + (readOnly ? "cursor-not-allowed opacity-70" : "cursor-pointer")}
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4 shrink-0"
                            checked={actClubChecked[g.lineGroupId] ?? false}
                            disabled={readOnly}
                            onChange={() => toggleActClub(g.lineGroupId)}
                          />
                          <span className="min-w-0 break-keep [overflow-wrap:anywhere]">{g.name}</span>
                        </label>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </section>

            {/* [10] 하단 탭 — 버튼만(컨텐츠 placeholder) */}
            <section className="space-y-0">
              <div className="grid grid-cols-2 overflow-hidden rounded-t-md border border-b-0">
                {(["act", "line"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    data-tab={tab}
                    onClick={() => setActiveTab(tab)}
                    className={
                      "px-4 py-2 text-sm font-bold transition-colors " +
                      (activeTab === tab
                        ? "bg-emerald-500 text-white"
                        : "bg-emerald-50 text-emerald-800 hover:bg-emerald-100")
                    }
                  >
                    {tab === "act" ? "액트 체크 관리" : "라인 개설 관리"}
                  </button>
                ))}
              </div>
              <div
                data-tab-content
                className="min-h-[120px] rounded-b-md border bg-muted/20 p-4"
              >
                {activeTab === "line" ? (
                  lineLoading ? (
                    <LoadingState active />
                  ) : lineError ? (
                    <p className="py-6 text-center text-sm text-red-700">{lineError}</p>
                  ) : lineData ? (
                    <div className="space-y-5" data-line-opening-panel>
                      {/* [0] 주차 전체 요약 — 최상위 */}
                      <LineSummaryRow title="# 주차 전체 라인칸 개설 관리" s={lineData.summary} level={1} />
                      {/* 허브 급 1: 실무 정보 — 요약 + 라인별 표 */}
                      <InfoLineOpeningSection data={lineData.practicalInfo} />
                      {/* 허브 급 2: 실무 경험 — 요약 + 팀 탭 + 선택 팀 라인표 */}
                      <ExperienceLineOpeningSection data={lineData.practicalExperience} />
                      {/* 허브 급 3: 실무 역량 — 요약 + 등록 라인별 표 */}
                      <CompetencyLineOpeningSection data={lineData.practicalCompetency} />
                    </div>
                  ) : (
                    <p className="py-6 text-center text-sm text-muted-foreground">데이터가 없습니다.</p>
                  )
                ) : actLoading ? (
                  <LoadingState active />
                ) : actError ? (
                  <p className="py-6 text-center text-sm text-red-700">{actError}</p>
                ) : actData ? (
                  <div className="space-y-5" data-act-check-panel>
                    {/* [0] 주차 전체 요약 — 최상위 */}
                    <ActSummaryRow title="# 주차 전체 액트 체크 관리" s={actData.summary} level={1} />

                    {/* 허브 급 0: 클럽 총괄 — 실무 정보와 동일 UI(허브 요약 + 라인급/요일 액트). */}
                    <div className="space-y-3" data-hub-section="club">
                      <ActSummaryRow title="허브 급 0 : [클럽 총괄]" s={actData.clubOverall.summary} level={2} />
                      <HubActTable
                        lines={actData.clubOverall.lines}
                        variableActsByDay={actData.clubOverall.variableActsByDay}
                      />
                    </div>

                    {/* 허브 급 1: 실무 정보 — 중위 */}
                    <div className="space-y-3" data-hub-section="info">
                      <ActSummaryRow title="허브 급 1 : [실무 정보]" s={actData.practicalInfo.summary} level={2} />
                      <HubActTable
                        lines={actData.practicalInfo.lines}
                        variableActsByDay={actData.practicalInfo.variableActsByDay}
                      />
                    </div>

                    {/* 허브 급 2: 실무 경험 (팀 탭) */}
                    {(() => {
                      const teams = actData.practicalExperience.teams;
                      const selected = teams.find((t) => t.teamId === expTeamId) ?? teams[0] ?? null;
                      return (
                        <div className="space-y-3" data-hub-section="experience">
                          <ActSummaryRow title="허브 급 2 : [실무 경험]" s={actData.practicalExperience.summary} level={2} />
                          {teams.length === 0 ? (
                            <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                              이번 주 활동하는 팀이 없습니다.
                            </p>
                          ) : (
                            <>
                              {/* 팀 탭 */}
                              <div className="flex flex-wrap gap-1" role="tablist" aria-label="실무 경험 팀 선택">
                                {teams.map((t) => (
                                  <button
                                    key={t.teamId}
                                    type="button"
                                    role="tab"
                                    aria-selected={selected?.teamId === t.teamId}
                                    data-exp-team-tab={t.teamId}
                                    onClick={() => setExpTeamId(t.teamId)}
                                    className={
                                      "rounded-md border px-3 py-1.5 text-sm font-bold transition-colors " +
                                      (selected?.teamId === t.teamId
                                        ? "border-emerald-600 bg-emerald-600 text-white"
                                        : "border-input bg-background text-muted-foreground hover:bg-muted")
                                    }
                                  >
                                    {t.teamName}
                                  </button>
                                ))}
                              </div>
                              {selected ? (
                                <>
                                  {/* 선택 팀 요약 — 하위 */}
                                  <ActSummaryRow title={`[${selected.teamName}] 팀 요약`} s={selected.summary} level={3} />
                                  {/* 선택 팀 라인급 × 요일 액트 */}
                                  <HubActTable
                                    lines={selected.lines}
                                    variableActsByDay={selected.variableActsByDay}
                                  />
                                </>
                              ) : null}
                            </>
                          )}
                        </div>
                      );
                    })()}

                    {/* 허브 급 3: 실무 역량 — 실무 정보와 동일 UI(허브 요약 + 라인급/요일 액트). */}
                    <div className="space-y-3" data-hub-section="competency">
                      <ActSummaryRow title="허브 급 3 : [실무 역량]" s={actData.practicalCompetency.summary} level={2} />
                      <HubActTable
                        lines={actData.practicalCompetency.lines}
                        variableActsByDay={actData.practicalCompetency.variableActsByDay}
                      />
                    </div>
                  </div>
                ) : (
                  <p className="py-6 text-center text-sm text-muted-foreground">데이터가 없습니다.</p>
                )}
              </div>
            </section>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
