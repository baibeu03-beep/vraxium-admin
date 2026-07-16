import { NextRequest } from "next/server";
import { ADMIN_WRITE_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { assertUserInRequestScope } from "@/lib/userScope";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ user_id: string; week_id: string; line_id: string }> };

// 크루 아웃풋 이미지 저장소와 동일 버킷/정책(URL 이 output_images 에 들어가 크루 카드가 동일 이미지 표시).
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const BUCKET = "activity-detail-images";
const MAX_SLOT_INDEX = 4; // slot 0..3
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// POST /api/admin/members/[user_id]/weeks/[week_id]/lines/[line_id]/upload-image
//   관리자 라인 상세 팝업의 이미지 업로드/교체. FormData: { file, slot_index }.
//   ⚠ 크루 정책과 동일하게 스토리지 orphan 은 정리하지 않는다(교체/삭제 시 output_images jsonb 에서만 제거).
//     최종 저장 실패로 미참조된 파일이 남을 수 있음 — 기존 크루 업로드 정책과 일치.
export async function POST(request: NextRequest, { params }: Ctx) {
  let admin;
  try {
    admin = await requireAdmin(ADMIN_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }
  void admin;

  const { user_id, week_id, line_id } = await params;

  try {
    await assertUserInRequestScope(request, user_id);
  } catch (error) {
    return Response.json(
      { success: false, error: error instanceof Error ? error.message : "Scope violation" },
      { status: (error as { status?: number }).status ?? 422 },
    );
  }

  if (!ID_PATTERN.test(user_id) || !ID_PATTERN.test(week_id) || !ID_PATTERN.test(line_id)) {
    return Response.json({ success: false, error: "잘못된 식별자입니다." }, { status: 400 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ success: false, error: "잘못된 요청입니다." }, { status: 400 });
  }
  const file = formData.get("file") as File | null;
  const slotIndex = Number(formData.get("slot_index"));

  if (!file) {
    return Response.json({ success: false, error: "파일이 없습니다." }, { status: 400 });
  }
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= MAX_SLOT_INDEX) {
    return Response.json({ success: false, error: "잘못된 슬롯 인덱스입니다." }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE) {
    return Response.json({ success: false, error: "파일 크기는 5MB 이하여야 합니다." }, { status: 400 });
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return Response.json(
      { success: false, error: "지원하지 않는 파일 형식입니다. (JPEG, PNG, WebP, GIF만 가능)" },
      { status: 400 },
    );
  }

  try {
    const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
    const fileName = `${user_id}/${week_id}/line-${line_id}/slot-${slotIndex}_${Date.now()}.${ext}`;
    const buffer = new Uint8Array(await file.arrayBuffer());
    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(fileName, buffer, { contentType: file.type, upsert: true });
    if (uploadError) {
      console.error("[admin line upload-image]", uploadError.message);
      return Response.json({ success: false, error: "이미지 업로드에 실패했습니다." }, { status: 500 });
    }
    const { data: urlData } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(fileName);
    return Response.json({ success: true, url: urlData.publicUrl, fileName });
  } catch (err) {
    console.error("[admin line upload-image] handler", err);
    return Response.json({ success: false, error: "서버 오류가 발생했습니다." }, { status: 500 });
  }
}
