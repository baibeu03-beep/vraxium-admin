"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { adminDialog } from "@/components/ui/admin-dialog";
import { LoadingState } from "@/components/ui/loading-state";
import { cn } from "@/lib/utils";
import CafeCrewPicker, {
  type CafeCrew,
  type CafeCrewMeta,
} from "@/components/admin/CafeCrewPicker";
import { useAdminDevMode } from "@/components/admin/useAdminDevMode";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import { ADMIN_SHARED_HELP_KEYS } from "@/lib/adminSharedHelpKeys";

// 실무 정보 — "개설 대상 크루 수정" 모달.
//   이미 개설된 (과거) 라인의 개설 대상 크루를 카페 검수 UI(CafeCrewPicker)로 사후 수정한다.
//   - 상단 "현재 개설 대상 크루" 섹션: 이름/팀·파트/학교·전공 + [제외](모달 내부 pending change).
//   - mode='add'(기본)  : 기존 대상자 유지(+제외 예정 반영) + 검수된 크루 추가(중복은 "이미 추가됨").
//   - mode='replace'    : 기존 user 대상자를 검수된 집합으로 전부 교체.
//   - 저장 = PATCH /api/admin/cluster4/info-lines/crew — pending 제외 + 추가/교체를 한 번에 반영.
//     · add + 제외 없음            → mode='add'(기존 유지 + 추가).
//     · add + 제외 있음 / replace  → mode='replace'(최종 집합으로 교체) — 한 번의 호출로 add/remove 동시.
//   - 허용 주차 게이트(25겨울 W1 ~ 26봄 W11)는 서버가 fail-closed 로 강제(버튼 노출도 동일 게이트).
//   - 현재 대상자/매칭은 운영·테스트(demoUserId) 경로 모두 같은 CrewRecord DTO(GET ?mode 동봉).

