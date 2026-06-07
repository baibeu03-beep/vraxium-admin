"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarPlus, RotateCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ── 데이터 타입: /api/admin/season-weeks 응답 DTO 그대로 (기간 정보와 동일 원천 —
//    기간 등록 전용 데이터 구조를 만들지 않는다) ─────────────────────────────
type SeasonWeekRow = {
  season_key: string;
  week_id: string;
  week_number: number | null;
  week_start_date: string | null;
  week_end_date: string | null;
  is_official_rest: boolean;
};

type ApiPayload = {
  rows?: SeasonWeekRow[];
};

// ── 선택지 상수 ──────────────────────────────────────────────────────────────
const NONE = "__none__";
const NOTE_MAX_LENGTH = 30;

// 기간 선택.1 / 연도 선택 공통: 2022~2026 (기획 고정값)
const YEAR_OPTIONS = ["2026", "2025", "2024", "2023", "2022"] as const;

type SeasonToken = "winter" | "spring" | "summer" | "autumn";

// 시즌 선택: 겨울/봄/여름/가을 순 (기획 명세 순서)
const SEASON_OPTIONS: { key: SeasonToken; label: string }[] = [
  { key: "winter", label: "겨울" },
  { key: "spring", label: "봄" },
  { key: "summer", label: "여름" },
  { key: "autumn", label: "가을" },
];

// 주차 선택: 0~18
const WEEK_OPTIONS = Array.from({ length: 19 }, (_, i) => String(i));

type ActivityKey = "official" | "rest";

const ACTIVITY_OPTIONS: { key: ActivityKey; label: string }[] = [
  { key: "official", label: "공식 활동" },
  { key: "rest", label: "공식 휴식" },
];

