"use client";

// 프로세스 체크 액트 팝업 — 상태별(needed/pending/completed) 신청/취소 UX.
//   needed   : 검수 링크 + 검수 시점 입력 → [체크 신청]. [초기화] 활성 · [체크 취소] 비활성.
//   pending  : 신청값 readonly. [체크 취소] 활성(검수 시점 전만) · 나머지 비활성.
//   completed: 모든 값 readonly · 모든 버튼 비활성(체크 크루 수 표시).
// 검수 시점 = 날짜+시간(24h, 30분), 요일 자동. now 이전/+7일 초과 불가(서버 재검증).

import { useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { DAY_NAMES } from "@/lib/practicalInfoSection0Format";
import { type ProcessHub } from "@/lib/adminProcessesTypes";
import { type ScopeMode } from "@/lib/userScopeShared";
import {
  formatCheckDateTimeKo,
  validateReviewLink,
  validateScheduledCheckAt,
  REVIEWER_RESOLUTION_LABEL,
  type ProcessCheckActRowDto,
  type ProcessCheckScopeKind,
} from "@/lib/adminProcessCheckTypes";

// 30분 단위 시간 슬롯(00:00 ~ 23:30).
const TIME_SLOTS: string[] = (() => {
  const out: string[] = [];
  for (let m = 0; m < 24 * 60; m += 30) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return out;
})();

function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 날짜(YYYY-MM-DD) → 요일 라벨.
function dowOf(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return "";
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return DAY_NAMES[d.getDay()];
}

type Banner = { kind: "error"; message: string } | null;

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words font-medium">{value}</span>
    </div>
  );
}

