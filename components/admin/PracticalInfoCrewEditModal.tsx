"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import CafeCrewPicker, {
  type CafeCrew,
  type CafeCrewMeta,
} from "@/components/admin/CafeCrewPicker";

// 실무 정보 — "개설 대상 크루 수정" 모달.
//   이미 개설된 (과거) 라인의 개설 대상 크루를 카페 검수 UI(CafeCrewPicker)로 사후 수정한다.
//   - mode='add'(기본)  : 기존 대상자 유지 + 검수된 크루 추가(중복은 "이미 추가됨").
//   - mode='replace'    : 기존 user 대상자를 검수된 집합으로 전부 교체.
//   - 저장 = PATCH /api/admin/cluster4/info-lines/crew (org+mode 쿼리 동봉, 서버 스코프 가드).
//   - 허용 주차 게이트(25겨울 W1 ~ 26봄 W11)는 서버가 fail-closed 로 강제(버튼 노출도 동일 게이트).

type ExistingTarget = { userId: string; displayName: string };

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
  const [editMode, setEditMode] = useState<"add" | "replace">("add");
  const [candidates, setCandidates] = useState<CafeCrew[]>([]);
  const [, setMeta] = useState<CafeCrewMeta>(null);

  const [existing, setExisting] = useState<ExistingTarget[]>([]);
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // 기존 대상자 조회 — info-lines GET(week_id + activity_type_id + organization).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingExisting(true);
      try {
        const loc = new URLSearchParams(window.location.search);
        const org = loc.get("org");
        const qs = new URLSearchParams({
          week_id: weekId,
          activity_type_id: activityTypeId,
        });
        if (org) qs.set("organization", org);
        const res = await fetch(`/api/admin/cluster4/info-lines?${qs.toString()}`);
        const json = await res.json();
        if (cancelled) return;
        const rows = json?.success ? (json.data?.rows ?? []) : [];
        const line = rows.find((r: { id: string }) => r.id === lineId) ?? null;
        const targets: ExistingTarget[] = line
          ? (line.targets ?? [])
              .filter(
                (t: { targetMode: string; targetUserId: string | null }) =>
                  t.targetMode === "user" && t.targetUserId,
              )
              .map((t: { targetUserId: string; displayName: string }) => ({
                userId: t.targetUserId,
                displayName: t.displayName,
              }))
          : [];
        setExisting(targets);
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

  // add 모드: 기존 대상자를 "이미 추가됨"으로 제외. replace 모드: 전부 교체하므로 제외 없음.
  const existingMemberIds = useMemo(
    () => (editMode === "add" ? existing.map((e) => e.userId) : []),
    [editMode, existing],
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
      const res = await fetch(
        `/api/admin/cluster4/info-lines/crew${sp.toString() ? `?${sp.toString()}` : ""}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            line_id: lineId,
            week_id: weekId,
            mode: editMode,
            target_user_ids: candidates.map((c) => c.userId),
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
      const parts = [`추가 ${d.added.length}명`];
      if (d.alreadyPresent.length) parts.push(`이미 추가됨 ${d.alreadyPresent.length}명`);
      if (d.removed.length) parts.push(`제외 ${d.removed.length}명`);
      parts.push(`현재 대상 ${d.finalUserCount}명`);
      onSaved(`개설 대상 크루가 수정되었습니다 (${parts.join(" · ")})`);
    } catch {
      setError("수정 중 오류가 발생했습니다");
    } finally {
      setSaving(false);
      setConfirmOpen(false);
    }
  }, [lineId, weekId, editMode, candidates, onSaved]);

  const canSave = !saving && !loadingExisting;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8">
      <div
        className="w-full max-w-3xl space-y-5 rounded-lg bg-background p-6 shadow-xl"
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

        {/* 반영 방식 — add(기본) / replace */}
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-semibold">반영 방식</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setEditMode("add")}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                editMode === "add"
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-input bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              기존 유지 + 추가 (기본)
            </button>
            <button
              type="button"
              onClick={() => setEditMode("replace")}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
                editMode === "replace"
                  ? "border-red-400 bg-red-50 text-red-700"
                  : "border-input bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              전체 교체
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {editMode === "add"
              ? "기존 대상자는 그대로 두고, 검수된 크루를 추가합니다. 이미 대상자인 크루는 \"이미 추가됨\"으로 제외됩니다."
              : "기존 대상자를 모두 제외하고, 검수된 크루로 전부 교체합니다. (주의: 기존 대상자가 빠집니다)"}
          </p>
        </div>

        {/* 현재 대상자 (읽기 전용) */}
        <div className="space-y-1 rounded-md border p-3">
          <p className="text-sm font-semibold">
            현재 대상자{" "}
            <span className="text-muted-foreground">
              ({loadingExisting ? "…" : existing.length}명)
            </span>
          </p>
          {loadingExisting ? (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 불러오는 중…
            </p>
          ) : existing.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              현재 대상자가 없습니다 (0명 개설 상태).
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {existing.map((e) => e.displayName).join(", ")}
            </p>
          )}
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
          </p>
          <div className="flex gap-3">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              닫기
            </Button>
            <Button onClick={() => setConfirmOpen(true)} disabled={!canSave}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              수정 저장
            </Button>
          </div>
        </div>
      </div>

      {/* 확인 모달 */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={() => !saving && setConfirmOpen(false)}
        >
          <div
            className="w-full max-w-md space-y-4 rounded-lg bg-background p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold">개설 대상 크루 수정 확인</h3>
            <dl className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">주차</dt>
                <dd className="font-medium">{weekLabel}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">라인</dt>
                <dd className="font-medium">{lineName}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">반영 방식</dt>
                <dd className="font-medium">
                  {editMode === "add" ? "기존 유지 + 추가" : "전체 교체"}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">검수 크루</dt>
                <dd className="font-medium">{candidates.length}명</dd>
              </div>
            </dl>
            <p className="text-xs text-amber-700">
              주의: 저장 후 해당 주차/라인의 대상 크루 상태가 변경되고 고객 앱에 반영됩니다.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="outline"
                onClick={() => setConfirmOpen(false)}
                disabled={saving}
              >
                취소
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                확인
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
