import { NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";

// 비밀번호 재설정 완료 (Supabase Auth 공식 updateUser 플로우).
//   - /auth/recovery 에서 발급된 recovery 세션(쿠키)으로 본인 비밀번호만 변경한다.
//   - 서버는 새 비밀번호를 저장하지 않는다 — Supabase Auth 에 그대로 위임.

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 72;

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const password = (body as { password?: unknown } | null)?.password;
  if (typeof password !== "string") {
    return Response.json(
      { success: false, error: "password must be a string" },
      { status: 400 },
    );
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return Response.json(
      {
        success: false,
        error: `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`,
      },
      { status: 400 },
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return Response.json(
      {
        success: false,
        error: `비밀번호는 ${MAX_PASSWORD_LENGTH}자 이하여야 합니다.`,
      },
      { status: 400 },
    );
  }

  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return Response.json(
      {
        success: false,
        error:
          "재설정 세션이 없거나 만료되었습니다. 재설정 메일을 다시 요청해주세요.",
      },
      { status: 401 },
    );
  }

  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    const message = error.message.includes("different from the old password")
      ? "기존 비밀번호와 다른 비밀번호를 입력해주세요."
      : "비밀번호 변경에 실패했습니다. 잠시 후 다시 시도해주세요.";
    console.error("[password-reset/complete] updateUser failed", {
      userId: user.id,
      status: error.status ?? null,
      error: error.message,
    });
    return Response.json(
      { success: false, error: message },
      { status: error.status ?? 500 },
    );
  }

  return Response.json({ success: true });
}
