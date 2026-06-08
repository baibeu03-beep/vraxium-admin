"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Check } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { readOrgParam } from "@/lib/adminOrgContext";
import {
  formatBannerPeriod,
  formatToday,
} from "@/lib/practicalInfoSection0Format";

// 실무 정보 라인 개설 [섹션 0] — 상황 통제 영역.
//   (1) 상태창: 오늘/이번 주 + 지난 주(개설 대상 N-1) 라인 개설 필요/완료 안내.
//   (2) 개설/검수 기록: 라인별 어드민 메모(opening_review_note). 스냅샷 무관 전용 엔드포인트.
// '지난 주' = 기존 개설 대상 주차(isOpenTarget / describeOpenableWeek) 재사용 — 별도 날짜 경계 없음.

const INITIAL_RECORD_TEXT = "아직 '라인' 을 개설하지 못했습니다.";
const DEFAULT_RECORD_TEXT =
  "라인 개설 시 별다른 이상 사항이 없었으며, 예상 시간 내에 완벽히 종료되었습니다.";

type WeekLike = {
  id?: string | null;
  year: number;
  seasonName: string;
  weekNumber: number;
  isOfficialRest?: boolean;
};

type ActivityTypeLike = { id: string; name: string };

type Props = {
  // 이번 주(N) — currentWeek DTO.
  currentWeek: WeekLike | null;
  // 지난 주(개설 대상 N-1) — weekOptions.find(isOpenTarget).
  openableWeek: WeekLike | null;
  // 현재 선택된 활동 유형(위즈덤/에세이/…).
  activeType: ActivityTypeLike | null;
};

export default function PracticalInfoOpeningSection0({
  currentWeek,
  openableWeek,
  activeType,
}: Props) {
  // 지난 주 + 활동유형에 대한 활성 info 라인(개설됨 판정 + note 대상).
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [loadingLine, setLoadingLine] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openableWeekId = openableWeek?.id ?? null;
  const activeTypeId = activeType?.id ?? null;

  // 지난 주(개설 대상) + 활동유형의 활성 라인 + note 를 조회한다.
  const loadLine = useCallback(async () => {
    setEditing(false);
    setError(null);
    if (!openableWeekId || !activeTypeId) {
      setActiveLineId(null);
      setNote(null);
      return;
    }
    setLoadingLine(true);
    try {
      const qs = new URLSearchParams({
        week_id: openableWeekId,
        activity_type_id: activeTypeId,
      });
      // org 컨텍스트(?org) → organization 변환. info 는 common 이라 전 조직 동일 노출(정책 유지).
      const org = readOrgParam(new URLSearchParams(window.location.search));
      if (org) qs.set("organization", org);
      const res = await fetch(`/api/admin/cluster4/info-lines?${qs.toString()}`);
      const json = await res.json();
      const rows: Array<{ id: string; isActive: boolean }> = json?.success
        ? json.data?.rows ?? []
        : [];
      const active = rows.find((r) => r.isActive) ?? null;
      setActiveLineId(active?.id ?? null);
      if (active?.id) {
        // 개설된 라인의 개설/검수 기록(note) 조회. 실패해도 기본 문구 표시로 폴백.
        try {
          const noteRes = await fetch(
            `/api/admin/cluster4/lines/${active.id}/opening-note`,
          );
          const noteJson = await noteRes.json();
          setNote(noteJson?.success ? noteJson.data?.note ?? null : null);
        } catch {
          setNote(null);
        }
      } else {
        setNote(null);
      }
    } catch {
      setActiveLineId(null);
      setNote(null);
      setError("라인 상태를 불러오지 못했습니다");
    } finally {
      setLoadingLine(false);
    }
  }, [openableWeekId, activeTypeId]);

  useEffect(() => {
    loadLine();
  }, [loadLine]);

  const opened = activeLineId != null;

  // 개설/검수 기록 표시값: 초기(미개설) / 개설 후(note ?? 기본문구) / 수정 중(draft).
  const recordValue = editing
    ? draft
    : opened
      ? note ?? DEFAULT_RECORD_TEXT
      : INITIAL_RECORD_TEXT;

  const startEdit = () => {
    setDraft(note ?? DEFAULT_RECORD_TEXT);
    setEditing(true);
    setError(null);
  };

  const confirmEdit = useCallback(async () => {
    if (!activeLineId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/cluster4/lines/${activeLineId}/opening-note`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: draft }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? `HTTP ${res.status}`);
      }
      setNote(json.data?.note ?? null);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장에 실패했습니다");
    } finally {
      setSaving(false);
    }
  }, [activeLineId, draft]);

  const activityName = activeType?.name ?? "해당";
  const lastWeekLabel = openableWeek ? formatBannerPeriod(openableWeek) : null;
  const thisWeekLabel = currentWeek ? formatBannerPeriod(currentWeek) : null;

  return (
    <div className="space-y-4">
      {/* ── 상태창 ── */}
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
            <span className="font-semibold">
              [{thisWeekLabel ?? "—"}]
            </span>{" "}
            입니다. (월 ~ 일)
          </p>

          {/* 문구2: 지난 주(개설 대상) 라인 개설 필요/완료 */}
          {lastWeekLabel ? (
            loadingLine ? (
              <p className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 지난 주 라인 상태
                확인 중…
              </p>
            ) : opened ? (
              <p className="rounded-md border border-green-300 bg-green-50 px-3 py-2 text-green-800">
                지난 주 <span className="font-semibold">[{lastWeekLabel}]</span> 의{" "}
                {activityName} 라인이 ‘개설’ 되어, 크루 기입이 가능합니다.
              </p>
            ) : (
              <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800">
                지난 주 <span className="font-semibold">[{lastWeekLabel}]</span> 의{" "}
                {activityName} 라인이 ‘개설’ 되어야 합니다.
                {openableWeek?.isOfficialRest && (
                  <span className="ml-1 text-amber-600">(공식 휴식 주차)</span>
                )}
              </p>
            )
          ) : (
            <p className="text-muted-foreground">
              지난 주(개설 대상) 주차 정보를 확인할 수 없습니다.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── 개설/검수 기록 ── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
          <CardTitle className="text-base">개설/검수 기록</CardTitle>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={startEdit}
              disabled={!opened || editing || saving}
            >
              <Pencil className="mr-1.5 h-3.5 w-3.5" /> 수정
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={confirmEdit}
              disabled={!editing || saving}
            >
              {saving ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="mr-1.5 h-3.5 w-3.5" />
              )}
              확인
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <textarea
            value={recordValue}
            onChange={(e) => setDraft(e.target.value)}
            disabled={!editing}
            rows={3}
            className={cn(
              "w-full resize-none rounded-md border px-3 py-2 text-sm",
              editing
                ? "border-input bg-background text-foreground"
                : "border-input bg-muted/40 text-muted-foreground",
            )}
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
        </CardContent>
      </Card>

      {/* ── 그 아래 영역(실제 개설 폼/로그/버튼)은 후속 — 준비 중 placeholder ── */}
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          이 아래 라인 개설 영역은 준비 중입니다.
        </CardContent>
      </Card>
    </div>
  );
}
