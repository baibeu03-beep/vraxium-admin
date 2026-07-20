"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import {
  StatusList,
  StatusListItem,
} from "@/components/admin/lineOpeningStatusUi";
import { readOrgParam } from "@/lib/adminOrgContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import {
  buildHubOpenStatusLine,
  buildLineOpeningStatus,
  type LineOpeningStatus,
  type StatusExtension,
  type StatusLine,
  type StatusTeam,
  type StatusToken,
  type StatusWeek,
} from "@/lib/lineOpeningStatusEngine";

// 라인 개설 상태창(운영 대시보드) 공용 컴포넌트.
//   - 서버 상태 API 를 조회해 공용 엔진(lib/lineOpeningStatusEngine)으로 블록 문구를 만든 뒤,
//     red 토큰만 빨강 강조로 렌더한다. 표시 전용 — write/snapshot/DTO 무관.
//   - 허브명만 바꿔 실무 경험/정보/역량이 재사용한다.
//
// variant:
//   "team" = 실무 경험. 블록1(오늘/이번 주) + 블록2(확장 라인) + 블록3(팀별 개설 현황).
//   "hub"  = 실무 역량. 블록1 + 허브 전체 1문장(팀별 분기 없음). 확장/팀 블록 미사용.
type LineOpeningHub = "experience" | "competency";

const HUB_CONFIG: Record<
  LineOpeningHub,
  { label: string; endpoint: string; variant: "team" | "hub" }
> = {
  experience: {
    label: "실무 경험",
    endpoint: "/api/admin/cluster4/experience/opening-status",
    variant: "team",
  },
  competency: {
    label: "실무 역량",
    endpoint: "/api/admin/cluster4/competency/opening-status",
    variant: "hub",
  },
};

type StatusResponse = {
  currentWeek: StatusWeek | null;
  targetWeek: StatusWeek | null;
  // team variant 전용.
  extension?: StatusExtension;
  teams?: StatusTeam[];
  // hub variant 전용.
  opened?: boolean;
};

function renderTokens(tokens: StatusToken[]) {
  return tokens.map((tok, i) =>
    tok.red ? (
      <span key={i} className="font-semibold text-red-600">
        {tok.text}
      </span>
    ) : (
      <span key={i}>{tok.text}</span>
    ),
  );
}

// 한 주차 기준(현재 운영 / 선택한 주차)의 개설 상태 본문 — 문장 구조·톤·강조를 두 영역이 100% 공유한다.
//   team: 확장 라인(block2) + 팀별 개설 현황(block3). hub: 허브 전체 1문장(hubLine).
//   keyPrefix 로 두 영역의 block3 React key 충돌(같은 team_id)을 회피한다.
function TargetOpenStatusBody({
  variant,
  status,
  hubLine,
  org,
  keyPrefix,
}: {
  variant: "team" | "hub";
  status: LineOpeningStatus;
  hubLine: StatusLine | null;
  org: string | null;
  keyPrefix: string;
}) {
  if (variant === "hub") {
    return (
      <StatusList>
        {hubLine && (
          <StatusListItem tone={hubLine.tone}>
            {renderTokens(hubLine.tokens)}
          </StatusListItem>
        )}
      </StatusList>
    );
  }
  return (
    <div className="space-y-3">
      <StatusList>
        {status.block2 && (
          <StatusListItem tone={status.block2.tone}>
            {renderTokens(status.block2.tokens)}
          </StatusListItem>
        )}
      </StatusList>
      <div className="space-y-2">
        <p className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground">
          팀별 개설 현황
          <AdminHelpIconButton
            size="xs"
            helpKey="admin.lineOpening.statusBoard.section.teamOpenStatus"
            title="팀별 개설 현황"
          />
        </p>
        {status.block3.length === 0 ? (
          <p className="text-muted-foreground">
            {org
              ? "이 클럽에 등록된 팀이 없습니다."
              : "클럽(?org)이 지정되지 않았습니다."}
          </p>
        ) : (
          <StatusList>
            {status.block3.map((line) => (
              <StatusListItem key={`${keyPrefix}-${line.id}`} tone={line.tone}>
                {renderTokens(line.tokens)}
              </StatusListItem>
            ))}
          </StatusList>
        )}
      </div>
    </div>
  );
}

