"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LoadingState } from "@/components/ui/loading-state";
import { readOrgParam } from "@/lib/adminOrgContext";
import { appendModeQuery, readScopeMode } from "@/lib/userScopeShared";
import PracticalInfoOpeningLogPanel from "@/components/admin/PracticalInfoOpeningLogPanel";
import PracticalInfoOpeningForm, {
  type OpeningFormWeek,
  type ExceptionFormWeek,
} from "@/components/admin/PracticalInfoOpeningForm";
import {
  formatBannerPeriod,
  formatToday,
} from "@/lib/practicalInfoSection0Format";

// 실무 정보 라인 개설 [섹션 0] — 상황 통제 영역.
//   상태창: 오늘/이번 주 + 지난 주(개설 대상 N-1) 라인 개설 필요/완료 안내.
// '지난 주' = 개설 대상 주차(isOpenTarget / describeOpenableWeek, 금요일 경계) 재사용.
// (개설/검수 기록 메모 카드는 2026-06-14 UI 정리로 제거 — opening-note 저장 엔드포인트는 보존.)

type WeekLike = {
  id?: string | null;
  year: number;
  seasonName: string;
  weekNumber: number;
  isOfficialRest?: boolean;
};

type ActivityTypeLike = { id: string; name: string };

type UserLike = {
  userId: string;
  displayName: string;
  organization?: string | null;
};

type Props = {
  // 이번 주(N) — currentWeek DTO.
  currentWeek: WeekLike | null;
  // 개설 대상 주차(금요일 경계 규칙) — weekOptions.find(isOpenTarget).
  openableWeek: OpeningFormWeek | null;
  // 최근 주차 옵션 전체 — 개설 폼의 어드민 잠금 해제(dev)용.
  weekOptions: OpeningFormWeek[];
  // 활성 라인 개설 예외 주차(line_opening_windows) — 자동 정책 외 "예외 허용 주차".
  exceptionWeeks: ExceptionFormWeek[];
  // 현재 선택된 활동 유형(위즈덤/에세이/…) — 상태창/로그/개설 폼 기본 라인.
  activeType: ActivityTypeLike | null;
  // 개설 폼 "라인명" 드롭다운 — 현재 상단 탭 활동유형으로 필터됨.
  activityTypes: ActivityTypeLike[];
  // 개설 대상 크루 후보.
  users: UserLike[];
  // 개설 성공 시 상위(메타/라인 목록) 재조회 트리거.
  onOpened: () => void;
};

