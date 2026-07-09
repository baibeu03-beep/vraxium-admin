"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarPlus, RefreshCw, RotateCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import AdminHelp from "@/components/admin/AdminHelp";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatClubDate } from "@/lib/clubDate";

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

type ActivityKey = "official" | "rest" | "transition";

const ACTIVITY_OPTIONS: { key: ActivityKey; label: string }[] = [
  { key: "official", label: "공식 활동" },
  { key: "rest", label: "공식 휴식" },
  { key: "transition", label: "전환 주차" },
];

// 시즌별 정규 주수 — 전환 주차(정규 주수 +1) 검증용. 백엔드 SEASON_WEEKS 미러.
//   전환 주차 번호 = SEASON_WEEKS + 1 (봄/가을 17, 여름/겨울 9).
const SEASON_WEEKS: Record<SeasonToken, number> = {
  winter: 8,
  spring: 16,
  summer: 8,
  autumn: 16,
};

// base-ui Select 는 items 매핑이 있어야 닫힌 트리거에 라벨을 표시한다.
const YEAR_ITEMS = [
  { value: NONE, label: "-" },
  ...YEAR_OPTIONS.map((y) => ({ value: y, label: `${y}년` })),
];
const SEASON_ITEMS = [
  { value: NONE, label: "-" },
  ...SEASON_OPTIONS.map((o) => ({ value: o.key, label: o.label })),
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

  // 크루 페이지 업데이트 — 등록한 주차 기간을 크루 페이지에 반영(등록 직후 노출).
  // 내부적으로 영향 대상 카드 재계산 API 를 재사용하되, 화면에는 개발 용어를 쓰지 않는다.
  const [lastRegistered, setLastRegistered] = useState<{
    start: string;
    end: string;
  } | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateDone, setUpdateDone] = useState<string | null>(null);
  // dry_run 으로 확인한 반영 대상 수(확인 전 = null). 값이 있으면 '업데이트 실행' 단계.
  const [reflectTargetCount, setReflectTargetCount] = useState<number | null>(
    null,
  );

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
    const isTransition = activity === "transition";

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

    // 전환 주차: 시즌 정규 주수 +1 (봄/가을 17주, 여름/겨울 9주)만 등록 가능.
    //   저장 DTO 는 그대로(is_official_rest=false) — is_transition 은 week_number 로 파생되므로
    //   주차 번호가 맞지 않으면 조회 시 전환으로 잡히지 않아 등록 단계에서 차단한다.
    //   (백엔드 POST 에서도 동일 규칙으로 재검증한다 — 400)
    if (isTransition) {
      const expectedWeek = SEASON_WEEKS[regSeason as SeasonToken] + 1;
      if (weekNumber !== expectedWeek) {
        const seasonLabel =
          SEASON_OPTIONS.find((o) => o.key === regSeason)?.label ?? regSeason;
        alert(`전환 주차는 ${seasonLabel} 시즌 ${expectedWeek}주차여야 합니다.`);
        return;
      }
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
          // 전환 주차도 저장 표현은 공식 활동과 동일(is_official_rest=false). 전환 여부는
          // week_number(정규 주수 +1)로 조회 시 파생되며, is_transition 은 백엔드 교차검증용.
          is_official_rest: activity === "rest",
          is_transition: isTransition,
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
      // 크루 페이지 업데이트 대상 = 방금 등록한 주차 기간(resetForm 전에 캡처).
      setLastRegistered({
        start: selectedCandidate.start,
        end: selectedCandidate.end,
      });
      setReflectTargetCount(null);
      setUpdateError(null);
      setUpdateDone(null);
      resetForm();
      // 기간 정보와 동일 원천 재조회 — 다음 중복 검증에 신규 등록분 즉시 반영.
      setRefreshTick((v) => v + 1);
    } catch {
      alert("등록 중 오류가 발생했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  // ── 크루 페이지 업데이트 ────────────────────────────────────────────────────
  // 1단계: 반영 대상 수 확인 → 2단계: 실제 반영. 기존 영향-대상 재계산 API 재사용.
  const REFLECT_API = "/api/admin/cluster4/recompute-official-rest-snapshots";

  const handleReflectCheck = async () => {
    if (!lastRegistered) return;
    setUpdateError(null);
    setUpdateDone(null);
    setUpdateBusy(true);
    try {
      const res = await fetch(REFLECT_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: lastRegistered.start,
          end_date: lastRegistered.end,
          dry_run: true,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setUpdateError(json?.error ?? "대상 확인에 실패했습니다.");
        return;
      }
      setReflectTargetCount(Number(json.data?.target_count ?? 0));
    } catch {
      setUpdateError("대상 확인 중 오류가 발생했습니다.");
    } finally {
      setUpdateBusy(false);
    }
  };

  const handleReflectRun = async () => {
    if (!lastRegistered) return;
    setUpdateError(null);
    setUpdateBusy(true);
    try {
      const res = await fetch(REFLECT_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          start_date: lastRegistered.start,
          end_date: lastRegistered.end,
          dry_run: false,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setUpdateError(json?.error ?? "크루 페이지 업데이트에 실패했습니다.");
        return;
      }
      const requested = Number(json.data?.requested ?? 0);
      const failed = Number(json.data?.failed ?? 0);
      setUpdateDone(
        `크루 페이지 업데이트가 완료되었습니다. 대상: ${requested}명` +
          (failed > 0 ? ` (반영 실패 ${failed}명)` : ""),
      );
      setReflectTargetCount(null);
    } catch {
      setUpdateError("크루 페이지 업데이트 중 오류가 발생했습니다.");
    } finally {
      setUpdateBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 상단: 페이지 제목 */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-xl font-semibold tracking-normal text-foreground">
          기간 등록
        </h1>
        <AdminHelp />
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
                  <SelectItem value={NONE}>-</SelectItem>
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
                  <SelectItem value={NONE}>-</SelectItem>
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
                  <SelectItem value={NONE}>-</SelectItem>
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
                  <SelectItem value={NONE}>-</SelectItem>
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
                  <SelectItem value={NONE}>-</SelectItem>
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
                  <SelectItem value={NONE}>-</SelectItem>
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
            <Button type="button" onClick={handleSubmit} loading={submitting}>
              <CalendarPlus className="h-4 w-4" />
              등록
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

      {/* 크루 페이지 업데이트 — 등록 직후 노출. 등록한 기간을 크루 페이지에 반영. */}
      {lastRegistered && (
        <Card className="border-sky-200 bg-sky-50/40">
          <CardContent className="flex flex-col gap-3 py-5">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                크루 페이지 업데이트
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                등록한 기간 정보를 크루 페이지에 반영합니다.
              </p>
            </div>

            {updateError && (
              <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {updateError}
              </div>
            )}

            {updateDone ? (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                {updateDone}
              </div>
            ) : reflectTargetCount == null ? (
              <div>
                <Button
                  type="button"
                  onClick={handleReflectCheck}
                  loading={updateBusy}
                >
                  <RefreshCw className="h-4 w-4" />
                  크루 페이지 업데이트
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-foreground">
                  {reflectTargetCount > 0 ? (
                    <>
                      반영 대상: <strong>{reflectTargetCount}명</strong>. 확인 후
                      ‘업데이트 실행’을 누르세요.
                    </>
                  ) : (
                    <>반영할 크루가 없습니다. 그대로 실행해도 됩니다.</>
                  )}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    onClick={handleReflectRun}
                    loading={updateBusy}
                  >
                    <RefreshCw className="h-4 w-4" />
                    업데이트 실행
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setReflectTargetCount(null)}
                    disabled={updateBusy}
                  >
                    취소
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
