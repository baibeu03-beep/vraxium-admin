"use client";

// 변동 액트 생성 팝업 — 검수 신청 / 수동 부여 공용.
//   대상자(고객) 검색·선택 + 액트명 + 소요시간 + 사유 + 포인트 A/B/C + 액트 종류 + 검수 링크/시점.
//   검수 신청 → 검수 링크·시점 필수(pending). 수동 부여 → 검수 링크·시점 선택(즉시 completed).
//   ⚠ 카페는 입력하지 않는다(kind 파생 표시값). org+mode 분리는 대상자(target) 기준(서버 재검증).

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CONFIRM, useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { DAY_NAMES } from "@/lib/practicalInfoSection0Format";
import { type ScopeMode, appendModeQuery } from "@/lib/userScopeShared";
import { IrregularPointFields } from "@/components/admin/IrregularPointFields";
import {
  IRREGULAR_CREW_REACTIONS,
  IRREGULAR_CREW_REACTION_DEFAULT,
  IRREGULAR_CREW_REACTION_LABEL,
  IRREGULAR_KIND_LABEL,
  IRREGULAR_POINT_MODE_DEFAULT,
  formatCheckDateTimeKo,
  irregularCafeLabel,
  validateReviewLink,
  validateScheduledCheckAt,
  type IrregularCrewReaction,
  type IrregularKind,
  type IrregularPointMode,
  type IrregularTargetUserDto,
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
  kind,
  organization,
  mode,
  onClose,
  onDone,
}: {
  kind: IrregularKind;
  organization: string;
  mode: ScopeMode;
  onClose: () => void;
  onDone: () => void;
}) {
  const isReview = kind === "review_request";

  const [target, setTarget] = useState<IrregularTargetUserDto | null>(null);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<IrregularTargetUserDto[]>([]);
  const [searching, setSearching] = useState(false);

  const [actName, setActName] = useState("");
  const [duration, setDuration] = useState("");
  const [reason, setReason] = useState("");
  const [pointA, setPointA] = useState(0);
  const [pointB, setPointB] = useState(0);
  const [pointC, setPointC] = useState(0);
  const [crewReaction, setCrewReaction] = useState<IrregularCrewReaction>(IRREGULAR_CREW_REACTION_DEFAULT);
  const [pointMode, setPointMode] = useState<IrregularPointMode>(IRREGULAR_POINT_MODE_DEFAULT);
  const [reviewLink, setReviewLink] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");

  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const confirm = useConfirm();

  // 입력값이 하나라도 있으면 dirty(닫기 시 확인 문구 노출 판단).
  const dirty =
    target !== null ||
    q.trim() !== "" ||
    actName.trim() !== "" ||
    duration.trim() !== "" ||
    reason.trim() !== "" ||
    pointA !== 0 ||
    pointB !== 0 ||
    pointC !== 0 ||
    crewReaction !== IRREGULAR_CREW_REACTION_DEFAULT ||
    pointMode !== IRREGULAR_POINT_MODE_DEFAULT ||
    reviewLink.trim() !== "" ||
    date !== "" ||
    time !== "";

  // 닫기 — 입력값이 있을 때만 확인.
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

  // 대상자 검색(디바운스). 선택된 대상이 있으면 검색 중단.
  const searchReq = useRef(0);
  useEffect(() => {
    if (target) return;
    const term = q.trim();
    if (!term) {
      setResults([]);
      return;
    }
    const myReq = ++searchReq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          appendModeQuery(
            `/api/admin/processes/check/irregular/targets?org=${encodeURIComponent(organization)}&q=${encodeURIComponent(term)}`,
            mode,
          ),
        );
        const json = await res.json().catch(() => ({}));
        if (myReq !== searchReq.current) return;
        setResults(res.ok && json.success ? (json.data as IrregularTargetUserDto[]) : []);
      } finally {
        if (myReq === searchReq.current) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, target, organization, mode]);

  const reset = async () => {
    if (!(await confirm(CONFIRM.reset))) return;
    setActName("");
    setDuration("");
    setReason("");
    setPointA(0);
    setPointB(0);
    setPointC(0);
    setCrewReaction(IRREGULAR_CREW_REACTION_DEFAULT);
    setPointMode(IRREGULAR_POINT_MODE_DEFAULT);
    setReviewLink("");
    setDate("");
    setTime("");
    if (isReview) {
      setTarget(null);
      setQ("");
    }
    setBanner(null);
  };

  const submit = async () => {
    setBanner(null);
    // 대상자 — 수동 부여만 필수(검수 신청은 크롤링으로 사후 식별).
    if (!isReview && !target) return setBanner("대상자(고객)를 선택해주세요");
    if (!actName.trim()) return setBanner("액트명을 입력해주세요");
    if (isReview) {
      const link = validateReviewLink(reviewLink);
      if (!link.ok) return setBanner(link.error);
      if (!scheduledIso) return setBanner("검수 시점(날짜·시간)을 선택해주세요");
      const sched = validateScheduledCheckAt(scheduledIso, Date.now());
      if (!sched.ok) return setBanner(sched.error);
    } else if (reviewLink.trim()) {
      const link = validateReviewLink(reviewLink);
      if (!link.ok) return setBanner(link.error);
    }
    // 한 번 더 확인 — 검수 신청/수동 부여 라벨 분기.
    if (!(await confirm({ ...CONFIRM.complete, confirmLabel: isReview ? "검수 신청 완료" : "수동 부여 완료" }))) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/processes/check/irregular", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization,
          ...(mode === "test" ? { mode: "test" } : {}),
          kind,
          act_name: actName.trim(),
          ...(target ? { target_user_id: target.userId } : {}),
          duration_minutes: duration.trim() ? Number(duration) : null,
          reason: reason.trim() || null,
          point_a: pointA,
          point_b: pointB,
          point_c: pointC,
          crew_reaction: crewReaction,
          point_mode: pointMode,
          ...(reviewLink.trim() ? { review_link: reviewLink.trim() } : {}),
          ...(scheduledIso ? { scheduled_check_at: scheduledIso } : {}),
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
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            변동 액트 ·{" "}
            <span className={cn(isReview ? "text-purple-700" : "text-green-700")}>
              {IRREGULAR_KIND_LABEL[kind]}
            </span>
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              (카페: {irregularCafeLabel(kind)} · 자동)
            </span>
          </h2>
          <button type="button" onClick={() => void handleClose()} disabled={submitting} className="hover:opacity-70">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          {/* 대상자 — 수동 부여만(단일 대상). 검수 신청은 검수 시점에 크롤링으로 크루를 식별. */}
          {isReview ? (
            <div className="rounded-md border border-purple-200 bg-purple-50 px-3 py-2 text-[11px] text-purple-700">
              검수 신청은 대상자를 미리 선택하지 않습니다. 검수 시점이 도래하면 검수 링크의 댓글을
              크롤링해 반응한 크루를 자동 식별합니다.
            </div>
          ) : (
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              대상자(고객) <span className="text-red-500">*</span>
            </label>
            {target ? (
              <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{target.displayName}</span>{" "}
                  <span className="text-muted-foreground">
                    {target.authEmail || target.contactEmail || target.userId}
                  </span>
                </span>
                <button
                  type="button"
                  className="text-xs text-rose-600 hover:underline"
                  onClick={() => {
                    setTarget(null);
                    setQ("");
                  }}
                  disabled={submitting}
                >
                  변경
                </button>
              </div>
            ) : (
              <div className="relative">
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="이름·이메일로 검색"
                  disabled={submitting}
                />
                {(searching || results.length > 0) && q.trim() && (
                  <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-card shadow-lg">
                    {searching ? (
                      <p className="px-3 py-2 text-xs text-muted-foreground">검색 중…</p>
                    ) : results.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-muted-foreground">
                        스코프 내 검색 결과가 없습니다.
                      </p>
                    ) : (
                      results.map((u) => (
                        <button
                          key={u.userId}
                          type="button"
                          onClick={() => {
                            setTarget(u);
                            setResults([]);
                          }}
                          className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted"
                        >
                          <span>
                            <span className="font-medium">{u.displayName}</span>{" "}
                            <span className="text-muted-foreground">{u.authEmail || u.contactEmail}</span>
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          )}

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

          {/* 소요 시간 + 액트 종류 */}
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
              <select
                aria-label="액트 종류"
                value={crewReaction}
                onChange={(e) => setCrewReaction(e.target.value as IrregularCrewReaction)}
                disabled={submitting}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {IRREGULAR_CREW_REACTIONS.map((c) => (
                  <option key={c} value={c}>
                    {IRREGULAR_CREW_REACTION_LABEL[c]}
                  </option>
                ))}
              </select>
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

          {/* 포인트 — 전원=A/B/C 자유 / 부분=포인트 방식(A+B|C) 택1 + 비활성·안내문 */}
          <IrregularPointFields
            crewReaction={crewReaction}
            pointMode={pointMode}
            setPointMode={setPointMode}
            pointA={pointA}
            setPointA={setPointA}
            pointB={pointB}
            setPointB={setPointB}
            pointC={pointC}
            setPointC={setPointC}
            disabled={submitting}
          />

          {/* 검수 링크 */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              검수 링크 {isReview && <span className="text-red-500">*</span>}
              {!isReview && <span className="text-muted-foreground"> (선택)</span>}
            </label>
            <Input
              value={reviewLink}
              onChange={(e) => setReviewLink(e.target.value)}
              placeholder="https://cafe.naver.com/..."
              disabled={submitting}
            />
          </div>

          {/* 검수 시점 */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              검수 시점 {isReview && <span className="text-red-500">*</span>}
              {!isReview && <span className="text-muted-foreground"> (선택)</span>}
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

          <p
            className={cn(
              "rounded-md border px-3 py-2 text-[11px]",
              isReview
                ? "border-purple-200 bg-purple-50 text-purple-700"
                : "border-green-200 bg-green-50 text-green-700",
            )}
          >
            {isReview
              ? "검수 신청 후 ‘체크 대기’ 상태가 되며, 검수 시점이 도래하면 자동 검수(크롤링)로 ‘체크 완료’ 됩니다."
              : "수동 부여는 생성 즉시 ‘체크 완료’ 처리됩니다."}
          </p>
        </div>

        {banner && (
          <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {banner}
          </p>
        )}

        {/* 버튼 — 정규 프로세스 체크 UX(초기화 / 체크 신청). 체크 취소는 신청 후 목록에서. */}
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={() => void reset()}>
            초기화
          </Button>
          <Button type="button" size="sm" disabled={submitting} onClick={() => void submit()}>
            {submitting ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="mr-1.5 h-3.5 w-3.5" />
            )}
            {isReview ? "체크 신청" : "수동 부여"}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={() => void handleClose()}>
            닫기
          </Button>
        </div>
      </div>
    </div>
  );
}
