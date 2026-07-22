"use client";

import { useMemo, useState } from "react";
import { CalendarPlus, RotateCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { apiErrorFrom, getApiErrorMessage } from "@/lib/apiError";
import { adminDialog } from "@/components/ui/admin-dialog";
import { Button } from "@/components/ui/button";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatClubDate } from "@/lib/clubDate";
import {
  itemLabel,
  seasonOptions,
  YEAR_OPTIONS,
  SEASON_LABEL,
  type SeasonToken,
} from "@/lib/seasonSelectOptions";
import { validateTransitionWeek } from "@/lib/seasonCalendar";
import type { SeasonWeekRow } from "@/components/admin/seasonWeeksData";

// ── 선택지 상수 ──────────────────────────────────────────────────────────────
const NONE = "__none__";
const NOTE_MAX_LENGTH = 30;

// 연도(기획 고정값 2022~2026)·계절 label 은 공용 SoT(@/lib/seasonSelectOptions) 재사용.
//   기간 선택.1 / 연도 선택 = YEAR_OPTIONS.
// 시즌 선택: 겨울/봄/여름/가을 순 (기획 명세 순서). 라벨은 공용 SEASON_LABEL.
const SEASON_ORDER: SeasonToken[] = ["winter", "spring", "summer", "autumn"];
const SEASON_OPTIONS = SEASON_ORDER.map((key) => ({
  key,
  label: SEASON_LABEL[key],
}));

// 주차 선택: 0~18
const WEEK_OPTIONS = Array.from({ length: 19 }, (_, i) => String(i));

type ActivityKey = "official" | "rest" | "transition";

const ACTIVITY_OPTIONS: { key: ActivityKey; label: string }[] = [
  { key: "official", label: "공식 활동" },
  { key: "rest", label: "공식 휴식" },
  { key: "transition", label: "전환 주차" },
];

// 전환 주차 저장/검증 규칙은 lib/seasonCalendar.validateTransitionWeek 단일 SoT(서버 POST 와 공유).
//   관리자는 "끝나는 시즌 + 마지막+1 주차"(구 정책)가 아니라 **도착 시즌 + 0주차**를 직접 선택한다
//   (예: 여름→가을 전환 = "가을" + "0주차"). week_number===0 은 전환 주차 전용.

// base-ui Select 는 items 매핑이 있어야 닫힌 트리거에 라벨을 표시한다.
// 옵션 목록 렌더와 트리거 라벨 해석이 동일 배열(items SoT)을 쓰도록 한다.
const YEAR_ITEMS = [{ value: NONE, label: "-" }, ...YEAR_OPTIONS];
const SEASON_ITEMS = [
  { value: NONE, label: "-" },
  ...seasonOptions(SEASON_ORDER),
];
const WEEK_ITEMS = [
  { value: NONE, label: "-" },
  ...WEEK_OPTIONS.map((w) => ({ value: w, label: `${w}주차` })),
];
const ACTIVITY_ITEMS = [
  { value: NONE, label: "-" },
  ...ACTIVITY_OPTIONS.map((o) => ({ value: o.key, label: o.label })),
];

