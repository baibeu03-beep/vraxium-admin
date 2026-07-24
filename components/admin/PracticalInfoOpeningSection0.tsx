"use client";

import { useEffect, useState } from "react";
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
  statusTokenClass,
} from "@/components/admin/lineOpeningStatusUi";

// 실무 정보 라인 개설 [섹션 0] — 상황 통제 영역.
//   상태창: 오늘/이번 주 + '지난 주(개설 대상 주차)'의 개설 상태만 표시(경험/역량 상태창과 동일 정책·공통 강조 토큰).
// '지난 주' = 개설 대상 주차(isOpenTarget / describeOpenableWeek, 금요일 경계) — 월~목: N-1, 금~일: N.
//   금~일엔 이번 주와 같은 주차로 표시되는 것은 금요일 경계 규칙에 따른 정상 동작(화면 문구는 "지난 주" 유지).
// (개설/검수 기록 메모 카드는 2026-06-14 UI 정리로 제거 — opening-note 저장 엔드포인트는 보존.)
//
// ⚠ (2026-07-24 정책) 상태창은 '개설 대상 주차'만 서술한다 — 주차 드롭다운(selectedWeekId)을 바꿔도
//   상태창은 변하지 않는다(선택한 주차 상태는 생성/표시하지 않는다). 강조는 역할별 공통 토큰(statusTokenClass).

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
  // 대상 주차 단일 SoT — 상위(Manager)가 소유. 개설 폼·POST week_id·상단 탭 배지·② 선택한 주차 상태가 공유한다.
  selectedWeekId: string;
  onSelectWeek: (weekId: string) => void;
  // 개설 성공 시 상위(메타/라인 목록) 재조회 트리거.
  onOpened: () => void;
};

// 개설 대상 주차 + 활동유형의 (a) 활성 라인 존재(개설됨) (b) 오픈(개설 대상) 여부를 조회한다.
//   ① 현재 운영 상태·② 선택한 주차 상태가 week_id 만 바꿔 같은 조회를 재사용한다(동일 판정 로직).
async function queryInfoLineStatus(
  weekId: string,
  activityTypeId: string,
): Promise<{ opened: boolean; notOpen: boolean }> {
  const search = new URLSearchParams(window.location.search);
  const org = readOrgParam(search);
  const mode = readScopeMode(search);
  const baseQs = new URLSearchParams({ week_id: weekId });
  if (org) baseQs.set("organization", org);

  // (a) 활성 라인 존재 여부 — 개설됨 판정.
  const linesQs = new URLSearchParams(baseQs);
  linesQs.set("activity_type_id", activityTypeId);
  const linesRes = await fetch(
    appendModeQuery(`/api/admin/cluster4/info-lines?${linesQs.toString()}`, mode),
  );
  const linesJson = await linesRes.json();
  const rows: Array<{ id: string; isActive: boolean }> = linesJson?.success
    ? linesJson.data?.rows ?? []
    : [];
  const opened = rows.some((r) => r.isActive);

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
  return { opened, notOpen: openMap[activityTypeId] === false };
}

