"use client";

import { useEffect, useState, type ReactNode } from "react";
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
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
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

type InfoChecked = Record<string, boolean>;
type ExpChecked = Record<string, Record<ExperienceLineType, boolean>>;

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

// 카드 한 줄 렌더 — 존재하는 항목만 " │ " 구분자로 이어 붙인다.
function CardRow({ parts }: { parts: ReactNode[] }) {
  return (
    <>
      {parts.map((node, i) => (
        <span key={i} className="flex items-center gap-x-2 whitespace-nowrap">
          {i > 0 ? <span className="text-muted-foreground/30">│</span> : null}
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
  const parts: ReactNode[] = [<span key="n" className="font-semibold">{actName}</span>];
  if (state !== "inactive") {
    if (scheduledLabel) parts.push(<span key="s" className="text-muted-foreground">{scheduledLabel}</span>);
    if (state === "done_ontime" || state === "done_late") parts.push(<StateIcon key="i" state={state} />);
    if (requesterLabel) parts.push(<span key="r" className="text-muted-foreground">{requesterLabel}</span>);
  }
  return (
    <div
      {...dataAttrs}
      data-card-state={state}
      className={"flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border px-2 py-1.5 text-sm " + CARD_STATE_CLASS[state]}
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
        {/* 라인 급 컬럼 고정 폭(7rem=112px) — 긴 라인명이 요일 컬럼을 침범하지 못하게 고정. */}
        <col style={{ width: "7rem" }} />
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
              {/* 라인 급 셀 — overflow-hidden 으로 셀 밖 침범 차단. 배지는 max-w-full + truncate(nowrap+ellipsis)
                  로 셀 안에서만 표시하고 넘치면 말줄임(…). 전체 이름은 title 툴팁으로. */}
              <td className="overflow-hidden border px-1.5 py-2 text-center font-bold">
                <span
                  title={line.lineName}
                  className={
                    "inline-block max-w-full truncate rounded px-1.5 py-0.5 align-middle text-sm " +
                    (line.isOpenThisWeek ? "bg-amber-200 text-amber-900" : "bg-zinc-100 text-zinc-500")
                  }
                >
                  {line.lineName}
                </span>
              </td>
              {cols.map((d) => (
                <td key={d.key} className="border px-1.5 py-1.5 align-top">
                  <div className="flex flex-col gap-1">
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

  // 편집 가능한 체크 상태(로드 시 DTO 로 초기화).
  const [infoChecked, setInfoChecked] = useState<InfoChecked>({});
  const [expChecked, setExpChecked] = useState<ExpChecked>({});
  const [compChecked, setCompChecked] = useState(true);

  const [reviewed, setReviewed] = useState(false);
  const [openConfirmed, setOpenConfirmed] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [banner, setBanner] = useState<{ kind: "success" | "error"; message: string } | null>(null);

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
        setInfoChecked(
          Object.fromEntries(dto.openingConfig.practicalInfo.map((l) => [l.lineId, l.checked])),
        );
        setExpChecked(
          Object.fromEntries(
            dto.openingConfig.practicalExperience.map((t) => [
              t.teamId,
              Object.fromEntries(t.lines.map((l) => [l.type, l.checked])) as Record<
                ExperienceLineType,
                boolean
              >,
            ]),
          ),
        );
        setCompChecked(dto.openingConfig.practicalCompetency.checked);
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

  const buildConfig = () => ({
    practicalInfo: infoChecked,
    practicalExperience: expChecked,
    practicalCompetency: { checked: compChecked },
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

  // ↩ 실행 취소 — 직전 단계("오픈 확인 전") 복원. open_confirmed=false(config 보존)·snapshot 무접촉.
  const onOpenConfirmRevert = async () => {
    if (!club || readOnly) return;
    setBanner(null);
    const res = await fetch(
      appendModeQuery(`/api/admin/team-parts/info/weeks/${weekId}/open-confirm?club=${club}`, mode),
      { method: "DELETE" },
    );
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json?.error ?? `취소 실패 (${res.status})`);
    setOpenConfirmed(false);
    setBanner({ kind: "success", message: "오픈 확인이 취소되었습니다(‘오픈 확인 전’ 상태)." });
    // 액트 체크 관리 탭 "가동" 상태가 오픈 설정 기준으로 갱신되도록 재조회 트리거.
    setActRefresh((n) => n + 1);
  };

  const onReview = async () => {
    if (!club || readOnly) return;
    setReviewing(true);
    setBanner(null);
    try {
      const res = await fetch(
        appendModeQuery(`/api/admin/team-parts/info/weeks/${weekId}/review?club=${club}`, mode),
        { method: "POST" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json?.error ?? `검수 실패 (${res.status})`);
      setReviewed(true);
      setBanner({ kind: "success", message: "주차 검수가 완료되었습니다." });
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : "주차 검수 실패" });
    } finally {
      setReviewing(false);
    }
  };

  // ↩ 실행 취소 — 주차 검수(공표+검수) 실행 직전 상태로 복원(성장 성공/실패·고객 앱 표시 원복).
  //   확인 모달은 공용 ActionControl 이 담당(강한 확인 문구).
  const onReviewRevert = async () => {
    if (!club || readOnly) return;
    setReverting(true);
    setBanner(null);
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
          ? "주차 검수를 실행 취소했습니다(‘검수 전·집계 중’ 상태로 복원)."
          : "이미 미확정(집계 중) 상태입니다.",
      });
    } catch (e) {
      setBanner({ kind: "error", message: e instanceof Error ? e.message : "실행 취소 실패" });
    } finally {
      setReverting(false);
    }
  };

  const toggleInfo = (lineId: string) =>
    setInfoChecked((p) => ({ ...p, [lineId]: !p[lineId] }));
  const toggleExp = (teamId: string, type: ExperienceLineType) =>
    setExpChecked((p) => ({
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
        {banner ? (
          <div
            className={
              "rounded-md px-3 py-2 text-sm " +
              (banner.kind === "success" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700")
            }
          >
            {banner.message}
          </div>
        ) : null}

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
                {/* 기존 [주차 검수] 버튼 — 그대로 유지(대체/이름변경 금지). */}
                <Button
                  type="button"
                  data-review-button
                  onClick={onReview}
                  disabled={readOnly || reviewing || reviewed}
                  className="bg-slate-800 text-white hover:bg-slate-700"
                >
                  {reviewed ? "검수 완료" : reviewing ? "검수 중…" : "주차 검수"}
                </Button>
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
                        "이 작업은 주차 검수를 실행하기 전 상태로 되돌립니다.\n변경된 주차 결과와 고객 앱 표시도 함께 이전 상태로 복원됩니다.\n정말 실행하시겠습니까?"
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
                  {/* 공용 수동 실행 — 기존 [오픈 확인] 버튼이 이미 즉시 실행 역할을 하므로(중복 방지)
                      ⚡ 즉시 실행은 두지 않고, 옆에 ↩ 실행 취소(직전 단계 복원)만 추가한다. */}
                  {!readOnly && (
                    <div data-ac-open-confirm>
                      <ActionControl
                        hideInstant
                        onRollback={onOpenConfirmRevert}
                        rollbackClass={ACTION_CONTROL_REGISTRY.weekOpenConfirm.rollback.class}
                        rollbackDisabled={!openConfirmed}
                        rollbackDisabledReason="아직 오픈 확인되지 않았습니다."
                        mode={mode === "test" ? "test" : "operating"}
                      />
                    </div>
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

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(220px,1fr)_minmax(320px,1.4fr)_minmax(160px,0.7fr)_minmax(180px,0.8fr)]">
                {/* [5] 실무 정보 */}
                <div data-hub="info" className="rounded-md border border-sky-200 bg-sky-50/50 p-3">
                  <p className="mb-2 font-bold">[실무 정보]</p>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                    {data.openingConfig.practicalInfo.map((l) => (
                      <label key={l.lineId} className="flex items-center gap-2 text-sm" data-info-line={l.lineId}>
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={infoChecked[l.lineId] ?? false}
                          disabled={readOnly}
                          onChange={() => toggleInfo(l.lineId)}
                        />
                        <span className="truncate">{l.lineName}</span>
                      </label>
                    ))}
                    {data.openingConfig.practicalInfo.length === 0 ? (
                      <span className="text-xs text-muted-foreground">라인 없음</span>
                    ) : null}
                  </div>
                </div>

                {/* [6] 실무 경험 */}
                <div data-hub="experience" className="overflow-x-auto rounded-md border border-sky-200 bg-sky-50/50 p-3">
                  <p className="mb-2 font-bold">[실무 경험]</p>
                  {data.openingConfig.practicalExperience.length === 0 ? (
                    <span className="text-xs text-muted-foreground">팀 없음</span>
                  ) : (
                    <table className="text-sm">
                      <thead>
                        <tr className="text-xs text-muted-foreground">
                          <th className="px-2 py-1 text-left">팀</th>
                          {EXP_TYPES.map((t) => (
                            <th key={t} className="px-2 py-1 text-center font-medium">
                              {EXP_TYPE_LABEL[t]}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.openingConfig.practicalExperience.map((team) => (
                          <tr key={team.teamId} data-exp-team={team.teamId}>
                            <td className="whitespace-nowrap px-2 py-1 font-medium">{team.teamName}</td>
                            {EXP_TYPES.map((type) => (
                              <td key={type} className="px-2 py-1 text-center">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4"
                                  data-exp-cell={`${team.teamId}:${type}`}
                                  checked={expChecked[team.teamId]?.[type] ?? false}
                                  disabled={readOnly}
                                  onChange={() => toggleExp(team.teamId, type)}
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* [7] 실무 역량 */}
                <div data-hub="competency" className="rounded-md border border-sky-200 bg-sky-50/50 p-3">
                  <p className="mb-2 font-bold">[실무 역량]</p>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      data-competency-checkbox
                      checked={compChecked}
                      disabled={readOnly}
                      onChange={() => setCompChecked((v) => !v)}
                    />
                    <span>정상 진행</span>
                  </label>
                </div>

                {/* [8] 실무 경력 */}
                <div data-hub="career" className="rounded-md border border-sky-200 bg-sky-50/50 p-3">
                  <p className="mb-2 font-bold">[실무 경력]</p>
                  <p className="text-xs text-muted-foreground">
                    [실무 경력] 산하 라인들은 별도 페이지에서 관리합니다.
                  </p>
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
