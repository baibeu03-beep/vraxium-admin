"use client";

// 선별(selection) 액트 수동 부여 모달 (2026-06-18) — 관리자가 대상 크루 + 포인트를 직접 입력해 즉시 완료.
//   변동 수동 부여(ProcessIrregularManualGrantDialog)와 동일 UX이되 정규 액트(act_id)에 귀속된다.
//   - 필드: 액트명(기본=마스터 액트명·편집 가능)·소요시간·사유·포인트 A/B/C·대상 크루(복수).
//   - '선별' 규칙상 포인트 C = 0 고정·disabled(시각적 비활성).
//   - 대상 크루 = org+mode 스코프 자동완성(cafe-line-crew GET 재사용). 저장 시 서버 fail-closed 재검증.
//   - 저장 = POST /api/admin/processes/check { action:'manual_grant', act_id, hub, scope, part_name, … }
//     → 상태 행 completed+manual_grant + recipients(중복 스킵) + 포인트 적립(snapshot 무효화).

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CONFIRM, useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type ScopeMode, appendModeQuery } from "@/lib/userScopeShared";
import { type ProcessHub } from "@/lib/adminProcessesTypes";
import {
  MANUAL_GRANT_REASON_MAX,
  formatCheckDateTimeKo,
  type ProcessCheckActRowDto,
  type ProcessCheckScopeKind,
} from "@/lib/adminProcessCheckTypes";
import ProcessCheckCompletedCrewList from "@/components/admin/ProcessCheckCompletedCrewList";

const POINTS = Array.from({ length: 21 }, (_, i) => i); // 0~20
const DURATIONS = Array.from({ length: 18 }, (_, i) => (i + 1) * 5); // 5~90, 5분 단위

// cafe-line-crew GET 이 돌려주는 크루 레코드(스코프 적용됨).
type Crew = {
  userId: string;
  crewNo: number | null;
  name: string;
  teamName: string | null;
  schoolName: string | null;
};