// 한 주차 기준 개설 상태 문장 — 개설 대상 주차의 개설 상태 1줄.
//   강조는 역할별 공통 토큰(statusTokenClass): 주차명=rose · 활동/라인명=blue · 개설/크루기입=green ·
//   개설 필요=amber · 휴식/미오픈=gray. 경험/역량 상태창과 동일 규칙(색만이 아니라 bullet 색+문구로 구분).
function InfoOpenStatusItem({
  prefix,
  weekLabel,
  activityName,
  loading,
  opened,
  isOfficialRest,
  notOpen,
}: {
  prefix: string;
  weekLabel: string | null;
  activityName: string;
  loading: boolean;
  opened: boolean;
  isOfficialRest: boolean;
  notOpen: boolean;
}) {
  if (!weekLabel) {
    return (
      <StatusListItem tone="neutral">
        개설 대상 주차 정보를 확인할 수 없습니다.
      </StatusListItem>
    );
  }
  // 공통 head: "개설 대상 주차 [주차명] 의 {활동명} 라인" — 주차=rose, 활동/라인명=blue.
  const head = (
    <>
      {prefix} <span className={statusTokenClass("date")}>[{weekLabel}]</span> 의{" "}
      <span className={statusTokenClass("team")}>{activityName}</span> 라인
    </>
  );
  if (loading) {
    return (
      <StatusListItem tone="neutral">
        <span className="text-muted-foreground">{prefix} 라인 상태 확인 중…</span>
      </StatusListItem>
    );
  }
  if (opened) {
    return (
      <StatusListItem tone="positive">
        {head}이 ‘<span className={statusTokenClass("openDone")}>개설</span>’ 되어,{" "}
        <span className={statusTokenClass("crewOk")}>크루 기입이 가능</span>합니다.
      </StatusListItem>
    );
  }
  if (isOfficialRest) {
    // 공식 휴식 주차 — 액션(개설 되어야) 요구하지 않는다(공용 엔진과 동일). 회색 강조.
    return (
      <StatusListItem tone="neutral">
        {head}은 개설 대상이 아닙니다 (
        <span className={statusTokenClass("periodNone")}>공식 휴식 주차</span>).
      </StatusListItem>
    );
  }
  if (notOpen) {
    // 미오픈(그 주차에 이 활동유형이 개설 대상 아님) — 개설 필요 문구 대신 미오픈만 안내(회색).
    return (
      <StatusListItem tone="neutral">
        {head}은 현재 ‘
        <span className={statusTokenClass("periodNone")}>미오픈</span>’ 상태입니다.
      </StatusListItem>
    );
  }
  return (
    <StatusListItem tone="warning">
      {head}이 ‘<span className={statusTokenClass("openNeed")}>개설</span>’ 되어야 합니다.
    </StatusListItem>
  );
}

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
  // 현재 운영 상태(개설 대상 주차 = openableWeek) 조회값.
  const [opStatus, setOpStatus] = useState<{ opened: boolean; notOpen: boolean }>(
    { opened: false, notOpen: false },
  );
  const [opLoading, setOpLoading] = useState(false);
  // 개설 직후 로그창 재조회 트리거.
  const [logRefreshTick, setLogRefreshTick] = useState(0);
  // 개설 완료/취소 직후 상태창 재조회 트리거 — 값이 바뀌면 effect 가 다시 조회한다.
  const [statusRefreshTick, setStatusRefreshTick] = useState(0);

  // ── 상태창 대상 주차 = 개설 대상 주차(openableWeek, 금요일 경계 SoT) ──
  //   드롭다운(selectedWeekId)과 무관 — 항상 '오늘 기준 현재 개설 대상 주차'만 본다.
  const statusWeek = openableWeek;
  const statusWeekId = statusWeek?.id ?? null;
  const activeTypeId = activeType?.id ?? null;

  // 현재 운영 상태 조회 — statusWeekId(현재 개설 대상 주차)만.
  //   setState 는 async IIFE 안에서만(+cancelled 가드) — effect 본문 동기 setState 금지(cascading 렌더 방지).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!statusWeekId || !activeTypeId) {
        if (!cancelled) setOpStatus({ opened: false, notOpen: false });
        return;
      }
      if (!cancelled) setOpLoading(true);
      try {
        const r = await queryInfoLineStatus(statusWeekId, activeTypeId);
        if (!cancelled) setOpStatus(r);
      } catch {
        if (!cancelled) setOpStatus({ opened: false, notOpen: false });
      } finally {
        if (!cancelled) setOpLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [statusWeekId, activeTypeId, statusRefreshTick]);

  const activityName = activeType?.name ?? "해당";
  const thisWeekLabel = currentWeek ? formatBannerPeriod(currentWeek) : null;
  const operatingWeekLabel = statusWeek ? formatBannerPeriod(statusWeek) : null;

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
          <CardContent className="space-y-4 text-sm">
            {/* 블록1 — 오늘 + 이번 주 (정보성 → neutral bullet). 날짜·주차명=rose(공통 토큰). */}
            <StatusList>
              <StatusListItem tone="neutral">
                오늘은{" "}
                <span className={statusTokenClass("date")}>{formatToday(new Date())}</span>{" "}
                이며, 이번 주는{" "}
                <span className={statusTokenClass("date")}>[{thisWeekLabel ?? "—"}]</span>{" "}
                입니다. (월 ~ 일)
              </StatusListItem>
            </StatusList>

            {/* 개설 대상 주차 개설 상태 — 화면 문구는 "지난 주"로 유지(프로젝트 관용).
                주차 드롭다운을 바꿔도 이 문장은 변하지 않는다(선택한 주차 상태는 표시하지 않는다). */}
            <section>
              <StatusList>
                <InfoOpenStatusItem
                  prefix="지난 주"
                  weekLabel={operatingWeekLabel}
                  activityName={activityName}
                  loading={opLoading}
                  opened={opStatus.opened}
                  isOfficialRest={!!statusWeek?.isOfficialRest}
                  notOpen={opStatus.notOpen}
                />
              </StatusList>
            </section>
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
          // 개설 직후 상태창(개설 대상 주차)·로그창 즉시 재조회 + 상위 메타/라인 목록 갱신.
          setStatusRefreshTick((t) => t + 1);
          setLogRefreshTick((t) => t + 1);
          onOpened();
        }}
      />
    </div>
  );
}
