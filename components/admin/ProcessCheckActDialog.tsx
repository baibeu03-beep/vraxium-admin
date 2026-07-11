"use client";

// 프로세스 체크 액트 팝업 — 상태별(needed/pending/completed) 신청/취소 UX.
//   needed   : 검수 링크 + 검수 시점 입력 → [체크 신청]. [초기화] 활성 · [체크 취소] 비활성.
//   pending  : 신청값 readonly. [체크 취소] 활성(검수 시점 전만) · 나머지 비활성.
//   completed: 모든 값 readonly · 모든 버튼 비활성(체크 크루 수 표시).
// 검수 시점 = 날짜+시간(24h, 30분), 요일 자동. now 이전/+7일 초과 불가(서버 재검증).

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CONFIRM, useConfirm } from "@/components/ui/confirm-dialog";
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
import ProcessCheckCompletedCrewList from "@/components/admin/ProcessCheckCompletedCrewList";

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

// 라벨(위) + 값(아래) 셀 — grid 칸/검수 링크·검수 시점 표시 공용.
function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="min-w-0 break-words text-sm font-medium">{children}</div>
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
  weekId = null,
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
  // 선택 주차(weeks.id) — 보드 선택 주차. 예외 허용 주차 저장 시 보드와 동일 주차로 write.
  weekId?: string | null;
  onClose: () => void;
  onDone: () => void; // 성공 후 보드/로그/상태창 재조회
}) {
  const confirm = useConfirm();
  const [reviewLink, setReviewLink] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [banner, setBanner] = useState<Banner>(null);
  const [submitting, setSubmitting] = useState(false);

  // 닫기 확인용 — needed 상태에서 입력값이 있을 때만 한 번 더 확인.
  const dirty = reviewLink !== "" || date !== "" || time !== "";

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

  // 즉시 검증(클라) — 날짜+시간이 완성돼 timestamp 가 나오는 즉시 신청 시점(nowMs) 기준 12시간 규칙을 판정.
  //   기준 시각 = 화면이 신청 시점으로 쓰는 nowMs(팝업 오픈 시점 고정, min·max 와 동일 축). 서버는 실제 요청
  //   시각으로 재검증(공통 validateScheduledCheckAt SoT). 미완성(날짜만/시간만)은 판정 보류(null).
  const scheduleValidation = useMemo(
    () => (scheduledIso ? validateScheduledCheckAt(scheduledIso, nowMs) : null),
    [scheduledIso, nowMs],
  );
  const scheduleInvalid = scheduleValidation !== null && !scheduleValidation.ok;
  const scheduleError = scheduleValidation && !scheduleValidation.ok ? scheduleValidation.error : null;

  // 날짜/시간 변경으로 완성된 timestamp 가 12시간 규칙 위반이면 공통 팝업으로 즉시 안내.
  //   onChange(사용자 행위) 에서만 호출 → 렌더/state update 마다 반복 팝업하지 않는다. 미완성은 보류,
  //   새로운 잘못된 값을 다시 고르면 다시 안내된다. 잘못된 값의 최종 차단은 disabled + submit 재검증이 담당.
  const warnIfScheduleInvalid = (nextDate: string, nextTime: string) => {
    if (!nextDate || !nextTime) return;
    const d = new Date(`${nextDate}T${nextTime}:00`);
    if (Number.isNaN(d.getTime())) return;
    const v = validateScheduledCheckAt(d.toISOString(), nowMs);
    if (!v.ok) void confirm({ title: "검수 시점 확인", description: v.error, confirmLabel: "확인" });
  };

  // pending: 검수 시점 전이어야 취소 가능.
  const cancelable =
    status === "pending" &&
    (!act.scheduledCheckAt || nowMs < Date.parse(act.scheduledCheckAt));

  const reset = async () => {
    // 초기화 전 한 번 더 확인.
    if (!(await confirm(CONFIRM.reset))) return;
    setReviewLink("");
    setDate("");
    setTime("");
    setBanner(null);
  };

  // 닫기 — 입력값이 있을 때만 한 번 더 확인(없으면 그냥 닫기).
  const requestClose = async () => {
    if (submitting) return;
    if (dirty && !(await confirm(CONFIRM.close))) return;
    onClose();
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
    // 처리 전 한 번 더 확인(신청/취소 각각 안내 문구 분리).
    const ok =
      action === "request"
        ? await confirm({
            title: "체크 신청",
            description: "체크를 신청합니다. 진행하시겠습니까?",
            confirmLabel: "체크 신청",
          })
        : await confirm({
            title: "체크 취소",
            description: "체크를 취소 처리합니다. 진행하시겠습니까?",
            confirmLabel: "체크 취소",
            tone: "destructive",
          });
    if (!ok) return;
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
          // 선택 주차 — 현재 주차와 다르면(예외 허용 주차) 서버가 그 주차로 저장. 미부착=현재 주차.
          ...(weekId ? { week: weekId } : {}),
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
        if (e.target === e.currentTarget && !submitting) void requestClose();
      }}
    >
      <div className="max-h-[92vh] modal-w-lg overflow-y-auto rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10">
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
          <button type="button" onClick={() => void requestClose()} disabled={submitting} className="hover:opacity-70">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* (1) 상단 정보 — 1행 3열: 액트명 / 소속 라인급 / 액트 종류 */}
        <div className="grid grid-cols-3 gap-3 rounded-md border bg-muted/30 px-3 py-2">
          <Field label="액트명">{act.actName}</Field>
          <Field label="소속 라인급">{act.lineGroupName}</Field>
          <Field label="액트 종류">{act.crewReactionLabel}</Field>
        </div>

        {/* (2) 검수 링크 — needed=입력 / 그 외=링크 표시 */}
        <div className="mt-3 space-y-1">
          {status === "needed" ? (
            <>
              <label className="text-xs text-muted-foreground">
                검수 링크 <span className="text-red-500">*</span>
              </label>
              <Input
                value={reviewLink}
                onChange={(e) => setReviewLink(e.target.value)}
                placeholder="https://cafe.naver.com/..."
                disabled={submitting}
              />
            </>
          ) : (
            <Field label="검수 링크">
              {act.reviewLink ? (
                <a href={act.reviewLink} target="_blank" rel="noreferrer" className="text-blue-600 underline">
                  {act.reviewLink}
                </a>
              ) : (
                "-"
              )}
            </Field>
          )}
        </div>

        {/* (3) 검수 시점 / 체크 크루 인원수 — needed 는 입력 그룹을 전폭으로(한 행 유지), 그 외는 1행 2열 */}
        <div className="mt-3 grid grid-cols-2 gap-3">
          {status === "needed" ? (
            <div className="col-span-2 space-y-1">
              <label className="text-xs text-muted-foreground">
                검수 시점 <span className="text-red-500">*</span>
              </label>
              {/* 날짜 · (요일) · 시간을 한 행에 고정 — flex-nowrap + 요일은 shrink-0/whitespace-nowrap.
                  좁은 화면에서도 요일 괄호가 단독 줄바꿈되지 않도록 그룹 단위로 가로 스크롤 처리한다. */}
              <div className="flex flex-nowrap items-center gap-1.5 overflow-x-auto">
                <input
                  type="date"
                  value={date}
                  min={minDate}
                  max={maxDate}
                  onChange={(e) => {
                    const v = e.target.value;
                    setDate(v);
                    warnIfScheduleInvalid(v, time); // 시간이 이미 있으면 날짜 변경만으로도 즉시 판정
                  }}
                  disabled={submitting}
                  aria-invalid={scheduleInvalid}
                  className="h-9 min-w-[9rem] shrink-0 rounded-md border border-input bg-background px-2 text-sm aria-[invalid=true]:border-rose-400"
                />
                <span className="w-9 shrink-0 whitespace-nowrap text-center text-sm text-muted-foreground">
                  {date ? `(${dowOf(date)})` : "(–)"}
                </span>
                <select
                  aria-label="검수 시각"
                  value={time}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTime(v);
                    warnIfScheduleInvalid(date, v); // 날짜가 이미 있으면 시간 선택으로 timestamp 완성 → 즉시 판정
                  }}
                  disabled={submitting}
                  aria-invalid={scheduleInvalid}
                  className="h-9 min-w-[5.5rem] shrink-0 rounded-md border border-input bg-background px-2 text-sm aria-[invalid=true]:border-rose-400"
                >
                  <option value="">시간</option>
                  {TIME_SLOTS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              {/* 유효(12h 이후)면 확정 미리보기 · 위반이면 즉시 경고 문구(신청 버튼도 비활성). */}
              {scheduledIso && !scheduleInvalid && (
                <p className="text-[11px] text-muted-foreground">→ {formatCheckDateTimeKo(scheduledIso)}</p>
              )}
              {scheduleError && (
                <p className="text-[11px] font-medium text-rose-600">{scheduleError}</p>
              )}
            </div>
          ) : (
            <>
              <Field label="검수 시점">{act.scheduledCheckAt ? formatCheckDateTimeKo(act.scheduledCheckAt) : "-"}</Field>
              <Field label="체크 크루 인원수">
                {status === "completed" ? `${act.checkedCrewCount ?? act.completedCrewList.length}명` : "-"}
              </Field>
            </>
          )}
        </div>

        {/* 완료 부가 정보(신청/완료 시점) — completed 만 */}
        {status === "completed" && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="신청 시점">{act.requestedAt ? formatCheckDateTimeKo(act.requestedAt) : "-"}</Field>
            <Field label="완료 시점">{act.completedAt ? formatCheckDateTimeKo(act.completedAt) : "-"}</Field>
          </div>
        )}

        {/* (4) 체크 크루 명단(이름·소속 팀·소속 파트·클래스) — 없으면 안내 문구 */}
        <div className="mt-3">
          <ProcessCheckCompletedCrewList crews={act.completedCrewList} />
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
            onClick={() => void reset()}
          >
            초기화
          </Button>
          <Button
            type="button"
            size="sm"
            loading={submitting && status === "needed"}
            // 12h 규칙 위반(scheduleInvalid) 이면 신청 불가. 미완성 값은 submit 이 "날짜·시간 선택" 으로 안내.
            disabled={status !== "needed" || submitting || scheduleInvalid}
            onClick={() => void submit("request")}
          >
            체크 신청
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-rose-300 text-rose-700 hover:bg-rose-50"
            loading={submitting && status === "pending"}
            disabled={!cancelable || submitting}
            onClick={() => void submit("cancel")}
          >
            체크 취소
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={() => void requestClose()}>
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