export default function PracticalInfoCrewEditModal({
  lineId,
  weekId,
  activityTypeId,
  lineName,
  weekLabel,
  mainTitle,
  onClose,
  onSaved,
}: {
  lineId: string;
  weekId: string;
  activityTypeId: string;
  lineName: string;
  weekLabel: string;
  mainTitle: string | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const devMode = useAdminDevMode();
  const [editMode, setEditMode] = useState<"add" | "replace">("add");
  const [candidates, setCandidates] = useState<CafeCrew[]>([]);
  const [, setMeta] = useState<CafeCrewMeta>(null);

  // 현재 개설 대상 크루(enriched). GET /info-lines/crew — 이름/팀·파트/학교·전공/crew_no.
  const [existing, setExisting] = useState<CafeCrew[]>([]);
  const [loadingExisting, setLoadingExisting] = useState(true);
  // [제외] 로 마킹된 현재 대상자 userId(저장 전까지 DB 미반영 · 모달 내부 pending change).
  const [pendingRemovals, setPendingRemovals] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 현재 대상자 조회 — info-lines/crew GET(line_id + week_id + org + mode, enriched DTO).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingExisting(true);
      try {
        const loc = new URLSearchParams(window.location.search);
        const qs = new URLSearchParams({ line_id: lineId, week_id: weekId });
        const org = loc.get("org");
        if (org) qs.set("organization", org);
        if (loc.get("mode") === "test") qs.set("mode", "test");
        const res = await fetch(
          `/api/admin/cluster4/info-lines/crew?${qs.toString()}`,
        );
        const json = await res.json();
        if (cancelled) return;
        const rows: CafeCrew[] = json?.success ? (json.data?.targets ?? []) : [];
        setExisting(rows);
        if (!json?.success) setError(json?.error ?? "기존 대상자를 불러오지 못했습니다");
      } catch {
        if (!cancelled) setError("기존 대상자를 불러오지 못했습니다");
      } finally {
        if (!cancelled) setLoadingExisting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lineId, weekId, activityTypeId]);

  const toggleRemoval = useCallback((userId: string) => {
    setPendingRemovals((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }, []);

  // 모드 전환: replace 로 가면 개별 제외 마킹은 의미 없음(전체 교체) → 초기화.
  const switchMode = useCallback((mode: "add" | "replace") => {
    setEditMode(mode);
    if (mode === "replace") setPendingRemovals(new Set());
  }, []);

  // 유지될 현재 대상자(add 모드: 제외 예정 제거 / replace 모드: 전부 빠짐).
  const keptExisting = useMemo(
    () =>
      editMode === "replace"
        ? []
        : existing.filter((e) => !pendingRemovals.has(e.userId)),
    [editMode, existing, pendingRemovals],
  );

  // 카페 검수에서 "이미 추가됨"으로 제외할 대상 = 유지될 현재 대상자.
  //   (제외 예정이거나 replace 모드면 후보로 다시 넣을 수 있게 제외하지 않는다.)
  const existingMemberIds = useMemo(
    () => keptExisting.map((e) => e.userId),
    [keptExisting],
  );

  // 저장 후 최종 대상 userId 집합.
  const finalUserIds = useMemo(() => {
    const ids =
      editMode === "replace"
        ? candidates.map((c) => c.userId)
        : [...keptExisting.map((e) => e.userId), ...candidates.map((c) => c.userId)];
    return Array.from(new Set(ids));
  }, [editMode, candidates, keptExisting]);

  // 제외(저장 시) 미리보기 — add: 제외 예정 / replace: 현재 대상자 중 후보에 없는 사람.
  const candidateIdSet = useMemo(
    () => new Set(candidates.map((c) => c.userId)),
    [candidates],
  );
  const removalPreview = useMemo(
    () =>
      editMode === "replace"
        ? existing.filter((e) => !candidateIdSet.has(e.userId))
        : existing.filter((e) => pendingRemovals.has(e.userId)),
    [editMode, existing, candidateIdSet, pendingRemovals],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const loc = new URLSearchParams(window.location.search);
      const sp = new URLSearchParams();
      const org = loc.get("org");
      if (org) sp.set("organization", org);
      if (loc.get("mode") === "test") sp.set("mode", "test");

      // 반영 방식 매핑:
      //   add + 제외 없음 → mode='add'(기존 유지 + 추가, 기존 동작 그대로).
      //   add + 제외 있음 / replace → mode='replace'(최종 집합) — add/remove 를 한 번에 반영.
      const useReplace =
        editMode === "replace" || pendingRemovals.size > 0;
      const apiMode = useReplace ? "replace" : "add";
      const apiIds = useReplace ? finalUserIds : candidates.map((c) => c.userId);

      const res = await fetch(
        `/api/admin/cluster4/info-lines/crew${sp.toString() ? `?${sp.toString()}` : ""}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            line_id: lineId,
            week_id: weekId,
            mode: apiMode,
            target_user_ids: apiIds,
          }),
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json?.error ?? `수정에 실패했습니다 (HTTP ${res.status})`);
        return;
      }
      const d = json.data as {
        added: string[];
        alreadyPresent: string[];
        removed: string[];
        finalUserCount: number;
      };
      const parts: string[] = [];
      if (d.added.length) parts.push(`추가 ${d.added.length}명`);
      if (d.removed.length) parts.push(`제외 ${d.removed.length}명`);
      if (apiMode === "add" && d.alreadyPresent.length)
        parts.push(`이미 추가됨 ${d.alreadyPresent.length}명`);
      if (parts.length === 0) parts.push("변경 없음");
      parts.push(`현재 대상 ${d.finalUserCount}명`);
      onSaved(`개설 대상 크루가 수정되었습니다 (${parts.join(" · ")})`);
    } catch {
      setError("수정 중 오류가 발생했습니다");
    } finally {
      setSaving(false);
    }
  }, [lineId, weekId, editMode, candidates, finalUserIds, pendingRemovals, onSaved]);

  const canSave = !saving && !loadingExisting;
  const hasChanges =
    candidates.length > 0 || pendingRemovals.size > 0 || editMode === "replace";

  // 저장 전 확인(공통 adminDialog·warning) — 요약 + 주의 문구. 확인 시 handleSave 실행.
  const requestSave = () =>
    adminDialog.confirm({
      variant: "warning",
      title: "개설 대상 크루 수정 확인",
      confirmLabel: "저장",
      description: (
        <div className="space-y-3">
          <dl className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
            <div className="flex gap-2">
              <dt className="w-32 shrink-0 whitespace-nowrap text-muted-foreground">주차</dt>
              <dd className="font-medium">{weekLabel}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-32 shrink-0 whitespace-nowrap text-muted-foreground">라인</dt>
              <dd className="font-medium">{lineName}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-32 shrink-0 whitespace-nowrap text-muted-foreground">반영 방식</dt>
              <dd className="font-medium">
                {editMode === "add" ? "기존 유지 + 추가" : "전체 교체"}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-32 shrink-0 whitespace-nowrap text-muted-foreground">검수 크루</dt>
              <dd className="font-medium">{candidates.length}명</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-32 shrink-0 whitespace-nowrap text-muted-foreground">제외</dt>
              <dd className="font-medium text-red-600">{removalPreview.length}명</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-32 shrink-0 whitespace-nowrap text-muted-foreground">저장 후 대상</dt>
              <dd className="font-medium">{finalUserIds.length}명</dd>
            </div>
          </dl>
          <p className="text-xs text-amber-700 dark:text-amber-500">
            주의: 저장 후 해당 주차/라인의 대상 크루 상태가 변경되고 크루 페이지에 반영됩니다.
          </p>
        </div>
      ),
      onConfirm: handleSave,
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-8">
      <div
        className="max-h-[90vh] modal-w-xl space-y-5 overflow-y-auto rounded-xl bg-background p-6 shadow-xl ring-1 ring-foreground/10"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">
              {lineName} · {weekLabel}
            </p>
            <h2 className="truncate text-lg font-bold">개설 대상 크루 수정</h2>
            {mainTitle ? (
              <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{mainTitle}</p>
            ) : null}
            {devMode ? (
              <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                lineId: {lineId}
              </p>
            ) : null}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} disabled={saving}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        {error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        )}

        {/* 현재 개설 대상 크루 (이름/팀·파트/학교·전공 + [제외] pending) */}
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="inline-flex items-center gap-1.5 text-sm font-semibold">
              현재 개설 대상 크루
              <AdminHelpIconButton
                size="sm"
                helpKey="admin.lineOpening.info.crewEdit.section.currentCrew"
                title="현재 개설 대상 크루"
              />
              {" "}
              <span className="text-muted-foreground">
                {loadingExisting ? "…" : `${existing.length}명`}
              </span>
            </p>
            {!loadingExisting && (pendingRemovals.size > 0 || editMode === "replace") && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                저장 후 예상 {finalUserIds.length}명
                {removalPreview.length > 0 ? ` · 제외 ${removalPreview.length}명` : ""}
              </span>
            )}
          </div>

          {editMode === "replace" && existing.length > 0 && (
            <p className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-700">
              전체 교체 모드 — 아래 현재 대상자는 모두 제외되고, 검수된 크루로 교체됩니다.
            </p>
          )}

          {loadingExisting ? (
            <LoadingState active />
          ) : existing.length === 0 ? (
            <p className="py-3 text-center text-sm text-muted-foreground">
              현재 개설 대상 크루가 없습니다 (0명 개설 상태).
            </p>
          ) : (
            <div className="max-h-60 overflow-y-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/60">
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
                        팀 · 파트
                        <AdminHelpIconButton
                          helpKey="admin.lineOpening.info.crewEdit.column.teamPart"
                          title="팀 · 파트"
                          size="xs"
                        />
                      </span>
                    </th>
                    <th className="px-2 py-1.5">
                      <span className="inline-flex items-center gap-1">
                        학교 · 전공
                        <AdminHelpIconButton
                          helpKey="admin.lineOpening.info.crewEdit.column.schoolMajor"
                          title="학교 · 전공"
                          size="xs"
                        />
                      </span>
                    </th>
                    <th className="px-2 py-1.5 text-right">
                      <span className="inline-flex items-center gap-1">
                        제외
                        <AdminHelpIconButton
                          helpKey="admin.lineOpening.info.crewEdit.column.remove"
                          title="제외"
                          size="xs"
                        />
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {existing.map((e) => {
                    const removed = editMode === "replace" || pendingRemovals.has(e.userId);
                    return (
                      <tr
                        key={e.userId}
                        className={cn(
                          "border-b last:border-0",
                          removed && "bg-red-50/60 text-muted-foreground line-through",
                        )}
                      >
                        <td className="px-2 py-1.5 font-mono text-xs">{e.crewCode ?? "-"}</td>
                        <td className="px-2 py-1.5 font-medium">{e.name || "-"}</td>
                        <td className="px-2 py-1.5 text-xs">
                          {(e.teamName ?? "-") + " · " + (e.partName ?? "-")}
                        </td>
                        <td className="px-2 py-1.5 text-xs">
                          {(e.schoolName ?? "-") + " · " + (e.majorName ?? "-")}
                        </td>
                        <td className="px-2 py-1.5 text-right">
                          {editMode === "replace" ? (
                            <span className="text-xs text-red-600 no-underline">교체 제외</span>
                          ) : pendingRemovals.has(e.userId) ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 gap-1 text-xs no-underline"
                              onClick={() => toggleRemoval(e.userId)}
                              disabled={saving}
                            >
                              <Undo2 className="h-3.5 w-3.5" /> 되돌리기
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 gap-1 text-xs text-red-600"
                              onClick={() => toggleRemoval(e.userId)}
                              disabled={saving}
                              aria-label={`${e.name} 제외`}
                            >
                              <X className="h-3.5 w-3.5" /> 제외
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 반영 방식 — add(기본) / replace */}
        <div className="space-y-2 rounded-md border p-3">
          <p className="inline-flex items-center gap-1.5 text-sm font-semibold">
            반영 방식
            <AdminHelpIconButton
              size="sm"
              helpKey="admin.lineOpening.info.crewEdit.section.applyMode"
              title="반영 방식"
            />
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={editMode === "add"}
              onClick={() => switchMode("add")}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm transition-colors",
                editMode === "add"
                  ? "border-primary bg-primary/10 font-semibold text-primary"
                  : "border-input bg-background font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              기존 유지 + 추가 (기본)
            </button>
            <button
              type="button"
              aria-pressed={editMode === "replace"}
              onClick={() => switchMode("replace")}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm transition-colors",
                editMode === "replace"
                  ? "border-red-500 bg-red-50 font-semibold text-red-700 dark:bg-red-950/40 dark:text-red-300"
                  : "border-input bg-background font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              전체 교체
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {editMode === "add"
              ? "기존 대상자는 그대로 두고(제외 예정 제외), 검수된 크루를 추가합니다. 이미 대상자인 크루는 \"이미 추가됨\"으로 제외됩니다."
              : "기존 대상자를 모두 제외하고, 검수된 크루로 전부 교체합니다. (주의: 기존 대상자가 빠집니다)"}
          </p>
        </div>

        {/* 카페 검수 UI (공용 CafeCrewPicker) */}
        <CafeCrewPicker
          candidates={candidates}
          onCandidatesChange={setCandidates}
          onMetaChange={setMeta}
          existingMemberIds={existingMemberIds}
          disabled={saving}
        />

        {/* 액션 */}
        <div className="flex items-center justify-between gap-3 border-t pt-4">
          <p className="text-xs text-muted-foreground">
            {editMode === "add" ? "추가" : "교체"} 대상 검수 크루:{" "}
            <span className="font-medium text-foreground">{candidates.length}명</span>
            {editMode === "add" && pendingRemovals.size > 0 ? (
              <>
                {" · "}
                <span className="font-medium text-red-600">제외 {pendingRemovals.size}명</span>
              </>
            ) : null}
          </p>
          <div className="flex gap-3">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              닫기
            </Button>
            <Button
              onClick={() => void requestSave()}
              disabled={!canSave || !hasChanges}
              loading={saving}
            >
              수정 저장
            </Button>
          </div>
        </div>
      </div>

      {/* 저장 확인은 공통 adminDialog(warning)로 대체됨(requestSave). */}
    </div>
  );
}
