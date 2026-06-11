"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RotateCcw, Eye, CheckCircle2, XCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  EXPERIENCE_OVERALL_CATEGORIES,
  OVERALL_CELL_DEFAULT,
  OVERALL_LEADER_CATEGORIES,
  isOverallCellFail,
  type ExperienceOverallCategory,
  type ExperienceTeamOverallBoard as BoardDto,
  type OverallBoardCrew,
  type OverallCell,
  type OverallLeaderCellDto,
} from "@/lib/experienceTeamOverallTypes";

// 실무 경험 [팀 총괄] — 개설 검수/완료/취소 편집 보드.
//   행=전 파트 크루(+파트장), 열=도출/분석/견문(파트신청 라이브, 읽기전용) + 관리/확장(팀장 입력).
//   확장은 확장 주간에만 활성. 카테고리별 아웃풋 링크/설명 입력(이미지는 라인 등록값 자동).
//   버튼 4종: [개설 검수](에이전트 임시저장) · [초기화](프론트 전용) · [개설 완료](팀장, 고객 반영) · [개설 취소](완료 원복).

type Banner = { kind: "success" | "error"; message: string } | null;

const leaderKey = (userId: string, category: ExperienceOverallCategory) =>
  `${userId}::${category}`;

// 표 컬럼 폭 — table-layout: fixed 와 함께 헤더/바디 폭을 정확히 고정한다.
//   이름 = 20%(나머지의 약 1.75배), 파트·상태·도출·분석·견문·관리·확장 = 80%/7 = 11.4286% 동일.
//   8개 컬럼 합 = 20 + 7×11.4286 ≈ 100%. min-width 로 데스크톱에서 컨트롤이 찌그러지지 않게 한다.
const NAME_COL_W = "20%";
const EQUAL_COL_W = "11.4286%";

function BoardColgroup() {
  return (
    <colgroup>
      <col style={{ width: NAME_COL_W }} />
      <col style={{ width: EQUAL_COL_W }} />{/* 파트 */}
      <col style={{ width: EQUAL_COL_W }} />{/* 크루 상태 */}
      {EXPERIENCE_OVERALL_CATEGORIES.map((c) => (
        <col key={c.key} style={{ width: EQUAL_COL_W }} />
      ))}
    </colgroup>
  );
}

