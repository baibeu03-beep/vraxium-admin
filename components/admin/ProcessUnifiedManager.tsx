"use client";

// /admin/processes/register (= "프로세스 관리") — 프로세스 등록 + 프로세스 정보 통합 화면.
//
// 상단: 액트/라인급 "마스터" 등록 폼 (POST /api/admin/processes/{line-groups,acts}).
// 하단: 전체 허브 액트를 단일 표로 조회 (GET /api/admin/processes/info?hub=all) + 삭제.
//
// 사용자 수행기록 · user_weekly_points 자동 합산 · 주차 성장 계산 · snapshot · checkGate 판정은
// 일절 건드리지 않는다 — point.check 를 "정의"하는 카탈로그이며 계산 반영은 별도 Phase.
// 조직/모드(demoUserId·mode=test) 구분 없음 — 허브×라인급×액트 전역 1세트(동일 DTO).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { adminDialog } from "@/components/ui/admin-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import AdminHelp from "@/components/admin/AdminHelp";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import ExecutionTimeCell from "@/components/admin/ExecutionTimeCell";
import { useStickyColumns, type StickyColProps } from "@/components/ui/sticky-columns";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SelectBadge } from "@/components/ui/status-badge";
import { CONFIRM, useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { Checkbox, checkedTextClass } from "@/components/ui/checkbox";
import { pointColorClass } from "@/components/ui/point-value";
import {
  PROCESS_ACT_TYPE_LABEL,
  PROCESS_ACT_TYPE_OPTIONS,
  PROCESS_CAFE_LABEL,
  PROCESS_CAFE_OPTIONS,
  PROCESS_CHECK_TARGET_LABEL,
  PROCESS_CHECK_TARGET_OPTIONS,
  PROCESS_DOW_LABELS,
  PROCESS_DURATION_OPTIONS,
  PROCESS_HUBS,
  PROCESS_HUB_LABEL,
  PROCESS_LINE_GROUP_MAX,
  PROCESS_NAME_MAX,
  PROCESS_POINT_OPTIONS,
  PROCESS_TIME_OPTIONS,
  PROCESS_WEEK_REFS,
  PROCESS_WEEK_REF_LABEL,
  enforcePointC,
  formatProcessWhen,
  isReviewGapTooShort,
  PROCESS_REVIEW_GAP_MESSAGE,
  PROCESS_OCCUR_FIRST_MESSAGE,
  PROCESS_REVIEW_GAP_IMMEDIATE_MESSAGE,
  processWhenOrdinal,
  reactionAllowsPointC,
  type ProcessActDto,
  type ProcessActSummary,
  type ProcessActType,
  type ProcessCafe,
  type ProcessCheckTarget,
  type ProcessHub,
  type ProcessLineGroupDto,
  type ProcessLineGroupScope,
  type ProcessPointTriplet,
  type ProcessWeekRef,
} from "@/lib/adminProcessesTypes";
import { LoadingState } from "@/components/ui/loading-state";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";

type Banner = { kind: "success" | "error"; message: string } | null;

const SELECT_CLS =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-60";
const FILTER_SELECT_CLS = "h-9 rounded-md border border-input bg-background px-3 text-sm";
const PAGE_SIZE = 15;

const EMPTY_SUMMARY: ProcessActSummary = {
  actCount: 0,
  lineGroupCount: 0,
  totalDurationMinutes: 0,
  required: { check: 0, advantage: 0, penalty: 0 },
  excellent: { check: 0, advantage: 0, penalty: 0 },
  max: { check: 0, advantage: 0, penalty: 0 },
};

// 허브 급 드롭다운 — 디폴트 "-"(미선택). "-" 상태에서는 등록 불가.
const HUB_PLACEHOLDER = "" as const;

// ── 필터 (표시용) ──────────────────────────────────────────────────────────
type FilterKey = "all" | "required" | "optional" | "selection" | "basic" | "check" | "posting";
const FILTER_OPTIONS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "required", label: "필수" },
  { key: "optional", label: "선택" },
  { key: "selection", label: "선발" },
  { key: "basic", label: "기본" },
  { key: "check", label: "체크" },
  { key: "posting", label: "포스팅" },
];

// 허브 급 필터 — 전체 + 5개 허브.
type HubFilterKey = "all" | ProcessHub;

function matchFilter(a: ProcessActDto, f: FilterKey): boolean {
  switch (f) {
    case "all":
      return true;
    case "required":
    case "optional":
    case "selection":
    case "basic":
      return a.actType === f;
    case "check":
      return a.checkTarget === "check";
    case "posting":
      return a.cafe === "occur";
    default:
      return true;
  }
}

const weekRank = (w: string) => (w === "N" ? 0 : 1);
// ── 통합 표 컬럼 정렬/도움말 정의 (season-weeks/라인 정보 표와 동일 기준) ────────
//   · 정렬 기준값은 표시 문자열이 아니라 실제 정렬값(허브/종류=순서 인덱스, 시점=ordinal,
//     소요/포인트=숫자, 그 외=문자열 locale). null/"-" 은 방향 무관 항상 뒤로.
//   · 정렬 button 과 도움말 button 은 형제(중첩 금지) + 도움말은 stopPropagation → 정렬 비간섭.
//   · 삭제(액션)는 정렬 의미 없어 제외(정렬 컨트롤 미노출, 도움말은 유지).
type ProcColKey =
  | "hub" | "actName" | "lineGroup" | "duration"
  | "execution" | "pointA" | "pointB" | "pointC"
  | "actType" | "checkTarget" | "cafe" | "actions";
type ProcSortValue = number | string | null;

const ACT_TYPE_RANK: Record<string, number> = {
  required: 0, optional: 1, selection: 2, basic: 3,
};

type ProcColumnDef = {
  key: ProcColKey;
  label: string;
  helpKey: string;
  headClass: string;
  align: "left" | "center";
  sortable: boolean;
  sortValue: (a: ProcessActDto) => ProcSortValue;
};

const PROC_COLUMNS: ProcColumnDef[] = [
  { key: "hub", label: "허브 급", helpKey: "admin.processes.register.column.hub", headClass: "w-[84px]", align: "center", sortable: true, sortValue: (a) => (PROCESS_HUBS as readonly string[]).indexOf(a.hub) },
  { key: "actName", label: "액트명", helpKey: "admin.processes.register.column.actName", headClass: "min-w-[320px] text-left", align: "left", sortable: true, sortValue: (a) => a.actName },
  { key: "lineGroup", label: "소속 라인 급", helpKey: "admin.processes.register.column.lineGroup", headClass: "min-w-[150px] text-left", align: "left", sortable: true, sortValue: (a) => a.lineGroupName ?? null },
  { key: "duration", label: "소요(m)", helpKey: "admin.processes.register.column.duration", headClass: "w-[64px]", align: "center", sortable: true, sortValue: (a) => a.durationMinutes },
  // 이행 시점(필요) = 신청 시점(필요)+검수 시점(필요) 통합(셀 안 2행). 정렬은 신청(occur) 기준.
  { key: "execution", label: "이행 시점(필요)", helpKey: "admin.processes.register.column.executionWhen", headClass: "w-[172px]", align: "center", sortable: true, sortValue: (a) => processWhenOrdinal(a.occurWeek, a.occurDow, a.occurTime) },
  { key: "pointA", label: "Po.A", helpKey: "admin.processes.register.column.pointA", headClass: "w-[52px]", align: "center", sortable: true, sortValue: (a) => a.pointCheck },
  { key: "pointB", label: "Po.B", helpKey: "admin.processes.register.column.pointB", headClass: "w-[52px]", align: "center", sortable: true, sortValue: (a) => a.pointAdvantage },
  { key: "pointC", label: "Po.C", helpKey: "admin.processes.register.column.pointC", headClass: "w-[52px]", align: "center", sortable: true, sortValue: (a) => a.pointPenalty },
  { key: "actType", label: "액트 종류", helpKey: "admin.processes.register.column.actType", headClass: "w-[96px]", align: "center", sortable: true, sortValue: (a) => ACT_TYPE_RANK[a.actType] ?? 99 },
  { key: "checkTarget", label: "체크 대상", helpKey: "admin.processes.register.column.checkTarget", headClass: "w-[88px]", align: "center", sortable: true, sortValue: (a) => (a.checkTarget === "check" ? 0 : 1) },
  { key: "cafe", label: "카페", helpKey: "admin.processes.register.column.cafe", headClass: "w-[72px]", align: "center", sortable: true, sortValue: (a) => (a.cafe === "occur" ? 0 : 1) },
  { key: "actions", label: "삭제", helpKey: "admin.processes.register.column.actions", headClass: "w-[72px]", align: "center", sortable: false, sortValue: () => null },
];

