import { supabaseAdmin } from "@/lib/supabaseAdmin";

// 클럽 관리 기록 — 관리자 메모(사용자당 1행). 전용 테이블 crew_management_notes.
//   · 운영 기록이므로 user_profiles 와 분리(작성자/수정시각 추적).
//   · 저장은 upsert(현재는 메모 1개). snapshot/포인트 무접촉.

export type CrewNote = {
  note: string;
  updatedAt: string | null;
  updatedBy: string | null;
};

type CrewNoteRow = {
  note: string | null;
  updated_at: string | null;
  updated_by: string | null;
};

// 단건 조회. 행 없으면 빈 메모.
export async function getCrewNote(userId: string): Promise<CrewNote> {
  const id = String(userId ?? "").trim();
  if (!id) return { note: "", updatedAt: null, updatedBy: null };

  const { data, error } = await supabaseAdmin
    .from("crew_management_notes")
    .select("note,updated_at,updated_by")
    .eq("user_id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);

  const row = data as CrewNoteRow | null;
  return {
    note: row?.note ?? "",
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

// upsert(저장 버튼). updated_at 은 서버 시각으로 갱신.
export async function upsertCrewNote(
  userId: string,
  note: string,
  updatedBy: string | null,
): Promise<CrewNote> {
  const id = String(userId ?? "").trim();
  if (!id) throw new Error("userId is required");

  const payload = {
    user_id: id,
    note: note ?? "",
    updated_at: new Date().toISOString(),
    updated_by: updatedBy ?? null,
  };

  const { data, error } = await supabaseAdmin
    .from("crew_management_notes")
    .upsert(payload, { onConflict: "user_id" })
    .select("note,updated_at,updated_by")
    .maybeSingle();
  if (error) throw new Error(error.message);

  const row = data as CrewNoteRow | null;
  return {
    note: row?.note ?? payload.note,
    updatedAt: row?.updated_at ?? payload.updated_at,
    updatedBy: row?.updated_by ?? payload.updated_by,
  };
}
