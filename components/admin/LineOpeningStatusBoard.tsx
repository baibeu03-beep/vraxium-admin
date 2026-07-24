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
  StatusTokens,
} from "@/components/admin/lineOpeningStatusUi";
import { readOrgParam } from "@/lib/adminOrgContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";
import {
  buildHubOpenStatusLine,
  buildLineOpeningStatus,
  type LineOpeningStatus,
  type StatusExtension,
  type StatusLine,
  type StatusTeam,
  type StatusWeek,
} from "@/lib/lineOpeningStatusEngine";

// 라인 개설 상태창(운영 대시보드) 공용 컴포넌트.
//   - 서버 상태 API 를 조회해 공용 엔진(lib/lineOpeningStatusEngine)으로 블록 문구를 만든 뒤,
//     역할별 공통 토큰(StatusTokens)으로 강조를 입혀 렌더한다. 표시 전용 — write/snapshot/DTO 무관.
//   - 허브명만 바꿔 실무 경험/정보/역량이 재사용한다.
//
//   ⚠ 상태창은 "개설 대상 주차"(금요일 경계 SoT)만 표시한다 — 오늘/이번 주 + 개설 대상 주차의 개설 현황.
//     주차 드롭다운(?week)을 바꿔도 상태창은 변하지 않는다(선택 주차 상태는 생성/표시하지 않는다).
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

// 개설 대상 주차의 개설 상태 본문 — team/hub 이 문장 구조·톤·강조를 공유한다.
//   team: 확장 라인(block2) + 팀별 라인 문장(block3)을 하나의 연속 bullet 목록으로(별도 소제목 없음).
//   hub: 허브 전체 1문장(hubLine).
function TargetOpenStatusBody({
  variant,
  status,
  hubLine,
  org,
}: {
  variant: "team" | "hub";
  status: LineOpeningStatus;
  hubLine: StatusLine | null;
  org: string | null;
}) {
  if (variant === "hub") {
    return (
      <StatusList>
        {hubLine && (
          <StatusListItem tone={hubLine.tone}>
            <StatusTokens tokens={hubLine.tokens} />
          </StatusListItem>
        )}
      </StatusList>
    );
  }
  return (
    <div className="space-y-2">
      {/* 확장(block2) + 팀별 라인(block3)을 한 목록으로 이어서 — '팀별 개설 현황' 소제목 제거. */}
      <StatusList>
        {status.block2 && (
          <StatusListItem tone={status.block2.tone}>
            <StatusTokens tokens={status.block2.tokens} />
          </StatusListItem>
        )}
        {status.block3.map((line) => (
          <StatusListItem key={line.id} tone={line.tone}>
            <StatusTokens tokens={line.tokens} />
          </StatusListItem>
        ))}
      </StatusList>
      {status.block3.length === 0 && (
        <p className="text-muted-foreground">
          {org
            ? "이 클럽에 등록된 팀이 없습니다."
            : "클럽(?org)이 지정되지 않았습니다."}
        </p>
      )}
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

  // 상태창은 항상 서버 현재 시각 + 현재 개설 대상 주차(금요일 경계 SoT, week_id 미전송)만 조회한다.
  //   주차 드롭다운(?week)은 하단 개설 폼 전용 — 상태창은 소비하지 않는다(선택 주차 상태 생성 금지).
  const [operating, setOperating] = useState<StatusResponse | null>(null);
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
        setOperating(null);
      }
      try {
        const params = new URLSearchParams();
        if (org) params.set("organization", org);
        const suffix = params.toString();
        const res = await fetch(
          appendModeQuery(`${endpoint}${suffix ? `?${suffix}` : ""}`, mode),
        );
        const json = await res.json();
        if (!json?.success) {
          throw apiErrorFrom(res, json, "상태창 데이터를 불러오지 못했습니다");
        }
        if (cancelled) return;
        setOperating(json.data as StatusResponse);
      } catch (err) {
        if (!cancelled) {
          console.error("[line-opening] status board load failed", err);
          setError(getApiErrorMessage(err, "상태창 데이터를 불러오지 못했습니다"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint, org, mode, refreshKey]);

  // 현재 운영 상태 — 오늘 기준 개설 대상 주차(금요일 경계 N 또는 N-1). block1(오늘/이번 주) 포함.
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
            {/* 블록1 — 오늘 / 이번 주 (정보성 → neutral bullet) */}
            <StatusList>
              <StatusListItem tone="neutral">
                <StatusTokens tokens={operatingStatus.block1.tokens} />
              </StatusListItem>
            </StatusList>

            {/* 개설 대상 주차(화면 문구 "지난 주") 개설 현황 — 제목 없이 문장 자체로 구분. */}
            <section>
              <TargetOpenStatusBody
                variant={variant}
                status={operatingStatus}
                hubLine={operatingHubLine}
                org={org}
              />
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
