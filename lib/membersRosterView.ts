// /admin/members 표 A — 필터(상태 버킷)·검색(표시값 부분검색)·정렬 공용 로직(순수, 서버·클라 공유).
//   서버 페이지네이션과 클라 표시가 동일 결과를 내도록 단일 SoT. React 무관.
//   대상 row = MemberRosterRow (lib/adminMembersData). 품계는 user_grade_stats 캐시값(rankGradeNumber/Label).
import type { MemberRosterRow } from "@/lib/adminMembersData";
import { classLabel } from "@/lib/adminMembersTypes";
import { BUCKET_LABEL, statusBucket, type MemberStatusBucket } from "@/lib/memberStatusBucket";
import { organizationLabelKo } from "@/lib/organizations";

export type ClubValue = "all" | "encre" | "oranke" | "phalanx" | "none";
// 클럽 표시명 = lib/organizations 단일 SoT. 미지정(null)은 이 명부 규칙대로 "-".
export function clubLabelKo(slug: string | null): string {
  return organizationLabelKo(slug, { nullLabel: "-" });
}

function fmtStr(v: string | null | undefined): string { return v && v.trim() ? v : "—"; }
function fmtNum(v: number | null | undefined): string { return v == null ? "—" : v.toLocaleString(); }
function fmtPct(v: number | null | undefined): string { return v == null ? "—" : `${v}%`; }
function birthMs(v: string | null): number | null { if (!v) return null; const t = new Date(v).getTime(); return Number.isNaN(t) ? null : t; }

export type ColType = "string" | "number" | "date" | "rank";
export type ColKey =
  | "name" | "club" | "status" | "class" | "gender" | "birth" | "school" | "major"
  | "team" | "part" | "rank" | "success" | "growable" | "poA" | "poB" | "poC" | "schedule" | "activity";

export type RosterColumn = {
  key: ColKey;
  label: string;
  type: ColType;
  align?: "right";
  clamp?: string;
  text: (m: MemberRosterRow) => string;
  num?: (m: MemberRosterRow) => number | null;
  date?: (m: MemberRosterRow) => number | null;
};

export const ROSTER_COLUMNS: RosterColumn[] = [
  { key: "name", label: "이름", type: "string", text: (m) => fmtStr(m.displayName) },
  { key: "club", label: "클럽명", type: "string", text: (m) => clubLabelKo(m.organizationSlug) },
  { key: "status", label: "상태", type: "string", text: (m) => BUCKET_LABEL[statusBucket(m.displayGrowthStatus)] },
  { key: "class", label: "클래스", type: "string", text: (m) => classLabel(m.role, m.membershipLevel) },
  { key: "gender", label: "성별", type: "string", text: (m) => fmtStr(m.gender) },
  { key: "birth", label: "생년월일", type: "date", text: (m) => fmtStr(m.birthDate), date: (m) => birthMs(m.birthDate) },
  { key: "school", label: "학교", type: "string", clamp: "max-w-[160px]", text: (m) => fmtStr(m.schoolName) },
  { key: "major", label: "전공", type: "string", clamp: "max-w-[160px]", text: (m) => fmtStr(m.departmentName) },
  { key: "team", label: "팀", type: "string", clamp: "max-w-[120px]", text: (m) => fmtStr(m.teamName) },
  { key: "part", label: "파트", type: "string", clamp: "max-w-[120px]", text: (m) => fmtStr(m.partName) },
  { key: "rank", label: "품계", type: "rank", text: (m) => fmtStr(m.rankGradeLabel), num: (m) => m.rankGradeNumber },
  { key: "success", label: "성장 성공", type: "number", align: "right", text: (m) => fmtNum(m.successWeeks), num: (m) => m.successWeeks },
  { key: "growable", label: "성장 가능", type: "number", align: "right", text: (m) => fmtNum(m.growableWeeks), num: (m) => m.growableWeeks },
  { key: "poA", label: "Po.A", type: "number", align: "right", text: (m) => fmtNum(m.poA), num: (m) => m.poA },
  { key: "poB", label: "Po.B", type: "number", align: "right", text: (m) => fmtNum(m.poB), num: (m) => m.poB },
  { key: "poC", label: "Po.C", type: "number", align: "right", text: (m) => fmtNum(m.poC), num: (m) => m.poC },
  { key: "schedule", label: "일정 신뢰도", type: "number", align: "right", text: (m) => fmtPct(m.scheduleReliability), num: (m) => m.scheduleReliability },
  { key: "activity", label: "활동 완료율", type: "number", align: "right", text: (m) => fmtPct(m.activityCompletion), num: (m) => m.activityCompletion },
];

