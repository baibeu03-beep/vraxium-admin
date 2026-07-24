"use client";

import { type ReactNode } from "react";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { useStickyColumns } from "@/components/ui/sticky-columns";

// ── 팀 카드 공용 조각 — 클럽 상세(다중 팀 카드)와 팀 상세(단일 팀) 양쪽이 재사용한다 ──────────
//   정보 밀도 분리(사용자 정의):
//     클럽 상세 = 팀별 핵심 요약(팀장 프로필 · 파트 목록 · 현재 크루 수). 파트×주차 표는 미표시.
//     팀 상세   = 위 전부 + 파트×주차 존재표(TeamPartWeekMatrix).
//   진입 위치별 복제 없음 — 같은 컴포넌트를 두 화면이 공유한다.

// DB 표시명("비주얼랩(T)") → breadcrumb 라벨("비주얼랩 팀"). (T) 테스트 마커 제거 + " 팀" 접미.
export function toTeamBreadcrumbLabel(teamName: string): string {
  return `${teamName.replace(/\(T\)\s*$/, "").trim()} 팀`;
}

export function dash(v: string | number | null | undefined): string {
  return v === null || v === undefined || v === "" ? "-" : String(v);
}
export function formatBirth6(b: string | null): string {
  if (!b || b.length < 6) return "-";
  return `${b.slice(0, 2)}. ${b.slice(2, 4)}. ${b.slice(4, 6)}`;
}

// 팀장 프로필(1행) — 팀장 개인 프로필만. ⚠ 파트 수·파트 배지·크루 수는 여기서 제외(별도 행).
export type TeamLeaderProfileLike = {
  teamHalfId: string;
  teamName: string;
  leaderName: string | null;
  leaderBirth6: string | null;
  leaderGender: string | null;
  leaderSchool: string | null;
  leaderMajor: string | null;
  leaderResidence: string | null;
  leaderClassLabel: string | null;
  leaderGradeLabel: string | null;
};

