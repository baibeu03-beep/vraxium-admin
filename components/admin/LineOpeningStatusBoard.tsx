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
  // 두 허브(경험/역량) 개설 탭 모두 드롭다운 선택 주차를 URL(?week)에 단일 SoT 로 보존한다 —
  //   경험=파트장 그리드, 역량=개설 대시보드가 쓰고, 각 로그창이 읽는 값. 상태창도 같은 ?week 를
  //   읽어 선택 주차 기준으로 판정·표기('선택한 주차')한다. 선택 주차가 바뀌면 상태창도 그 주차로
  //   재조회된다(서버가 week_id 로 targetWeek·teams·opened 를 판정). ?week 미지정이면 서버가 오늘 기준
  //   개설 대상 주차로 폴백 → 기존 동작(회귀 0).
  const selectedWeekId = searchParams?.get("week")?.trim() || null;

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
        // 주차 변경 즉시 이전 주차 데이터 폐기 — 로딩 중 이전 주차 상태 잔류 방지.
        setData(null);
      }
      try {
        const params = new URLSearchParams();
        if (org) params.set("organization", org);
        // 선택 주차(경험 탭)만 week_id 부착 → 서버가 그 주차 기준으로 targetWeek·teams·extension 판정.
        //   미부착(역량/미선택)이면 서버는 오늘 기준 개설 대상 주차로 폴백(기존 동작).
        if (selectedWeekId) params.set("week_id", selectedWeekId);
        const suffix = params.toString();
        const res = await fetch(
          appendModeQuery(`${endpoint}${suffix ? `?${suffix}` : ""}`, mode),
        );
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
  }, [endpoint, org, mode, selectedWeekId, refreshKey]);

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
      // 선택 주차 모드 — targetWeek 가 사용자가 고른 선택 주차일 때 문구를 '선택한 주차'로 표기.
      selectionMode: selectedWeekId != null,
    });
  }, [data, hubLabel, selectedWeekId]);

  const hubLine: StatusLine | null = useMemo(() => {
    if (!data || variant !== "hub") return null;
    return buildHubOpenStatusLine({
      hubLabel,
      currentWeek: data.currentWeek,
      targetWeek: data.targetWeek,
      opened: data.opened ?? false,
      // 선택 주차 모드 — 대시보드가 고른 주차(?week)일 때 '선택한 주차' 문구.
      selectionMode: selectedWeekId != null,
    });
  }, [data, hubLabel, variant, selectedWeekId]);

  return (
    <Card>
      {/* ③ 운영 현황 설명 문구 + 도움말 아이콘 제거 — team/hub 공통으로 헤더는 '상태창' 제목만 유지. */}
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
