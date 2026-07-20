"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { fetchHelpMeta, hasHelpContent, updateHelpMeta } from "@/lib/adminHelpEmphasis";
import { cn } from "@/lib/utils";

// 어드민 "관련 도움말" 편집/저장 모달(단일 SoT = /api/admin/help, 테이블 admin_page_help_contents).
//   · 페이지 단위(AdminHelp: storageKey=usePathname)와 요소 단위(AdminHelpIconButton: storageKey=helpKey)가
//     동일 컴포넌트/동일 API 를 공유한다 — 도움말 본문의 출처는 코드가 아니라 저장소/API.
//   · storageKey 별로 본문을 조회/저장. 기본 읽기 전용 → [편집]으로 textarea → [저장] 시 영구 저장.
//   · 빈 도움말도 저장 가능. 같은 키로 다시 열면 저장 내용이 다시 보인다.
//   · 편집/저장 권한(canEdit)은 GET 응답에서 받아 자체 판단(prop 불필요).
//   · org/mode/test 로 갈라지지 않는다 — 키에 org/mode 를 넣지 않으므로 공통 도움말이다.

type Props = {
  /** 열림 상태(트리거 컴포넌트가 소유). */
  open: boolean;
  /** 닫기 콜백. */
  onClose: () => void;
  /**
   * 저장/조회 식별 키. 페이지 경로("/admin/...") 또는 요소 키("admin.foo.bar.column.x").
   * API 의 path 파라미터로 그대로 전달된다.
   */
  storageKey: string;
  /** 모달 헤더에 표시할 짧은 라벨(도움말 "본문"이 아니라 어떤 항목인지 식별용). 기본 "관련 도움말". */
  title?: string;
};

export default function AdminHelpModal({ open, onClose, storageKey, title = "관련 도움말" }: Props) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(""); // 저장된 내용(읽기 표시 SoT)
  const [draft, setDraft] = useState(""); // 편집 중 textarea 값
  const [error, setError] = useState<string | null>(null);
  // 쓰기 역할이면 편집/저장 노출. GET 응답으로 확정(로딩 중엔 낙관적 true).
  const [canEdit, setCanEdit] = useState(true);

  const close = useCallback(() => {
    setEditing(false);
    setError(null);
    onClose();
  }, [onClose]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const meta = await fetchHelpMeta(storageKey);
      if (meta.loadError) throw new Error(meta.loadError);
      setContent(meta.content);
      setCanEdit(meta.canEdit);
    } catch (e) {
      setError(e instanceof Error ? e.message : "도움말을 불러오지 못했습니다.");
      setContent("");
    } finally {
      setLoading(false);
    }
  }, [storageKey]);

  // 열 때마다 최신 내용을 가져온다(편집 상태 초기화).
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [open, load]);

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
        body: JSON.stringify({ path: storageKey, content: draft }),
      });
      const json = await res.json();
      if (!res.ok || !json?.success) {
        throw new Error(json?.error ?? `저장 실패 (${res.status})`);
      }
      const saved = typeof json.data?.content === "string" ? json.data.content : draft;
      setContent(saved);
      updateHelpMeta(storageKey, saved, canEdit);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }, [canEdit, draft, storageKey]);

  // Esc 닫기(편집 중에는 실수 방지를 위해 닫지 않음).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editing && !saving) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, editing, saving, close]);

  if (!open) return null;

  const isEmpty = !hasHelpContent(content);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        // 바깥 클릭으로 닫기(편집/저장 중에는 유지).
        if (e.target === e.currentTarget && !editing && !saving) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[88vh] modal-w-xl flex-col overflow-hidden rounded-xl bg-card shadow-xl ring-1 ring-foreground/10"
      >
        {/* 헤더 바: 제목(좌) + [편집][저장][X](우) */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-6 py-3.5">
          <div className="min-w-0">
            <h2 className="truncate text-[24px] font-semibold leading-tight text-foreground">{title}</h2>
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
              onClick={close}
              disabled={saving}
              aria-label="닫기"
              title="닫기"
              className="size-[34px]"
            >
              <X className="size-5" />
            </Button>
          </div>
        </div>

        {/* 본문: 읽기(whitespace-pre-wrap) ↔ 편집(textarea) */}
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
              placeholder="이 항목에 대한 도움말을 입력하세요. (빈 내용도 저장할 수 있습니다)"
              className="h-[55vh] min-h-[320px] w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-[19px] leading-relaxed shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          ) : isEmpty ? (
            <div className="flex h-[320px] flex-col items-center justify-center gap-2 text-center text-lg text-muted-foreground">
              <p>등록된 도움말이 없습니다.</p>
              {canEdit && <p className="text-sm">우측 상단 [편집]을 눌러 작성할 수 있습니다.</p>}
            </div>
          ) : (
            <div className={cn("text-[19px] leading-relaxed whitespace-pre-wrap text-foreground")}>
              {content}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
