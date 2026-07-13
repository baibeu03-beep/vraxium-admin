"use client";

// 검수 링크(review_request) 상세 — 정규 프로세스 체크 UX.
//   pending  : 입력값 readonly(비활성) · [체크 취소]만 활성(신청 삭제).
//   completed: 입력값 readonly + 자동 검수 결과(식별 크루) 표시 · 취소 불가.
// ⚠ user_weekly_points·snapshot 무접촉 — point_a/b/c·식별 결과는 관리 기록.

import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CONFIRM, useConfirm } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { type ScopeMode } from "@/lib/userScopeShared";
import {
  IRREGULAR_CREW_REACTION_LABEL,
  IRREGULAR_STATUS_LABEL,
  formatCheckDateTimeKo,
  irregularStatusClass,
  type ProcessIrregularActRowDto,
} from "@/lib/adminProcessIrregularTypes";
import { getProcessPointLabels } from "@/lib/pointLabels";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words font-medium">{value}</span>
    </div>
  );
}

export default function ProcessIrregularReviewDetail({
  act,
  organization,
  mode,
  editable = true,
  onClose,
  onDone,
}: {
  act: ProcessIrregularActRowDto;
  organization: string;
  mode: ScopeMode;
  // 현재 주차(편집 가능)일 때만 체크 취소/삭제 허용. 과거 주차 = 조회 전용.
  editable?: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const confirm = useConfirm();
  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const isReview = act.kind === "review_request";
  const po = getProcessPointLabels(organization);
  // 체크 취소(=신청 삭제)는 현재 주차 · 검수 링크 · pending(검수 시점 전) 일 때만.
  //   수동 부여/완료/과거 주차는 취소 불가.
  const cancelable = editable && isReview && act.status === "pending";

  // 체크 취소 = 신청 삭제(pending 에서만). 완료 후에는 취소 불가.
  //   호출 측에서 한 번 더 확인을 끝낸 뒤 실제 DELETE 만 수행.
  const cancel = async () => {
    setBanner(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/processes/check/irregular", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: act.id, organization, ...(mode === "test" ? { mode: "test" } : {}) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      onDone();
      onClose();
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "체크 취소에 실패했습니다");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="max-h-[90vh] modal-w-lg overflow-y-auto rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {act.kindLabel} ·{" "}
            <span
              className={cn(
                "rounded border px-1.5 py-0.5 text-xs",
                irregularStatusClass(act.status),
              )}
            >
              {IRREGULAR_STATUS_LABEL[act.status]}
            </span>
          </h2>
          <button type="button" onClick={onClose} disabled={submitting} className="hover:opacity-70">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 입력값 — readonly(비활성) */}
        <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2.5">
          <Row label="액트명" value={act.actName} />
          <Row label="카페" value={act.cafeLabel} />
          <Row label="신청자" value={act.applicantAdminName} />
          <Row label="소요 시간" value={act.durationMinutes != null ? `${act.durationMinutes}분` : "—"} />
          <Row label="사유" value={act.reason || "—"} />
          <Row
            label={`${po.a} / ${po.b} / ${po.c}`}
            value={`${act.pointA} / ${act.pointB} / ${act.pointC}`}
          />
          <Row label="액트 종류" value={IRREGULAR_CREW_REACTION_LABEL[act.crewReaction]} />
          <Row
            label="링크"
            value={
              act.reviewLink ? (
                <a href={act.reviewLink} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                  {act.reviewLink}
                </a>
              ) : (
                "—"
              )
            }
          />
          <Row
            label="검수 시점"
            value={act.scheduledCheckAt ? formatCheckDateTimeKo(act.scheduledCheckAt) : "—"}
          />
          {act.status === "completed" && (
            <Row label="완료 시점" value={act.completedAt ? formatCheckDateTimeKo(act.completedAt) : "—"} />
          )}
        </div>

        {/* 자동 검수 결과 — 완료 후 식별 크루 */}
        {act.status === "completed" && (
          <div className="mt-3 rounded-md border px-3 py-2.5">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              {isReview ? `자동 검수 결과 · 식별 크루 ${act.matchedCount}명` : `대상 크루 ${act.matchedCount}명`}
            </p>
            {act.recipients.length === 0 ? (
              <p className="text-xs text-muted-foreground">식별된 크루가 없습니다.</p>
            ) : (
              <ul className="space-y-0.5 text-sm">
                {act.recipients.map((r, i) => (
                  <li key={`${r.nickname}-${i}`} className="flex items-center gap-2">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[11px]",
                        r.matchType === "matched"
                          ? "bg-green-100 text-green-800"
                          : "bg-amber-100 text-amber-800",
                      )}
                    >
                      {r.matchType === "matched" ? "매칭" : "수동확인"}
                    </span>
                    <span>{r.nickname}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {act.lastError && cancelable && (
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            자동 검수 시도 {act.attemptCount}회 실패: {act.lastError}
          </p>
        )}

        {banner && (
          <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {banner}
          </p>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          {isReview ? (
            // 검수 링크 — pending 에서만 체크 취소(=신청 삭제).
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-rose-300 text-rose-700 hover:bg-rose-50"
              loading={submitting}
              disabled={!cancelable}
              onClick={() =>
                void (async () => {
                  // 체크 취소(=신청 삭제) — 한 번 더 확인.
                  const ok = await confirm({
                    title: "취소",
                    description: "이 동작을 취소 처리합니다. 진행하시겠습니까?",
                    confirmLabel: "체크 취소",
                    tone: "destructive",
                  });
                  if (!ok) return;
                  await cancel();
                })()
              }
            >
              체크 취소
            </Button>
          ) : (
            // 수동 부여 — 관리용 삭제(완료 상태·취소 개념 없음). 과거 주차는 비활성.
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-rose-300 text-rose-700 hover:bg-rose-50"
              loading={submitting}
              disabled={!editable}
              onClick={() =>
                void (async () => {
                  // 수동 입력 관리용 삭제 — 한 번 더 확인.
                  const ok = await confirm(CONFIRM.delete);
                  if (!ok) return;
                  await cancel();
                })()
              }
            >
              삭제
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={onClose}>
            닫기
          </Button>
        </div>
        {isReview && !cancelable && (
          <p className="mt-2 text-right text-xs text-muted-foreground">
            {!editable
              ? "과거 주차는 조회 전용입니다(체크 취소 불가)."
              : "검수 시점이 지났거나 완료된 신청은 취소할 수 없습니다."}
          </p>
        )}
      </div>
    </div>
  );
}