export default function ProcessCheckActDialog({
  act,
  hub,
  organization,
  teamId = null,
  mode = "operating",
  scope = null,
  partName = null,
  onClose,
  onDone,
}: {
  act: ProcessCheckActRowDto;
  hub: ProcessHub;
  organization: string;
  teamId?: string | null; // experience 섹션.1 선택 팀 스코프(POST team_id). info=null.
  mode?: ScopeMode; // operating=현재 주차 / test=info 13주차 예외. 저장 주차를 보드와 일치시킨다.
  // experience 팀·파트 스코프 — team_overall|part(team_all 은 읽기전용이라 팝업이 열리지 않음).
  scope?: ProcessCheckScopeKind | null;
  partName?: string | null; // part 스코프일 때 선택 파트명(user_memberships 실제 파트).
  onClose: () => void;
  onDone: () => void; // 성공 후 보드/로그/상태창 재조회
}) {
  const [reviewLink, setReviewLink] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [banner, setBanner] = useState<Banner>(null);
  const [submitting, setSubmitting] = useState(false);

  const status = act.status;
  // 팝업 오픈 시점 고정(취소 가능 판정/날짜 min·max 기준) — 렌더 중 Date.now() 호출 회피.
  const [nowMs] = useState(() => Date.now());
  const today = useMemo(() => new Date(nowMs), [nowMs]);
  const minDate = toLocalDateStr(today);
  const maxDate = useMemo(() => toLocalDateStr(new Date(today.getTime() + 7 * 86_400_000)), [today]);

  // needed: 입력 datetime ISO(없으면 null).
  const scheduledIso = useMemo(() => {
    if (!date || !time) return null;
    const d = new Date(`${date}T${time}:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }, [date, time]);

  // pending: 검수 시점 전이어야 취소 가능.
  const cancelable =
    status === "pending" &&
    (!act.scheduledCheckAt || nowMs < Date.parse(act.scheduledCheckAt));

  const reset = () => {
    setReviewLink("");
    setDate("");
    setTime("");
    setBanner(null);
  };

  const submit = async (action: "request" | "cancel") => {
    setBanner(null);
    if (action === "request") {
      const link = validateReviewLink(reviewLink);
      if (!link.ok) return setBanner({ kind: "error", message: link.error });
      if (!scheduledIso) return setBanner({ kind: "error", message: "검수 시점(날짜·시간)을 선택해주세요" });
      const sched = validateScheduledCheckAt(scheduledIso, Date.now());
      if (!sched.ok) return setBanner({ kind: "error", message: sched.error });
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/processes/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hub,
          organization,
          act_id: act.actId,
          ...(teamId ? { team_id: teamId } : {}),
          // experience 팀·파트 스코프(서버 fail-closed 가드와 동일 축). info=미부착.
          ...(scope ? { scope } : {}),
          ...(scope === "part" && partName ? { part_name: partName } : {}),
          // 운영 모드면 미부착(기존 페이로드 불변) — 서버 기본 operating.
          ...(mode === "test" ? { mode: "test" } : {}),
          action,
          ...(action === "request" ? { review_link: reviewLink.trim(), scheduled_check_at: scheduledIso } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      onDone();
      onClose();
    } catch (err) {
      setBanner({ kind: "error", message: err instanceof Error ? err.message : "처리에 실패했습니다" });
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
      <div className="w-full max-w-md rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            액트 체크 ·{" "}
            <span
              className={cn(
                status === "completed"
                  ? "text-green-700"
                  : status === "pending"
                    ? "text-purple-700"
                    : "text-amber-700",
              )}
            >
              {status === "completed" ? "체크 완료" : status === "pending" ? "체크 대기" : "체크 필요"}
            </span>
          </h2>
          <button type="button" onClick={onClose} disabled={submitting} className="hover:opacity-70">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 표시 정보(공통) */}
        <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2">
          <InfoRow label="액트명" value={act.actName} />
          <InfoRow label="소속 라인급" value={act.lineGroupName} />
        </div>

        {/* 입력/표시 — 상태별 */}
        <div className="mt-3 space-y-3">
          {status === "needed" ? (
            <>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">
                  검수 링크 <span className="text-red-500">*</span> (네이버 카페 게시물 링크)
                </label>
                <Input
                  value={reviewLink}
                  onChange={(e) => setReviewLink(e.target.value)}
                  placeholder="https://cafe.naver.com/..."
                  disabled={submitting}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">
                  검수 시점 <span className="text-red-500">*</span> (24시간 · now 이후 ~ +7일)
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={date}
                    min={minDate}
                    max={maxDate}
                    onChange={(e) => setDate(e.target.value)}
                    disabled={submitting}
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  />
                  <span className="w-8 text-center text-sm text-muted-foreground">
                    {date ? `(${dowOf(date)})` : "(–)"}
                  </span>
                  <select
                    aria-label="검수 시각"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    disabled={submitting}
                    className="h-9 rounded-md border border-input bg-background px-2 text-sm"
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
              <InfoRow label="체크 크루" value="-" />
            </>
          ) : (
            <>
              <InfoRow
                label="검수 링크"
                value={
                  act.reviewLink ? (
                    <a href={act.reviewLink} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                      {act.reviewLink}
                    </a>
                  ) : (
                    "-"
                  )
                }
              />
              <InfoRow
                label={status === "completed" ? "검수 시점" : "검수 시점"}
                value={act.scheduledCheckAt ? formatCheckDateTimeKo(act.scheduledCheckAt) : "-"}
              />
              {status === "completed" ? (
                <>
                  <InfoRow
                    label="신청 시점"
                    value={act.requestedAt ? formatCheckDateTimeKo(act.requestedAt) : "-"}
                  />
                  <InfoRow
                    label="완료 시점"
                    value={act.completedAt ? formatCheckDateTimeKo(act.completedAt) : "-"}
                  />
                  <InfoRow label="체크 크루 수" value={act.checkedCrewCount ?? "-"} />
                </>
              ) : (
                <InfoRow label="체크 크루" value="-" />
              )}
            </>
          )}
        </div>

        {/* 검수 크루 식별 진단(테스트/관리자용) — "검수 크루 0명"의 원인 분리. needed 는 의미 없음(생략). */}
        {status !== "needed" && act.reviewerDebug && (
          <div className="mt-3 rounded-md border border-dashed border-muted-foreground/30 bg-muted/20 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            <p className="font-semibold">검수 진단</p>
            <p>
              원인: <span className="font-medium text-foreground">{REVIEWER_RESOLUTION_LABEL[act.reviewerDebug.resolutionStatus]}</span>
              {" · "}식별 닉네임 {act.reviewerDebug.crawledCommentCount} · 매칭 {act.reviewerDebug.matchedCrewCount} · 미매칭 {act.reviewerDebug.unmatchedCommentAuthors.length}
            </p>
            {act.reviewerDebug.attemptCount > 0 && (
              <p>worker 시도 {act.reviewerDebug.attemptCount}회{act.reviewerDebug.lastError ? ` · 오류: ${act.reviewerDebug.lastError}` : ""}</p>
            )}
          </div>
        )}

        {banner && (
          <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {banner.message}
          </p>
        )}

        {/* 버튼 — 상태별 활성/비활성 */}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={status !== "needed" || submitting}
            onClick={reset}
          >
            초기화
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={status !== "needed" || submitting}
            onClick={() => void submit("request")}
          >
            {submitting && status === "needed" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            체크 신청
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-rose-300 text-rose-700 hover:bg-rose-50"
            disabled={!cancelable || submitting}
            onClick={() => void submit("cancel")}
          >
            {submitting && status === "pending" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            체크 취소
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={onClose}>
            닫기
          </Button>
        </div>
        {status === "pending" && !cancelable && (
          <p className="mt-2 text-right text-[11px] text-amber-700">
            검수 시점이 지나 취소할 수 없습니다.
          </p>
        )}
      </div>
    </div>
  );
}