export function TeamLeaderProfileRow({ team }: { team: TeamLeaderProfileLike }) {
  const schoolMajor = team.leaderSchool
    ? team.leaderMajor
      ? `${team.leaderSchool}, ${team.leaderMajor}`
      : team.leaderSchool
    : null;
  const birth =
    team.leaderBirth6 && team.leaderBirth6.length >= 6
      ? formatBirth6(team.leaderBirth6)
      : null;

  const items: { key: string; node: ReactNode }[] = [
    {
      key: "name",
      node: (
        <span
          data-team-leader-name={team.teamName}
          className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-0.5 font-medium"
        >
          {dash(team.leaderName)}
        </span>
      ),
    },
  ];
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

  return (
    <div
      data-team-leader-profile={team.teamHalfId}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
    >
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

// 파트 목록(2행) — 팀장 프로필 아래 별도 행. 기존 data-team-parts 선택자(값=teamName) 유지.
export function TeamPartsRow({
  teamHalfId,
  teamName,
  partCount,
  partNames,
}: {
  teamHalfId: string;
  teamName: string;
  partCount: number;
  partNames: string[];
}) {
  const empty = partNames.length === 0;
  return (
    <div
      data-team-parts-row={teamHalfId}
      className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm"
    >
      <span className="inline-flex items-center gap-1 font-medium text-muted-foreground">
        파트
        {!empty ? (
          <strong data-team-partcount={teamName} className="text-foreground">
            {partCount}개
          </strong>
        ) : null}
      </span>
      {empty ? (
        <span className="text-muted-foreground">등록된 파트 없음</span>
      ) : (
        <div className="flex flex-wrap gap-2" data-team-parts={teamName}>
          {partNames.map((p) => (
            <span
              key={p}
              className="rounded-md border border-input bg-background px-2.5 py-1 text-sm font-medium"
            >
              {p}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// 현재 시점 크루 수(3행) — 클러빙/정규/심화. ⚠ selectedHalf 무관(현재 접속 시점 기준).
export type TeamCrewLike = {
  clubbingCount: number;
  regularCrewCount: number;
  advancedCrewCount: number;
};

const CREW_CELLS: { key: keyof TeamCrewLike; label: string; helpKey: string }[] = [
  { key: "clubbingCount", label: "클러빙", helpKey: "admin.teamPartsInfoClubs.column.clubbing" },
  { key: "regularCrewCount", label: "정규 크루", helpKey: "admin.teamPartsInfoClubs.column.regular" },
  { key: "advancedCrewCount", label: "심화 크루", helpKey: "admin.teamPartsInfoClubs.column.advanced" },
];

export function TeamCurrentCrewStrip({
  teamHalfId,
  crew,
  clubbingLabel,
}: {
  teamHalfId: string;
  crew?: TeamCrewLike;
  // 클러빙 셀의 표시 문구(기본 "클러빙"). 집계 값·기준은 동일 — 화면 문구만 바꾼다(예: 팀 상세="전체 크루").
  clubbingLabel?: string;
}) {
  return (
    <div
      data-team-current-crew-summary={teamHalfId}
      className="grid grid-cols-1 gap-3 rounded-md border bg-muted/20 px-4 py-3 sm:grid-cols-3"
    >
      {CREW_CELLS.map((c) => (
        <div
          key={c.key}
          data-team-current-crew-cell={c.key}
          className="flex items-center gap-2 whitespace-nowrap"
        >
          <span className="text-sm text-muted-foreground">
            · {c.key === "clubbingCount" ? clubbingLabel ?? c.label : c.label}
          </span>
          <strong className="text-base font-bold tabular-nums text-foreground">
            {crew ? crew[c.key] : "–"}
          </strong>
          <AdminHelpIconButton helpKey={c.helpKey} title={c.label} />
        </div>
      ))}
    </div>
  );
}

// 파트×주차 존재표 — 팀 상세 전용(클럽 상세에서는 미표시). 기존 표 렌더/선택자를 그대로 재사용.
export type PartWeekColumnLike = {
  weekStartDate: string;
  label: string;
  isRest: boolean;
  weekNumber?: number | null; // 0주차(전환) UI 제외 판정용(서버 DTO 가 전달).
};
export type PartWeekMatrixLike = {
  partNames: string[];
  present: boolean[][];
};

export function TeamPartWeekMatrix({
  teamName,
  matrix,
  weekColumns,
  currentWeekStartDate,
}: {
  teamName: string;
  matrix: PartWeekMatrixLike | null;
  weekColumns: PartWeekColumnLike[];
  // 현재 주차 시작일 — 이 주차에 운용(●) 중인 파트 "행 전체"를 강조한다. 표 반기에 현재 주차가
  //   없으면 null(강조 없음). 과거 주차 체크만 있는 행은 강조하지 않는다(현재 주차 셀 기준).
  currentWeekStartDate?: string | null;
}) {
  // 파트명 단독 고정(식별 1열) + 상단 주차 헤더 고정 — 공통 sticky 계약.
  const sticky = useStickyColumns({ headerSticky: true });
  if (!matrix || weekColumns.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-muted-foreground">
        이 반기의 파트×주차 존재표 데이터가 없습니다.
      </div>
    );
  }
  // 현재 주차 컬럼 인덱스(표 반기에 포함될 때만 ≥0). 그 컬럼에 ● 인 파트 행만 현재 운용으로 강조.
  const currentWeekIdx = currentWeekStartDate
    ? weekColumns.findIndex((c) => c.weekStartDate === currentWeekStartDate)
    : -1;
  return (
    <div
      ref={sticky.ref}
      className={
        "overflow-x-auto rounded-md border border-zinc-200" +
        (sticky.regionClassName ? " " + sticky.regionClassName : "")
      }
      data-part-week-table={teamName}
    >
      <table className="min-w-max border-collapse text-sm">
        <thead>
          <tr>
            <th
              data-sticky-col={sticky.col(2)["data-sticky-col"]}
              className={
                sticky.col(2).className +
                " min-w-[120px] border-b px-4 py-2.5 text-left text-sm font-semibold whitespace-nowrap"
              }
            >
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
                  "min-w-[84px] border-b border-r px-3 py-2.5 text-center text-sm font-semibold whitespace-nowrap " +
                  (c.isRest ? "bg-zinc-100 text-zinc-400" : "bg-zinc-50")
                }
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.partNames.map((p, pi) => {
            // 현재 주차 운용 = 현재 주차 컬럼에 ● 인 파트. 표현은 "파트명 셀만" 강조한다
            //   (행 전체·빈 칸 색칠 금지). 각 데이터 셀의 배경은 그 셀 자체의 운용 여부(on)로만 결정.
            const currentWeekOperated =
              currentWeekIdx >= 0 && Boolean(matrix.present[pi]?.[currentWeekIdx]);
            return (
              <tr
                key={p}
                data-pw-row={p}
                data-pw-current-operated={currentWeekOperated ? "1" : "0"}
                // 운용 파트 강조(emerald)를 고정 셀에도 유지(--stick-cell-bg).
                data-sticky-row-accent={currentWeekOperated ? "emerald" : undefined}
              >
                <td
                  data-sticky-col={sticky.col(2)["data-sticky-col"]}
                  className={
                    sticky.col(2).className +
                    " min-w-[120px] border-b px-4 py-2.5 text-sm whitespace-nowrap " +
                    (currentWeekOperated
                      ? "font-bold text-emerald-800"
                      : "font-medium")
                  }
                >
                  {p}
                </td>
                {weekColumns.map((c, wi) => {
                  // 셀 배경은 그 칸 자체의 운용 여부(on)만 반영 — 빈 칸(data-pw-cell="0")은 배경 없음.
                  const on = Boolean(matrix.present[pi]?.[wi]);
                  return (
                    <td
                      key={c.weekStartDate}
                      data-pw-cell={on ? "1" : "0"}
                      className={
                        "min-w-[84px] border-b border-r px-3 py-2.5 text-center text-sm " +
                        (on ? "bg-emerald-50/60 " : c.isRest ? "bg-zinc-50/60 " : "")
                      }
                    >
                      {on ? <span className="text-base text-emerald-600">●</span> : ""}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