// null/빈값/"-" 은 정렬 방향과 무관하게 항상 뒤로. 숫자는 숫자, 문자열은 한글 locale.
function compareProcValues(a: ProcSortValue, b: ProcSortValue, dir: "asc" | "desc"): number {
  const aEmpty = a == null || a === "" || a === "-";
  const bEmpty = b == null || b === "" || b === "-";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  let c: number;
  if (typeof a === "number" && typeof b === "number") c = a - b;
  else c = String(a).localeCompare(String(b), "ko");
  return dir === "asc" ? c : -c;
}

// 컬럼 헤더 — 정렬 button(정렬 가능 컬럼만) + 도움말 button 을 형제로 둔다.
function ProcSortableHeader({
  col, dir, onSort, sticky,
}: {
  col: ProcColumnDef;
  dir: "asc" | "desc" | null;
  onSort: () => void;
  sticky?: StickyColProps;
}) {
  return (
    <TableHead
      className={cn(col.headClass, sticky?.className)}
      data-sticky-col={sticky?.["data-sticky-col"]}
      aria-sort={
        !col.sortable ? undefined : dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"
      }
    >
      <div className={cn("inline-flex items-center gap-1", col.align === "center" && "justify-center")}>
        {col.sortable ? (
          <button
            type="button"
            onClick={onSort}
            aria-label={`${col.label} 정렬`}
            className={cn(
              "inline-flex items-center gap-1 font-semibold tracking-wide text-muted-foreground hover:text-foreground",
              dir && "text-foreground",
            )}
          >
            <span>{col.label}</span>
            {dir === "asc" ? <ArrowUp className="h-3 w-3" /> : dir === "desc" ? <ArrowDown className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3 opacity-40" />}
          </button>
        ) : (
          <span className="font-semibold tracking-wide text-muted-foreground">{col.label}</span>
        )}
        <AdminHelpIconButton helpKey={col.helpKey} title={col.label} size="xs" />
      </div>
    </TableHead>
  );
}

// A/B/C 를 균등 분산으로 표시 (붙어보이지 않게) — 요약 카드 공용.
function PointTripletCells({ t }: { t: ProcessPointTriplet }) {
  return (
    // 3열 균등(grid-cols-3)·넓은 간격(gap-x-6)·flex-1 로 값 컨테이너의 남는 폭을 모두 채운다.
    // 부모 값 컨테이너(SummaryCell growValue)가 flex 로 확장되므로 고정 min-w 대신 가변 폭.
    <div className="grid flex-1 grid-cols-3 gap-x-6 tabular-nums">
      {(
        [
          ["A", t.check],
          ["B", t.advantage],
          ["C", t.penalty],
        ] as const
      ).map(([k, v]) => (
        <span key={k} className="flex items-baseline justify-end gap-1">
          <span className="text-xs font-normal text-muted-foreground">{k}</span>
          <span>{v}</span>
        </span>
      ))}
    </div>
  );
}

function pageItems(current: number, total: number): (number | "...")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const items: (number | "...")[] = [1];
  if (current > 3) items.push("...");
  for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) items.push(i);
  if (current < total - 2) items.push("...");
  items.push(total);
  return items;
}