export default function ExperienceTeamOverallBoard({
  organization,
  teamId,
  teamName,
  weekId,
  onActivity,
}: {
  organization: string;
  teamId: string;
  teamName: string;
  weekId: string;
  // 검수/완료/취소 직후 상위(상태창·로그창)를 갱신하라는 신호.
  onActivity?: () => void;
}) {
  const [board, setBoard] = useState<BoardDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);

  // 팀장 직접 입력(관리/확장) 로컬 편집값.
  const [leaderCells, setLeaderCells] = useState<Map<string, OverallCell>>(new Map());
  // 카테고리별 아웃풋 링크/설명 로컬 편집값.
  const [outputs, setOutputs] = useState<
    Map<ExperienceOverallCategory, { link: string; description: string }>
  >(new Map());

  // 카테고리별 "연결된 라인명" 표시용 — 기존 라인 등록 조회(experience-line-masters) 재사용(읽기 전용).
  //   ⚠ 팀 총괄 API/DTO/저장구조 무변경. 표시 라벨만 보강한다.
  const [masters, setMasters] = useState<
    Array<{ experienceCategory: ExperienceOverallCategory | null; lineName: string; lineCode: string; organizationSlug: string; isActive: boolean }>
  >([]);

  const allCrews = useMemo<OverallBoardCrew[]>(
    () => (board?.parts ?? []).flatMap((p) => p.crews),
    [board],
  );

  // 카테고리 → 연결 라인명. 같은 카테고리 후보 다수면 org 우선, 확장은 활성 종류(온/오프) 우선, 그 외 첫 라인.
  const lineNameByCategory = useMemo(() => {
    const out: Partial<Record<ExperienceOverallCategory, string>> = {};
    for (const c of EXPERIENCE_OVERALL_CATEGORIES) {
      const cands = masters.filter((m) => m.isActive && m.experienceCategory === c.key);
      if (cands.length === 0) continue;
      const orgCands = cands.filter((m) => m.organizationSlug === organization);
      const pool = orgCands.length ? orgCands : cands;
      let chosen = pool[0];
      if (c.key === "extension" && board?.extensionKind) {
        const want = board.extensionKind === "online" ? "온라인" : "오프라인";
        chosen = pool.find((m) => m.lineName.includes(want) || m.lineCode.includes(want)) ?? pool[0];
      }
      out[c.key] = chosen.lineName;
    }
    return out;
  }, [masters, organization, board]);

  const opened = board?.status === "opened";
  const extensionActive = board?.extensionActive ?? false;

  // 보드를 로컬 편집 state 로 흡수(저장값/기본값).
  const hydrate = useCallback((b: BoardDto) => {
    const lc = new Map<string, OverallCell>();
    for (const part of b.parts) {
      for (const crew of part.crews) {
        for (const cat of OVERALL_LEADER_CATEGORIES) {
          lc.set(leaderKey(crew.userId, cat), { ...crew.cells[cat] });
        }
      }
    }
    setLeaderCells(lc);
    const out = new Map<ExperienceOverallCategory, { link: string; description: string }>();
    for (const o of b.outputs) {
      out.set(o.category, { link: o.link, description: o.description });
    }
    setOutputs(out);
  }, []);

  const fetchBoard = useCallback(async () => {
    if (!organization || !teamId || !teamName || !weekId) {
      setBoard(null);
      return;
    }
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        organization,
        week_id: weekId,
        team_id: teamId,
        team_name: teamName,
      });
      const res = await fetch(
        `/api/admin/cluster4/experience/team-overall?${qs.toString()}`,
      );
      const json = await res.json();
      if (json?.success) {
        const b = json.data as BoardDto;
        setBoard(b);
        hydrate(b);
      } else {
        setBoard(null);
        setBanner({ kind: "error", message: json?.error ?? "팀 총괄 데이터를 불러오지 못했습니다" });
      }
    } catch {
      setBoard(null);
      setBanner({ kind: "error", message: "팀 총괄 데이터를 불러오지 못했습니다" });
    } finally {
      setLoading(false);
    }
  }, [organization, teamId, teamName, weekId, hydrate]);

  useEffect(() => {
    // setState 는 effect 본문이 아닌 async 콜백 안에서 호출(동기 cascading 렌더 방지 — 프로젝트 표준 패턴).
    void (async () => {
      await fetchBoard();
    })();
  }, [fetchBoard]);

  // 연결 라인명 — 기존 라인 등록 목록 1회 조회(표시 전용, 팀 총괄 API 무관).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // org 필터 없이 전체 조회 후 클라에서 org 우선 매칭(공통/타 org 라인 누락 방지) — 매니저와 동일 정책.
        const res = await fetch(`/api/admin/cluster4/experience-line-masters`);
        const json = await res.json();
        if (cancelled) return;
        setMasters(json?.success ? (json.data ?? []) : []);
      } catch {
        if (!cancelled) setMasters([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organization]);

  // ── 셀 편집(관리/확장) — 체크/점수 연동 ──
  const getLeaderCell = useCallback(
    (userId: string, category: ExperienceOverallCategory): OverallCell =>
      leaderCells.get(leaderKey(userId, category)) ?? { ...OVERALL_CELL_DEFAULT },
    [leaderCells],
  );

  const setLeaderCell = useCallback(
    (userId: string, category: ExperienceOverallCategory, next: OverallCell) => {
      setLeaderCells((prev) => {
        const m = new Map(prev);
        m.set(leaderKey(userId, category), next);
        return m;
      });
    },
    [],
  );

  const toggleLeaderCheck = useCallback(
    (userId: string, category: ExperienceOverallCategory) => {
      const cur = getLeaderCell(userId, category);
      const nextChecked = !cur.checked;
      // 체크 해제 → 점수 0. 재체크(점수 0이었으면) → 기본 7.
      const nextScore = nextChecked ? (cur.score === 0 ? 7 : cur.score) : 0;
      setLeaderCell(userId, category, { checked: nextChecked, score: nextScore });
    },
    [getLeaderCell, setLeaderCell],
  );

  const setLeaderScore = useCallback(
    (userId: string, category: ExperienceOverallCategory, score: number) => {
      // 점수 선택 → 체크 자동 ON.
      setLeaderCell(userId, category, { checked: true, score });
    },
    [setLeaderCell],
  );

  const getOutput = useCallback(
    (category: ExperienceOverallCategory) =>
      outputs.get(category) ?? { link: "", description: "" },
    [outputs],
  );

  const setOutput = useCallback(
    (category: ExperienceOverallCategory, patch: { link?: string; description?: string }) => {
      setOutputs((prev) => {
        const m = new Map(prev);
        const cur = m.get(category) ?? { link: "", description: "" };
        m.set(category, { ...cur, ...patch });
        return m;
      });
    },
    [],
  );

  // ── payload 빌더 ──
  const buildPayload = useCallback(() => {
    const cells: OverallLeaderCellDto[] = [];
    for (const crew of allCrews) {
      for (const cat of OVERALL_LEADER_CATEGORIES) {
        // 확장은 확장 주간에만 저장.
        if (cat === "extension" && !extensionActive) continue;
        const c = getLeaderCell(crew.userId, cat);
        cells.push({
          crewUserId: crew.userId,
          category: cat as "management" | "extension",
          checked: c.checked,
          score: c.score,
        });
      }
    }
    const outs = EXPERIENCE_OVERALL_CATEGORIES.filter(
      (c) => !(c.key === "extension" && !extensionActive),
    ).map((c) => {
      const o = getOutput(c.key);
      return { category: c.key, link: o.link, description: o.description };
    });
    return { cells, outs };
  }, [allCrews, extensionActive, getLeaderCell, getOutput]);

  const post = useCallback(
    async (action: "review" | "open" | "cancel") => {
      const { cells, outs } = buildPayload();
      const res = await fetch("/api/admin/cluster4/experience/team-overall", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          organization,
          week_id: weekId,
          team_id: teamId,
          team_name: teamName,
          leaderCells: action === "cancel" ? [] : cells,
          outputs: action === "cancel" ? [] : outs,
        }),
      });
      return res.json();
    },
    [buildPayload, organization, weekId, teamId, teamName],
  );

  // ── 버튼 핸들러 ──
  const onReview = useCallback(async () => {
    setSaving(true);
    setBanner(null);
    try {
      const json = await post("review");
      if (!json?.success) {
        setBanner({ kind: "error", message: json?.error ?? "개설 검수 저장에 실패했습니다" });
        return;
      }
      setBanner({ kind: "success", message: "개설 검수 — 임시 저장되었습니다 (고객 미반영)" });
      await fetchBoard();
      onActivity?.();
    } catch {
      setBanner({ kind: "error", message: "개설 검수 중 오류가 발생했습니다" });
    } finally {
      setSaving(false);
    }
  }, [post, fetchBoard, onActivity]);

  const onReset = useCallback(() => {
    // DB 통신 없음 — 프론트 화면 입력값만 기본값으로 복원.
    const lc = new Map<string, OverallCell>();
    for (const crew of allCrews) {
      for (const cat of OVERALL_LEADER_CATEGORIES) {
        lc.set(leaderKey(crew.userId, cat), { ...OVERALL_CELL_DEFAULT });
      }
    }
    setLeaderCells(lc);
    setOutputs(new Map());
    setBanner({
      kind: "success",
      message: "입력값을 기본값으로 초기화했습니다 (저장 안 됨 — 개설 검수/완료 시 저장)",
    });
  }, [allCrews]);

  const onOpen = useCallback(async () => {
    if (!confirm("현재 입력값으로 개설 완료하시겠습니까? 고객 페이지에 실제 반영됩니다.")) return;
    setSaving(true);
    setBanner(null);
    try {
      const json = await post("open");
      if (!json?.success) {
        setBanner({ kind: "error", message: json?.error ?? "개설 완료에 실패했습니다" });
        return;
      }
      const d = json.data as {
        linesCreated: number;
        targetsCreated: number;
        evaluationsCreated: number;
      };
      const warnings: string[] = json.warnings ?? [];
      let msg = `개설 완료 — 라인 ${d.linesCreated}개, 대상 ${d.targetsCreated}명, 평가 ${d.evaluationsCreated}건 (고객 페이지 반영)`;
      if (warnings.length > 0) msg += ` · 경고 ${warnings.length}건: ${warnings.join(" / ")}`;
      setBanner({ kind: warnings.length > 0 ? "error" : "success", message: msg });
      await fetchBoard();
      onActivity?.();
    } catch {
      setBanner({ kind: "error", message: "개설 완료 중 오류가 발생했습니다" });
    } finally {
      setSaving(false);
    }
  }, [post, fetchBoard, onActivity]);

  const onCancel = useCallback(async () => {
    if (!confirm("이미 개설 완료된 정보를 모두 취소하고 고객 페이지 반영을 원복하시겠습니까?")) return;
    setSaving(true);
    setBanner(null);
    try {
      const json = await post("cancel");
      if (!json?.success) {
        setBanner({ kind: "error", message: json?.error ?? "개설 취소에 실패했습니다" });
        return;
      }
      const d = json.data as { linesRemoved: number };
      setBanner({
        kind: "success",
        message: `개설 취소 — 라인 ${d.linesRemoved}개 원복되었습니다 (고객 페이지 원복)`,
      });
      await fetchBoard();
      onActivity?.();
    } catch {
      setBanner({ kind: "error", message: "개설 취소 중 오류가 발생했습니다" });
    } finally {
      setSaving(false);
    }
  }, [post, fetchBoard, onActivity]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!board) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        팀 총괄 데이터를 불러올 수 없습니다.
      </p>
    );
  }

  const partColCount = 3 + EXPERIENCE_OVERALL_CATEGORIES.length; // 이름/파트/상태 + 5열

  return (
    <div className="space-y-4">
      {/* 상태 헤더 */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={board.status} />
        {extensionActive ? (
          <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
            확장 주간 · {board.extensionKind === "online" ? "온라인" : "오프라인"}
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
            확장 비활성 (확장 라인 입력 잠금)
          </span>
        )}
        {opened && (
          <span className="text-xs text-muted-foreground">
            개설 완료됨 — 수정하려면 [개설 취소] 후 진행하세요.
          </span>
        )}
      </div>

      {banner && (
        <div
          className={cn(
            "whitespace-pre-wrap rounded-md border px-3 py-2 text-sm",
            banner.kind === "success"
              ? "border-green-300 bg-green-50 text-green-800"
              : "border-red-300 bg-red-50 text-red-800",
          )}
        >
          {banner.message}
          <button className="float-right" onClick={() => setBanner(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* 데스크톱(lg+): 좌측 콘텐츠(그리드+아웃풋) + 우측 고정 액션 컬럼. 모바일: 세로 stack.
          파트 선택(PartGrid) 화면의 우측 액션 영역과 동일 구조. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1 space-y-4">
      {/* 파트별 그리드 */}
      {board.parts.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          이 팀에 평가 대상 크루가 없습니다.
        </p>
      ) : (
        board.parts.map((part) => (
          <div key={part.partName} className="space-y-2">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold">{part.partName}</h4>
              {part.submitted ? (
                <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-700">
                  신청 완료
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                  미신청 (기본값)
                </span>
              )}
            </div>
            <div className="overflow-x-auto">
              <Table className="min-w-[1000px] table-fixed">
                <BoardColgroup />
                <TableHeader>
                  <TableRow>
                    <TableHead>이름</TableHead>
                    <TableHead>파트</TableHead>
                    <TableHead>크루 상태</TableHead>
                    {EXPERIENCE_OVERALL_CATEGORIES.map((c) => (
                      <TableHead key={c.key} className="text-center">
                        {c.label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {part.crews.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={partColCount}
                        className="py-6 text-center text-sm text-muted-foreground"
                      >
                        크루가 없습니다.
                      </TableCell>
                    </TableRow>
                  ) : (
                    part.crews.map((crew) => (
                      <TableRow key={crew.userId}>
                        <TableCell className="font-medium whitespace-normal break-words">
                          {crew.displayName}
                          {crew.isPartLeader && (
                            <span className="ml-1 text-[11px] text-sky-700">(파트장)</span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-normal break-words text-xs text-muted-foreground">
                          {crew.partName ?? "-"}
                        </TableCell>
                        <TableCell className="whitespace-normal break-words text-xs">
                          {crew.statusLabel}
                        </TableCell>
                        {EXPERIENCE_OVERALL_CATEGORIES.map((c) => {
                          const isLeader = (OVERALL_LEADER_CATEGORIES as string[]).includes(
                            c.key,
                          );
                          if (!isLeader) {
                            // 도출/분석/견문 — 파트신청 라이브, 읽기 전용 표시.
                            const cell = crew.cells[c.key];
                            const fail = isOverallCellFail(cell);
                            return (
                              <TableCell key={c.key} className="text-center">
                                <span
                                  className={cn(
                                    "inline-block rounded-md border px-2 py-1 text-xs",
                                    fail
                                      ? "border-red-400 bg-red-50 text-red-700"
                                      : "border-green-300 bg-green-50 text-green-800",
                                  )}
                                >
                                  {cell.checked ? "✓" : "✕"} {cell.score}
                                </span>
                              </TableCell>
                            );
                          }
                          // 관리/확장 — 팀장 직접 입력(편집).
                          const cell = getLeaderCell(crew.userId, c.key);
                          const fail = isOverallCellFail(cell);
                          const disabled =
                            opened || saving || (c.key === "extension" && !extensionActive);
                          return (
                            <TableCell key={c.key} className="text-center">
                              <div
                                className={cn(
                                  "inline-flex items-center gap-2 rounded-md border px-2 py-1.5",
                                  disabled && c.key === "extension" && !extensionActive
                                    ? "border-dashed border-input bg-muted/40 opacity-60"
                                    : fail
                                      ? "border-red-400 bg-red-50"
                                      : "border-input bg-background",
                                )}
                              >
                                <input
                                  type="checkbox"
                                  className="rounded border-gray-300"
                                  checked={cell.checked}
                                  disabled={disabled}
                                  onChange={() => toggleLeaderCheck(crew.userId, c.key)}
                                  aria-label={`${crew.displayName} ${c.label} 체크`}
                                />
                                <select
                                  className="rounded border border-input bg-background px-1.5 py-0.5 text-sm disabled:opacity-60"
                                  value={cell.score}
                                  disabled={disabled}
                                  onChange={(e) =>
                                    setLeaderScore(crew.userId, c.key, Number(e.target.value))
                                  }
                                  aria-label={`${crew.displayName} ${c.label} 점수`}
                                >
                                  {Array.from({ length: 11 }, (_, i) => i).map((n) => (
                                    <option key={n} value={n}>
                                      {n}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        ))
      )}

      {/* 아웃풋 링크 & 이미지 — 카테고리별 [○○ 류] 라인명 + (링크 6 : 설명 4) 한 줄 입력 */}
      <div className="space-y-4 rounded-md border p-3">
        <p className="text-sm font-semibold">아웃풋 링크 &amp; 이미지</p>
        {EXPERIENCE_OVERALL_CATEGORIES.map((c) => {
          const o = getOutput(c.key);
          const disabled = opened || saving || (c.key === "extension" && !extensionActive);
          const lineName = lineNameByCategory[c.key];
          return (
            <div key={c.key} className="space-y-1.5">
              <p className="text-sm font-medium">
                <span className="text-muted-foreground">[{c.label} 류]</span>{" "}
                {lineName ? (
                  <span>{lineName}</span>
                ) : (
                  <span className="text-muted-foreground">— 연결된 라인 없음</span>
                )}
                {c.key === "extension" && !extensionActive && (
                  <span className="ml-1 text-[11px] text-muted-foreground">(확장 주간 외)</span>
                )}
              </p>
              {/* [링크1][URL 입력][설명1][설명 입력] — 한 행 가로 배치, 라벨 80px·입력칸 flex-1 */}
              <div className="flex w-full items-center gap-2">
                <Label className="w-20 shrink-0 text-xs font-medium text-muted-foreground">
                  링크1
                </Label>
                <Input
                  className="min-w-0 flex-1"
                  value={o.link}
                  disabled={disabled}
                  placeholder="URL 입력"
                  onChange={(e) => setOutput(c.key, { link: e.target.value })}
                />
                <Label className="w-20 shrink-0 text-xs font-medium text-muted-foreground">
                  설명1
                </Label>
                <Input
                  className="min-w-0 flex-1"
                  value={o.description}
                  disabled={disabled}
                  placeholder="설명 입력"
                  onChange={(e) => setOutput(c.key, { description: e.target.value })}
                />
              </div>
            </div>
          );
        })}
      </div>
        </div>
        {/* 우측 고정 액션 컬럼(lg+) — 1열 4행 세로 버튼 그룹. 모바일: 콘텐츠 하단 stack.
            파트 선택 화면의 우측 액션 영역과 동일 구조. 동작/색상/disabled 조건 무변경. */}
        <div className="flex flex-col gap-2 lg:w-36 lg:shrink-0 lg:self-start lg:border-l lg:pl-3">
          <Button
            variant="outline"
            className="w-full justify-center"
            onClick={onReview}
            disabled={saving || opened}
          >
            {saving ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Eye className="mr-1.5 h-4 w-4" />
            )}
            개설 검수
          </Button>
          <Button
            variant="outline"
            className="w-full justify-center"
            onClick={onReset}
            disabled={saving || opened}
          >
            <RotateCcw className="mr-1.5 h-4 w-4" /> 초기화
          </Button>
          <Button
            className="w-full justify-center"
            onClick={onOpen}
            disabled={saving || opened}
          >
            <CheckCircle2 className="mr-1.5 h-4 w-4" /> 개설 완료
          </Button>
          <Button
            variant="outline"
            className="w-full justify-center border-red-300 text-red-700 hover:bg-red-50"
            onClick={onCancel}
            disabled={saving || !opened}
            title={!opened ? "개설 완료 후에만 취소할 수 있습니다" : undefined}
          >
            <XCircle className="mr-1.5 h-4 w-4" /> 개설 취소
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: BoardDto["status"] }) {
  if (status === "opened") {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
        개설 완료
      </span>
    );
  }
  if (status === "reviewed") {
    return (
      <span className="inline-flex items-center rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
        개설 검수 (임시저장)
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
      미진행
    </span>
  );
}
