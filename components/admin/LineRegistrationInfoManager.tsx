"use client";

// /admin/lines (라인 정보 탭) — 모든 클럽에서 사용 중인 라인을 한 표로 보여주는 읽기 전용 화면 (2026-06-27 개편).
//
// 조회 원천 = line_registrations (GET /api/admin/lines/registrations, hub 별 조회로 합산).
//   - 실무 경력(career) 허브는 이 화면에서 제외한다.
//   - 적용 클럽 / 메인 타이틀 표시 정책은 lib/adminLineRegistrationsTypes 의 표시 헬퍼
//     (lineRegistrationDisplayClub · lineRegistrationDisplayMainTitle)를 단일 SoT 로 사용한다.
//   - 기존 4허브 SoT(cluster4_lines · 마스터 · career_projects) · snapshot · 저장 로직은 일절 참조/수정하지 않는다.
//
// 구성: 상단 통계(전체 허브 갯수 / 전체 라인 갯수) → 필터(클럽 단일·허브 다중[확인]·결과 갯수·초기화)
//       → 표(적용 클럽 · 라인 코드 · 라인명 · 소속 허브 · 라인 종류 · 메인 타이틀 내용 · 유닛 버튼).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ExternalLink, RefreshCw, RotateCcw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { TableSkeletonRows } from "@/components/ui/table-skeleton";
import { useReportLoading } from "@/components/admin/loadingBannerContext";
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
  COMMON_CLUB_LABEL,
  LINE_REGISTRATION_HUBS,
  LINE_REGISTRATION_HUB_LABEL,
  lineRegistrationDisplayClub,
  lineRegistrationDisplayMainTitle,
  type LineRegistrationDto,
  type LineRegistrationHub,
  type ListLineRegistrationsResult,
} from "@/lib/adminLineRegistrationsTypes";

// 이 화면이 다루는 허브 — 실무 경력(career)은 제외.
const INFO_HUBS = LINE_REGISTRATION_HUBS.filter(
  (h) => h !== "career",
) as readonly LineRegistrationHub[]; // ["info", "experience", "competency"]

// 적용 클럽 한글 표시 — lineRegistrationDisplayClub 반환(공통/encre/oranke/phalanx/-) → 한글.
const CLUB_KO: Record<string, string> = {
  encre: "엥크레",
  oranke: "오랑캐",
  phalanx: "팔랑크스",
};
function clubKo(raw: string): string {
  return CLUB_KO[raw] ?? raw; // "공통", "-" 는 그대로
}

// 클럽 필터 — value 는 표시 헬퍼 반환값과 매칭하기 위한 키.
type ClubFilter = "-" | "encre" | "oranke" | "phalanx" | "common";
const CLUB_FILTER_OPTIONS: { value: ClubFilter; label: string }[] = [
  { value: "-", label: "-" },
  { value: "encre", label: "엥크레" },
  { value: "oranke", label: "오랑캐" },
  { value: "phalanx", label: "팔랑크스" },
  { value: "common", label: "공통" },
];

// 적용 클럽 필터 매칭 — 표시값(displayClub ∈ {"공통","encre","oranke","phalanx","-"}) 기준.
//   엥크레/오랑캐/팔랑크스 → 해당 클럽 OR 공통 · 공통 → 공통만 · "-" → 조건 없음.
function matchesClub(filter: ClubFilter, displayClub: string): boolean {
  switch (filter) {
    case "-":
      return true;
    case "common":
      return displayClub === COMMON_CLUB_LABEL;
    default:
      return displayClub === filter || displayClub === COMMON_CLUB_LABEL;
  }
}

// 표 정렬 — 허브 → 라인 종류 → 라인 코드 순(안정적). 마지막 tiebreaker = id.
const HUB_ORDER = new Map<string, number>(INFO_HUBS.map((h, i) => [h, i]));
const LINE_TYPE_ORDER = new Map<string, number>(
  ["일반", "도출", "분석", "평가", "관리", "확장", "원리", "기술", "관점", "자원"].map(
    (t, i) => [t, i],
  ),
);

