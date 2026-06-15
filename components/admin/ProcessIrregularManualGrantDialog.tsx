"use client";

// 수동 부여(manual_grant) 모달 — 사람이 이미 검수 완료한 비정규 액트.
//   검수 신청과 공통 입력(액트명·소요시간·사유·포인트 A/B/C) + "대상 크루" 명단(복수).
//   검수 링크/시점 없음 · 체크 대기 없음 · [체크 완료] 즉시 생성(created==completed).
//   대상 크루 = 자동완성 검색(org+mode 스코프, cafe-line-crew GET 재사용) → [확인] → 명단 추가.
//   ⚠ user_weekly_points·snapshot 무접촉.

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { reactionAllowsPointC } from "@/lib/adminProcessesTypes";
import {
  IRREGULAR_CREW_REACTION_LABEL,
  IRREGULAR_CREW_REACTIONS,
  irregularCafeLabel,
  type IrregularCrewReaction,
} from "@/lib/adminProcessIrregularTypes";

const POINTS = Array.from({ length: 21 }, (_, i) => i); // 0~20
const DURATIONS = Array.from({ length: 18 }, (_, i) => (i + 1) * 5); // 5~90, 5분 단위
const REASON_MAX = 50;

// cafe-line-crew GET 이 돌려주는 크루 레코드(스코프 적용됨).
type Crew = {
  userId: string;
  crewNo: number | null;
  name: string;
  teamName: string | null;
  schoolName: string | null;
};

export default function ProcessIrregularManualGrantDialog({
  organization,
  mode,
  onClose,
  onDone,
}: {
  organization: string;
  mode: ScopeMode;
  onClose: () => void;
  onDone: () => void;
}) {
  const [actName, setActName] = useState("");
  const [duration, setDuration] = useState("");
  const [reason, setReason] = useState("");
  const [pointA, setPointA] = useState(0);
  const [pointB, setPointB] = useState(0);
  const [pointC, setPointC] = useState(0);
  const [crewReaction, setCrewReaction] = useState<IrregularCrewReaction>("none");

  // 대상 크루 — 자동완성 검색/선택 후보 + 명단.
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Crew[]>([]);
  const [searching, setSearching] = useState(false);
  const [candidate, setCandidate] = useState<Crew | null>(null);
  const [roster, setRoster] = useState<Crew[]>([]);

  const [banner, setBanner] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const searchReq = useRef(0);

  // 디바운스 자동완성 — org+mode 스코프(cafe-line-crew GET).
  useEffect(() => {
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
    }, 250);
    return () => clearTimeout(t);
  }, [q, organization, mode]);

  const addCandidate = () => {
    if (!candidate) return;
    setRoster((prev) => (prev.some((c) => c.userId === candidate.userId) ? prev : [...prev, candidate]));
    setCandidate(null);
    setQ("");
    setResults([]);
  };

  const reset = () => {
    setActName("");
    setDuration("");
    setReason("");
    setPointA(0);
    setPointB(0);
    setPointC(0);
    setCrewReaction("none");
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
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/processes/check/irregular", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization,
          ...(mode === "test" ? { mode: "test" } : {}),
          kind: "manual_grant",
          act_name: actName.trim(),
          target_user_ids: roster.map((c) => c.userId),
          duration_minutes: duration.trim() ? Number(duration) : null,
          reason: reason.trim() || null,
          point_a: pointA,
          point_b: pointB,
          point_c: pointC,
          crew_reaction: crewReaction,
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
        if (e.target === e.currentTarget && !submitting) onClose();
      }}
    >
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">
            비정규 액트 · <span className="text-green-700">수동 부여</span>
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              (카페: {irregularCafeLabel("manual_grant")} · 자동)
            </span>
          </h2>
          {/* 우측 상단 인원 수 */}
          <span className="text-sm font-medium text-muted-foreground">대상 크루 {roster.length}명</span>
        </div>

        <div className="space-y-3">
          {/* 공통 입력 */}
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              액트명(비정규) <span className="text-red-500">*</span>
            </label>
            <Input value={actName} onChange={(e) => setActName(e.target.value)} maxLength={60} placeholder="비정규 액트명" disabled={submitting} />
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
              <label className="text-xs text-muted-foreground">크루 반응</label>
              <select
                aria-label="크루 반응"
                value={crewReaction}
                onChange={(e) => {
                  const v = e.target.value as IrregularCrewReaction;
                  setCrewReaction(v);
                  if (!reactionAllowsPointC(v)) setPointC(0); // '필수' 아니면 즉시 C=0
                }}
                disabled={submitting}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {IRREGULAR_CREW_REACTIONS.map((c) => (
                  <option key={c} value={c}>{IRREGULAR_CREW_REACTION_LABEL[c]}</option>
                ))}
              </select>
            </div>
          </div>

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

          {/* 포인트 A/B/C — 크루 반응이 '필수'가 아니면 C=0 고정·비활성 */}
          <div className="grid grid-cols-3 gap-3">
            {([
              ["포인트 A", pointA, setPointA, false],
              ["포인트 B", pointB, setPointB, false],
              ["포인트 C", pointC, setPointC, !reactionAllowsPointC(crewReaction)],
            ] as const).map(([label, val, set, locked]) => (
              <div key={label} className="space-y-1">
                <label className="text-xs text-muted-foreground">{label}</label>
                <select
                  aria-label={label}
                  value={val}
                  onChange={(e) => set(Number(e.target.value))}
                  disabled={submitting || locked}
                  title={locked ? "‘필수’ 크루 반응만 포인트 C를 부여할 수 있습니다" : undefined}
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {POINTS.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          {/* 대상 크루 — 자동완성 검색 + [확인] */}
          <div className="space-y-1 rounded-md border p-3">
            <label className="text-xs font-medium text-muted-foreground">대상 크루 (자동완성 검색)</label>
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
                    <TableHead className="text-right">크루 번호</TableHead>
                    <TableHead>크루명</TableHead>
                    <TableHead>소속 팀</TableHead>
                    <TableHead>학교</TableHead>
                    <TableHead className="text-right">제거</TableHead>
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
                        <TableCell className="text-right tabular-nums">{c.crewNo ?? "—"}</TableCell>
                        <TableCell className="font-medium">{c.name}</TableCell>
                        <TableCell>{c.teamName ?? "-"}</TableCell>
                        <TableCell>{c.schoolName ?? "-"}</TableCell>
                        <TableCell className="text-right">
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
            수동 부여는 이미 검수가 끝난 상태입니다. [체크 완료] 시 즉시 ‘체크 완료’로 생성됩니다(체크 대기 없음).
          </p>
        </div>

        {banner && (
          <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{banner}</p>
        )}

        {/* 상단 버튼 — 초기화 / 체크 완료 (체크 신청·체크 취소 없음) */}
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={reset}>
            초기화
          </Button>
          <Button type="button" size="sm" disabled={submitting} onClick={() => void submit()}>
            {submitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
            체크 완료
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={onClose}>
            닫기
          </Button>
        </div>
      </div>
    </div>
  );
}
