"use client";

import { useCallback, useState } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IrregularPointFields } from "@/components/admin/IrregularPointFields";
import { type ScopeMode } from "@/lib/userScopeShared";
import type { CrewWeekActDetailDto } from "@/lib/adminCrewWeekActDetail";

// 액트 보완 모달 — 특정 크루·특정 주차에 변동·부분·즉시 체크 완료 액트 1건 생성.
//   대상 크루/주차는 URL(userId+weekId)로 고정 — 크루 검색·주차 선택·소요시간·종류 입력 없음.
//   포인트 A/B⇄C 상호 잠금·조직 라벨은 공용 IrregularPointFields 재사용(서버 normalizeIrregularPoints 가 SoT).

const ACT_NAME_MAX = 20;
const REASON_MAX = 50;

export default function ActSupplementDialog({
  userId,
  weekId,
  mode,
  orgSlug,
  weekLabel,
  onClose,
  onDone,
}: {
  userId: string;
  weekId: string;
  mode: ScopeMode;
  orgSlug: string | null;
  weekLabel: string;
  onClose: () => void;
  onDone: (weekDetail: CrewWeekActDetailDto | null) => void;
}) {
  const [actName, setActName] = useState("");
  const [reason, setReason] = useState("");
  const [pointA, setPointA] = useState(0);
  const [pointB, setPointB] = useState(0);
  const [pointC, setPointC] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasPoint = pointA > 0 || pointB > 0 || pointC > 0;
  const canSubmit = actName.trim().length > 0 && hasPoint && !submitting;

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/members/${userId}/weeks/${weekId}/acts/supplement`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actName: actName.trim(), reason: reason.trim() || null, pointA, pointB, pointC, mode }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "액트 보완에 실패했습니다.");
      }
      onDone((json.data?.weekDetail ?? null) as CrewWeekActDetailDto | null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "액트 보완에 실패했습니다.");
    } finally {
      setSubmitting(false);
    }
  }, [userId, weekId, actName, reason, pointA, pointB, pointC, mode, onDone, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="modal-w-lg max-h-[92vh] overflow-y-auto rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-base font-semibold">액트 보완</h2>
          <button type="button" onClick={onClose} disabled={submitting} className="hover:opacity-70">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-4 text-xs text-muted-foreground">{weekLabel}</p>

        <div className="space-y-4">
          {/* 액트명 */}
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span className="flex items-center justify-between">
              <span>
                액트명 <span className="text-red-500">*</span>
              </span>
              <span>{actName.length}/{ACT_NAME_MAX}</span>
            </span>
            <input
              value={actName}
              onChange={(e) => setActName(e.target.value.slice(0, ACT_NAME_MAX))}
              maxLength={ACT_NAME_MAX}
              disabled={submitting}
              placeholder="보완 액트명"
              className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground"
            />
          </label>

          {/* 사유 */}
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span className="flex items-center justify-between">
              <span>액트 보완 사유</span>
              <span>{reason.length}/{REASON_MAX}</span>
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
              maxLength={REASON_MAX}
              rows={3}
              disabled={submitting}
              placeholder="선택"
              className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground"
            />
          </label>

          {/* 포인트 A/B/C — 부분 액트 상호 잠금(공용 컴포넌트) */}
          <IrregularPointFields
            crewReaction="partial"
            pointA={pointA}
            setPointA={setPointA}
            pointB={pointB}
            setPointB={setPointB}
            pointC={pointC}
            setPointC={setPointC}
            disabled={submitting}
            orgSlug={orgSlug}
          />

          <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
            액트 보완 시 즉시 체크 완료 처리되며 포인트와 주차 집계에 반영됩니다.
          </p>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={onClose}>
            취소
          </Button>
          <Button type="button" size="sm" loading={submitting} disabled={!canSubmit} onClick={submit}>
            <Check className="h-4 w-4" />
            액트 보완
          </Button>
        </div>
      </div>
    </div>
  );
}
