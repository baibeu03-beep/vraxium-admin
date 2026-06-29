"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { CircleHelp, Pencil, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

// 각 어드민 페이지 제목 영역 우측 [도움말] 버튼 + "관련 도움말" 팝업.
//   · 페이지(path)별로 도움말 본문을 조회/저장(API: /api/admin/help).
//   · 기본 읽기 전용 → [편집]으로 textarea 전환 → [저장] 시 영구 저장 → [X] 닫기.
//   · 빈 도움말도 저장 가능. 같은 경로로 다시 열면 저장 내용이 다시 보인다.
//   · 편집/저장 권한(canEdit)은 GET 응답에서 받아 자체 판단 — prop 없이 어느 페이지에나 드롭 가능.
//   · className 으로 배치(정렬/여백)만 외부에서 조정.

type Props = { className?: string };

export default function AdminHelp({ className }: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(""); // 저장된 내용(읽기 표시 SoT)
  const [draft, setDraft] = useState(""); // 편집 중 textarea 값
  const [error, setError] = useState<string | null>(null);
  // 쓰기 역할이면 편집/저장 노출. GET 응답으로 확정(로딩 중엔 낙관적 true).
  const [canEdit, setCanEdit] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/help?path=${encodeURIComponent(pathname)}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        throw new Error(json?.error ?? `조회 실패 (${res.status})`);
      }
      setContent(json.data?.content ?? "");
      if (typeof json.data?.canEdit === "boolean") setCanEdit(json.data.canEdit);
    } catch (e) {
      setError(e instanceof Error ? e.message : "도움말을 불러오지 못했습니다.");
      setContent("");
    } finally {
      setLoading(false);
    }
  }, [pathname]);

  // 열 때마다 현재 경로 기준으로 최신 내용을 가져온다.
  const openModal = useCallback(() => {
    setOpen(true);
    setEditing(false);
    void load();
  }, [load]);

  const closeModal = useCallback(() => {
    setOpen(false);
    setEditing(false);
    setError(null);
  }, []);

  const startEdit = useCallback(() => {
    setDraft(content);
    setEditing(true);
    setError(null);
  }, [content]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/help", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: pathname, content: draft }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        throw new Error(json?.error ?? `저장 실패 (${res.status})`);
      }
      setContent(json.data?.content ?? draft);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }, [draft, pathname]);

  // Esc 닫기(편집 중에는 실수 방지를 위해 닫지 않음).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editing && !saving) {
        e.preventDefault();
        closeModal();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, editing, saving, closeModal]);

  const isEmpty = content.trim().length === 0;

  return (
    <>
      {/* 트리거 버튼 — 기본 대비 ~1.2배(높이/글자/아이콘/패딩). 팝업도 동일 배율. */}
      <Button
        type="button"
        variant="outline"
        onClick={openModal}
        aria-haspopup="dialog"
        title="이 페이지의 관련 도움말"
        className={cn("h-[34px] shrink-0 gap-1.5 px-3 text-sm", className)}
      >
        <CircleHelp className="size-4" />
        도움말
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onMouseDown={(e) => {
            // 바깥 클릭으로 닫기(편집/저장 중에는 유지).
            if (e.target === e.currentTarget && !editing && !saving) closeModal();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="관련 도움말"
            className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-card shadow-xl ring-1 ring-foreground/10"
          >
            {/* 헤더 바: 제목(좌) + [편집][저장][X](우) — ~1.2배 */}
            <div className="flex items-start justify-between gap-3 border-b border-border px-6 py-3.5">
              <div className="min-w-0">
                <h2 className="text-[24px] font-semibold leading-tight text-foreground">관련 도움말</h2>
                <p className="truncate text-sm text-muted-foreground" title={pathname}>
                  {pathname}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {canEdit && (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={startEdit}
                      disabled={editing || loading || saving}
                      className="h-[34px] gap-1.5 px-3 text-sm"
                    >
                      <Pencil className="size-4" />
                      편집
                    </Button>
                    <Button
                      type="button"
                      variant="default"
                      onClick={save}
                      disabled={!editing || saving}
                      loading={saving}
                      className="h-[34px] gap-1.5 px-3 text-sm"
                    >
                      <Save className="size-4" />
                      저장
                    </Button>
                  </>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={closeModal}
                  disabled={saving}
                  aria-label="닫기"
                  title="닫기"
                  className="size-[34px]"
                >
                  <X className="size-5" />
                </Button>
              </div>
            </div>

            {/* 본문: 읽기(whitespace-pre-wrap) ↔ 편집(textarea) — ~1.2배 */}
            <div className="min-h-[340px] flex-1 overflow-auto p-6">
              {error && (
                <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-base text-destructive">
                  {error}
                </div>
              )}

              {loading ? (
                <div className="flex h-[320px] items-center justify-center gap-2 text-lg text-muted-foreground">
                  <Spinner className="h-5 w-5" />
                  불러오는 중…
                </div>
              ) : editing ? (
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  autoFocus
                  placeholder="이 페이지에 대한 도움말을 입력하세요. (빈 내용도 저장할 수 있습니다)"
                  className="h-[55vh] min-h-[320px] w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-[19px] leading-relaxed shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              ) : isEmpty ? (
                <div className="flex h-[320px] flex-col items-center justify-center gap-2 text-center text-lg text-muted-foreground">
                  <p>등록된 도움말이 없습니다.</p>
                  {canEdit && <p className="text-sm">우측 상단 [편집]을 눌러 작성할 수 있습니다.</p>}
                </div>
              ) : (
                <div
                  className={cn(
                    "text-[19px] leading-relaxed whitespace-pre-wrap text-foreground",
                  )}
                >
                  {content}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