// 독립 통계 셀 — 라벨(좌) + 값(우, 우측정렬). 그리드로 나열해 박스 전체 폭을 균등 분산한다.
function SummaryCell({
  label,
  value,
  helpKey,
  growValue = false,
}: {
  label: string;
  value: React.ReactNode;
  helpKey?: string;
  // A/B/C 삼중값처럼 값 영역이 남는 가로 폭을 모두 채워야 할 때 true.
  growValue?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 rounded-md bg-background/50 px-3 py-2">
      {/* growValue 시 라벨은 고정폭(shrink-0)·줄바꿈 금지로 유지해 값 영역에 남는 폭을 넘긴다. */}
      <span
        className={cn(
          "inline-flex items-center gap-1 text-sm text-muted-foreground",
          growValue && "shrink-0 whitespace-nowrap",
        )}
      >
        {label}
        {helpKey && <AdminHelpIconButton helpKey={helpKey} title={label} size="xs" />}
      </span>
      <span
        className={cn(
          "text-sm font-semibold tabular-nums",
          growValue ? "flex min-w-0 flex-1" : "shrink-0",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function FormRow({
  label,
  helpKey,
  required,
  children,
  alignTop,
}: {
  label: string;
  // 지정 시 라벨 오른쪽에 편집형 돋보기 도움말. 라벨 영역(176px 컬럼)에만 배치 → 입력 폭 불변.
  helpKey?: string;
  required?: boolean;
  children: React.ReactNode;
  alignTop?: boolean;
}) {
  return (
    <div
      className={cn(
        // 라벨 컬럼: 커진 폰트에서 "신청 시점(필요)" 등 최장 라벨 + 돋보기가 한 줄로 들어오도록 196px.
        "grid grid-cols-[196px_minmax(0,1fr)] gap-3",
        alignTop ? "items-start" : "items-center",
      )}
    >
      <div className={cn("inline-flex items-center gap-1", alignTop && "pt-2")}>
        <Label className="whitespace-nowrap text-sm text-foreground">
          {label}
          {required && <span className="ml-0.5 text-red-500">*</span>}
        </Label>
        {helpKey && <AdminHelpIconButton helpKey={helpKey} title={label} size="xs" />}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

// 주/요일/시간 3종 묶음 입력 (신청 시점 · 검수 시점 공용).
//   각 select 는 선두에 "-"(미선택, value="") 옵션을 두고 기본값을 미선택으로 둔다.
//   week=""/dow=""/time="" 셋 모두 채워졌을 때만 "시점 선택 완료"로 취급한다(호출부 판정).
//   intercept: 열기 직전 가로채기(mousedown/keydown). true 반환 시 드롭다운을 열지 않는다
//     — 검수 시점을 "신청 시점 미선택" 상태에서 조작하려 할 때 팝업만 띄우고 값 변경을 막는 용도.
function WhenInput({
  week,
  dow,
  time,
  onWeek,
  onDow,
  onTime,
  disabled,
  idPrefix,
  intercept,
}: {
  week: ProcessWeekRef | "";
  dow: number | "";
  time: string;
  onWeek: (v: ProcessWeekRef | "") => void;
  onDow: (v: number | "") => void;
  onTime: (v: string) => void;
  disabled?: boolean;
  idPrefix: string;
  intercept?: () => boolean;
}) {
  // 클릭 가로채기 — 드롭다운을 열지 않는다.
  const guardMouse = intercept
    ? (e: React.MouseEvent) => {
        if (intercept()) e.preventDefault();
      }
    : undefined;
  // 키보드 가로채기 — 열기/이동 키만 차단하고 Tab/Escape 등 포커스 이동은 통과시킨다.
  const guardKey = intercept
    ? (e: React.KeyboardEvent) => {
        if (e.key === "Tab" || e.key === "Escape") return;
        if (intercept()) e.preventDefault();
      }
    : undefined;
  return (
    <div className="grid grid-cols-3 gap-2">
      <select
        aria-label={`${idPrefix} 주`}
        className={SELECT_CLS}
        value={week}
        onChange={(e) => onWeek(e.target.value as ProcessWeekRef | "")}
        onMouseDown={guardMouse}
        onKeyDown={guardKey}
        disabled={disabled}
      >
        <option value="">-</option>
        {PROCESS_WEEK_REFS.map((w) => (
          <option key={w} value={w}>
            {PROCESS_WEEK_REF_LABEL[w]}
          </option>
        ))}
      </select>
      <select
        aria-label={`${idPrefix} 요일`}
        className={SELECT_CLS}
        value={dow === "" ? "" : String(dow)}
        onChange={(e) => onDow(e.target.value === "" ? "" : Number(e.target.value))}
        onMouseDown={guardMouse}
        onKeyDown={guardKey}
        disabled={disabled}
      >
        <option value="">-</option>
        {PROCESS_DOW_LABELS.map((d, i) => (
          <option key={i} value={i}>
            {d}
          </option>
        ))}
      </select>
      <select
        aria-label={`${idPrefix} 시간`}
        className={SELECT_CLS}
        value={time}
        onChange={(e) => onTime(e.target.value)}
        onMouseDown={guardMouse}
        onKeyDown={guardKey}
        disabled={disabled}
      >
        <option value="">-</option>
        {PROCESS_TIME_OPTIONS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </div>
  );
}

// 라인급 저장 확인 팝업의 [파트 전용] 배지(칩 목록 공용) — 가시성 있는 배지(작은 회색 보조문구 금지).
function PartExclusiveBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
      파트 전용
    </span>
  );
}

// 파트 전용 체크박스가 포함된 라인급 저장 확인 본문(experience 허브 전용).
//   자체 상태를 가지고, 변경 시 부모 ref 로 값을 전달한다(confirm resolve 후 부모가 값을 읽는다).
function PartExclusiveConfirmBody({
  name,
  onChange,
}: {
  name: string;
  onChange: (v: boolean) => void;
}) {
  const [checked, setChecked] = useState(false);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-foreground">입력한 ‘{name}’을 저장하시겠습니까?</p>
      <p className="text-muted-foreground">
        저장하는 ‘{name}’이 각 파트에서 진행되는 ‘파트 전용’인가요?
      </p>
      <label className="inline-flex cursor-pointer items-center gap-2">
        <Checkbox
          aria-label="파트 전용"
          checked={checked}
          onChange={() => {
            const next = !checked;
            setChecked(next);
            onChange(next);
          }}
        />
        <span className={checkedTextClass(checked)}>파트 전용</span>
      </label>
    </div>
  );
}

export default function ProcessUnifiedManager() {
  const confirm = useConfirm();
  // 안내 문구는 문서 흐름 안의 상단 배너가 아니라 화면 하단 고정 토스트로 띄운다.
  //   기존 호출부(setBanner({ kind, message }))를 그대로 재사용하기 위한 얇은 shim.
  //   setBanner(null) 은 예전에 "작업 전 배너 지우기" 용도였는데, 토스트는 각자
  //   자동 닫힘/수동 닫힘을 가지므로 no-op 으로 흘려보낸다.
  const { toast } = useToast();
  const setBanner = useCallback(
    (b: Banner) => {
      if (b) toast(b.kind, b.message);
    },
    [toast],
  );

  // ── 등록 폼 (허브 = 드롭다운, 디폴트 "-") ──
  const [selectedHub, setSelectedHub] = useState<ProcessHub | typeof HUB_PLACEHOLDER>(HUB_PLACEHOLDER);
  const [lineGroups, setLineGroups] = useState<ProcessLineGroupDto[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [addingGroup, setAddingGroup] = useState(false);
  // 파트 전용 저장 확인 팝업(experience)의 체크박스 값 — confirm resolve 후 읽는다.
  const partExclusiveRef = useRef(false);

  const [actName, setActName] = useState("");
  const [lineGroupId, setLineGroupId] = useState<string>("");
  const [duration, setDuration] = useState<number>(PROCESS_DURATION_OPTIONS[0]);
  // 신청/검수 시점 — 신규 진입 시 자동 선택 없이 미선택("-"). "" = 미선택 sentinel.
  const [occurWeek, setOccurWeek] = useState<ProcessWeekRef | "">("");
  const [occurDow, setOccurDow] = useState<number | "">("");
  const [occurTime, setOccurTime] = useState<string>("");
  const [checkWeek, setCheckWeek] = useState<ProcessWeekRef | "">("");
  const [checkDow, setCheckDow] = useState<number | "">("");
  const [checkTime, setCheckTime] = useState<string>("");
  const [pointCheck, setPointCheck] = useState(0);
  const [pointAdvantage, setPointAdvantage] = useState(0);
  const [pointPenalty, setPointPenalty] = useState(0);
  const [cafe, setCafe] = useState<ProcessCafe>("occur");
  const [checkTarget, setCheckTarget] = useState<ProcessCheckTarget>("check");
  const [actType, setActType] = useState<ProcessActType | "">("");
  const [overview, setOverview] = useState("");
  const [remarks, setRemarks] = useState("");
  const [saving, setSaving] = useState(false);

  // ── 통합 표 (전체 허브) ──
  const [acts, setActs] = useState<ProcessActDto[]>([]);
  const [summary, setSummary] = useState<ProcessActSummary>(EMPTY_SUMMARY);
  const [infoLoading, setInfoLoading] = useState(false);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [hubFilter, setHubFilter] = useState<HubFilterKey>("all");
  const [page, setPage] = useState(1);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // 왼쪽 식별 열(허브 급) 단독 고정 — 공통 sticky 계약(col(2)만 사용).
  const sticky = useStickyColumns();
  // 컬럼 헤더 클릭 정렬. null = 기본 순서(신청 시점 기준).
  //   클릭 순환: 없음 → 오름차순 → 내림차순 → 기본 복귀.
  const [columnSort, setColumnSort] = useState<{ key: ProcColKey; dir: "asc" | "desc" } | null>(null);
  const cycleProcSort = useCallback((key: ProcColKey) => {
    setColumnSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "asc" };
      if (prev.dir === "asc") return { key, dir: "desc" };
      return null; // 내림차순 다음 → 기본 순서 복귀
    });
  }, []);

  const infoReqRef = useRef(0);

  // 전체 허브 액트/요약 로드.
  const loadInfo = useCallback(async () => {
    const myReq = ++infoReqRef.current;
    setInfoLoading(true);
    try {
      const res = await fetch("/api/admin/processes/info?hub=all");
      const json = await res.json().catch(() => ({}));
      if (myReq !== infoReqRef.current) return;
      if (!res.ok || !json.success) throw apiErrorFrom(res, json, "조회에 실패했습니다");
      setActs((json.data?.acts ?? []) as ProcessActDto[]);
      setSummary((json.data?.summary ?? EMPTY_SUMMARY) as ProcessActSummary);
    } catch (err) {
      if (myReq !== infoReqRef.current) return;
      setActs([]);
      setSummary(EMPTY_SUMMARY);
      console.error("[processes] info load failed", err);
      setBanner({ kind: "error", message: getApiErrorMessage(err, "조회에 실패했습니다") });
    } finally {
      if (myReq === infoReqRef.current) setInfoLoading(false);
    }
  }, [setBanner]);

  // 선택 허브의 라인급 로드 ("-" 이면 비움).
  const loadGroups = useCallback(async (hub: ProcessHub | typeof HUB_PLACEHOLDER) => {
    if (!hub) {
      setLineGroups([]);
      return;
    }
    setGroupsLoading(true);
    try {
      const res = await fetch(`/api/admin/processes/line-groups?hub=${hub}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw apiErrorFrom(res, json, "라인급 조회에 실패했습니다");
      }
      setLineGroups((json.data ?? []) as ProcessLineGroupDto[]);
    } catch (err) {
      setLineGroups([]);
      console.error("[processes] line-groups load failed", err);
      setBanner({
        kind: "error",
        message: getApiErrorMessage(err, "라인급 조회에 실패했습니다"),
      });
    } finally {
      setGroupsLoading(false);
    }
  }, [setBanner]);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  useEffect(() => {
    setPage(1);
  }, [filter, hubFilter, columnSort]);

  // 액트 폼만 초기화 — 허브 선택은 유지(연속 등록).
  const resetActForm = useCallback(() => {
    setActName("");
    setLineGroupId("");
    setDuration(PROCESS_DURATION_OPTIONS[0]);
    setOccurWeek("");
    setOccurDow("");
    setOccurTime("");
    setCheckWeek("");
    setCheckDow("");
    setCheckTime("");
    setPointCheck(0);
    setPointAdvantage(0);
    setPointPenalty(0);
    setCafe("occur");
    setCheckTarget("check");
    setActType("");
    setOverview("");
    setRemarks("");
  }, []);

  const handleHubChange = useCallback(
    (hub: ProcessHub | typeof HUB_PLACEHOLDER) => {
      setBanner(null);
      setSelectedHub(hub);
      setLineGroupId("");
      setNewGroupName("");
      void loadGroups(hub);
    },
    [loadGroups, setBanner],
  );

  // ── 신청/검수 시점: 미선택("-") · 순서 강제 · 12시간 규칙 즉시 검증 ──────────
  // 시점은 (주·요일·시각) 3종이 모두 채워져야 "선택 완료"다.
  const occurComplete = occurWeek !== "" && occurDow !== "" && occurTime !== "";
  const checkComplete = checkWeek !== "" && checkDow !== "" && checkTime !== "";

  // 동일 오류 팝업 중복 스택 방지 — 하나가 열려 있으면 새로 띄우지 않는다.
  const popupOpenRef = useRef(false);
  const notify = useCallback((title: string, description: string) => {
    if (popupOpenRef.current) return;
    popupOpenRef.current = true;
    void adminDialog
      .alert({ variant: "warning", title, description })
      .finally(() => {
        popupOpenRef.current = false;
      });
  }, []);

  // 신청 시점 변경: 값 반영 후, 기존 검수 시점이 새 신청 기준 12시간 미만이 되면 즉시 초기화 + 팝업.
  const changeOccur = useCallback(
    (nextWeek: ProcessWeekRef | "", nextDow: number | "", nextTime: string) => {
      setBanner(null);
      setOccurWeek(nextWeek);
      setOccurDow(nextDow);
      setOccurTime(nextTime);
      const occurNow = nextWeek !== "" && nextDow !== "" && nextTime !== "";
      const checkNow = checkWeek !== "" && checkDow !== "" && checkTime !== "";
      if (
        occurNow &&
        checkNow &&
        isReviewGapTooShort(
          nextWeek as ProcessWeekRef, nextDow as number, nextTime,
          checkWeek as ProcessWeekRef, checkDow as number, checkTime,
        )
      ) {
        setCheckWeek("");
        setCheckDow("");
        setCheckTime("");
        notify("검수 시점 확인", PROCESS_REVIEW_GAP_IMMEDIATE_MESSAGE);
      }
    },
    [checkWeek, checkDow, checkTime, notify, setBanner],
  );

  // 검수 시점 변경: 신청 미완성이면 팝업만(값 불변). 완성 후 12시간 미만이면 반영 거부 + 팝업 + 필드오류.
  const changeCheck = useCallback(
    (nextWeek: ProcessWeekRef | "", nextDow: number | "", nextTime: string) => {
      setBanner(null);
      if (!(occurWeek !== "" && occurDow !== "" && occurTime !== "")) {
        notify("신청 시점 확인", PROCESS_OCCUR_FIRST_MESSAGE);
        return;
      }
      const nextComplete = nextWeek !== "" && nextDow !== "" && nextTime !== "";
      if (!nextComplete) {
        // 부분 선택 — 간격 판정 불가, 값만 반영.
        setCheckWeek(nextWeek);
        setCheckDow(nextDow);
        setCheckTime(nextTime);
        return;
      }
      if (
        isReviewGapTooShort(
          occurWeek as ProcessWeekRef, occurDow as number, occurTime,
          nextWeek as ProcessWeekRef, nextDow as number, nextTime,
        )
      ) {
        // 잘못된 검수 시점 — 저장하지 않고 기존값 유지 + 즉시 팝업(인라인 오류는 미표시).
        notify("검수 시점 확인", PROCESS_REVIEW_GAP_IMMEDIATE_MESSAGE);
        return;
      }
      setCheckWeek(nextWeek);
      setCheckDow(nextDow);
      setCheckTime(nextTime);
    },
    [occurWeek, occurDow, occurTime, notify, setBanner],
  );

  const handleResetActForm = useCallback(async () => {
    if (!(await confirm(CONFIRM.reset))) return;
    resetActForm();
  }, [confirm, resetActForm]);

  const handleAddGroup = useCallback(async () => {
    if (!selectedHub) {
      setBanner({ kind: "error", message: "허브 급을 먼저 선택해주세요" });
      return;
    }
    const name = newGroupName.trim();
    if (!name) {
      setBanner({ kind: "error", message: "라인급명을 입력해주세요" });
      return;
    }
    // 소속 라인급명 최대 30자 — 입력 maxLength 로도 막지만 최종 방어(백엔드도 동일).
    if (name.length > PROCESS_NAME_MAX) {
      setBanner({ kind: "error", message: `라인급명은 최대 ${PROCESS_NAME_MAX}자까지 입력할 수 있습니다` });
      return;
    }
    if (lineGroups.length >= PROCESS_LINE_GROUP_MAX) {
      setBanner({
        kind: "error",
        message: `라인급은 최대 ${PROCESS_LINE_GROUP_MAX}개까지 등록할 수 있습니다`,
      });
      return;
    }
    // 실무 경험 허브만 '파트 전용' 옵션 팝업(체크박스) — 그 외 허브는 기존 단순 저장 확인.
    let scopeType: ProcessLineGroupScope = "TEAM";
    if (selectedHub === "experience") {
      partExclusiveRef.current = false;
      const ok = await confirm({
        title: "저장",
        description: (
          <PartExclusiveConfirmBody
            name={name}
            onChange={(v) => {
              partExclusiveRef.current = v;
            }}
          />
        ),
        confirmLabel: "저장",
        cancelLabel: "취소",
      });
      if (!ok) return;
      scopeType = partExclusiveRef.current ? "PART" : "TEAM";
    } else {
      if (!(await confirm(CONFIRM.save))) return;
    }
    setAddingGroup(true);
    setBanner(null);
    try {
      const res = await fetch("/api/admin/processes/line-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hub: selectedHub, name, scope_type: scopeType }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw apiErrorFrom(res, json, "라인급 등록에 실패했습니다");
      setNewGroupName("");
      await loadGroups(selectedHub);
      await loadInfo();
      setBanner({ kind: "success", message: `라인급 "${name}" 이(가) 등록되었습니다` });
    } catch (err) {
      console.error("[processes] line-group create failed", err);
      setBanner({
        kind: "error",
        message: getApiErrorMessage(err, "라인급 등록에 실패했습니다"),
      });
    } finally {
      setAddingGroup(false);
    }
  }, [selectedHub, newGroupName, lineGroups.length, loadGroups, loadInfo, confirm, setBanner]);

  const handleDeleteGroup = useCallback(
    async (group: ProcessLineGroupDto) => {
      if (group.actCount > 0) {
        void adminDialog.alert({
          variant: "warning",
          title: "라인급 삭제 불가",
          description:
            "산하 등록된 액트가 존재합니다.\n\n산하 등록된 액트가 없어야, 이 라인 급을 삭제할 수 있습니다.\n\n액트 삭제는 아래 통합 목록 표에서 진행해주세요.",
        });
        return;
      }
      if (!(await confirm({ ...CONFIRM.delete, description: `라인급 "${group.name}" 을(를) 삭제할까요?` }))) return;
      setBanner(null);
      try {
        const res = await fetch(`/api/admin/processes/line-groups/${group.id}`, { method: "DELETE" });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) {
          if (res.status === 409) {
            void adminDialog.alert({ variant: "danger", title: "삭제 불가", description: json.error || "산하 액트가 존재하여 삭제할 수 없습니다" });
            if (selectedHub) await loadGroups(selectedHub);
            return;
          }
          throw apiErrorFrom(res, json, "라인급 삭제에 실패했습니다");
        }
        if (lineGroupId === group.id) setLineGroupId("");
        if (selectedHub) await loadGroups(selectedHub);
        await loadInfo();
        setBanner({ kind: "success", message: `라인급 "${group.name}" 이(가) 삭제되었습니다` });
      } catch (err) {
        console.error("[processes] line-group delete failed", err);
        setBanner({
          kind: "error",
          message: getApiErrorMessage(err, "라인급 삭제에 실패했습니다"),
        });
      }
    },
    [selectedHub, lineGroupId, loadGroups, loadInfo, confirm, setBanner],
  );

  const handleSubmitAct = useCallback(async () => {
    if (!selectedHub) {
      setBanner({ kind: "error", message: "허브 급을 먼저 선택해야 합니다" });
      return;
    }
    if (!actName.trim()) {
      setBanner({ kind: "error", message: "액트명을 입력해주세요" });
      return;
    }
    // 액트명 최대 30자 — 입력 maxLength 로도 막지만, 붙여넣기·우회 대비 최종 방어(백엔드도 동일).
    if (actName.trim().length > PROCESS_NAME_MAX) {
      setBanner({ kind: "error", message: `액트명은 최대 ${PROCESS_NAME_MAX}자까지 입력할 수 있습니다` });
      return;
    }
    if (!lineGroupId) {
      setBanner({ kind: "error", message: "소속 라인급을 선택해주세요" });
      return;
    }
    if (!actType) {
      setBanner({ kind: "error", message: "액트 종류를 먼저 선택해야 합니다" });
      return;
    }
    // 개요 필수 — 공백만 입력도 불가(trim 기준). (백엔드도 동일 검증)
    if (!overview.trim()) {
      setBanner({ kind: "error", message: "개요를 입력해주세요." });
      return;
    }
    // 신청/검수 시점 필수 — 3종(주·요일·시각)이 모두 선택되어야 한다.
    if (!occurComplete) {
      notify("신청 시점 확인", "신청 시점(주·요일·시각)을 모두 선택해주세요.");
      return;
    }
    if (!checkComplete) {
      notify("검수 시점 확인", "검수 시점(주·요일·시각)을 모두 선택해주세요.");
      return;
    }
    // 최소 12시간 규칙 — 검수 시점은 신청 시점 + 12시간 이후여야 등록 가능(백엔드도 동일 검증).
    //   위반 시 저장 요청을 보내지 않고 공통 경고 모달로 차단한다(브라우저 alert 미사용).
    if (
      isReviewGapTooShort(
        occurWeek as ProcessWeekRef, occurDow as number, occurTime,
        checkWeek as ProcessWeekRef, checkDow as number, checkTime,
      )
    ) {
      await confirm({
        title: "검수 시점 확인",
        description: PROCESS_REVIEW_GAP_MESSAGE,
        confirmLabel: "확인",
        cancelLabel: "닫기",
      });
      return;
    }
    if (!(await confirm(CONFIRM.save))) return;
    setSaving(true);
    setBanner(null);
    try {
      const res = await fetch("/api/admin/processes/acts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          line_group_id: lineGroupId,
          hub: selectedHub,
          act_name: actName.trim(),
          duration_minutes: duration,
          occur_week: occurWeek as ProcessWeekRef,
          occur_dow: occurDow as number,
          occur_time: occurTime,
          check_week: checkWeek as ProcessWeekRef,
          check_dow: checkDow as number,
          check_time: checkTime,
          point_check: pointCheck,
          point_advantage: pointAdvantage,
          point_penalty: enforcePointC(actType, pointPenalty),
          cafe,
          check_target: checkTarget,
          act_type: actType,
          overview: overview.trim(),
          remarks: remarks.trim() || null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw apiErrorFrom(res, json, "액트 등록에 실패했습니다");
      const saved = json.data as ProcessActDto;
      resetActForm();
      await loadGroups(selectedHub);
      await loadInfo();
      setBanner({
        kind: "success",
        message: `액트가 등록되었습니다 (${saved.hubLabel} · ${saved.lineGroupName ?? "-"} · ${saved.actName})`,
      });
    } catch (err) {
      console.error("[processes] act create failed", err);
      setBanner({
        kind: "error",
        message: getApiErrorMessage(err, "액트 등록에 실패했습니다"),
      });
    } finally {
      setSaving(false);
    }
  }, [
    selectedHub, actName, lineGroupId, duration, occurWeek, occurDow, occurTime,
    checkWeek, checkDow, checkTime, occurComplete, checkComplete, notify,
    pointCheck, pointAdvantage, pointPenalty,
    cafe, checkTarget, actType, overview, remarks, resetActForm, loadGroups, loadInfo, confirm, setBanner,
  ]);

  const handleDelete = useCallback(
    async (act: ProcessActDto) => {
      if (!(await confirm({ ...CONFIRM.delete, description: `액트 "${act.actName}" 을(를) 삭제할까요?\n삭제하면 되돌릴 수 없습니다.` }))) return;
      setDeletingId(act.id);
      setBanner(null);
      try {
        const res = await fetch(`/api/admin/processes/acts/${act.id}`, { method: "DELETE" });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) throw apiErrorFrom(res, json, "삭제에 실패했습니다");
        await loadInfo();
        // 삭제된 액트가 현재 선택 허브 소속이면 라인급 산하 액트수도 갱신.
        if (selectedHub && act.hub === selectedHub) await loadGroups(selectedHub);
        setBanner({ kind: "success", message: `액트가 삭제되었습니다 (${act.actName})` });
      } catch (err) {
        console.error("[processes] act delete failed", err);
        setBanner({ kind: "error", message: getApiErrorMessage(err, "삭제에 실패했습니다") });
      } finally {
        setDeletingId(null);
      }
    },
    [selectedHub, loadGroups, loadInfo, confirm, setBanner],
  );

  const visibleActs = useMemo(() => {
    const filtered = acts.filter(
      (a) => (hubFilter === "all" || a.hub === hubFilter) && matchFilter(a, filter),
    );
    // 안정적 표시를 위해 동값일 때 id 로 최종 tiebreak(정렬 의미는 불변, 순서 흔들림만 제거).
    const sorted = [...filtered];
    // 컬럼 헤더 정렬이 활성이면 그 기준으로, 아니면 신청 시점(occur) 기본 순서.
    const col = columnSort ? PROC_COLUMNS.find((c) => c.key === columnSort.key) : null;
    if (col && col.sortable && columnSort) {
      sorted.sort(
        (a, b) =>
          compareProcValues(col.sortValue(a), col.sortValue(b), columnSort.dir) ||
          a.id.localeCompare(b.id),
      );
    } else {
      sorted.sort(
        (a, b) =>
          weekRank(a.occurWeek) - weekRank(b.occurWeek) ||
          a.occurDow - b.occurDow ||
          a.occurTime.localeCompare(b.occurTime) ||
          a.id.localeCompare(b.id),
      );
    }
    return sorted;
  }, [acts, filter, hubFilter, columnSort]);

  const pageCount = Math.max(1, Math.ceil(visibleActs.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = useMemo(
    () => visibleActs.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [visibleActs, safePage],
  );

  const canSubmit = Boolean(selectedHub);

  return (
    // 본문은 사이드바 제외 main 전체 폭을 사용(중앙 고정 캡 제거) → 넓은 모니터에서 좌우 여백 없이
    // 통합 표가 화면 폭을 최대한 쓴다. 폭이 부족할 때만 표 내부에서 가로 스크롤(fallback).
    <div className="flex w-full min-w-0 flex-col gap-4">
      <div className="flex justify-end">
        <AdminHelp />
      </div>
      {/* 안내 문구는 화면 하단 고정 토스트(<ToastViewport /> · Layout 마운트)로 표시.
          문서 흐름 안 상단 배너 제거 → 페이지 아래쪽에서 작업해도 스크롤 없이 즉시 보인다. */}

      {/* ── 등록 폼 ── 표는 full width. 폼 카드는 자체 폭 상한 + mx-auto 로 페이지 가로 가운데 정렬
          (제목/라벨/입력의 내부 정렬은 기존 좌측 유지 — 카드 블록만 중앙에 놓는다). */}
      <Card className="mx-auto w-full max-w-[1040px]">
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-1.5">
            프로세스 등록
            <AdminHelpIconButton
              helpKey="admin.processes.register.section.registerForm"
              title="프로세스 등록"
              size="sm"
            />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* [1] 허브 급 — 드롭다운(디폴트 "-"). "-" 상태에서는 등록 불가. */}
          <FormRow label="허브 급" helpKey="admin.processes.register.hub" required>
            <select
              aria-label="허브 급"
              className={cn(SELECT_CLS, "max-w-[240px]")}
              value={selectedHub}
              onChange={(e) =>
                handleHubChange(e.target.value as ProcessHub | typeof HUB_PLACEHOLDER)
              }
            >
              <option value={HUB_PLACEHOLDER}>-</option>
              {PROCESS_HUBS.map((h) => (
                <option key={h} value={h}>
                  {PROCESS_HUB_LABEL[h]} 급
                </option>
              ))}
            </select>
          </FormRow>

          {/* [2] 액트명 — 최대 30자(maxLength 로 입력 차단, 등록/서버에서도 재검증). */}
          <FormRow label="액트명" helpKey="admin.processes.register.actName" required alignTop>
            <div className="space-y-1">
              <Input
                value={actName}
                onChange={(e) => setActName(e.target.value)}
                maxLength={PROCESS_NAME_MAX}
                placeholder="예) [브리핑] 클럽 시작"
                disabled={!canSubmit}
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>최대 {PROCESS_NAME_MAX}자까지 입력할 수 있습니다.</span>
                <span className="tabular-nums">현재 글자 수 {actName.length} / {PROCESS_NAME_MAX}</span>
              </div>
            </div>
          </FormRow>

          {/* [3] 소속 라인급 — 등록 + 칩 목록 */}
          <FormRow label="소속 라인급" helpKey="admin.processes.register.lineGroup" required alignTop>
            {!canSubmit ? (
              <p className="pt-2 text-xs text-muted-foreground">
                허브 급을 먼저 선택하면 라인급을 등록/선택할 수 있습니다.
              </p>
            ) : (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <Input
                    value={newGroupName}
                    onChange={(e) => setNewGroupName(e.target.value)}
                    maxLength={PROCESS_NAME_MAX}
                    placeholder={`라인급명 (최대 ${PROCESS_LINE_GROUP_MAX}개)`}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleAddGroup();
                      }
                    }}
                    disabled={addingGroup || lineGroups.length >= PROCESS_LINE_GROUP_MAX}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0"
                    onClick={() => void handleAddGroup()}
                    loading={addingGroup}
                    disabled={addingGroup || lineGroups.length >= PROCESS_LINE_GROUP_MAX}
                  >
                    등록
                  </Button>
                  <AdminHelpIconButton
                    helpKey="admin.processes.register.addLineGroup"
                    title="라인급 등록"
                    size="sm"
                    className="shrink-0 self-center"
                  />
                </div>
                {/* 라인급명(소속 라인급) 최대 30자 안내 — 액트명과 동일 컴포넌트/스타일. */}
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>최대 {PROCESS_NAME_MAX}자까지 입력할 수 있습니다.</span>
                  <span className="tabular-nums">현재 글자 수 {newGroupName.length} / {PROCESS_NAME_MAX}</span>
                </div>

                {groupsLoading ? (
                  <LoadingState active variant="inline" />
                ) : lineGroups.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    등록된 라인급이 없습니다. 위에서 먼저 라인급을 등록해주세요.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {lineGroups.map((g) => {
                      const selected = lineGroupId === g.id;
                      return (
                        <div
                          key={g.id}
                          className={cn(
                            "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors",
                            selected
                              ? "border-primary bg-primary/10 font-semibold text-primary"
                              : "border-border bg-background font-medium text-muted-foreground",
                          )}
                        >
                          <Checkbox
                            aria-label={`${g.name} 선택`}
                            checked={selected}
                            onChange={() => setLineGroupId(selected ? "" : g.id)}
                          />
                          <span className={checkedTextClass(selected)}>{g.name}</span>
                          {g.scopeType === "PART" && <PartExclusiveBadge />}
                          <span className="text-xs text-muted-foreground">(액트 {g.actCount})</span>
                          <button
                            type="button"
                            aria-label={`${g.name} 삭제`}
                            className="text-muted-foreground hover:text-red-500"
                            onClick={() => void handleDeleteGroup(g)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </FormRow>

          {/* [4] 소요 시간 */}
          <FormRow label="소요 시간" helpKey="admin.processes.register.duration" required>
            <select
              aria-label="소요 시간"
              className={cn(SELECT_CLS, "max-w-[160px]")}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              disabled={!canSubmit}
            >
              {PROCESS_DURATION_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m}m
                </option>
              ))}
            </select>
          </FormRow>

          {/* [5][6] 신청/검수 시점 — 넓은 화면에서 두 그룹을 나란히 배치(가로 공간 활용).
              폭이 좁으면(xl 미만) 그룹 단위로 세로 스택. 안내 문구는 두 필드 하단에 배치. */}
          <div className="space-y-2">
            <div className="grid grid-cols-1 gap-x-10 gap-y-4 xl:grid-cols-2">
              {/* [5] 신청 시점(필요) — 기본 미선택("-"). */}
              <FormRow label="신청 시점(필요)" helpKey="admin.processes.register.occurWhen" required>
                <WhenInput
                  week={occurWeek}
                  dow={occurDow}
                  time={occurTime}
                  onWeek={(v) => changeOccur(v, occurDow, occurTime)}
                  onDow={(v) => changeOccur(occurWeek, v, occurTime)}
                  onTime={(v) => changeOccur(occurWeek, occurDow, v)}
                  idPrefix="신청"
                  disabled={!canSubmit}
                />
              </FormRow>

              {/* [6] 검수 시점(필요) — 신청 시점 미선택 시 조작 차단(팝업). 12시간 미만 선택 즉시 팝업+오류. */}
              <FormRow label="검수 시점(필요)" helpKey="admin.processes.register.checkWhen" required alignTop>
                <div className="space-y-1">
                  <WhenInput
                    week={checkWeek}
                    dow={checkDow}
                    time={checkTime}
                    onWeek={(v) => changeCheck(v, checkDow, checkTime)}
                    onDow={(v) => changeCheck(checkWeek, v, checkTime)}
                    onTime={(v) => changeCheck(checkWeek, checkDow, v)}
                    idPrefix="검수"
                    disabled={!canSubmit}
                    intercept={() => {
                      if (!occurComplete) {
                        notify("신청 시점 확인", PROCESS_OCCUR_FIRST_MESSAGE);
                        return true;
                      }
                      return false;
                    }}
                  />
                  {canSubmit && !occurComplete && (
                    <p className="text-xs text-muted-foreground">
                      {PROCESS_OCCUR_FIRST_MESSAGE}
                    </p>
                  )}
                </div>
              </FormRow>
            </div>
            <p className="text-xs text-amber-600">
              ※ 신청자가 충분한 시간을 확보할 수 있도록, 검수 시점은 신청 시점보다 최소
              12시간 이후로 설정해야 합니다.
            </p>
          </div>

          {/* [7] 액트 종류 | 카페 | 체크 대상 */}
          <div className="grid grid-cols-1 gap-x-8 gap-y-4 lg:grid-cols-3">
            <FormRow label="액트 종류" helpKey="admin.processes.register.actType" required>
              <select
                aria-label="액트 종류"
                className={SELECT_CLS}
                value={actType}
                disabled={!canSubmit}
                onChange={(e) => {
                  const v = e.target.value as ProcessActType | "";
                  setActType(v);
                  if (!v || !reactionAllowsPointC(v)) setPointPenalty(0);
                }}
              >
                <option value="" disabled>
                  선택
                </option>
                {PROCESS_ACT_TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {PROCESS_ACT_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </FormRow>
            <FormRow label="카페" helpKey="admin.processes.register.cafe" required>
              <select
                aria-label="카페"
                className={SELECT_CLS}
                value={cafe}
                disabled={!canSubmit}
                onChange={(e) => setCafe(e.target.value as ProcessCafe)}
              >
                {PROCESS_CAFE_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {PROCESS_CAFE_LABEL[c]}
                  </option>
                ))}
              </select>
            </FormRow>
            <FormRow label="체크 대상" helpKey="admin.processes.register.checkTarget" required>
              <select
                aria-label="체크 대상"
                className={SELECT_CLS}
                value={checkTarget}
                disabled={!canSubmit}
                onChange={(e) => setCheckTarget(e.target.value as ProcessCheckTarget)}
              >
                {PROCESS_CHECK_TARGET_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {PROCESS_CHECK_TARGET_LABEL[c]}
                  </option>
                ))}
              </select>
            </FormRow>
          </div>

          {/* [8] 포인트 — A/B/C (0~20). 미선택 잠금 · '선별'이면 C 고정. */}
          <FormRow label="포인트" helpKey="admin.processes.register.point" required alignTop>
            <div className="space-y-1.5">
              <div className="grid grid-cols-3 gap-x-8 gap-y-2">
                {(
                  [
                    { label: "A · point.check", value: pointCheck, set: setPointCheck },
                    { label: "B · point.advantage", value: pointAdvantage, set: setPointAdvantage },
                    {
                      label: "C · point.penalty",
                      value: pointPenalty,
                      set: setPointPenalty,
                      hardDisabled: actType !== "" && !reactionAllowsPointC(actType),
                    },
                  ] as const
                ).map((p) => {
                  const locked = !canSubmit || actType === "";
                  const hardDisabled = "hardDisabled" in p && p.hardDisabled;
                  return (
                    <div key={p.label} className="space-y-1">
                      <span className="text-xs text-muted-foreground">{p.label}</span>
                      <select
                        aria-label={p.label}
                        className={cn(SELECT_CLS, locked && "cursor-not-allowed opacity-60")}
                        value={p.value}
                        disabled={hardDisabled}
                        title={
                          locked
                            ? "허브 급·액트 종류를 먼저 선택해야 합니다"
                            : hardDisabled
                              ? "‘필수’ 액트만 포인트 C(미이행 페널티)를 부여할 수 있습니다"
                              : undefined
                        }
                        onMouseDown={(e) => {
                          if (locked) {
                            e.preventDefault();
                            setBanner({
                              kind: "error",
                              message: !canSubmit
                                ? "허브 급을 먼저 선택해야 합니다"
                                : "액트 종류를 먼저 선택해야 합니다",
                            });
                          }
                        }}
                        onKeyDown={(e) => {
                          if (locked) {
                            e.preventDefault();
                            setBanner({
                              kind: "error",
                              message: !canSubmit
                                ? "허브 급을 먼저 선택해야 합니다"
                                : "액트 종류를 먼저 선택해야 합니다",
                            });
                          }
                        }}
                        onChange={(e) => {
                          if (locked) return;
                          p.set(Number(e.target.value));
                        }}
                      >
                        {PROCESS_POINT_OPTIONS.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
              {canSubmit && actType === "" && (
                <p className="text-xs text-amber-600">액트 종류를 먼저 선택해야 합니다</p>
              )}
            </div>
          </FormRow>

          {/* [9] 개요 — 필수 입력. 공백만 입력은 빈값 처리(trim). */}
          <FormRow label="개요" helpKey="admin.processes.register.overview" required alignTop>
            <textarea
              aria-label="개요"
              className={cn(
                "min-h-[96px] w-full rounded-md border bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60",
                canSubmit && overview.trim().length === 0
                  ? "border-red-400 focus-visible:ring-red-400"
                  : "border-input",
              )}
              value={overview}
              onChange={(e) => setOverview(e.target.value)}
              placeholder="액트 개요 (150자 이상 권장, 제한은 엄격하지 않음)"
              disabled={!canSubmit}
              aria-invalid={canSubmit && overview.trim().length === 0}
            />
          </FormRow>

          {/* [10] 비고 */}
          <FormRow label="비고" helpKey="admin.processes.register.remarks" alignTop>
            <textarea
              aria-label="비고"
              className="min-h-[96px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="비고"
              disabled={!canSubmit}
            />
          </FormRow>

          {/* 버튼 그룹 — 도움말 돋보기는 각 버튼 외부에 배치(클릭이 등록/초기화를 실행하지 않음). */}
          <div className="flex items-center justify-end gap-4 border-t pt-4">
            <div className="inline-flex items-center gap-1.5">
              <Button
                type="button"
                onClick={() => void handleSubmitAct()}
                loading={saving}
                disabled={saving || !canSubmit}
              >
                등록
              </Button>
              <AdminHelpIconButton helpKey="admin.processes.register.submit" title="등록" size="sm" />
            </div>
            <div className="inline-flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleResetActForm()}
                disabled={saving || !canSubmit}
              >
                초기화
              </Button>
              <AdminHelpIconButton helpKey="admin.processes.register.reset" title="초기화" size="sm" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── 전역 요약 (전체 허브) ── 6개 통계를 독립 셀로 나열해 박스 전체 폭을 균등 분산.
          넓은 화면=3열×2행(긴 "…포인트 총합" 라벨 + A/B/C 가 찌그러지지 않게 6열 대신 3열 상한),
          중간=2열, 좁은 화면=1열. 값·A/B/C 우측 정렬 유지. 계산/포맷/합산 로직 무변경. */}
      <div className="grid grid-cols-1 gap-x-8 gap-y-2 rounded-lg border bg-muted/30 px-4 py-3 lg:grid-cols-2 xl:grid-cols-3">
        <SummaryCell label="전체 액트 수" value={`${summary.actCount}개`} helpKey="admin.processes.register.stat.actCount" />
        <SummaryCell label="전체 라인급 수" value={`${summary.lineGroupCount}개`} helpKey="admin.processes.register.stat.lineGroupCount" />
        <SummaryCell label="총합 소요 시간" value={`${summary.totalDurationMinutes}m`} helpKey="admin.processes.register.stat.totalDuration" />
        <SummaryCell label="필수 포인트 총합" value={<PointTripletCells t={summary.required} />} helpKey="admin.processes.register.stat.requiredPoint" growValue />
        <SummaryCell label="우수 포인트 총합" value={<PointTripletCells t={summary.excellent} />} helpKey="admin.processes.register.stat.excellentPoint" growValue />
        <SummaryCell label="최대 포인트 총합" value={<PointTripletCells t={summary.max} />} helpKey="admin.processes.register.stat.maxPoint" growValue />
      </div>

      {/* ── 통합 목록 표 (전체 허브) ── */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {/* 필터 2그룹을 flex-1 grid로 분산 → 좌측 쏠림 제거·가로 공간 균등 활용.
              각 그룹은 라벨(+돋보기)과 select 가 한 덩어리로 유지되고, select 는 flex-1 로 넓게. */}
          <div className="grid w-full grid-cols-1 gap-x-8 gap-y-3 sm:flex-1 sm:grid-cols-2">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <span className="inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
                허브 급
                <AdminHelpIconButton helpKey="admin.processes.register.filter.hub" title="허브 급 필터" size="xs" />
              </span>
              <select
                aria-label="허브 급 필터"
                className={cn(FILTER_SELECT_CLS, "min-w-[150px] flex-1")}
                value={hubFilter}
                onChange={(e) => setHubFilter(e.target.value as HubFilterKey)}
              >
                <option value="all">전체</option>
                {PROCESS_HUBS.map((h) => (
                  <option key={h} value={h}>
                    {PROCESS_HUB_LABEL[h]} 급
                  </option>
                ))}
              </select>
            </div>
            <div className="flex min-w-0 items-center justify-between gap-3">
              <span className="inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
                필터
                <AdminHelpIconButton helpKey="admin.processes.register.filter.actType" title="필터" size="xs" />
              </span>
              <select
                aria-label="필터"
                className={cn(FILTER_SELECT_CLS, "min-w-[150px] flex-1")}
                value={filter}
                onChange={(e) => setFilter(e.target.value as FilterKey)}
              >
                {FILTER_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-muted-foreground">
            결과 수 {visibleActs.length}개
            <AdminHelpIconButton helpKey="admin.processes.register.filter.resultCount" title="결과 수" size="xs" />
          </span>
        </CardHeader>
        <CardContent className="space-y-3">
          {infoLoading ? (
            <LoadingState active />
          ) : pageRows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {acts.length === 0
                ? "등록된 액트가 없습니다. 위 등록 폼에서 먼저 등록해주세요."
                : "필터 조건에 맞는 액트가 없습니다."}
            </p>
          ) : (
            <>
              <Table containerRef={sticky.ref} stickyLeft>
                <TableHeader>
                  <TableRow>
                    {PROC_COLUMNS.map((col, idx) => (
                      <ProcSortableHeader
                        key={col.key}
                        col={col}
                        dir={columnSort?.key === col.key ? columnSort.dir : null}
                        onSort={() => cycleProcSort(col.key)}
                        sticky={idx === 0 ? sticky.col(2) : undefined}
                      />
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageRows.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell
                        {...sticky.col(2)}
                        className={cn("whitespace-nowrap", sticky.col(2).className)}
                      >
                        {a.hubLabel} 급
                      </TableCell>
                      {/* 액트명 = 남는 폭 우선 배분 대상. 넉넉한 상한으로 넓은 화면 슬랙을 흡수(초장문 독식만 방지). */}
                      <TableCell className="min-w-[320px] max-w-[760px] whitespace-normal break-words text-left font-medium">
                        {a.actName}
                      </TableCell>
                      <TableCell className="min-w-[150px] max-w-[260px] whitespace-normal break-words text-left">
                        {a.lineGroupName ?? "-"}
                      </TableCell>
                      <TableCell className="tabular-nums">{a.durationMinutes}</TableCell>
                      {/* 이행 시점(필요) — 신청(occur)/검수(check) 2행. */}
                      <TableCell className="whitespace-nowrap text-left">
                        <ExecutionTimeCell
                          apply={formatProcessWhen(a.occurWeek, a.occurDow, a.occurTime)}
                          review={formatProcessWhen(a.checkWeek, a.checkDow, a.checkTime)}
                        />
                      </TableCell>
                      <TableCell className={cn("tabular-nums", pointColorClass("a"))}>{a.pointCheck}</TableCell>
                      <TableCell className={cn("tabular-nums", pointColorClass("b"))}>{a.pointAdvantage}</TableCell>
                      <TableCell className={cn("tabular-nums", pointColorClass("c"))}>{a.pointPenalty}</TableCell>
                      <TableCell className="text-center">
                        <SelectBadge label={PROCESS_ACT_TYPE_LABEL[a.actType]} size="sm" />
                      </TableCell>
                      <TableCell>{PROCESS_CHECK_TARGET_LABEL[a.checkTarget]}</TableCell>
                      <TableCell>{PROCESS_CAFE_LABEL[a.cafe]}</TableCell>
                      <TableCell>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                          loading={deletingId === a.id}
                          disabled={deletingId === a.id}
                          onClick={() => void handleDelete(a)}
                        >
                          삭제
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {/* 페이지네이션 — 15개 기준 */}
              {pageCount > 1 && (
                <div className="flex items-center justify-center gap-1 pt-2" aria-label="페이지네이션">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={safePage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    aria-label="이전 페이지"
                  >
                    ‹
                  </Button>
                  {pageItems(safePage, pageCount).map((it, i) =>
                    it === "..." ? (
                      <span key={`e${i}`} className="px-2 text-sm text-muted-foreground">
                        …
                      </span>
                    ) : (
                      <Button
                        key={it}
                        type="button"
                        variant={it === safePage ? "default" : "outline"}
                        size="sm"
                        className="min-w-9"
                        aria-label={`${it} 페이지`}
                        aria-current={it === safePage ? "page" : undefined}
                        onClick={() => setPage(it)}
                      >
                        {it}
                      </Button>
                    ),
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={safePage >= pageCount}
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                    aria-label="다음 페이지"
                  >
                    ›
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
