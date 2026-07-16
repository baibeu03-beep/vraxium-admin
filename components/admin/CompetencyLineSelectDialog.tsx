"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { adminDialog } from "@/components/ui/admin-dialog";
import { useActionToast } from "@/lib/actionToast";
import { type ScopeMode } from "@/lib/userScopeShared";
import { type CrewIdentity } from "@/components/admin/crew/CrewIdentityCards";

// 실무 역량 "강화 실패 placeholder(라인명 -) → 강화 성공(라인 선택)" 전용 팝업.
//   강화 성공 선택 시 개설된 역량 활동 마스터 드롭다운이 뜨고, 선택하면 그 라인의 메인타이틀·링크·이미지가
//   조회 전용으로 로드된다. 저장 = 선택 마스터로 이 크루 전용 라인 인스턴스 + 대상자 생성(강화 성공).
//   ⚠ 이 팝업은 실무 역량 placeholder(비대상) 전용. 실제 라인 편집/성공→실패는 일반 라인 상세 팝업이 담당.

type MasterOption = {
  masterId: string;
  lineCode: string | null;
  lineName: string;
  mainTitle: string | null;
  previewLink: string | null;
  previewImage: string | null;
};
type Result = "fail" | "success";

export default function CompetencyLineSelectDialog({
  userId,
  weekId,
  weekLabel,
  mode,
  member,
  onClose,
  onSaved,
}: {
  userId: string;
  weekId: string;
  weekLabel: string | null;
  mode: ScopeMode;
  member: CrewIdentity | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useActionToast();
  const [options, setOptions] = useState<MasterOption[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result>("fail");
  const [selectedId, setSelectedId] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const ctxQuery = mode === "test" ? "?mode=test" : "";

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/admin/members/${userId}/weeks/${weekId}/competency-lines${ctxQuery}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json?.error ?? "역량 라인 목록을 불러오지 못했습니다.");
        if (alive) setOptions((json.data.options ?? []) as MasterOption[]);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "역량 라인 목록을 불러오지 못했습니다.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId, weekId, ctxQuery]);

  const selected = useMemo(
    () => options?.find((o) => o.masterId === selectedId) ?? null,
    [options, selectedId],
  );

  const requestClose = useCallback(async () => {
    if (saving) return;
    if (result === "success" && selectedId) {
      const ok = await adminDialog.confirm({
        variant: "warning",
        title: "닫기",
        description: "저장하지 않은 선택이 있습니다.\n팝업을 닫으시겠습니까?",
        confirmLabel: "닫기",
      });
      if (!ok) return;
    }
    onClose();
  }, [saving, result, selectedId, onClose]);

  const post = useCallback(
    async (confirmGrowthFlip: boolean) => {
      const res = await fetch(`/api/admin/members/${userId}/weeks/${weekId}/competency-lines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ masterId: selectedId, confirmGrowthFlip, mode }),
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, ok: res.ok, json };
    },
    [userId, weekId, selectedId, mode],
  );

  const doSave = useCallback(async () => {
    // 강화 실패로 저장 = 대상자 아님 유지(변경 없음) — 그냥 닫는다.
    if (result === "fail") {
      onClose();
      return;
    }
    if (!selectedId) {
      await adminDialog.alert({
        variant: "warning",
        title: "실무 역량 라인 선택",
        description: "강화 성공으로 저장하려면 실무 역량 라인을 선택해주세요.",
      });
      return;
    }
    setSaving(true);
    try {
      let r = await post(false);
      if (r.status === 409 && r.json?.error === "GROWTH_STATUS_WILL_CHANGE") {
        const g = r.json.growth ?? {};
        const ok = await adminDialog.confirm({
          variant: "warning",
          title: "성장 결과 변경",
          description: `${member?.displayName ?? "이 크루"}의 ${weekLabel ?? "해당 주차"} 결과가\n'${g.beforeLabel ?? "-"}'에서 '${g.afterLabel ?? "-"}'(으)로 변경됩니다.\n\n그래도 저장하시겠습니까?`,
          confirmLabel: "저장",
        });
        if (!ok) return;
        r = await post(true);
      }
      if (!r.ok || !r.json?.success) {
        t.error("save", { status: r.status, message: r.json?.error });
        return;
      }
      t.success("save");
      onSaved();
      onClose();
    } catch {
      t.error("save", "network");
    } finally {
      setSaving(false);
    }
  }, [result, selectedId, post, t, onSaved, onClose, member, weekLabel]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) void requestClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="실무 역량 라인 선택"
        className="flex max-h-[92vh] w-full max-w-[720px] flex-col overflow-hidden rounded-xl bg-card text-card-foreground shadow-xl ring-1 ring-foreground/10"
      >
        {/* 헤더 */}
        <div className="flex items-start justify-between gap-4 border-b px-6 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-sm font-semibold text-muted-foreground">실무 역량</span>
              <span className="text-lg font-bold text-foreground">
                {result === "success" && selected ? selected.lineName : "라인명 미정"}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
              {weekLabel ? <span className="font-medium text-foreground">{weekLabel}</span> : null}
              {member?.displayName ? <span>{member.displayName}</span> : null}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* 강화 결과 — 실패/성공만(오픈 라인, 미오픈은 이 화면 대상 아님). */}
            <div className="flex items-center gap-2">
              <span className="whitespace-nowrap text-sm font-medium text-muted-foreground">강화 결과</span>
              <select
                value={result}
                disabled={saving}
                onChange={(e) => setResult(e.target.value as Result)}
                className={cn(
                  "rounded-md border bg-background px-2.5 py-1.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
                  result === "success"
                    ? "border-emerald-500/50 text-emerald-700 dark:text-emerald-400"
                    : "border-red-500/50 text-red-600 dark:text-red-400",
                )}
              >
                <option value="fail">강화 실패</option>
                <option value="success">강화 성공</option>
              </select>
            </div>
            <button
              type="button"
              aria-label="닫기"
              onClick={() => void requestClose()}
              disabled={saving}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-40"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* 본문 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <p className="py-8 text-sm text-muted-foreground">불러오는 중…</p>
          ) : error ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
              {error}
            </div>
          ) : result === "fail" ? (
            <div className="rounded-md border border-muted bg-muted/20 px-4 py-6 text-sm text-muted-foreground">
              이 회원은 아직 실무 역량 대상자가 아닙니다(강화 실패). 강화 성공으로 인정하려면 상단에서
              <b className="text-foreground"> 강화 성공</b>을 선택하고 실무 역량 라인을 지정해주세요.
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {/* 라인 선택 드롭다운 */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-foreground">실무 역량 라인 선택</label>
                {options && options.length > 0 ? (
                  <select
                    value={selectedId}
                    disabled={saving}
                    onChange={(e) => setSelectedId(e.target.value)}
                    className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                  >
                    <option value="">라인 선택…</option>
                    {options.map((o) => (
                      <option key={o.masterId} value={o.masterId}>
                        {o.lineCode ? `[${o.lineCode}] ` : ""}
                        {o.lineName}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
                    이 주차·조직에서 선택 가능한(아직 배정되지 않은) 실무 역량 라인이 없습니다.
                  </div>
                )}
              </div>

              {/* 선택 라인 미리보기(조회 전용) — 메인 타이틀 / 링크 1 / 이미지 1 */}
              {selected ? (
                <div className="flex flex-col gap-4 rounded-md border bg-muted/20 p-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">Main Title (조회 전용)</span>
                    <span className="text-sm text-foreground">{selected.mainTitle ?? "-"}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">아웃풋 링크</span>
                    {selected.previewLink ? (
                      <a
                        href={selected.previewLink}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate text-sm text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
                      >
                        {selected.previewLink}
                      </a>
                    ) : (
                      <span className="text-sm text-muted-foreground">-</span>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">아웃풋 이미지</span>
                    {selected.previewImage ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={selected.previewImage}
                        alt="아웃풋 이미지"
                        className="max-h-40 w-auto rounded-md border object-contain"
                      />
                    ) : (
                      <span className="text-sm text-muted-foreground">-</span>
                    )}
                  </div>
                </div>
              ) : null}

              <p className="text-xs text-muted-foreground">
                저장하면 선택한 실무 역량 라인으로 이 회원의 대상자 배정이 생성되어 강화 성공으로 반영되고,
                라인 포인트·2차 기입 자격·집계·크루 페이지가 함께 갱신됩니다.
              </p>
            </div>
          )}
        </div>

        {/* 푸터 */}
        <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
          <button
            type="button"
            onClick={() => void requestClose()}
            disabled={saving}
            className="rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted disabled:opacity-40"
          >
            닫기
          </button>
          <button
            type="button"
            onClick={() => void doSave()}
            disabled={saving || (result === "success" && !selectedId)}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            {saving ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}