export default function ProcessCheckManualGrantDialog({
  act,
  hub,
  organization,
  mode,
  teamId = null,
  scope = null,
  partName = null,
  onClose,
  onDone,
}: {
  act: ProcessCheckActRowDto;
  hub: ProcessHub;
  organization: string;
  mode: ScopeMode;
  teamId?: string | null; // experience 섹션.1 선택 팀(POST team_id). 비팀 허브=null.
  scope?: ProcessCheckScopeKind | null; // experience 팀·파트 스코프(team_overall|part).
  partName?: string | null; // part 스코프일 때 선택 파트명.
  onClose: () => void;
  onDone: () => void;
}) {
  const [actName, setActName] = useState(act.actName);
  const [duration, setDuration] = useState("");
  const [reason, setReason] = useState("");
  const [pointA, setPointA] = useState(0);
  const [pointB, setPointB] = useState(0);
  // 포인트 C — 선별 규칙상 0 고정(상태 없이 상수).

  // 대상 크루 — 자동완성 검색/선택 후보 + 명단.
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Crew[]>([]);
  const [searching, setSearching] = useState(false);
  const [candidate, setCandidate] = useState<Crew | null>(null);
  const [roster, setRoster] = useState<Crew[]>([]);

  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const searchReq = useRef(0);
  const confirm = useConfirm();

  // 수동 입력 팝업의 상태별 모드 —
  //   needed   : 입력 폼(대상 크루/포인트). 버튼 [초기화]·[체크 신청] 활성 · [체크 취소] 항상 비활성.
  //   completed: 읽기 전용(체크 완료 크루 명단). 모든 액션 버튼 비활성.
  //   ⚠ 수동 입력은 '체크 신청' 시 즉시 부여/완료 → '체크 대기'(pending)가 발생하지 않는다.
  //      따라서 이 팝업은 needed/completed 만 다루며, 어떤 상태에서도 '체크 취소'는 비활성이다.
  const isCompleted = act.status === "completed";

  // 입력값이 하나라도 있으면 dirty(닫기 시 확인 문구 노출 판단).
  const dirty =
    actName.trim() !== act.actName ||
    duration.trim() !== "" ||
    reason.trim() !== "" ||
    pointA !== 0 ||
    pointB !== 0 ||
    roster.length > 0 ||
    q.trim() !== "";

  // 닫기 — 입력값이 있을 때만 확인.
  const handleClose = async () => {
    if (submitting) return;
    if (dirty && !(await confirm(CONFIRM.close))) return;
    onClose();
  };

  // 디바운스 자동완성 — org+mode 스코프(cafe-line-crew GET). setState 는 모두 timeout 콜백(비동기)에서.
  useEffect(() => {
    const term = q.trim();
    const myReq = ++searchReq.current;
    const t = setTimeout(async () => {
      if (!term) {
        if (myReq === searchReq.current) setResults([]);
        return;
      }
      setSearching(true);
      try {
        const res = await fetch(
          appendModeQuery(
            `/api/admin/cluster4/cafe-line-crew?organization=${encodeURIComponent(organization)}&q=${encodeURIComponent(term)}`,
            mode,
          ),
        );
        const json = await res.json().catch(() => ({}));
        if (myReq !== searchReq.current) return;
        const crews = (res.ok && json.success ? json.data?.crews ?? [] : []) as Array<Record<string, unknown>>;
        setResults(
          crews.map((c) => ({
            userId: String(c.userId),
            crewNo: (c.crewNo as number | null) ?? null,
            name: String(c.name ?? ""),
            teamName: (c.teamName as string | null) ?? null,
            schoolName: (c.schoolName as string | null) ?? null,
          })),
        );
      } finally {
        if (myReq === searchReq.current) setSearching(false);
      }
    }, term ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, organization, mode]);

  const addCandidate = () => {
    if (!candidate) return;
    setRoster((prev) => (prev.some((c) => c.userId === candidate.userId) ? prev : [...prev, candidate]));
    setCandidate(null);
    setQ("");
    setResults([]);
  };

  const reset = async () => {
    if (!(await confirm(CONFIRM.reset))) return;
    setActName(act.actName);
    setDuration("");
    setReason("");
    setPointA(0);
    setPointB(0);
    setQ("");
    setResults([]);
    setCandidate(null);
    setRoster([]);
    setBanner(null);
  };

  const submit = async () => {
    setBanner(null);
    if (!actName.trim()) return setBanner("액트명을 입력해주세요");
    if (roster.length === 0) return setBanner("대상 크루를 1명 이상 추가해주세요");
    if (!(await confirm(CONFIRM.checkComplete))) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/processes/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hub,
          organization,
          act_id: act.actId,
          action: "manual_grant",
          ...(teamId ? { team_id: teamId } : {}),
          ...(scope ? { scope } : {}),
          ...(scope === "part" && partName ? { part_name: partName } : {}),
          ...(mode === "test" ? { mode: "test" } : {}),
          act_name: actName.trim(),
          target_user_ids: roster.map((c) => c.userId),
          duration_minutes: duration.trim() ? Number(duration) : null,
          reason: reason.trim() || null,
          point_a: pointA,
          point_b: pointB,
          point_c: 0, // 선별 규칙상 C=0 고정
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
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            선별 액트 ·{" "}
            <span className="text-green-700">{isCompleted ? "수동 부여 완료" : "수동 부여"}</span>
            <span className="ml-2 text-xs font-normal text-muted-foreground">({act.lineGroupName})</span>
          </h2>
          {/* 우측 상단 인원 수 — 완료=체크 완료 크루 수 / 입력=선택 중인 대상 수 */}
          <span className="text-sm font-medium text-muted-foreground">
            {isCompleted ? `체크 완료 크루 ${act.checkedCrewCount ?? 0}명` : `대상 크루 ${roster.length}명`}
          </span>
        </div>

        {isCompleted ? (
          /* 체크 완료 — 읽기 전용(액트 정보 + 체크 완료 크루 명단). 입력/버튼 비활성. */
          <div className="space-y-3">
            <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div className="flex gap-3">
                <span className="w-24 shrink-0 text-muted-foreground">액트명</span>
                <span className="min-w-0 break-words font-medium">{act.actName}</span>
              </div>
              <div className="flex gap-3">
                <span className="w-24 shrink-0 text-muted-foreground">완료 시점</span>
                <span className="font-medium">
                  {act.completedAt ? formatCheckDateTimeKo(act.completedAt) : "-"}
                </span>
              </div>
            </div>
            <ProcessCheckCompletedCrewList crews={act.completedCrewList} />
          </div>
        ) : (
        <div className="space-y-3">
          {/* 공통 입력 */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              액트명 <span className="text-red-500">*</span>
            </label>
            <Input value={actName} onChange={(e) => setActName(e.target.value)} maxLength={60} placeholder="액트명" disabled={submitting} />
          </div>

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
                  <option key={d} value={d}>{d}분</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">종류</label>
              <div className="flex h-9 items-center rounded-md border border-input bg-muted/50 px-3 text-sm text-muted-foreground">
                선별
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              액트 신청 사유 <span className="text-muted-foreground">({reason.length}/{MANUAL_GRANT_REASON_MAX})</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, MANUAL_GRANT_REASON_MAX))}
              rows={2}
              maxLength={MANUAL_GRANT_REASON_MAX}
              placeholder="선택"
              disabled={submitting}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>

          {/* 포인트 A/B/C — 선별 규칙상 C=0 고정·disabled(시각적 비활성) */}
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">포인트 A</label>
              <select
                aria-label="포인트 A"
                value={pointA}
                onChange={(e) => setPointA(Number(e.target.value))}
                disabled={submitting}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {POINTS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">포인트 B</label>
              <select
                aria-label="포인트 B"
                value={pointB}
                onChange={(e) => setPointB(Number(e.target.value))}
                disabled={submitting}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {POINTS.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">포인트 C</label>
              <select
                aria-label="포인트 C"
                value={0}
                disabled
                title="‘선별’ 액트는 포인트 C(미이행 페널티)를 부여할 수 없습니다(0 고정)"
                className="h-9 w-full cursor-not-allowed rounded-md border border-input bg-muted px-2 text-sm text-muted-foreground opacity-60"
              >
                <option value={0}>0</option>
              </select>
            </div>
          </div>

          {/* 대상 크루 — 자동완성 검색 + [확인] */}
          <div className="space-y-1 rounded-md border p-3">
            <label className="text-xs font-medium text-muted-foreground">
              대상 크루 (자동완성 검색 · {mode === "test" ? "테스트" : "운영"} 스코프)
            </label>
            <div className="flex items-start gap-2">
              <div className="relative flex-1">
                <Input
                  value={candidate ? `${candidate.name}${candidate.crewNo != null ? ` (#${candidate.crewNo})` : ""}` : q}
                  onChange={(e) => {
                    setCandidate(null);
                    setQ(e.target.value);
                  }}
                  placeholder="이름으로 검색"
                  disabled={submitting}
                />
                {!candidate && q.trim() && (searching || results.length > 0) && (
                  <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-card shadow-lg">
                    {searching ? (
                      <p className="px-3 py-2 text-xs text-muted-foreground">검색 중…</p>
                    ) : results.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-muted-foreground">스코프 내 결과 없음</p>
                    ) : (
                      results.map((c) => (
                        <button
                          key={c.userId}
                          type="button"
                          onClick={() => {
                            setCandidate(c);
                            setResults([]);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                        >
                          <span className="w-12 shrink-0 tabular-nums text-muted-foreground">{c.crewNo ?? "—"}</span>
                          <span className="font-medium">{c.name}</span>
                          <span className="text-xs text-muted-foreground">{c.teamName ?? "-"} · {c.schoolName ?? "-"}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              <Button type="button" size="sm" disabled={!candidate || submitting} onClick={addCandidate}>
                확인
              </Button>
            </div>

            {/* 명단 표 */}
            <div className="mt-2 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>크루 번호</TableHead>
                    <TableHead>크루명</TableHead>
                    <TableHead>소속 팀</TableHead>
                    <TableHead>학교</TableHead>
                    <TableHead>제거</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {roster.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="py-4 text-center text-xs text-muted-foreground">
                        대상 크루가 없습니다. 검색해 추가해주세요.
                      </TableCell>
                    </TableRow>
                  ) : (
                    roster.map((c) => (
                      <TableRow key={c.userId}>
                        <TableCell className="tabular-nums">{c.crewNo ?? "—"}</TableCell>
                        <TableCell className="font-medium">{c.name}</TableCell>
                        <TableCell>{c.teamName ?? "-"}</TableCell>
                        <TableCell>{c.schoolName ?? "-"}</TableCell>
                        <TableCell>
                          <button
                            type="button"
                            disabled={submitting}
                            onClick={() => setRoster((prev) => prev.filter((x) => x.userId !== c.userId))}
                            className="text-rose-600 hover:opacity-70"
                            aria-label="제거"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-[11px] text-green-700">
            수동 부여는 즉시 ‘수동 부여 완료’로 처리됩니다(체크 대기 없음). 같은 액트·주차에 이미 부여된 크루는 중복 저장되지 않습니다.
          </p>
        </div>
        )}

        {banner && (
          <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{banner}</p>
        )}

        {/* 버튼 정책(수동 입력) —
            [체크 필요]  초기화=활성 · 체크 신청=활성 · 체크 취소=비활성
            [체크 완료]  초기화/체크 신청/체크 취소 모두 비활성(닫기만 활성)
            ⚠ '체크 취소'는 어떤 상태에서도 비활성(수동 입력엔 체크 대기/취소 개념 없음). */}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={submitting || isCompleted}
            onClick={() => void reset()}
          >
            초기화
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={submitting || isCompleted}
            onClick={() => void submit()}
          >
            {submitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
            체크 신청
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-rose-300 text-rose-700"
            disabled
            title="수동 부여 방식은 ‘체크 신청’ 시 즉시 부여/완료됩니다 — 체크 취소가 없습니다."
          >
            체크 취소
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={() => void handleClose()}>
            닫기
          </Button>
        </div>
      </div>
    </div>
  );
}
