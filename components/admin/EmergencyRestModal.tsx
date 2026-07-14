"use client";

// 긴급 휴식 신청 모달 — /admin/rest-management 의 [긴급 휴식 신청].
//   [1] 신청자(actor, 서버 결정·읽기전용) · [2] 소속 팀 · [3] 휴식 크루 · [4] 휴식 희망 주차 ·
//   [5] 긴급 신청 상황(≤50자) · [6] 휴식 신청.
//
// 모든 조회/생성은 동일 API(/api/admin/rest-management/emergency/*)를 쓰며, mode(test)·
//   actAsTestUserId 는 URL 로 실어 서버 서비스에 위임한다(모드별 분기 없음). org 는 부모가 정한
//   활성 조직(activeOrg)을 prop 으로 받는다(통합 경로는 URL 에 org 가 없으므로).

import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { classTone } from "@/lib/statusBadge";
import { getProcessPointLabels } from "@/lib/pointLabels";
import type { OrganizationSlug } from "@/lib/organizations";

type WeekOption = {
  weekId: string;
  seasonKey: string;
  weekStartDate: string;
  weekEndDate: string;
  weekLabel: string;
  dateRangeLabel: string;
  isCurrent: boolean;
  resultingStatus: "fulfilled" | "approved";
};
type TeamOption = { teamId: string; teamName: string; organization: string };
type ContextDto = {
  organization: string;
  seasonKey: string | null;
  seasonLabel: string;
  actor: { roleLabel: string; displayName: string; teamName: string | null };
  teams: TeamOption[];
  weeks: WeekOption[];
  poC: number;
};
type CrewOption = {
  userId: string;
  crewName: string;
  crewCode: string | null;
  classLabel: string;
  teamId: string;
};

const REASON_MAX = 50;
const STATUS_TEXT: Record<"fulfilled" | "approved", string> = {
  fulfilled: "휴식 이행",
  approved: "휴식 승인",
};

// URL 의 mode/actAsTestUserId 를 모든 요청에 동일하게 실어 보낸다(동일 서비스·동일 DTO).
function modeParams(): URLSearchParams {
  const qs = new URLSearchParams();
  if (typeof window !== "undefined") {
    const loc = new URLSearchParams(window.location.search);
    if (loc.get("mode") === "test") qs.set("mode", "test");
    const act = loc.get("actAsTestUserId")?.trim();
    if (act) qs.set("actAsTestUserId", act);
  }
  return qs;
}

