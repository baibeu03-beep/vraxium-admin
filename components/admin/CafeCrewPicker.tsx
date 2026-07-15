"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search, Users, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { ADMIN_SHARED_HELP_KEYS } from "@/lib/adminSharedHelpKeys";
import {
  sortCafeCrews,
  CREW_SORT_OPTIONS,
  type CafeCrew,
  type CrewSortKey,
} from "@/lib/cafeCrewSort";
import { excludeAddedByUserId } from "@/lib/crewSearchExclude";

// 라인 개설 크루 선택기 — 네이버 카페 댓글 검수(자동 매칭) + 수동 추가/삭제/초기화.
//   "라인 개설" 폼과 "개설 대상 크루 수정" 모달이 공유하는 단일 UI/로직(SoT). 두 경로가
//   동일한 cafe-line-crew 검수·매칭을 쓰도록 보장한다(divergence 방지).
//
//   - candidates 는 controlled — 부모가 소유(개설 payload / 수정 payload 에 사용).
//   - 카페 검수 메타(cafe_url / matched / raw)는 onMetaChange 로 부모에 노출(감사 저장용).
//   - existingMemberIds: 이미 라인 대상자인 userId — 자동/수동 추가에서 제외하고 "이미 추가됨" 표시.
//   - resetSignal: 값이 바뀌면 내부 입력(카페 URL/검수결과/수동검색)을 초기화한다.
//   - org + mode 는 window.location.search(?org, ?mode)에서 읽어 cafe-line-crew 모집단을 좁힌다
//     (PracticalInfoOpeningForm 기존 동작과 동일 — 조직/운영·테스트 경계 밖 동명이인 제외).

// CafeCrew 타입 + 표시 정렬 로직은 React 무의존 순수 모듈로 분리(단위 테스트 가능).
//   기존 import 경로 호환을 위해 CafeCrew 는 이 파일에서 그대로 재노출한다.
export type { CafeCrew } from "@/lib/cafeCrewSort";

export type CafeCrewMeta = {
  cafeUrl: string;
  rawCommentCount: number;
  matchedCrewCount: number;
} | null;

type CafeReviewItem = { order: number; nickname: string; reason: string };

