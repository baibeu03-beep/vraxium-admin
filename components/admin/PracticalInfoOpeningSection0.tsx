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
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";

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
  // 대상 주차 단일 SoT — 상위(Manager)가 소유. 상태창·개설 폼·POST week_id·상단 탭 배지가 모두 이 값을 공유한다.
  //   (이전에는 이 컴포넌트가 자체 selectedWeekId 를 가져 상단 탭 배지와 어긋났다 → 상위로 승격해 단일화.)
  selectedWeekId: string;
  onSelectWeek: (weekId: string) => void;
  // 선택 주차 + 현재 활동유형이 '미오픈'인지 — 상단 탭 배지와 동일한 판정(openByActivityType, selectedWeekId 기준).
  //   상위가 배지용 맵에서 그대로 파생해 내려준다(문구용 별도 판정 금지). 상태창 '미오픈' 문구 분기에만 쓰인다.
  lineNotOpen: boolean;
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
  selectedWeekId,
  onSelectWeek,
  lineNotOpen,
  onOpened,
}: Props) {
  // 지난 주 + 활동유형에 대한 활성 info 라인(개설됨 판정용).
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [loadingLine, setLoadingLine] = useState(false);
  // 개설 직후 로그창 재조회 트리거.
  const [logRefreshTick, setLogRefreshTick] = useState(0);

  // ── 대상 주차 단일 SoT (상위 Manager 소유) ──────────────────────────────────
  //   상태창(개설 필요/완료) · 개설 폼(개설 판정 · POST week_id) · 상단 탭 배지 · 개설 후 재조회가 모두
  //   상위가 내려준 selectedWeekId 를 공유한다. 기본값 초기화도 상위(fetchMeta)가 담당한다.
  //   선택값이 weekOptions 밖(과거 주차 열람 등)이면 상태창 표기는 openableWeek 로 폴백한다.
  const selectedWeek =
    weekOptions.find((w) => w.id === selectedWeekId) ?? openableWeek;
  const resolvedWeekId = selectedWeek?.id ?? null;
  const activeTypeId = activeType?.id ?? null;

  // 선택 주차 + 활동유형의 활성 라인 존재 여부를 조회한다(개설됨/필요 판정) — 대상 주차 SoT 기준.
  const loadLine = useCallback(async () => {
    if (!resolvedWeekId || !activeTypeId) {
      setActiveLineId(null);
      return;
    }
    setLoadingLine(true);
    try {
      const qs = new URLSearchParams({
        week_id: resolvedWeekId,
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
  }, [resolvedWeekId, activeTypeId]);

  useEffect(() => {
    loadLine();
  }, [loadLine]);

  const opened = activeLineId != null;

  const activityName = activeType?.name ?? "해당";
  // 상태창 문구 = 대상 주차(selectedWeek) 기준. 현재 주차 고정이 아니라 관리자가 고른 주차를 따라간다.
  const lastWeekLabel = selectedWeek ? formatBannerPeriod(selectedWeek) : null;
  const thisWeekLabel = currentWeek ? formatBannerPeriod(currentWeek) : null;

  // 대상 주차 호칭 — 선택 주차가 현재 주차와 같으면 "이번 주", 다르면 "선택 주차"(과거 주차 보정 등).
  //   비교 = 시즌/연도/주차번호.
  const targetIsCurrent =
    !!currentWeek &&
    !!selectedWeek &&
    currentWeek.year === selectedWeek.year &&
    currentWeek.seasonName === selectedWeek.seasonName &&
    currentWeek.weekNumber === selectedWeek.weekNumber;
  const lastWeekPrefix = targetIsCurrent ? "이번 주" : "선택 주차";

  return (
    <div className="space-y-4">
      {/* 2분할 배치: 좌(상태창) | 우(로그창). 모바일=단일 컬럼 stack(반응형). */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {/* ── 좌열: 상태창 ── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="inline-flex items-center gap-1.5 text-base">
              상태창
              <AdminHelpIconButton
                size="sm"
                helpKey="admin.lineOpening.info.section.statusBoard"
                title="상태창"
              />
            </CardTitle>
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
              ) : selectedWeek?.isOfficialRest ? (
                /* 공식 휴식 주차 — 액션(개설 되어야) 요구하지 않는다(공용 엔진과 동일). */
                <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-foreground">
                  {lastWeekPrefix} <span className="font-semibold">[{lastWeekLabel}]</span>{" "}
                  의 {activityName} 라인은 개설 대상이 아닙니다 (
                  <span className="font-semibold text-red-600">공식 휴식 주차</span>).
                </p>
              ) : lineNotOpen ? (
                /* 미오픈(선택 주차 개설 대상 아님) — 상단 탭 배지와 동일 판정(lineNotOpen).
                   개설 필요('개설 되어야') 문구 대신 미오픈 상태만 안내한다. */
                <p className="rounded-md border border-zinc-300 bg-zinc-100 px-3 py-2 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-200">
                  {lastWeekPrefix} <span className="font-semibold">[{lastWeekLabel}]</span>{" "}
                  의 {activityName} 라인은 현재 ‘미오픈’ 상태입니다.
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
        selectedWeekId={selectedWeekId}
        onSelectWeek={onSelectWeek}
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