export default function LineOpeningStatusBoard({
  hub,
  refreshKey,
}: {
  hub: LineOpeningHub;
  // 값이 바뀌면 상태창 재조회(개설 완료/취소로 팀별 개설 현황이 바뀐 직후).
  refreshKey?: number;
}) {
  const { label: hubLabel, endpoint, variant } = HUB_CONFIG[hub];
  const searchParams = useSearchParams();
  const org = readOrgParam(searchParams);
  // 팀별 개설 현황(블록3) 팀 목록 스코프 — operating/test 토글 보존(appendModeQuery).
  const mode = readScopeMode(searchParams);
  // 드롭다운에서 고른 주차(?week) — '선택한 주차 상태' 영역 전용. 값이 없으면 선택 영역은 표시하지 않는다.
  //   ⚠ (2026-07-20 정책 변경) 상태창은 두 영역을 함께 보여준다:
  //     ① 현재 운영 상태 = 항상 서버 현재 시각 + 현재 개설 대상 주차(금요일 경계 SoT, week_id 미전송).
  //     ② 선택한 주차 상태 = ?week(드롭다운) 기준(week_id 전송). 두 영역은 데이터 기준만 다르고
  //        문장 구조·강조·톤·레이아웃은 동일하다. 선택 주차가 현재 개설 대상 주차와 같으면 ②를 숨긴다
  //        (중복 방지). 종전 '완전 분리'(①만 표시)에서 additive 재도입.
  const selectedWeekId = searchParams?.get("week")?.trim() || null;

  // ① 현재 운영 상태(week_id 미전송) / ② 선택한 주차 상태(week_id=selectedWeekId).
  const [operating, setOperating] = useState<StatusResponse | null>(null);
  const [selected, setSelected] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // setState 는 effect 본문이 아닌 async 콜백 안에서만 호출 — 동기 cascading 렌더 방지.
    (async () => {
      if (!cancelled) {
        setLoading(true);
        setError(null);
        // 재조회 시작 시 이전 데이터 폐기 — 로딩 중 이전 주차 상태 잔류 방지.
        setOperating(null);
        setSelected(null);
      }
      // 공용 fetch — weekId 있으면 그 주차 기준(선택), 없으면 현재 개설 대상 주차(운영).
      const load = async (weekId: string | null): Promise<StatusResponse | null> => {
        const params = new URLSearchParams();
        if (org) params.set("organization", org);
        if (weekId) params.set("week_id", weekId);
        const suffix = params.toString();
        const res = await fetch(
          appendModeQuery(`${endpoint}${suffix ? `?${suffix}` : ""}`, mode),
        );
        const json = await res.json();
        if (!json?.success) {
          throw new Error(json?.error ?? "상태창 데이터를 불러오지 못했습니다");
        }
        return json.data as StatusResponse;
      };
      try {
        // 운영 영역은 필수. 선택 주차가 있으면 병렬 조회(선택 영역 실패는 운영 영역을 막지 않음).
        const [op, sel] = await Promise.all([
          load(null),
          selectedWeekId
            ? load(selectedWeekId).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setOperating(op);
        setSelected(sel);
      } catch {
        if (!cancelled) setError("상태창 데이터를 불러오지 못했습니다");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint, org, mode, refreshKey, selectedWeekId]);

  // 현재 운영 상태 — 오늘 기준 개설 대상 주차(N 또는 N-1). block1(오늘/이번 주)은 여기서만 렌더.
  const operatingStatus: LineOpeningStatus | null = useMemo(() => {
    if (!operating) return null;
    return buildLineOpeningStatus({
      hubLabel,
      today: new Date(),
      currentWeek: operating.currentWeek,
      targetWeek: operating.targetWeek,
      extension: operating.extension ?? { kind: "none", index: null, total: null },
      teams: operating.teams ?? [],
    });
  }, [operating, hubLabel]);

  const operatingHubLine: StatusLine | null = useMemo(() => {
    if (!operating || variant !== "hub") return null;
    return buildHubOpenStatusLine({
      hubLabel,
      currentWeek: operating.currentWeek,
      targetWeek: operating.targetWeek,
      opened: operating.opened ?? false,
    });
  }, [operating, hubLabel, variant]);

  // 선택한 주차 상태 — 호칭 "선택한 주차"(kind="selected"). block1 은 사용하지 않는다.
  const selectedStatus: LineOpeningStatus | null = useMemo(() => {
    if (!selected) return null;
    return buildLineOpeningStatus(
      {
        hubLabel,
        today: new Date(),
        currentWeek: selected.currentWeek,
        targetWeek: selected.targetWeek,
        extension: selected.extension ?? { kind: "none", index: null, total: null },
        teams: selected.teams ?? [],
      },
      "selected",
    );
  }, [selected, hubLabel]);

  const selectedHubLine: StatusLine | null = useMemo(() => {
    if (!selected || variant !== "hub") return null;
    return buildHubOpenStatusLine({
      hubLabel,
      currentWeek: selected.currentWeek,
      targetWeek: selected.targetWeek,
      opened: selected.opened ?? false,
      kind: "selected",
    });
  }, [selected, hubLabel, variant]);

  // 선택 영역 표시 여부 — 선택 주차가 현재 개설 대상 주차와 다를 때만(같으면 중복이라 숨김).
  const showSelected =
    !!selectedStatus &&
    !!operating?.targetWeek?.startDate &&
    !!selected?.targetWeek?.startDate &&
    operating.targetWeek.startDate !== selected.targetWeek.startDate;

  return (
    <Card>
      {/* team/hub 공통으로 헤더는 '상태창' 제목만 유지. */}
      <CardHeader className="pb-2">
        <CardTitle className="inline-flex items-center gap-1.5 text-base">
          상태창
          <AdminHelpIconButton
            size="sm"
            helpKey="admin.lineOpening.statusBoard.section.board"
            title="라인 개설 상태창"
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {loading ? (
          <LoadingState active />
        ) : error ? (
          <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-800">
            {error}
          </p>
        ) : !operatingStatus ? (
          <p className="text-muted-foreground">표시할 데이터가 없습니다.</p>
        ) : (
          <>
            {/* 블록1 — 오늘 / 이번 주 (공통, 상단 1회 · 정보성 → neutral bullet) */}
            <StatusList>
              <StatusListItem tone="neutral">
                {renderTokens(operatingStatus.block1.tokens)}
              </StatusListItem>
            </StatusList>

            {/* ① 현재 운영 상태 — 오늘 기준 개설 대상 주차(N-1) */}
            <section className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground">
                현재 운영 상태
              </p>
              <TargetOpenStatusBody
                variant={variant}
                status={operatingStatus}
                hubLine={operatingHubLine}
                org={org}
                keyPrefix="op"
              />
            </section>

            {/* ② 선택한 주차 상태 — 드롭다운 선택 주차(현재 대상과 다를 때만) */}
            {showSelected && selectedStatus && (
              <section className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">
                  선택한 주차 상태
                </p>
                <TargetOpenStatusBody
                  variant={variant}
                  status={selectedStatus}
                  hubLine={selectedHubLine}
                  org={org}
                  keyPrefix="sel"
                />
              </section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
