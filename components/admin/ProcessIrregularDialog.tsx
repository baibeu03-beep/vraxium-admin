"use client";

// 변동 액트 검수 링크 신청 팝업 — 전원([전원] 버튼) / 부분([부분]>검수 링크) 공용.
//   액트명 + 소요시간(5~90·5단위) + 사유(≤50) + 포인트 A/B/C + 액트 종류(고정·전원|부분)
//   + 검수 링크(필수) + 검수 시점(필수). 제출 → review_request(체크 대기) 생성.
//   검수 시점이 지나면 보드에서 자동으로 '체크 완료' 표시(조회 시점 파생·DB write 없음).
//   ⚠ 카페는 입력하지 않는다(kind 파생 표시값). org+mode 분리는 서버가 scope_mode 로 각인.

import { useMemo, useState } from "react";
import { X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CONFIRM, useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { DAY_NAMES } from "@/lib/practicalInfoSection0Format";
import { type ScopeMode } from "@/lib/userScopeShared";
import { IrregularPointFields, derivePartialPointMode } from "@/components/admin/IrregularPointFields";
import {
  IRREGULAR_CREW_REACTION_LABEL,
  formatCheckDateTimeKo,
  validateReviewLink,
  validateScheduledCheckAt,
  type IrregularCrewReaction,
} from "@/lib/adminProcessIrregularTypes";

const TIME_SLOTS: string[] = (() => {
  const out: string[] = [];
  for (let m = 0; m < 24 * 60; m += 30) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return out;
})();
const DURATIONS = Array.from({ length: 18 }, (_, i) => (i + 1) * 5); // 5~90, 5분 단위
const REASON_MAX = 50;

function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dowOf(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return "";
  return DAY_NAMES[new Date(+m[1], +m[2] - 1, +m[3]).getDay()];
}

export default function ProcessIrregularDialog({
  crewReaction,
  organization,
  mode,
  weekId = null,
  onClose,
  onDone,
}: {
  // 액트 종류 고정 — [전원]=all / [부분]>검수 링크=partial. 다이얼로그 내 변경 불가.
  crewReaction: IrregularCrewReaction;
  organization: string;
  mode: ScopeMode;
  // 선택 주차(weeks.id) — 예외 허용 주차에 생성 시 보드와 동일 주차로 write. 미부착=현재 주차.
  weekId?: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const isAll = crewReaction === "all";

  const [actName, setActName] = useState("");
  const [duration, setDuration] = useState("");
  const [reason, setReason] = useState("");
  const [pointA, setPointA] = useState(0);
  const [pointB, setPointB] = useState(0);
  const [pointC, setPointC] = useState(0);
  const [reviewLink, setReviewLink] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");

  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const confirm = useConfirm();

  const dirty =
    actName.trim() !== "" ||
    duration.trim() !== "" ||
    reason.trim() !== "" ||
    pointA !== 0 ||
    pointB !== 0 ||
    pointC !== 0 ||
    reviewLink.trim() !== "" ||
    date !== "" ||
    time !== "";

  const handleClose = async () => {
    if (submitting) return;
    if (dirty && !(await confirm(CONFIRM.close))) return;
    onClose();
  };

  const [nowMs] = useState(() => Date.now());
  const today = useMemo(() => new Date(nowMs), [nowMs]);
  const minDate = toLocalDateStr(today);
  const maxDate = useMemo(() => toLocalDateStr(new Date(today.getTime() + 7 * 86_400_000)), [today]);

  const scheduledIso = useMemo(() => {
    if (!date || !time) return null;
    const d = new Date(`${date}T${time}:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }, [date, time]);

  const reset = async () => {
    if (!(await confirm(CONFIRM.reset))) return;
    setActName("");
    setDuration("");
    setReason("");
    setPointA(0);
    setPointB(0);
    setPointC(0);
    setReviewLink("");
    setDate("");
    setTime("");
    setBanner(null);
  };

  const submit = async () => {
    setBanner(null);
    if (!actName.trim()) return setBanner("액트명을 입력해주세요");
    const link = validateReviewLink(reviewLink);
    if (!link.ok) return setBanner(link.error);
    if (!scheduledIso) return setBanner("검수 시점(날짜·시간)을 선택해주세요");
    const sched = validateScheduledCheckAt(scheduledIso, Date.now());
    if (!sched.ok) return setBanner(sched.error);
    if (!(await confirm({ ...CONFIRM.complete, confirmLabel: "체크 신청" }))) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/processes/check/irregular", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization,
          ...(mode === "test" ? { mode: "test" } : {}),
          ...(weekId ? { week: weekId } : {}),
          kind: "review_request",
          act_name: actName.trim(),
          duration_minutes: duration.trim() ? Number(duration) : null,
          reason: reason.trim() || null,
          point_a: pointA,
          point_b: pointB,
          point_c: pointC,
          crew_reaction: crewReaction,
          // 부분만 포인트 방식(ab|c) 전달 — 값에서 파생. 전원은 서버가 무시.
          ...(isAll ? {} : { point_mode: derivePartialPointMode(pointC) }),
          review_link: reviewLink.trim(),
          scheduled_check_at: scheduledIso,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      onDone();
      onClose();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "처리에 실패했습니다");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) void handleClose();
      }}
    >
      <div className="max-h-[90vh] modal-w-lg overflow-y-auto rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            변동 액트 · <span className="text-purple-700">링크 신청</span>
            <span
              className={cn(
                "ml-2 rounded border px-1.5 py-0.5 text-xs font-medium",
                isAll ? "border-blue-300 bg-blue-50 text-blue-700" : "border-orange-300 bg-orange-50 text-orange-700",
              )}
            >
              {IRREGULAR_CREW_REACTION_LABEL[crewReaction]}
            </span>
          </h2>
          <button type="button" onClick={() => void handleClose()} disabled={submitting} className="hover:opacity-70">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          {/* 액트명 */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              액트명(변동) <span className="text-red-500">*</span>
            </label>
            <Input
              value={actName}
              onChange={(e) => setActName(e.target.value)}
              placeholder="변동 액트명"
              maxLength={60}
              disabled={submitting}
            />
          </div>

          {/* 소요 시간 + 액트 종류(고정) */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">소요 시간(분)</label>
              <select
                aria-label="소요 시간"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                disabled={submitting}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">선택</option>
                {DURATIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}분
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">액트 종류</label>
              <div
                aria-label="액트 종류"
                className="flex h-9 cursor-not-allowed items-center rounded-md border border-input bg-muted/50 px-2 text-sm text-muted-foreground"
                title="액트 종류는 선택한 버튼으로 고정됩니다"
              >
                {IRREGULAR_CREW_REACTION_LABEL[crewReaction]} (고정)
              </div>
            </div>
          </div>

          {/* 사유 (최대 50자) */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              액트 신청 사유 <span className="text-muted-foreground">({reason.length}/{REASON_MAX})</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
              rows={2}
              maxLength={REASON_MAX}
              placeholder="선택"
              disabled={submitting}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>

          {/* 포인트 — 전원=A/B/C 자유 / 부분=A+B 또는 C 택1(X 초기화) */}
          <IrregularPointFields
            crewReaction={crewReaction}
            pointA={pointA}
            setPointA={setPointA}
            pointB={pointB}
            setPointB={setPointB}
            pointC={pointC}
            setPointC={setPointC}
            disabled={submitting}
            orgSlug={organization}
          />

          {/* 링크 (필수) */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              링크 <span className="text-red-500">*</span>
            </label>
            <Input
              value={reviewLink}
              onChange={(e) => setReviewLink(e.target.value)}
              placeholder="https://cafe.naver.com/..."
              disabled={submitting}
            />
          </div>

          {/* 검수 시점 (필수) */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              검수 시점 <span className="text-red-500">*</span>
            </label>
            <div className="flex flex-nowrap items-center gap-2 overflow-x-auto">
              <input
                type="date"
                value={date}
                min={minDate}
                max={maxDate}
                onChange={(e) => setDate(e.target.value)}
                disabled={submitting}
                className="h-9 min-w-[9rem] shrink-0 rounded-md border border-input bg-background px-2 text-sm"
              />
              <span className="w-9 shrink-0 whitespace-nowrap text-center text-sm text-muted-foreground">
                {date ? `(${dowOf(date)})` : "(–)"}
              </span>
              <select
                aria-label="검수 시각"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                disabled={submitting}
                className="h-9 min-w-[5.5rem] shrink-0 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">시간</option>
                {TIME_SLOTS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            {scheduledIso && (
              <p className="text-[11px] text-muted-foreground">→ {formatCheckDateTimeKo(scheduledIso)}</p>
            )}
          </div>

          <p className="rounded-md border border-purple-200 bg-purple-50 px-3 py-2 text-[11px] text-purple-700">
            링크 신청 후 ‘체크 대기’ 상태가 되며, 검수 시점이 지나면 자동으로 ‘체크 완료’ 됩니다.
          </p>
        </div>

        {banner && (
          <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {banner}
          </p>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={() => void reset()}>
            초기화
          </Button>
          <Button type="button" size="sm" loading={submitting} onClick={() => void submit()}>
            <Check className="mr-1.5 h-3.5 w-3.5" />
            체크 신청
          </Button>
          {/* 신청 전 단계의 '체크 취소' = 팝업 닫기(단순 취소). 신청 후 실제 취소는 상세 모달에서. */}
          <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={() => void handleClose()}>
            체크 취소
          </Button>
        </div>
      </div>
    </div>
  );
}