export default function CafeCrewPicker({
  candidates,
  onCandidatesChange,
  existingMemberIds = [],
  onMetaChange,
  disabled = false,
}: {
  candidates: CafeCrew[];
  onCandidatesChange: (next: CafeCrew[]) => void;
  existingMemberIds?: string[];
  onMetaChange?: (meta: CafeCrewMeta) => void;
  // 내부 입력(카페 URL/검수결과/수동검색) 초기화는 부모가 key 를 바꿔 remount 로 처리한다.
  disabled?: boolean;
}) {
  const [cafeUrl, setCafeUrl] = useState("");
  const [cafeLoading, setCafeLoading] = useState(false);
  const [cafeError, setCafeError] = useState<string | null>(null);
  const [cafeMeta, setCafeMeta] = useState<CafeCrewMeta>(null);
  const [review, setReview] = useState<CafeReviewItem[]>([]);
  // 자동 매칭됐지만 이미 대상자라 추가하지 않은 건수(이번 검수 기준).
  const [skippedExisting, setSkippedExisting] = useState(0);
  const [manualQ, setManualQ] = useState("");
  const [manualResults, setManualResults] = useState<CafeCrew[]>([]);
  const [manualSearching, setManualSearching] = useState(false);
  // 검수 크루 목록 표시 정렬(클라이언트 전용). 기본 = 댓글 시간순(원본 순서).
  const [sortKey, setSortKey] = useState<CrewSortKey>("comment");

  // 표시용 정렬 뷰 — candidates(SoT)는 mutate 하지 않고 순수 helper 로 복사본만 정렬한다.
  //   추가/제거/저장은 여전히 candidates 로 동작(표시 순서만 변경).
  const sortedCandidates = useMemo(
    () => sortCafeCrews(candidates, sortKey),
    [candidates, sortKey],
  );

  const existingSet = useMemo(
    () => new Set(existingMemberIds),
    [existingMemberIds],
  );
  const candidateIds = useMemo(
    () => new Set(candidates.map((c) => c.userId)),
    [candidates],
  );
  // 이미 추가된(대상자 or 후보) userId — 검색 결과에서 완전 제외할 집합(공통 SoT).
  const addedForSearch = useMemo(() => {
    const s = new Set<string>(candidateIds);
    for (const id of existingSet) s.add(id);
    return s;
  }, [candidateIds, existingSet]);
  // 수동 검색 결과: 이미 추가된 크루는 목록에서 완전히 제외(userId 기준). 추가 즉시 사라지고,
  // 삭제하면 addedForSearch 가 줄어 다시 나타난다. org/mode/test/demo 무관 — 순수 필터.
  const visibleManualResults = useMemo(
    () => excludeAddedByUserId(manualResults, addedForSearch, (c) => c.userId),
    [manualResults, addedForSearch],
  );

  const addCandidate = useCallback(
    (crew: CafeCrew) => {
      if (existingSet.has(crew.userId)) return; // 이미 대상자 — 추가 금지(중복 방지)
      if (candidates.some((c) => c.userId === crew.userId)) return;
      onCandidatesChange([...candidates, crew]);
    },
    [candidates, existingSet, onCandidatesChange],
  );
  const removeCandidate = useCallback(
    (userId: string) => {
      onCandidatesChange(candidates.filter((c) => c.userId !== userId));
    },
    [candidates, onCandidatesChange],
  );
  const clearCandidates = useCallback(() => {
    onCandidatesChange([]);
  }, [onCandidatesChange]);

  const handleVerifyCafe = useCallback(async () => {
    if (!cafeUrl.trim()) {
      setCafeError("네이버 카페 게시물 링크를 입력해주세요");
      return;
    }
    setCafeLoading(true);
    setCafeError(null);
    try {
      // 현재 org + mode(운영/테스트) 모집단으로만 매칭 — 조직/모드 경계 밖 동명이인 제외.
      const loc = new URLSearchParams(window.location.search);
      const org = loc.get("org");
      const sp = new URLSearchParams();
      if (org) sp.set("organization", org);
      if (loc.get("mode") === "test") sp.set("mode", "test");
      sp.set("excludeSeasonRest", "1"); // 라인 개설 후보 = 현재 시즌 휴식자 제외
      const res = await fetch(
        `/api/admin/cluster4/cafe-line-crew${sp.toString() ? `?${sp.toString()}` : ""}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: cafeUrl.trim() }),
        },
      );
      const json = await res.json();
      if (!json.success) {
        setCafeError(json.message ?? json.error ?? "검수 실패");
        return;
      }
      const d = json.data as {
        cafeUrl: string;
        rawCommentCount: number;
        matchedCrewCount: number;
        matched: Array<{ crew: CafeCrew }>;
        review: CafeReviewItem[];
      };
      // 자동 매칭 크루를 댓글 시간순 그대로 후보에 채운다 — 기존 후보/기존 대상자와 dedupe.
      const matchedCrews = d.matched.map((m) => m.crew);
      const seen = new Set(candidates.map((c) => c.userId));
      let skipped = 0;
      const fresh: CafeCrew[] = [];
      for (const c of matchedCrews) {
        if (existingSet.has(c.userId)) {
          skipped += 1; // 이미 대상자 — 제외(이미 추가됨)
          continue;
        }
        if (seen.has(c.userId)) continue;
        seen.add(c.userId);
        fresh.push(c);
      }
      if (fresh.length > 0) onCandidatesChange([...candidates, ...fresh]);
      setSkippedExisting(skipped);
      setReview(d.review ?? []);
      const meta: CafeCrewMeta = {
        cafeUrl: d.cafeUrl,
        rawCommentCount: d.rawCommentCount,
        matchedCrewCount: d.matchedCrewCount,
      };
      setCafeMeta(meta);
      onMetaChange?.(meta);
    } catch {
      setCafeError("검수 요청 중 오류가 발생했습니다");
    } finally {
      setCafeLoading(false);
    }
  }, [cafeUrl, candidates, existingSet, onCandidatesChange, onMetaChange]);

  // 수동 추가 검색 — q 디바운스.
  useEffect(() => {
    const q = manualQ.trim();
    if (!q) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setManualSearching(true);
      try {
        const loc = new URLSearchParams(window.location.search);
        const org = loc.get("org");
        const sp = new URLSearchParams({ q });
        if (org) sp.set("organization", org);
        if (loc.get("mode") === "test") sp.set("mode", "test");
        sp.set("excludeSeasonRest", "1"); // 라인 개설 후보 = 현재 시즌 휴식자 제외
        const res = await fetch(`/api/admin/cluster4/cafe-line-crew?${sp.toString()}`);
        const json = await res.json();
        if (cancelled) return;
        setManualResults(json?.success ? (json.data?.crews ?? []) : []);
      } catch {
        if (!cancelled) setManualResults([]);
      } finally {
        if (!cancelled) setManualSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [manualQ]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <Label className="inline-flex items-center gap-1.5 text-sm font-semibold">
          라인 개설 크루
          <AdminHelpIconButton
            size="sm"
            helpKey="admin.lineOpening.info.section.openingCrew"
            title="라인 개설 크루"
          />
        </Label>
        <span className="text-xs text-muted-foreground">
          <Users className="mr-1 inline h-3 w-3" />
          {candidates.length}명
        </span>
      </div>

      {/* 카페 링크 검수 */}
      <div className="space-y-2 rounded-md border p-3">
        <div className="flex items-center gap-1">
          <p className="text-xs font-medium text-muted-foreground">카페 링크 검수</p>
          <AdminHelpIconButton
            helpKey="admin.lineOpening.info.filter.cafeUrl"
            title="카페 게시물 링크"
            size="xs"
          />
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={cafeUrl}
            onChange={(e) => setCafeUrl(e.target.value)}
            placeholder="https://cafe.naver.com/... (게시물 링크)"
            aria-label="카페 게시물 링크"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !cafeLoading) handleVerifyCafe();
            }}
            disabled={disabled || cafeLoading}
          />
          <Button
            type="button"
            onClick={handleVerifyCafe}
            loading={cafeLoading}
            disabled={disabled || cafeLoading}
            className="shrink-0"
          >
            <Search className="mr-2 h-4 w-4" />
            검수
          </Button>
          <AdminHelpIconButton
            helpKey="admin.lineOpening.info.action.verifyCafe"
            title="검수(매칭)"
            size="xs"
          />
        </div>
        {cafeError && <p className="text-sm text-red-600">{cafeError}</p>}
        {cafeMeta && (
          <p className="text-xs text-muted-foreground">
            원본 댓글 {cafeMeta.rawCommentCount} · 자동 매칭 {cafeMeta.matchedCrewCount} · 수동
            확인 {review.length}
            {skippedExisting > 0 ? ` · 이미 추가됨 ${skippedExisting}` : ""}
          </p>
        )}
      </div>

      {/* 인원 수 + 초기화 + 수동 추가 (한 줄, 목록 위) */}
      <div className="space-y-2 rounded-md border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            <Users className="mr-1 inline h-3 w-3" />
            개설 크루 {candidates.length}명
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={clearCandidates}
            disabled={disabled || candidates.length === 0}
          >
            초기화
          </Button>
          <AdminHelpIconButton
            helpKey="admin.lineOpening.info.action.clearCrew"
            title="개설 크루 초기화"
            size="xs"
          />
          <AdminHelpIconButton
            helpKey="admin.lineOpening.info.filter.manualSearch"
            title="크루 수동 추가 검색"
            size="xs"
          />
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="크루 수동 추가 검색..."
              value={manualQ}
              onChange={(e) => setManualQ(e.target.value)}
              aria-label="크루 수동 추가 검색"
              disabled={disabled}
            />
          </div>
        </div>
        {manualQ.trim() && (
          <div className="max-h-52 overflow-y-auto rounded-md border">
            {manualSearching ? (
              <p className="flex items-center gap-1.5 px-3 py-3 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> 검색 중…
              </p>
            ) : visibleManualResults.length === 0 ? (
              <p className="px-3 py-3 text-sm text-muted-foreground">검색 결과가 없습니다</p>
            ) : (
              visibleManualResults.map((c) => (
                <div
                  key={c.userId}
                  className="flex items-center justify-between gap-2 border-b px-3 py-2 text-sm last:border-0"
                >
                  <span className="min-w-0 truncate">
                    <span className="font-mono text-xs text-muted-foreground">
                      {c.crewCode ?? "-"}
                    </span>{" "}
                    <span className="font-medium">{c.name || "-"}</span>{" "}
                    <span className="text-xs text-muted-foreground">
                      {c.teamName ?? "-"} · {c.schoolName ?? "-"} · {c.majorName ?? "-"}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => addCandidate(c)}
                  >
                    추가
                  </Button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* 수동 확인 필요 (자동 매칭 안 됨 — 직접 검색해 추가). */}
      {review.length > 0 && (
        <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3">
          <p className="text-xs font-medium text-amber-800">
            수동 확인 필요 {review.length}건 — 자동 매칭하지 않았습니다(오매칭 방지). 위
            &quot;수동 추가&quot;로 직접 확인 후 넣어주세요.
          </p>
          <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs text-amber-900">
            {review.map((r) => (
              <li key={`${r.order}-${r.nickname}`} className="truncate">
                · <span className="font-medium">{r.nickname}</span>{" "}
                <span className="text-amber-700">({r.reason})</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 검수 크루 목록 — 표시 정렬(클라이언트 전용, DTO/저장 불변) */}
      <div className="space-y-2 rounded-md border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex items-center gap-1">
            <p className="text-xs font-medium text-muted-foreground">검수 크루 목록</p>
            <AdminHelpIconButton
              helpKey="admin.lineOpening.info.section.reviewCrewList"
              title="검수 크루 목록"
              size="xs"
            />
          </div>
          <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            정렬
            <select
              className="rounded-md border border-input bg-background px-2 py-1 text-xs"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as CrewSortKey)}
              aria-label="검수 크루 목록 정렬"
              disabled={disabled}
            >
              {CREW_SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {candidates.length === 0 ? (
          <p className="py-3 text-center text-sm text-muted-foreground">후보가 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-2 py-1.5">
                    <span className="inline-flex items-center gap-1">
                      크루 코드
                      <AdminHelpIconButton
                        helpKey={ADMIN_SHARED_HELP_KEYS.crew.code}
                        title="크루 코드"
                        size="xs"
                      />
                    </span>
                  </th>
                  <th className="px-2 py-1.5">
                    <span className="inline-flex items-center gap-1">
                      이름
                      <AdminHelpIconButton
                        helpKey={ADMIN_SHARED_HELP_KEYS.crew.name}
                        title="이름"
                        size="xs"
                      />
                    </span>
                  </th>
                  <th className="px-2 py-1.5">
                    <span className="inline-flex items-center gap-1">
                      팀명
                      <AdminHelpIconButton
                        helpKey="admin.lineOpening.info.cafe.column.teamName"
                        title="팀명"
                        size="xs"
                      />
                    </span>
                  </th>
                  <th className="px-2 py-1.5">
                    <span className="inline-flex items-center gap-1">
                      파트명
                      <AdminHelpIconButton
                        helpKey="admin.lineOpening.info.cafe.column.partName"
                        title="파트명"
                        size="xs"
                      />
                    </span>
                  </th>
                  <th className="px-2 py-1.5">
                    <span className="inline-flex items-center gap-1">
                      학교명
                      <AdminHelpIconButton
                        helpKey="admin.lineOpening.info.cafe.column.schoolName"
                        title="학교명"
                        size="xs"
                      />
                    </span>
                  </th>
                  <th className="px-2 py-1.5">
                    <span className="inline-flex items-center gap-1">
                      전공명
                      <AdminHelpIconButton
                        helpKey="admin.lineOpening.info.cafe.column.majorName"
                        title="전공명"
                        size="xs"
                      />
                    </span>
                  </th>
                  <th className="px-2 py-1.5">
                    <span className="inline-flex items-center gap-1">
                      삭제
                      <AdminHelpIconButton
                        helpKey="admin.lineOpening.info.cafe.column.remove"
                        title="삭제"
                        size="xs"
                      />
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedCandidates.map((c) => (
                  <tr key={c.userId} className="border-b last:border-0">
                    <td className="px-2 py-1.5 font-mono text-xs">{c.crewCode ?? "-"}</td>
                    <td className="px-2 py-1.5 font-medium">{c.name || "-"}</td>
                    <td className="px-2 py-1.5 text-xs">{c.teamName ?? "-"}</td>
                    <td className="px-2 py-1.5 text-xs">{c.partName ?? "-"}</td>
                    <td className="px-2 py-1.5 text-xs">{c.schoolName ?? "-"}</td>
                    <td className="px-2 py-1.5 text-xs">{c.majorName ?? "-"}</td>
                    <td className="px-2 py-1.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => removeCandidate(c.userId)}
                        aria-label={`${c.name} 제거`}
                        disabled={disabled}
                      >
                        <X className="h-4 w-4 text-red-500" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
