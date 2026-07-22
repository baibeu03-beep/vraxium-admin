import { NextRequest } from "next/server";
import {
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { CLUSTER4_LINE_WRITE_ROLES } from "@/lib/adminCluster4LinesTypes";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { publicErrorMessage } from "@/lib/apiError";

const BUCKET = "cluster4-line-images";
const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = await requireAdmin(CLUSTER4_LINE_WRITE_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return Response.json(
        { success: false, error: "파일이 필요합니다" },
        { status: 400 },
      );
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return Response.json(
        { success: false, error: "JPEG, PNG, WebP, GIF 이미지만 업로드 가능합니다" },
        { status: 400 },
      );
    }

    if (file.size > MAX_SIZE) {
      return Response.json(
        { success: false, error: "파일 크기는 5MB 이하여야 합니다" },
        { status: 400 },
      );
    }

    const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
    const timestamp = Date.now();
    const filePath = `info-lines/${timestamp}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const buffer = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(filePath, buffer, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      console.error("[upload-image] storage error", uploadError);
      // Bucket이 없으면 자동 생성 시도
      if (uploadError.message?.includes("not found") || uploadError.message?.includes("Bucket")) {
        const { error: createError } = await supabaseAdmin.storage.createBucket(BUCKET, {
          public: true,
          fileSizeLimit: MAX_SIZE,
          allowedMimeTypes: ALLOWED_TYPES,
        });
        if (createError) {
          console.error("[upload-image] bucket creation failed", createError);
          return Response.json(
            { success: false, error: `스토리지 설정 오류: ${createError.message}` },
            { status: 500 },
          );
        }
        // 재시도
        const { error: retryError } = await supabaseAdmin.storage
          .from(BUCKET)
          .upload(filePath, buffer, {
            contentType: file.type,
            upsert: false,
          });
        if (retryError) {
          return Response.json(
            { success: false, error: retryError.message },
            { status: 500 },
          );
        }
      } else {
        return Response.json(
          { success: false, error: uploadError.message },
          { status: 500 },
        );
      }
    }

    const { data: publicUrlData } = supabaseAdmin.storage
      .from(BUCKET)
      .getPublicUrl(filePath);

    return Response.json({
      success: true,
      data: {
        url: publicUrlData.publicUrl,
        path: filePath,
      },
    });
  } catch (error) {
    console.error("[admin/cluster4/upload-image POST]", error);
    return Response.json(
      {
        success: false,
        error: publicErrorMessage(error, 500, "업로드 실패"),
      },
      { status: 500 },
    );
  }
}