export const ROSTER_COLUMN_MAP: Record<ColKey, RosterColumn> = Object.fromEntries(
  ROSTER_COLUMNS.map((c) => [c.key, c]),
) as Record<ColKey, RosterColumn>;

export function defaultDir(type: ColType): "asc" | "desc" {
  return type === "number" ? "desc" : "asc";
}

export type SortEntry = { key: ColKey; dir: "asc" | "desc" };

export function compareCol(a: MemberRosterRow, b: MemberRosterRow, col: RosterColumn, dir: "asc" | "desc"): number {
  if (col.type === "number" || col.type === "rank") {
    const av = col.num!(a), bv = col.num!(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return dir === "asc" ? av - bv : bv - av;
  }
  if (col.type === "date") {
    const av = col.date!(a), bv = col.date!(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return dir === "asc" ? av - bv : bv - av;
  }
  const av = col.text(a), bv = col.text(b);
  const ae = av === "—" || av === "", be = bv === "—" || bv === "";
  if (ae && be) return 0;
  if (ae) return 1;
  if (be) return -1;
  const c = av.localeCompare(bv, "ko");
  return dir === "asc" ? c : -c;
}

export function rowSearchText(m: MemberRosterRow): string {
  return ROSTER_COLUMNS.map((c) => c.text(m)).join(" ").toLowerCase();
}

export type FilterValue =
  | "clubbing_expand" | "clubbing_reduce" | "elite" | "seasonal_rest"
  | "weekly_rest" | "suspended" | "onboarding" | "basanos" | "none";

export const FILTER_OPTIONS: { value: FilterValue; label: string }[] = [
  { value: "clubbing_expand", label: "클러빙_확대" },
  { value: "clubbing_reduce", label: "클러빙_축소" },
  { value: "elite", label: "엘리트" },
  { value: "seasonal_rest", label: "시즌 휴식" },
  { value: "weekly_rest", label: "주차 휴식" },
  { value: "suspended", label: "활동 중단" },
  { value: "onboarding", label: "온보딩" },
  { value: "basanos", label: "바사노스" },
  { value: "none", label: "-" },
];

export const FILTER_BUCKETS: Record<FilterValue, MemberStatusBucket[] | null> = {
  clubbing_expand: ["active", "weekly_rest", "seasonal_rest", "onboarding", "basanos"],
  clubbing_reduce: ["active", "weekly_rest", "onboarding"],
  elite: ["elite"],
  seasonal_rest: ["seasonal_rest"],
  weekly_rest: ["weekly_rest"],
  suspended: ["suspended"],
  onboarding: ["onboarding"],
  basanos: ["basanos"],
  none: null,
};

export function isFilterValue(v: unknown): v is FilterValue {
  return typeof v === "string" && v in FILTER_BUCKETS;
}

// 필터(버킷) + 검색(부분검색) + 다중정렬 적용. (페이지네이션 전 단계 — 전체 필터셋 산출)
export function applyRosterView(
  rows: MemberRosterRow[],
  opts: { filter?: FilterValue; search?: string; sort?: SortEntry[] },
): MemberRosterRow[] {
  const buckets = opts.filter ? FILTER_BUCKETS[opts.filter] : null;
  const q = (opts.search ?? "").trim().toLowerCase();
  let out = rows.filter((m) => {
    if (buckets && !buckets.includes(statusBucket(m.displayGrowthStatus))) return false;
    if (q && !rowSearchText(m).includes(q)) return false;
    return true;
  });
  const sort = opts.sort ?? [];
  if (sort.length > 0) {
    out = [...out].sort((a, b) => {
      for (const s of sort) {
        const col = ROSTER_COLUMN_MAP[s.key];
        if (!col) continue;
        const c = compareCol(a, b, col, s.dir);
        if (c !== 0) return c;
      }
      return a.userId.localeCompare(b.userId);
    });
  } else {
    out = [...out].sort(
      (a, b) => (a.displayName ?? "").localeCompare(b.displayName ?? "", "ko") || a.userId.localeCompare(b.userId),
    );
  }
  return out;
}