// base-ui Select 는 items 매핑이 있어야 닫힌 트리거에 라벨을 표시한다.
const YEAR_ITEMS = [
  { value: NONE, label: "선택" },
  ...YEAR_OPTIONS.map((y) => ({ value: y, label: `${y}년` })),
];
const SEASON_ITEMS = [
  { value: NONE, label: "선택" },
  ...SEASON_OPTIONS.map((o) => ({ value: o.key, label: o.label })),
];
const WEEK_ITEMS = [
  { value: NONE, label: "선택" },
  ...WEEK_OPTIONS.map((w) => ({ value: w, label: `${w}주차` })),
];
const ACTIVITY_ITEMS = [
  { value: NONE, label: "선택" },
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

// 표시 형식: 26. 06. 29. (월)
function formatCandidateDate(iso: string, dayLabel: string): string {
  const [y, m, d] = iso.split("-");
  return `${y.slice(2)}. ${m}. ${d}. (${dayLabel})`;
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
        label: `${formatCandidateDate(start, "월")} ~ ${formatCandidateDate(end, "일")}`,
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return out;
}

function FormField({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <span className="text-sm font-medium text-foreground">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

export default function PeriodRegisterForm() {
  // 중복 검증용 기존 데이터 — 기간 정보(GET /api/admin/season-weeks)와 동일 API/DTO.
  const [rows, setRows] = useState<SeasonWeekRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

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

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoadError(null);
      try {
        const res = await fetch("/api/admin/season-weeks", {
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json?.error ?? "Failed to load season weeks.");
        }
        const data = (json.data ?? {}) as ApiPayload;
        if (!cancelled) setRows(data.rows ?? []);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Failed to load.");
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  // 기간 선택.2 후보: 기간 선택.1 연도의 "수요일 귀속" 주차 목록.
  const candidates = useMemo(() => {
    if (candidateYear === NONE) return [];
    return weekCandidatesOfYear(Number(candidateYear));
  }, [candidateYear]);

  const candidateItems = useMemo(
    () => [
      { value: NONE, label: "선택" },
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
      alert("기간(월~일 주차)을 선택해 주세요.");
      return;
    }
    if (regYear === NONE) {
      alert("연도를 선택해 주세요.");
      return;
    }
    if (regSeason === NONE) {
      alert("시즌을 선택해 주세요.");
      return;
    }
    if (regWeek === NONE) {
      alert("주차를 선택해 주세요.");
      return;
    }
    if (activity === NONE) {
      alert("활동 구분을 선택해 주세요.");
      return;
    }
    const trimmedNote = note.trim();
    if (trimmedNote.length > NOTE_MAX_LENGTH) {
      alert(`비고는 최대 ${NOTE_MAX_LENGTH}자까지 입력할 수 있습니다.`);
      return;
    }

    const seasonKey = `${regYear}-${regSeason}`;
    const weekNumber = Number(regWeek);

    // 시험기간 고정 휴식: 봄/가을 6~8·14~16주차는 공식 휴식 고정 — 공식 활동 등록 차단.
    // (백엔드 POST 에서도 동일 규칙으로 재검증한다 — 400)
    const isExamRestWeek =
      (regSeason === "spring" || regSeason === "autumn") &&
      ((weekNumber >= 6 && weekNumber <= 8) ||
        (weekNumber >= 14 && weekNumber <= 16));
    if (activity === "official" && isExamRestWeek) {
      alert("해당 주차는 시험기간 공식 휴식 주차입니다.");
      return;
    }

    // 프론트 중복 검증 — 기간 정보와 동일한 rows(season_key+week_number) 기준.
    // (백엔드 POST 에서도 동일 규칙으로 재검증한다 — 409)
    const duplicated = rows.some(
      (row) => row.season_key === seasonKey && row.week_number === weekNumber,
    );
    if (duplicated) {
      alert("동일한 주차 정보를 가진 기간이 있습니다.");
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
          is_official_rest: activity === "rest",
          note: trimmedNote.length > 0 ? trimmedNote : null,
          week_start_date: selectedCandidate.start,
          week_end_date: selectedCandidate.end,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        alert(json?.error ?? "등록에 실패했습니다.");
        return;
      }

      setSuccessMessage(
        `${regYear}년 ${
          SEASON_OPTIONS.find((o) => o.key === regSeason)?.label ?? regSeason
        } ${weekNumber}주차(${selectedCandidate.label})가 등록되었습니다.`,
      );
      resetForm();
      // 기간 정보와 동일 원천 재조회 — 다음 중복 검증에 신규 등록분 즉시 반영.
      setRefreshTick((v) => v + 1);
    } catch {
      alert("등록 중 오류가 발생했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 상단: 페이지 제목 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-normal text-foreground">
            기간 등록
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            주차 기간을 등록합니다. 등록된 기간은 기간 정보에서 즉시 조회됩니다.
          </p>
        </div>
        <Button type="button" variant="outline" render={<Link href="/admin/season-weeks" />}>
          기간 정보로 이동
        </Button>
      </div>

      {loadError && (
        <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          기존 기간 정보를 불러오지 못했습니다: {loadError}
        </div>
      )}

      {successMessage && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {successMessage}
        </div>
      )}

      <Card>
        <CardContent className="flex flex-col gap-5 py-5">
          {/* 1행: 기간 선택.1/.2 + 연도/시즌/주차/활동 — 가로 배치, 폭 부족 시에만 줄바꿈 */}
          <div className="flex flex-wrap items-end gap-x-3 gap-y-4">
            <FormField label="기간 선택.1" className="w-32">
              <Select
                items={YEAR_ITEMS}
                value={candidateYear}
                onValueChange={handleCandidateYearChange}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>선택</SelectItem>
                  {YEAR_OPTIONS.map((year) => (
                    <SelectItem key={year} value={year}>
                      {year}년
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="기간 선택.2" className="w-72">
              <Select
                items={candidateItems}
                value={periodStart}
                onValueChange={(v) => setPeriodStart(v ?? NONE)}
                disabled={candidateYear === NONE}
              >
                <SelectTrigger className="w-full" disabled={candidateYear === NONE}>
                  <SelectValue />
                </SelectTrigger>
                {/* 한 번에 10개 정도 노출 — 항목 높이(28px)×10 + 패딩 */}
                <SelectContent className="max-h-80" alignItemWithTrigger={false}>
                  <SelectItem value={NONE}>선택</SelectItem>
                  {candidates.map((candidate) => (
                    <SelectItem key={candidate.start} value={candidate.start}>
                      {candidate.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="연도 선택" className="w-32">
              <Select
                items={YEAR_ITEMS}
                value={regYear}
                onValueChange={(v) => setRegYear(v ?? NONE)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>선택</SelectItem>
                  {YEAR_OPTIONS.map((year) => (
                    <SelectItem key={year} value={year}>
                      {year}년
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="시즌 선택" className="w-28">
              <Select
                items={SEASON_ITEMS}
                value={regSeason}
                onValueChange={(v) => setRegSeason(v ?? NONE)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>선택</SelectItem>
                  {SEASON_OPTIONS.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="주차 선택" className="w-28">
              <Select
                items={WEEK_ITEMS}
                value={regWeek}
                onValueChange={(v) => setRegWeek(v ?? NONE)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80" alignItemWithTrigger={false}>
                  <SelectItem value={NONE}>선택</SelectItem>
                  {WEEK_OPTIONS.map((week) => (
                    <SelectItem key={week} value={week}>
                      {week}주차
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="활동 선택" className="w-32">
              <Select
                items={ACTIVITY_ITEMS}
                value={activity}
                onValueChange={(v) => setActivity(v ?? NONE)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>선택</SelectItem>
                  {ACTIVITY_OPTIONS.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <FormField label="비고" hint={`최대 ${NOTE_MAX_LENGTH}자 (선택 입력)`}>
            <Input
              value={note}
              maxLength={NOTE_MAX_LENGTH}
              onChange={(e) => setNote(e.target.value)}
              placeholder="예: 설 연휴 휴식"
            />
          </FormField>

          {/* 3행: 우측 버튼 — 등록 / 취소(입력값 초기화) */}
          <div className="flex items-center justify-end gap-2">
            <Button type="button" onClick={handleSubmit} disabled={submitting}>
              <CalendarPlus className="h-4 w-4" />
              {submitting ? "등록 중..." : "등록"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={resetForm}
              disabled={submitting}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              취소
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