export default function EmergencyRestModal({
  org,
  labelOrg,
  onClose,
  onCreated,
}: {
  org: OrganizationSlug;
  // po.C 표시명 스코프 — [개별] 경로에서만 조직 slug 를 전달해 조직별 명칭(번개/어흥/화살…)으로
  //   표시하고, [통합] 경로(특정 조직 탭 선택 포함)에서는 null 을 전달해 중립 "Po.C" 를 유지한다.
  //   조회/생성 스코프(org)와 분리한 표시 전용 prop(로직·모집단 불변).
  labelOrg: OrganizationSlug | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();

  // po.C 표시명: labelOrg 있으면 조직별 명칭, 없으면(통합) 중립 "Po.C"(getProcessPointLabels fail-safe).
  const poCLabel = getProcessPointLabels(labelOrg).c;

  const [context, setContext] = useState<ContextDto | null>(null);
  const [loadingContext, setLoadingContext] = useState(true);
  const [contextError, setContextError] = useState<string | null>(null);

  const [teamId, setTeamId] = useState<string>("");
  const [crewUserId, setCrewUserId] = useState<string>("");
  const [weekId, setWeekId] = useState<string>("");
  const [reason, setReason] = useState<string>("");

  const [crews, setCrews] = useState<CrewOption[]>([]);
  const [loadingCrews, setLoadingCrews] = useState(false);
  const [crewError, setCrewError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    team?: string;
    crew?: string;
    week?: string;
    reason?: string;
  }>({});

  // ── 컨텍스트 로드(팀·주차·신청자) ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingContext(true);
      setContextError(null);
      try {
        const qs = modeParams();
        qs.set("organization", org);
        const res = await fetch(
          `/api/admin/rest-management/emergency/context?${qs.toString()}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json?.success) {
          throw new Error(json?.error ?? "정보를 불러오지 못했습니다.");
        }
        const ctx = json.context as ContextDto;
        setContext(ctx);
        // 팀/주차 1개면 자동 선택.
        if (ctx.teams.length === 1) setTeamId(ctx.teams[0].teamId);
        if (ctx.weeks.length === 1) setWeekId(ctx.weeks[0].weekId);
      } catch (err) {
        if (cancelled) return;
        setContextError(
          err instanceof Error ? err.message : "정보를 불러오지 못했습니다.",
        );
      } finally {
        if (!cancelled) setLoadingContext(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [org]);

  // ── 팀 선택 → 크루 목록 로드 ──────────────────────────────────────────────
  useEffect(() => {
    if (!teamId) {
      setCrews([]);
      setCrewUserId("");
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingCrews(true);
      setCrewError(null);
      setCrewUserId(""); // 팀 변경 시 크루 초기화
      try {
        const qs = modeParams();
        qs.set("organization", org);
        qs.set("teamId", teamId);
        const res = await fetch(
          `/api/admin/rest-management/emergency/crews?${qs.toString()}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json?.success) {
          throw new Error(json?.error ?? "크루를 불러오지 못했습니다.");
        }
        setCrews((json.crews ?? []) as CrewOption[]);
      } catch (err) {
        if (cancelled) return;
        setCrewError(err instanceof Error ? err.message : "크루를 불러오지 못했습니다.");
        setCrews([]);
      } finally {
        if (!cancelled) setLoadingCrews(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId, org]);

  const teams = context?.teams ?? [];
  const weeks = context?.weeks ?? [];
  const teamLocked = teams.length <= 1; // 0/1개면 변경 불가.
  const selectedCrew = useMemo(
    () => crews.find((c) => c.userId === crewUserId) ?? null,
    [crews, crewUserId],
  );
  const selectedWeek = useMemo(
    () => weeks.find((w) => w.weekId === weekId) ?? null,
    [weeks, weekId],
  );
  const reasonLen = reason.trim().length;
  const noWeeks = !loadingContext && weeks.length === 0;

  const actorLine = context
    ? `${context.seasonLabel}, ${context.actor.roleLabel}${
        context.actor.teamName ? `(${context.actor.teamName})` : ""
      } ${context.actor.displayName} 님`
    : "";

  // ── 제출 ────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    const errs: typeof fieldErrors = {};
    if (!teamId) errs.team = "소속 팀을 선택해 주세요.";
    if (!crewUserId) errs.crew = "휴식 크루를 선택해 주세요.";
    if (!weekId) errs.week = "휴식 희망 주차를 선택해 주세요.";
    if (reasonLen < 1) errs.reason = "긴급 신청 상황을 입력해 주세요.";
    else if (reasonLen > REASON_MAX) errs.reason = `최대 ${REASON_MAX}자까지 입력할 수 있습니다.`;
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      setBanner("필수 항목을 모두 입력해 주세요.");
      return;
    }
    setFieldErrors({});
    setBanner(null);
    setSubmitting(true);
    try {
      const qs = modeParams();
      const res = await fetch(
        `/api/admin/rest-management/emergency${qs.toString() ? `?${qs.toString()}` : ""}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            organization: org,
            teamId,
            crewUserId,
            weekId,
            reason: reason.trim(),
          }),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.success) {
        setBanner(json?.error ?? `신청에 실패했습니다 (HTTP ${res.status}).`);
        return;
      }
      toast("success", "긴급 휴식 신청이 완료되었습니다.");
      onCreated();
      onClose();
    } catch {
      setBanner("신청 중 오류가 발생했습니다.");
    } finally {
      setSubmitting(false);
    }
  }, [org, teamId, crewUserId, weekId, reason, reasonLen, onCreated, onClose, toast]);

  const canSubmit =
    !submitting && !loadingContext && !noWeeks && Boolean(teamId && crewUserId && weekId && reasonLen >= 1 && reasonLen <= REASON_MAX);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-8"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="max-h-[90vh] modal-w-lg space-y-5 overflow-y-auto rounded-xl bg-background p-6 shadow-xl ring-1 ring-foreground/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-bold">긴급 휴식 신청</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              대상 크루에게 즉시 <span className="font-semibold text-rose-600">{poCLabel} ×2</span> 가 부여됩니다.
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} disabled={submitting}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        {contextError ? (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
            {contextError}
          </div>
        ) : null}

        {banner ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {banner}
          </div>
        ) : null}

        {/* [1] 신청자 (읽기 전용) */}
        <Field label="신청자">
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm font-medium">
            {loadingContext ? "불러오는 중…" : actorLine || "—"}
          </div>
        </Field>

        {/* [2] 소속 팀 */}
        <Field label="소속 팀" error={fieldErrors.team}>
          <Select
            value={teamId}
            onValueChange={(v) => setTeamId(v ?? "")}
            disabled={loadingContext || teamLocked || teams.length === 0}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={teams.length === 0 ? "선택 가능한 팀이 없습니다" : "팀 선택"}>
                {(value: unknown) => {
                  const id = value == null ? "" : String(value);
                  return teams.find((t) => t.teamId === id)?.teamName ?? "팀 선택";
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {teams.map((t) => (
                <SelectItem key={t.teamId} value={t.teamId}>
                  {t.teamName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {/* [3] 휴식 크루 */}
        <Field label="휴식 크루" error={fieldErrors.crew ?? crewError ?? undefined}>
          <Select
            value={crewUserId}
            onValueChange={(v) => setCrewUserId(v ?? "")}
            disabled={!teamId || loadingCrews || crews.length === 0}
          >
            <SelectTrigger className="w-full">
              <SelectValue
                placeholder={
                  !teamId
                    ? "먼저 팀을 선택하세요"
                    : loadingCrews
                      ? "불러오는 중…"
                      : crews.length === 0
                        ? "소속 크루가 없습니다"
                        : "크루 선택"
                }
              >
                {(value: unknown) => {
                  const id = value == null ? "" : String(value);
                  return crews.find((c) => c.userId === id)?.crewName ?? "크루 선택";
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {crews.map((c) => (
                <SelectItem key={c.userId} value={c.userId}>
                  {c.crewName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedCrew ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <span className="font-mono text-xs">{selectedCrew.crewCode ?? "-"}</span>
              <span className="text-muted-foreground">|</span>
              <span className="font-medium">{selectedCrew.crewName}</span>
              <span className="text-muted-foreground">|</span>
              <Badge tone={classTone(selectedCrew.classLabel)} appearance="outline">
                {selectedCrew.classLabel}
              </Badge>
            </div>
          ) : null}
        </Field>

        {/* [4] 휴식 희망 주차 */}
        <Field label="휴식 희망 주차" error={fieldErrors.week}>
          <Select
            value={weekId}
            onValueChange={(v) => setWeekId(v ?? "")}
            disabled={loadingContext || noWeeks}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={noWeeks ? "신청 가능한 주차가 없습니다" : "주차 선택"}>
                {(value: unknown) => {
                  const id = value == null ? "" : String(value);
                  const w = weeks.find((x) => x.weekId === id);
                  return w ? `${w.weekLabel} · ${STATUS_TEXT[w.resultingStatus]}` : "주차 선택";
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {weeks.map((w) => (
                <SelectItem key={w.weekId} value={w.weekId}>
                  {w.weekLabel} · {STATUS_TEXT[w.resultingStatus]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedWeek ? (
            <p className="mt-1.5 text-sm text-muted-foreground">{selectedWeek.dateRangeLabel}</p>
          ) : null}
          {noWeeks ? (
            <p className="mt-1.5 text-sm text-amber-700">
              현재 주차와 다음 주차가 모두 공식 휴식 주차이므로 긴급 휴식을 신청할 수 없습니다.
            </p>
          ) : null}
        </Field>

        {/* [5] 긴급 신청 상황 */}
        <Field label="긴급 신청 상황" error={fieldErrors.reason}>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
            maxLength={REASON_MAX}
            rows={2}
            placeholder="긴급 휴식이 필요한 상황을 입력해 주세요."
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="mt-1 text-right text-xs tabular-nums text-muted-foreground">
            {reasonLen} / {REASON_MAX}
          </p>
        </Field>

        {/* [6] 액션 */}
        <div className="flex items-center justify-end gap-3 border-t pt-4">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            닫기
          </Button>
          <Button variant="destructive" onClick={handleSubmit} disabled={!canSubmit} loading={submitting}>
            휴식 신청
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-semibold text-foreground">{label}</label>
      {children}
      {error ? <p className="text-xs text-rose-600">{error}</p> : null}
    </div>
  );
}
