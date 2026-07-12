"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { cn } from "@/lib/utils";
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

function toneClass(tone: StatusLine["tone"]): string {
  switch (tone) {
    case "positive":
      return "border-green-300 bg-green-50 text-green-800";
    case "warning":
      return "border-amber-300 bg-amber-50 text-amber-800";
    default:
      return "border-border bg-muted/30 text-foreground";
  }
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

  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  useReportLoading(loading);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // setState 는 effect 본문이 아닌 async 콜백 안에서만 호출 — 동기 cascading 렌더 방지
    // (PracticalInfoCurrentSituation 과 동일 패턴).
    (async () => {
      if (!cancelled) {
        setLoading(true);
        setError(null);
      }
      try {
        const qs = org ? `?organization=${encodeURIComponent(org)}` : "";
        const res = await fetch(appendModeQuery(`${endpoint}${qs}`, mode));
        const json = await res.json();
        if (cancelled) return;
        if (json?.success) setData(json.data as StatusResponse);
        else setError(json?.error ?? "상태창 데이터를 불러오지 못했습니다");
      } catch {
        if (!cancelled) setError("상태창 데이터를 불러오지 못했습니다");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint, org, mode, refreshKey]);

  // team variant: 3블록 전부. hub variant: 블록1(엔진 재사용) + 허브 전체 1문장.
  const status: LineOpeningStatus | null = useMemo(() => {
    if (!data) return null;
    return buildLineOpeningStatus({
      hubLabel,
      today: new Date(),
      currentWeek: data.currentWeek,
      targetWeek: data.targetWeek,
      extension: data.extension ?? { kind: "none", index: null, total: null },
      teams: data.teams ?? [],
    });
  }, [data, hubLabel]);

  const hubLine: StatusLine | null = useMemo(() => {
    if (!data || variant !== "hub") return null;
    return buildHubOpenStatusLine({
      hubLabel,
      currentWeek: data.currentWeek,
      targetWeek: data.targetWeek,
      opened: data.opened ?? false,
    });
  }, [data, hubLabel, variant]);

  return (
    <Card>
      {/* hub variant(실무 역량)는 설명 문구 제거 + 헤더 컴팩트. team variant(실무 경험)는 기존 유지(회귀 방지). */}
      <CardHeader className={variant === "hub" ? "pb-2" : "pb-3"}>
        <CardTitle className="inline-flex items-center gap-1.5 text-base">
          상태창
          <AdminHelpIconButton
            size="sm"
            helpKey="admin.lineOpening.statusBoard.section.board"
            title="라인 개설 상태창"
          />
        </CardTitle>
        {variant !== "hub" && (
          <CardDescription>
            이번 주 {hubLabel} 라인 개설 운영 현황 (표시 전용)
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {loading ? (
          <LoadingState active />
        ) : error ? (
          <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-800">
            {error}
          </p>
        ) : !status ? (
          <p className="text-muted-foreground">표시할 데이터가 없습니다.</p>
        ) : (
          <>
            {/* 블록1 — 오늘 / 이번 주 (공통) */}
            <p className="text-foreground">{renderTokens(status.block1.tokens)}</p>

            {variant === "hub" ? (
              /* hub variant(실무 역량) — 허브 전체 개설 상태 1문장 */
              hubLine && (
                <p
                  className={cn(
                    "rounded-md border px-3 py-2",
                    toneClass(hubLine.tone),
                  )}
                >
                  {renderTokens(hubLine.tokens)}
                </p>
              )
            ) : (
              <>
                {/* 블록2 — 확장 라인(대상 주차) */}
                <p
                  className={cn(
                    "rounded-md border px-3 py-2",
                    toneClass(status.block2.tone),
                  )}
                >
                  {renderTokens(status.block2.tokens)}
                </p>

                {/* 블록3 — 팀별 개설 현황 */}
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
                    status.block3.map((line) => (
                      <p
                        key={line.id}
                        className={cn(
                          "rounded-md border px-3 py-2",
                          toneClass(line.tone),
                        )}
                      >
                        {renderTokens(line.tokens)}
                      </p>
                    ))
                  )}
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