export default function PracticalInfoOpeningSection0({
  currentWeek,
  openableWeek,
  weekOptions,
  exceptionWeeks,
  activeType,
  activityTypes,
  users,
  onOpened,
}: Props) {
  // 지난 주 + 활동유형에 대한 활성 info 라인(개설됨 판정용).
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [loadingLine, setLoadingLine] = useState(false);
  // 개설 직후 로그창 재조회 트리거.
  const [logRefreshTick, setLogRefreshTick] = useState(0);

  const openableWeekId = openableWeek?.id ?? null;
  const activeTypeId = activeType?.id ?? null;

  // 지난 주(개설 대상) + 활동유형의 활성 라인 존재 여부를 조회한다(개설됨/필요 판정).
  const loadLine = useCallback(async () => {
    if (!openableWeekId || !activeTypeId) {
      setActiveLineId(null);
      return;
    }
    setLoadingLine(true);
    try {
      const qs = new URLSearchParams({
        week_id: openableWeekId,
        activity_type_id: activeTypeId,
      });
      // org 컨텍스트(?org) → organization 변환.
      const org = readOrgParam(new URLSearchParams(window.location.search));
      if (org) qs.set("organization", org);
      const res = await fetch(
        appendModeQuery(
          `/api/admin/cluster4/info-lines?${qs.toString()}`,
          readScopeMode(new URLSearchParams(window.location.search)),
        ),
      );
      const json = await res.json();
      const rows: Array<{ id: string; isActive: boolean }> = json?.success
        ? json.data?.rows ?? []
        : [];
      const active = rows.find((r) => r.isActive) ?? null;
      setActiveLineId(active?.id ?? null);
    } catch {
      setActiveLineId(null);
    } finally {
      setLoadingLine(false);
    }
  }, [openableWeekId, activeTypeId]);

  useEffect(() => {
    loadLine();
  }, [loadLine]);

  const opened = activeLineId != null;

  const activityName = activeType?.name ?? "해당";
  const lastWeekLabel = openableWeek ? formatBannerPeriod(openableWeek) : null;
  const thisWeekLabel = currentWeek ? formatBannerPeriod(currentWeek) : null;

  // 대상 주차 호칭 — 금요일 경계(금~일)로 개설 대상이 현재 주차와 같아지면 "이번 주",
  //   다르면 "개설 대상 주차". (공용 엔진 targetWeekPrefix 와 동일 규칙 — 같은 주를 한 화면에서
  //   '이번 주'이자 '지난 주'로 부르던 오표기 제거.) 비교 = 시즌/연도/주차번호.
  const targetIsCurrent =
    !!currentWeek &&
    !!openableWeek &&
    currentWeek.year === openableWeek.year &&
    currentWeek.seasonName === openableWeek.seasonName &&
    currentWeek.weekNumber === openableWeek.weekNumber;
  const lastWeekPrefix = targetIsCurrent ? "이번 주" : "개설 대상 주차";

  return (
    <div className="space-y-4">
      {/* 2분할 배치: 좌(상태창) | 우(로그창). 모바일=단일 컬럼 stack(반응형). */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {/* ── 좌열: 상태창 ── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">상태창</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {/* 문구1: 오늘 + 이번 주 */}
            <p className="text-foreground">
              오늘은{" "}
              <span className="font-semibold">{formatToday(new Date())}</span> 이며,
              이번 주는{" "}
              <span className="font-semibold">[{thisWeekLabel ?? "—"}]</span> 입니다.
              (월 ~ 일)
            </p>

            {/* 문구2: 지난 주(개설 대상) 라인 개설 필요/완료 */}
            {lastWeekLabel ? (
              loadingLine ? (
                <LoadingState
                  active
                  variant="inline"
                  title={`${lastWeekPrefix} 라인 상태 확인 중…`}
                />
              ) : opened ? (
                <p className="rounded-md border border-green-300 bg-green-50 px-3 py-2 text-green-800">
                  {lastWeekPrefix} <span className="font-semibold">[{lastWeekLabel}]</span>{" "}
                  의 {activityName} 라인이 ‘개설’ 되어, 크루 기입이 가능합니다.
                </p>
              ) : openableWeek?.isOfficialRest ? (
                /* 공식 휴식 주차 — 액션(개설 되어야) 요구하지 않는다(공용 엔진과 동일). */
                <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-foreground">
                  {lastWeekPrefix} <span className="font-semibold">[{lastWeekLabel}]</span>{" "}
                  의 {activityName} 라인은 개설 대상이 아닙니다 (
                  <span className="font-semibold text-red-600">공식 휴식 주차</span>).
                </p>
              ) : (
                <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800">
                  {lastWeekPrefix} <span className="font-semibold">[{lastWeekLabel}]</span>{" "}
                  의 {activityName} 라인이 ‘개설’ 되어야 합니다.
                </p>
              )
            ) : (
              <p className="text-muted-foreground">
                개설 대상 주차 정보를 확인할 수 없습니다.
              </p>
            )}
          </CardContent>
        </Card>

        {/* ── 우열: 로그창 (현재 활동유형의 개설/취소 이력, 최신순) ── */}
        <PracticalInfoOpeningLogPanel
          activeType={activeType}
          refreshKey={logRefreshTick}
        />
      </div>

      {/* ── 실제 라인 개설 폼 ── */}
      <PracticalInfoOpeningForm
        openableWeek={openableWeek}
        weekOptions={weekOptions}
        exceptionWeeks={exceptionWeeks}
        activityTypes={activityTypes}
        defaultActivityTypeId={activeType?.id ?? null}
        users={users}
        onOpened={() => {
          // 개설 직후 상태창(개설됨 판정)·로그창을 즉시 재조회 + 상위 메타/라인 목록 갱신.
          loadLine();
          setLogRefreshTick((t) => t + 1);
          onOpened();
        }}
      />
    </div>
  );
}
