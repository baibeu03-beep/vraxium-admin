"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { readOrgParam } from "@/lib/adminOrgContext";
import {
  buildLineOpeningStatus,
  type LineOpeningStatus,
  type StatusExtension,
  type StatusLine,
  type StatusTeam,
  type StatusToken,
  type StatusWeek,
} from "@/lib/lineOpeningStatusEngine";

// 라인 개설 상태창(운영 대시보드) 공용 컴포넌트.
//   - 서버 상태 API 를 조회해 공용 엔진(lib/lineOpeningStatusEngine)으로 3블록 문구를 만든 뒤,
//     red 토큰만 빨강 강조로 렌더한다. 표시 전용 — write/snapshot/DTO 무관.
//   - 허브명만 바꿔 실무 경험/정보/역량이 재사용한다(현재는 experience 만 엔드포인트 보유).

// 현재 엔드포인트가 있는 허브. info/competency 는 후속(동일 엔진/컴포넌트 재사용).
type LineOpeningHub = "experience";

const HUB_CONFIG: Record<
  LineOpeningHub,
  { label: string; endpoint: string }
> = {
  experience: {
    label: "실무 경험",
    endpoint: "/api/admin/cluster4/experience/opening-status",
  },
};

type StatusResponse = {
  currentWeek: StatusWeek | null;
  targetWeek: StatusWeek | null;
  extension: StatusExtension;
  teams: StatusTeam[];
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
  const { label: hubLabel, endpoint } = HUB_CONFIG[hub];
  const searchParams = useSearchParams();
  const org = readOrgParam(searchParams);

  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
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
        const res = await fetch(`${endpoint}${qs}`);
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
  }, [endpoint, org, refreshKey]);

  const status: LineOpeningStatus | null = useMemo(() => {
    if (!data) return null;
    return buildLineOpeningStatus({
      hubLabel,
      today: new Date(),
      currentWeek: data.currentWeek,
      targetWeek: data.targetWeek,
      extension: data.extension,
      teams: data.teams,
    });
  }, [data, hubLabel]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">상태창</CardTitle>
        <CardDescription>
          이번 주 {hubLabel} 라인 개설 운영 현황 (표시 전용)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {loading ? (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> 불러오는 중…
          </p>
        ) : error ? (
          <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-red-800">
            {error}
          </p>
        ) : !status ? (
          <p className="text-muted-foreground">표시할 데이터가 없습니다.</p>
        ) : (
          <>
            {/* 블록1 — 오늘 / 이번 주 */}
            <p className="text-foreground">{renderTokens(status.block1.tokens)}</p>

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
              <p className="text-xs font-semibold text-muted-foreground">
                팀별 개설 현황
              </p>
              {status.block3.length === 0 ? (
                <p className="text-muted-foreground">
                  {org
                    ? "이 조직에 등록된 팀이 없습니다."
                    : "조직(?org)이 지정되지 않았습니다."}
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
      </CardContent>
    </Card>
  );
}