// ── 주차 후보 생성 (월~일, "그 주의 수요일이 속한 년도" 기준) ────────────────
type WeekCandidate = {
  start: string; // 월요일 YYYY-MM-DD
  end: string; // 일요일 YYYY-MM-DD
  label: string; // 26. 06. 29. (월) ~ 26. 07. 05. (일)
};

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function weekCandidatesOfYear(year: number): WeekCandidate[] {
  const out: WeekCandidate[] = [];
  // 전년 12월 말부터 첫 월요일을 찾아, 수요일(월+2일)이 해당 연도를 벗어날 때까지 순회.
  const cursor = new Date(Date.UTC(year - 1, 11, 24));
  while (cursor.getUTCDay() !== 1) cursor.setUTCDate(cursor.getUTCDate() + 1);
  for (;;) {
    const wed = new Date(cursor);
    wed.setUTCDate(wed.getUTCDate() + 2);
    const wedYear = wed.getUTCFullYear();
    if (wedYear > year) break;
    if (wedYear === year) {
      const sun = new Date(cursor);
      sun.setUTCDate(sun.getUTCDate() + 6);
      const start = toIsoDate(cursor);
      const end = toIsoDate(sun);
      out.push({
        start,
        end,
        label: `${formatClubDate(start)} ~ ${formatClubDate(end)}`,
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return out;
}

function FormField({
  label,
  helpKey,
  hint,
  className,
  children,
}: {
  label: string;
  // 요소 단위 도움말 키(고유). 지정 시 라벨 오른쪽에 돋보기 도움말 아이콘을 붙인다.
  //   · inline-flex 로 라벨 영역만 감싸 select/input 폭·정렬을 건드리지 않는다.
  helpKey?: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <span className="inline-flex items-center gap-1 text-sm font-medium text-foreground">
        {label}
        {helpKey && (
          <AdminHelpIconButton helpKey={helpKey} title={label} size="xs" />
        )}
      </span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

type Props = {
  // 중복 검증용 기존 데이터 — 상위 페이지가 하단 "기간 정보" 목록과 공유하는 단일 조회
  //   (GET /api/admin/season-weeks) 결과. 폼이 별도로 다시 호출하지 않는다(중복 호출 제거).
  rows: SeasonWeekRow[];
  // 등록 성공 시 상위 공유 데이터를 재조회 → 하단 목록 즉시 갱신 + 다음 중복 검증에 신규분 반영.
  onRegistered: () => void;
};

export default function PeriodRegisterForm({ rows, onRegistered }: Props) {
  // 기간 선택.1 — 주차 후보 필터 기준 연도 (등록 데이터의 표시 연도가 아님)
  const [candidateYear, setCandidateYear] = useState<string>(NONE);
  // 기간 선택.2 — 월~일 주차 (value=시작일 ISO)
  const [periodStart, setPeriodStart] = useState<string>(NONE);

  // 등록 값
  const [regYear, setRegYear] = useState<string>(NONE);
  const [regSeason, setRegSeason] = useState<string>(NONE);
  const [regWeek, setRegWeek] = useState<string>(NONE);
  const [activity, setActivity] = useState<string>(NONE);
  const [note, setNote] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // 기간 선택.2 후보: 기간 선택.1 연도의 "수요일 귀속" 주차 목록.
  const candidates = useMemo(() => {
    if (candidateYear === NONE) return [];
    return weekCandidatesOfYear(Number(candidateYear));
  }, [candidateYear]);

  const candidateItems = useMemo(
    () => [
      { value: NONE, label: "-" },
      ...candidates.map((c) => ({ value: c.start, label: c.label })),
    ],
    [candidates],
  );

  const selectedCandidate = useMemo(
    () => candidates.find((c) => c.start === periodStart) ?? null,
    [candidates, periodStart],
  );

  // 기간 선택.1 변경 시 기간 선택.2 초기화 (후보 목록이 바뀌므로).
  const handleCandidateYearChange = (value: string | null) => {
    setCandidateYear(value ?? NONE);
    setPeriodStart(NONE);
  };

  const resetForm = () => {
    setCandidateYear(NONE);
    setPeriodStart(NONE);
    setRegYear(NONE);
    setRegSeason(NONE);
    setRegWeek(NONE);
    setActivity(NONE);
    setNote("");
  };

  const handleSubmit = async () => {
    setSuccessMessage(null);

    if (candidateYear === NONE || !selectedCandidate) {
      void adminDialog.alert({ variant: "warning", title: "입력 확인", description: "기간(월~일 주차)을 선택해 주세요." });
      return;
    }
    if (regYear === NONE) {
      void adminDialog.alert({ variant: "warning", title: "입력 확인", description: "연도를 선택해 주세요." });
      return;
    }
    if (regSeason === NONE) {
      void adminDialog.alert({ variant: "warning", title: "입력 확인", description: "시즌을 선택해 주세요." });
      return;
    }
    if (regWeek === NONE) {
      void adminDialog.alert({ variant: "warning", title: "입력 확인", description: "주차를 선택해 주세요." });
      return;
    }
    if (activity === NONE) {
      void adminDialog.alert({ variant: "warning", title: "입력 확인", description: "활동 구분을 선택해 주세요." });
      return;
    }
    const trimmedNote = note.trim();
    if (trimmedNote.length > NOTE_MAX_LENGTH) {
      void adminDialog.alert({ variant: "warning", title: "입력 확인", description: `비고는 최대 ${NOTE_MAX_LENGTH}자까지 입력할 수 있습니다.` });
      return;
    }

    const seasonKey = `${regYear}-${regSeason}`;
    const weekNumber = Number(regWeek);
    const isTransition = activity === "transition";

    // 시험기간 고정 휴식: 봄/가을 6~8·14~16주차는 공식 휴식 고정 — 공식 활동 등록 차단.
    // (백엔드 POST 에서도 동일 규칙으로 재검증한다 — 400)
    const isExamRestWeek =
      (regSeason === "spring" || regSeason === "autumn") &&
      ((weekNumber >= 6 && weekNumber <= 8) ||
        (weekNumber >= 14 && weekNumber <= 16));
    if (activity === "official" && isExamRestWeek) {
      void adminDialog.alert({ variant: "warning", title: "등록 불가", description: "해당 주차는 시험기간 공식 휴식 주차입니다." });
      return;
    }

    // 전환/공식/휴식 활동 유형별 주차 검증 — 공통 정책 SoT(validateTransitionWeek, 서버 POST 와 동일).
    //   전환 주차 = 도착 시즌 + 0주차 전용, 0주차는 공식 활동/휴식으로 등록 불가.
    //   (백엔드 POST 에서도 동일 규칙으로 재검증한다 — 400)
    const activityValidation = validateTransitionWeek({
      seasonType: regSeason,
      weekNumber,
      activityType: activity as ActivityKey,
    });
    if (!activityValidation.ok) {
      void adminDialog.alert({ variant: "warning", title: "등록 불가", description: activityValidation.message });
      return;
    }

    // 프론트 중복 검증 — 기간 정보와 동일한 rows(season_key+week_number) 기준.
    //   관리자가 도착 시즌 + 0주차를 직접 선택하므로 별도 시즌 변환 없이 그대로 검증한다
    //   (전환 주차도 seasonKey = 선택 시즌, week_number = 0).
    // (백엔드 POST 에서도 동일 규칙으로 재검증한다 — 409)
    const duplicated = rows.some(
      (row) =>
        row.season_key === seasonKey &&
        row.week_number === weekNumber,
    );
    if (duplicated) {
      void adminDialog.alert({ variant: "warning", title: "중복 확인", description: "동일한 주차 정보를 가진 기간이 있습니다." });
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/season-weeks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year: Number(regYear),
          season_type: regSeason,
          week_number: weekNumber,
          // 전환 주차도 저장 표현은 공식 활동과 동일(is_official_rest=false). 전환 여부는
          // week_number===0(도착 시즌 0주차)으로 조회 시 파생되며, is_transition 은 백엔드 교차검증용.
          is_official_rest: activity === "rest",
          is_transition: isTransition,
          note: trimmedNote.length > 0 ? trimmedNote : null,
          week_start_date: selectedCandidate.start,
          week_end_date: selectedCandidate.end,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        // 서버 4xx 업무 사유(기간 충돌·중복 주차 등)는 그대로, 5xx 원문은 안전 문구로 치환된다.
        throw apiErrorFrom(res, json, "등록에 실패했습니다.");
      }

      const regSeasonLabel =
        SEASON_OPTIONS.find((o) => o.key === regSeason)?.label ?? regSeason;
      setSuccessMessage(
        isTransition
          ? `${regYear}년 ${regSeasonLabel} 시즌 전환 주차(0주차, ${selectedCandidate.label})가 등록되었습니다.`
          : `${regYear}년 ${regSeasonLabel} ${weekNumber}주차(${selectedCandidate.label})가 등록되었습니다.`,
      );
      resetForm();
      // 상위 공유 데이터 재조회 — 하단 "기간 정보" 목록 즉시 갱신 + 다음 중복 검증에 신규 등록분 반영.
      //   (전체 페이지 새로고침 아님 — 등록 폼과 목록이 같은 조회를 공유하므로 한 번의 refetch 로 동시 최신화.)
      // 크루 페이지(cluster4 카드) 반영은 별도 조작이 필요 없다: 휴식/기간 변경은 영향 snapshot 을
      //   자동 stale 처리하고, 사용자가 크루 페이지를 조회할 때 loadWeeklyCards() 가 lazy 재계산한다.
      onRegistered();
    } catch (err) {
      console.error("[periods/register] create failed", err);
      void adminDialog.alert({
        variant: "danger",
        title: "등록 실패",
        description: getApiErrorMessage(err, "등록에 실패했습니다."),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="admin-section-stack">
      {/* 섹션 제목(h2) — 페이지 제목(h1)/전역 도움말은 상위 통합 페이지(기간 관리)가 담당.
          기존 "기간 정보로 이동" 버튼은 제거(같은 페이지 하단에 기간 정보 목록이 함께 표시됨). */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto inline-flex items-center gap-1 text-lg font-semibold tracking-normal text-foreground">
          기간 등록
          <AdminHelpIconButton
            helpKey="admin.periods.register.section"
            title="기간 등록"
            size="sm"
          />
        </h2>
      </div>

      {successMessage && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {successMessage}
        </div>
      )}

      <Card>
        <CardContent className="flex flex-col gap-5 py-5">
          {/* 1행: 기간 선택.1/.2 + 연도/시즌/주차/활동 — 가로 배치, 폭 부족 시에만 줄바꿈 */}
          <div className="flex flex-wrap items-end gap-x-3 gap-y-4">
            <FormField
              label="기간 선택.1"
              helpKey="admin.periods.register.periodType1"
              className="w-32"
            >
              <Select
                items={YEAR_ITEMS}
                value={candidateYear}
                onValueChange={handleCandidateYearChange}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(v) => itemLabel(YEAR_ITEMS, v as string)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {YEAR_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField
              label="기간 선택.2"
              helpKey="admin.periods.register.periodType2"
              className="w-72"
            >
              <Select
                items={candidateItems}
                value={periodStart}
                onValueChange={(v) => setPeriodStart(v ?? NONE)}
                disabled={candidateYear === NONE}
              >
                <SelectTrigger className="w-full" disabled={candidateYear === NONE}>
                  <SelectValue>
                    {(v) => itemLabel(candidateItems, v as string)}
                  </SelectValue>
                </SelectTrigger>
                {/* 한 번에 10개 정도 노출 — 항목 높이(28px)×10 + 패딩 */}
                <SelectContent className="max-h-80" alignItemWithTrigger={false}>
                  {candidateItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField
              label="연도 선택"
              helpKey="admin.periods.register.year"
              className="w-32"
            >
              <Select
                items={YEAR_ITEMS}
                value={regYear}
                onValueChange={(v) => setRegYear(v ?? NONE)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(v) => itemLabel(YEAR_ITEMS, v as string)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {YEAR_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField
              label="시즌 선택"
              helpKey="admin.periods.register.season"
              className="w-28"
            >
              <Select
                items={SEASON_ITEMS}
                value={regSeason}
                onValueChange={(v) => setRegSeason(v ?? NONE)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(v) => itemLabel(SEASON_ITEMS, v as string)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {SEASON_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField
              label="주차 선택"
              helpKey="admin.periods.register.week"
              className="w-28"
            >
              <Select
                items={WEEK_ITEMS}
                value={regWeek}
                onValueChange={(v) => setRegWeek(v ?? NONE)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(v) => itemLabel(WEEK_ITEMS, v as string)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="max-h-80" alignItemWithTrigger={false}>
                  {WEEK_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField
              label="활동 선택"
              helpKey="admin.periods.register.activity"
              className="w-32"
            >
              <Select
                items={ACTIVITY_ITEMS}
                value={activity}
                onValueChange={(v) => setActivity(v ?? NONE)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {(v) => itemLabel(ACTIVITY_ITEMS, v as string)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {ACTIVITY_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <FormField
            label="비고"
            helpKey="admin.periods.register.note"
            hint={`최대 ${NOTE_MAX_LENGTH}자 (선택 입력)`}
          >
            <Input
              value={note}
              maxLength={NOTE_MAX_LENGTH}
              onChange={(e) => setNote(e.target.value)}
              placeholder="예: 설 연휴 휴식"
            />
          </FormField>

          {/* 3행: 우측 버튼 — 등록 / 취소(입력값 초기화).
              도움말 돋보기는 버튼 내부 텍스트가 아니라 각 버튼 바로 바깥쪽에 둔다. */}
          <div className="flex items-center justify-end gap-2">
            <div className="inline-flex items-center gap-1">
              <Button type="button" onClick={handleSubmit} loading={submitting}>
                <CalendarPlus className="h-4 w-4" />
                등록
              </Button>
              <AdminHelpIconButton
                helpKey="admin.periods.register.submit"
                title="등록"
                size="sm"
              />
            </div>
            <div className="inline-flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                onClick={resetForm}
                disabled={submitting}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                취소
              </Button>
              <AdminHelpIconButton
                helpKey="admin.periods.register.cancel"
                title="취소"
                size="sm"
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
