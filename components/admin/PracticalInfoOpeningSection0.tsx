"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  LineOpeningSectionDivider,
  StatusList,
  StatusListItem,
} from "@/components/admin/lineOpeningStatusUi";

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
  onOpened,
}: Props) {
  // 개설 대상 주차 + 활동유형에 대한 활성 info 라인(개설됨 판정용).
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  // 개설 대상 주차 + 활동유형이 '미오픈'(개설 대상 아님)인지 — 상태창 자체 조회값.
  const [statusLineNotOpen, setStatusLineNotOpen] = useState(false);
  const [loadingLine, setLoadingLine] = useState(false);
  // 개설 직후 로그창 재조회 트리거.
  const [logRefreshTick, setLogRefreshTick] = useState(0);

  // ── 상태창 대상 주차 = 개설 대상 주차(openableWeek, 금요일 경계 SoT) ──────────────
  //   ⚠ 하단 개설 폼의 주차 드롭다운(selectedWeekId)과 완전히 분리된다. 상태창은 항상 '오늘 기준
  //   현재 개설 대상 주차(월~목: 실제 N-1, 금~일: N)'만 본다. 드롭다운을 과거·다른 주차로 바꿔도
  //   상태창 문구·판정은 불변이며, 그 값에 selectedWeekId 는 일절 쓰지 않는다(전역 현재 상태).
  const statusWeek = openableWeek;
  const statusWeekId = statusWeek?.id ?? null;
  const activeTypeId = activeType?.id ?? null;

  // 개설 대상 주차 + 활동유형의 (a) 활성 라인 존재(개설됨) (b) 오픈(개설 대상) 여부를 조회한다.
  //   드롭다운과 무관하게 statusWeekId(=현재 개설 대상 주차)만 조회 — 상태창 전용 자체 fetch.
  const loadStatus = useCallback(async () => {
    if (!statusWeekId || !activeTypeId) {
      setActiveLineId(null);
      setStatusLineNotOpen(false);
      return;
    }
    setLoadingLine(true);
    try {
      const search = new URLSearchParams(window.location.search);
      const org = readOrgParam(search);
      const mode = readScopeMode(search);
      const baseQs = new URLSearchParams({ week_id: statusWeekId });
      if (org) baseQs.set("organization", org);

      // (a) 활성 라인 존재 여부 — 개설됨 판정.
      const linesQs = new URLSearchParams(baseQs);
      linesQs.set("activity_type_id", activeTypeId);
      const linesRes = await fetch(
        appendModeQuery(
          `/api/admin/cluster4/info-lines?${linesQs.toString()}`,
          mode,
        ),
      );
      const linesJson = await linesRes.json();
      const rows: Array<{ id: string; isActive: boolean }> = linesJson?.success
        ? linesJson.data?.rows ?? []
        : [];
      setActiveLineId(rows.find((r) => r.isActive)?.id ?? null);

      // (b) 활동유형별 오픈(개설 대상) 여부 — 미오픈 문구 판정. false=미오픈.
      const openRes = await fetch(
        appendModeQuery(
          `/api/admin/cluster4/info-line-open-status?${baseQs.toString()}`,
          mode,
        ),
      );
      const openJson = await openRes.json();
      const openMap: Record<string, boolean> = openJson?.success
        ? openJson.data?.openByActivityType ?? {}
        : {};
      setStatusLineNotOpen(openMap[activeTypeId] === false);
    } catch {
      setActiveLineId(null);
      setStatusLineNotOpen(false);
    } finally {
      setLoadingLine(false);
    }
  }, [statusWeekId, activeTypeId]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const opened = activeLineId != null;

  const activityName = activeType?.name ?? "해당";
  // 상태창 문구 = 개설 대상 주차(statusWeek) 기준 — 드롭다운 선택과 무관한 현재 상태.
  const lastWeekLabel = statusWeek ? formatBannerPeriod(statusWeek) : null;
  const thisWeekLabel = currentWeek ? formatBannerPeriod(currentWeek) : null;

  // 대상 주차 호칭 — 개설 대상 주차가 현재 주차와 같으면(금~일) "이번 주", 다르면(월~목) "지난 주"
  //   (= 실제 N-1). 금요일 경계상 대상은 항상 N 또는 N-1 뿐이라 "지난 주"는 실제 N-1 을 가리킨다.
  //   비교 = 시즌/연도/주차번호.
  const targetIsCurrent =
    !!currentWeek &&
    !!statusWeek &&
    currentWeek.year === statusWeek.year &&
    currentWeek.seasonName === statusWeek.seasonName &&
    currentWeek.weekNumber === statusWeek.weekNumber;
  const lastWeekPrefix = targetIsCurrent ? "이번 주" : "지난 주";

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
          <CardContent className="text-sm">
            {/* 문장별 박스 제거 — 공용 bullet 목록(StatusList)으로 통일. 상태 구분은 색상 bullet 로만.
                (문장 내부 볼드/빨강 강조는 기존 그대로 유지.) */}
            <StatusList>
              {/* 문구1: 오늘 + 이번 주 (정보성 → neutral bullet) */}
              <StatusListItem tone="neutral">
                오늘은{" "}
                <span className="font-semibold">{formatToday(new Date())}</span> 이며,
                이번 주는{" "}
                <span className="font-semibold">[{thisWeekLabel ?? "—"}]</span> 입니다.
                (월 ~ 일)
              </StatusListItem>

              {/* 문구2: 지난 주(개설 대상) 라인 개설 필요/완료 */}
              {!lastWeekLabel ? (
                <StatusListItem tone="neutral">
                  개설 대상 주차 정보를 확인할 수 없습니다.
                </StatusListItem>
              ) : loadingLine ? (
                <StatusListItem tone="neutral">
                  <span className="text-muted-foreground">
                    {lastWeekPrefix} 라인 상태 확인 중…
                  </span>
                </StatusListItem>
              ) : opened ? (
                <StatusListItem tone="positive">
                  {lastWeekPrefix} <span className="font-semibold">[{lastWeekLabel}]</span>{" "}
                  의 {activityName} 라인이 ‘개설’ 되어, 크루 기입이 가능합니다.
                </StatusListItem>
              ) : statusWeek?.isOfficialRest ? (
                /* 공식 휴식 주차 — 액션(개설 되어야) 요구하지 않는다(공용 엔진과 동일). */
                <StatusListItem tone="neutral">
                  {lastWeekPrefix} <span className="font-semibold">[{lastWeekLabel}]</span>{" "}
                  의 {activityName} 라인은 개설 대상이 아닙니다 (
                  <span className="font-semibold text-red-600">공식 휴식 주차</span>).
                </StatusListItem>
              ) : statusLineNotOpen ? (
                /* 미오픈(개설 대상 주차에 이 활동유형이 개설 대상 아님) — 상태창 자체 조회 판정.
                   개설 필요('개설 되어야') 문구 대신 미오픈 상태만 안내한다. */
                <StatusListItem tone="neutral">
                  {lastWeekPrefix} <span className="font-semibold">[{lastWeekLabel}]</span>{" "}
                  의 {activityName} 라인은 현재 ‘미오픈’ 상태입니다.
                </StatusListItem>
              ) : (
                <StatusListItem tone="warning">
                  {lastWeekPrefix} <span className="font-semibold">[{lastWeekLabel}]</span>{" "}
                  의 {activityName} 라인이 ‘개설’ 되어야 합니다.
                </StatusListItem>
              )}
            </StatusList>
          </CardContent>
        </Card>

        {/* ── 우열: 로그창 (현재 활동유형의 개설/취소 이력, 최신순) ── */}
        <PracticalInfoOpeningLogPanel
          activeType={activeType}
          refreshKey={logRefreshTick}
        />
      </div>

      {/* 상태창(상단)과 라인 개설 폼(하단)을 명확히 분리 — 공용 구분선 + 바깥 여백. */}
      <LineOpeningSectionDivider />

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
          loadStatus();
          setLogRefreshTick((t) => t + 1);
          onOpened();
        }}
      />
    </div>
  );
}