// 공통 라인 중복 제거 — 적용 클럽이 "공통"인 라인은 클럽(encre/oranke/phalanx)별로
// 별도 행이 저장돼 있어(같은 line_code·hub·line_type·라인명) 표에 3번씩 중복 노출된다.
//   → 표시 전에 공통 라인을 line_code + hub + line_type 기준으로 1행만 남긴다.
//   org별 라인(적용 클럽이 공통이 아닌 라인)은 line_code 가 클럽마다 달라 그대로 둔다(잘못 합치지 않음).
function dedupeCommonLines(
  list: readonly LineRegistrationDto[],
): LineRegistrationDto[] {
  const seen = new Set<string>();
  const out: LineRegistrationDto[] = [];
  for (const r of list) {
    const displayClub = lineRegistrationDisplayClub(r.hub, r.lineType, r.organizationSlug);
    if (displayClub === COMMON_CLUB_LABEL) {
      const key = `${r.lineCode}__${r.hub}__${r.lineType}`;
      if (seen.has(key)) continue; // 같은 공통 라인의 클럽별 복제 → 1행만
      seen.add(key);
    }
    out.push(r);
  }
  return out;
}

// 유닛 외부 링크 정규화 — '-'/빈값은 링크 없음(null). http(s) 가 아니면 https:// 보정(베스트 에포트).
function normalizeUnitHref(raw: string): string | null {
  const t = (raw ?? "").trim();
  if (!t || t === "-") return null;
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

function StatCard({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">
        {value === null ? "—" : value.toLocaleString()}
      </p>
    </div>
  );
}

export default function LineRegistrationInfoManager() {
  const [rows, setRows] = useState<LineRegistrationDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  useReportLoading(loading);

  // 클럽 필터(즉시 적용) · 허브 필터(보류 → [확인] 시 적용).
  const [clubFilter, setClubFilter] = useState<ClubFilter>("-");
  const [pendingHubs, setPendingHubs] = useState<Set<LineRegistrationHub>>(new Set());
  const [appliedHubs, setAppliedHubs] = useState<Set<LineRegistrationHub>>(new Set());
  const [hubMenuOpen, setHubMenuOpen] = useState(false);
  // 드롭다운은 body 로 portal 된다(필터 Card 의 overflow-hidden·표/카드 stacking 에 가리지 않게).
  //   trigger 버튼 rect 로 위치(fixed)·너비를 잡고, 스크롤/리사이즈 시 재계산한다.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );

  const computeMenuPos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 192) });
  }, []);

  const openHubMenu = useCallback(() => {
    // 열 때 보류 선택을 현재 적용값으로 동기화(닫았다 다시 열어도 일관).
    setPendingHubs(new Set(appliedHubs));
    computeMenuPos();
    setHubMenuOpen(true);
  }, [appliedHubs, computeMenuPos]);

  // 바깥 클릭 / Esc 로 닫기(보류 선택은 유지 — [확인] 전까지 표 미반영).
  // trigger·portal 메뉴 내부 클릭은 무시한다(메뉴가 body 로 분리돼 있어 둘 다 명시 검사).
  useEffect(() => {
    if (!hubMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setHubMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHubMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [hubMenuOpen]);

  // 열린 동안 스크롤/리사이즈 → 위치 재계산(fixed 좌표라 trigger 를 따라가게).
  useEffect(() => {
    if (!hubMenuOpen) return;
    const onMove = () => computeMenuPos();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [hubMenuOpen, computeMenuPos]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        // 실무 경력(career) 제외 → 3허브를 각각 조회(허브당 200 cap 내). org 스코프 미적용(모든 클럽).
        const results = await Promise.all(
          INFO_HUBS.map(async (h) => {
            const res = await fetch(
              `/api/admin/lines/registrations?hub=${h}&limit=200`,
              { cache: "no-store" },
            );
            const json = await res.json();
            if (!res.ok || !json.success) {
              throw new Error(
                (json && typeof json.error === "string" && json.error) ||
                  `HTTP ${res.status}`,
              );
            }
            return (json.data as ListLineRegistrationsResult).rows;
          }),
        );
        if (cancelled) return;
        // 방어적으로 career 한 번 더 제외(허브별 조회라 이미 없지만 안전망).
        setRows(results.flat().filter((r) => r.hub !== "career"));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "목록을 불러오지 못했습니다");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  // 통계 — 전체 허브 갯수(데이터에 존재하는 비-career 허브 종류 수) · 전체 라인 갯수.
  //   전체 라인 갯수는 공통 라인 중복을 제거한 "구분되는 라인 수"로 센다(클럽별 복제 제외).
  const totalLines = useMemo(
    () => dedupeCommonLines(rows ?? []).length,
    [rows],
  );
  const totalHubs = useMemo(
    () => new Set((rows ?? []).map((r) => r.hub)).size,
    [rows],
  );

  const filtered = useMemo(() => {
    const list = (rows ?? []).filter((r) => {
      const displayClub = lineRegistrationDisplayClub(
        r.hub,
        r.lineType,
        r.organizationSlug,
      );
      if (!matchesClub(clubFilter, displayClub)) return false;
      if (appliedHubs.size > 0 && !appliedHubs.has(r.hub)) return false;
      return true;
    });
    const sorted = [...list].sort((a, b) => {
      const hub = (HUB_ORDER.get(a.hub) ?? 99) - (HUB_ORDER.get(b.hub) ?? 99);
      if (hub !== 0) return hub;
      const type =
        (LINE_TYPE_ORDER.get(a.lineType) ?? 99) -
        (LINE_TYPE_ORDER.get(b.lineType) ?? 99);
      if (type !== 0) return type;
      const code = a.lineCode.localeCompare(b.lineCode, "ko");
      if (code !== 0) return code;
      return a.id.localeCompare(b.id);
    });
    // 정렬 후 공통 라인 중복 제거 → 클럽 필터(엥크레/오랑캐/팔랑크스/-)와 무관하게 공통 라인은 1행만.
    return dedupeCommonLines(sorted);
  }, [rows, clubFilter, appliedHubs]);

  const togglePendingHub = useCallback((hub: LineRegistrationHub) => {
    setPendingHubs((prev) => {
      const next = new Set(prev);
      if (next.has(hub)) next.delete(hub);
      else next.add(hub);
      return next;
    });
  }, []);

  const applyHubs = useCallback(() => {
    setAppliedHubs(new Set(pendingHubs));
    setHubMenuOpen(false);
  }, [pendingHubs]);

  const handleReset = useCallback(() => {
    setClubFilter("-");
    setPendingHubs(new Set());
    setAppliedHubs(new Set());
    setHubMenuOpen(false);
  }, []);

  // 허브 드롭다운 버튼 라벨 — 적용된 허브가 없으면 "-".
  const hubButtonLabel =
    appliedHubs.size === 0
      ? "-"
      : INFO_HUBS.filter((h) => appliedHubs.has(h))
          .map((h) => LINE_REGISTRATION_HUB_LABEL[h])
          .join(", ");

  const statsReady = rows !== null;

  return (
    <div className="flex w-full flex-col gap-4">
      {/* ── 상단 통계 ── */}
      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <StatCard label="전체 허브 갯수" value={statsReady ? totalHubs : null} />
        <StatCard label="전체 라인 갯수" value={statsReady ? totalLines : null} />
      </div>

      {/* ── 필터 ── */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-5 gap-y-3 py-3">
          {/* 클럽 — 즉시 적용 */}
          <div className="flex items-center gap-2">
            <Label className="shrink-0 text-xs text-muted-foreground">클럽</Label>
            <select
              aria-label="클럽 필터"
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={clubFilter}
              onChange={(e) => setClubFilter(e.target.value as ClubFilter)}
            >
              {CLUB_FILTER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {/* 허브 — 다중 선택 후 [확인] 시 적용 */}
          <div className="flex items-center gap-2">
            <Label className="shrink-0 text-xs text-muted-foreground">허브</Label>
            <button
              type="button"
              ref={triggerRef}
              onClick={() => (hubMenuOpen ? setHubMenuOpen(false) : openHubMenu())}
              aria-haspopup="true"
              aria-expanded={hubMenuOpen}
              aria-label="허브 필터"
              className="flex h-8 min-w-32 items-center justify-between gap-2 rounded-md border border-input bg-background px-2 text-sm"
            >
              <span className="truncate">{hubButtonLabel}</span>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
            {hubMenuOpen &&
              menuPos &&
              typeof document !== "undefined" &&
              createPortal(
                <div
                  ref={menuRef}
                  role="menu"
                  style={{
                    position: "fixed",
                    top: menuPos.top,
                    left: menuPos.left,
                    width: menuPos.width,
                    zIndex: 60,
                  }}
                  className="max-h-[60vh] overflow-auto rounded-md border bg-background p-2 shadow-lg"
                >
                  <ul className="space-y-1">
                    {INFO_HUBS.map((h) => (
                      <li key={h}>
                        <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted">
                          <input
                            type="checkbox"
                            checked={pendingHubs.has(h)}
                            onChange={() => togglePendingHub(h)}
                          />
                          {LINE_REGISTRATION_HUB_LABEL[h]}
                        </label>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex justify-end gap-1.5 border-t pt-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setPendingHubs(new Set())}
                    >
                      해제
                    </Button>
                    <Button type="button" size="sm" onClick={applyHubs}>
                      확인
                    </Button>
                  </div>
                </div>,
                document.body,
              )}
          </div>

          {/* 우측: 결과 갯수 + 초기화 + 새로고침 */}
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              결과{" "}
              <span className="font-semibold tabular-nums text-foreground">
                {filtered.length.toLocaleString()}
              </span>
              건
            </span>
            <Button type="button" variant="outline" size="sm" onClick={handleReset}>
              <RotateCcw className="mr-1.5 h-4 w-4" />
              초기화
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRefreshTick((n) => n + 1)}
              disabled={loading}
            >
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              <span className="ml-1.5">새로고침</span>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── 표 ── */}
      {error ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>적용 클럽</TableHead>
                <TableHead>라인 코드</TableHead>
                <TableHead>라인명</TableHead>
                <TableHead>소속 허브</TableHead>
                <TableHead>라인 종류</TableHead>
                <TableHead>메인 타이틀 내용</TableHead>
                <TableHead className="text-center">유닛</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && !rows ? (
                <TableSkeletonRows columns={7} rows={6} />
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-8 text-center text-muted-foreground"
                  >
                    조회 결과가 없습니다.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((row) => {
                  const displayClub = lineRegistrationDisplayClub(
                    row.hub,
                    row.lineType,
                    row.organizationSlug,
                  );
                  // 메인 타이틀 내용 — 허브 정책 SoT(실무 정보=변동 → "-").
                  const mainTitle = lineRegistrationDisplayMainTitle(
                    row.hub,
                    row.mainTitle,
                  ).title;
                  const href = normalizeUnitHref(row.unitLink);
                  return (
                    <TableRow key={row.id}>
                      <TableCell>{clubKo(displayClub)}</TableCell>
                      <TableCell className="font-mono text-xs">{row.lineCode}</TableCell>
                      <TableCell className="max-w-72 font-medium">
                        <span className="block truncate" title={row.lineName}>
                          {row.lineName}
                        </span>
                      </TableCell>
                      <TableCell>{row.hubLabel}</TableCell>
                      <TableCell>{row.lineType}</TableCell>
                      <TableCell className="max-w-72">
                        <span className="block truncate" title={mainTitle}>
                          {mainTitle}
                        </span>
                      </TableCell>
                      <TableCell className="text-center">
                        {href ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={cn(
                              buttonVariants({ variant: "outline", size: "sm" }),
                            )}
                            title="등록된 외부 링크 열기 (새 탭)"
                          >
                            <ExternalLink className="mr-1 h-3.5 w-3.5" />
                            유닛
                          </a>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled
                            title="등록된 유닛 링크가 없습니다"
                          >
                            유닛
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
