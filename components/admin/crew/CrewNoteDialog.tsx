"use client";

import { useCallback, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dash } from "@/components/admin/crew/CrewIdentityCards";

// 클럽 관리 기록(관리자 메모) 모달 — 회원 상세/주차 상세가 동일 모달·동일 API 를 공유한다.
//   이름·크루 코드 표시 + 관리자 메모(취소/저장). autosave 없음. PUT /api/admin/members/[user_id]/note.

export type CrewNote = {
  note: string;
  updatedAt: string | null;
  updatedBy: string | null;
};

export function CrewNoteDialog({
  userId,
  displayName,
  crewCode,
  initialNote,
  onClose,
  onSaved,
}: {
  userId: string;
  displayName: string | null;
  crewCode: string | null;
  initialNote: CrewNote;
  onClose: () => void;
  onSaved: (saved: CrewNote) => void;
}) {
  const [note, setNote] = useState(initialNote.note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/members/${userId}/note`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error ?? "메모를 저장하지 못했습니다.");
      }
      onSaved(json.data as CrewNote);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "메모를 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  }, [userId, note, onSaved, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="modal-w-md rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">클럽 관리 기록</h2>
          <button type="button" onClick={onClose} disabled={saving} className="hover:opacity-70">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-1.5 rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">이름</span>
            <span className="font-medium">{dash(displayName)}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground">크루 코드</span>
            <span className="font-mono">{crewCode ?? "미생성"}</span>
          </div>
        </div>

        <label className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
          관리자 메모
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={6}
            placeholder="관리 메모를 입력하세요."
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
          />
        </label>

        {error && (
          <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            취소
          </Button>
          <Button type="button" size="sm" loading={saving} disabled={saving} onClick={save}>
            저장
          </Button>
        </div>
      </div>
    </div>
  );
}
