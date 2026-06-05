import { NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// 비밀번호 재설정 메일 발송 요청 (Supabase Auth 공식 resetPasswordForEmail 플로우).
//   - 비밀번호를 저장/생성하지 않는다. 메일 발송만 Supabase 에 위임한다.
//   - 활성 admin_users 계정에만 발송한다. 단, 계정 존재 여부가 응답으로
//     드러나지 않도록(enumeration 방지) 비관리자/미존재 이메일에도 동일한
//     generic 성공 응답을 돌려준다.
//   - redirectTo(/auth/recovery)는 Supabase Dashboard → Auth → URL Configuration
//     의 Redirect URLs 허용 목록에 등록되어 있어야 한다.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const GENERIC_SUCCESS = {
  success: true,
  message:
    "관리자 계정이라면 비밀번호 재설정 메일이 발송됩니다. 메일함을 확인해주세요.",
};

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

  const emailRaw = (body as { email?: unknown } | null)?.email;
  if (typeof emailRaw !== "string") {
    return Response.json(
      { success: false, error: "email must be a string" },
      { status: 400 },
    );
  }
  const email = emailRaw.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    return Response.json(
      { success: false, error: "email format is invalid" },
      { status: 400 },
    );
  }

  // 활성 관리자 계정인 경우에만 실제 발송 (admin_users.email 은 lower-case 저장).
  const { data: adminRow, error: adminLookupError } = await supabaseAdmin
    .from("admin_users")
    .select("id,is_active")
    .eq("email", email)
    .maybeSingle();

  if (adminLookupError) {
    console.error("[password-reset/request] admin_users lookup failed", {
      error: adminLookupError.message,
    });
    return Response.json(
      { success: false, error: "잠시 후 다시 시도해주세요." },
      { status: 500 },
    );
  }

  if (!adminRow?.is_active) {
    // 비관리자/미존재/비활성 — 발송하지 않지만 응답은 동일하게.
    return Response.json(GENERIC_SUCCESS);
  }

  // 서버(SSR) 클라이언트로 호출해야 PKCE code verifier 가 응답 쿠키에 저장되어
  // 같은 브라우저에서 메일 링크(/auth/recovery)의 code 교환이 성공한다.
  const supabase = await getSupabaseServerClient();
  const redirectTo = `${request.nextUrl.origin}/auth/recovery`;
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo,
  });

  if (error) {
    // rate limit(429) 등 — 구체 사유는 응답에 노출하지 않는다.
    console.error("[password-reset/request] resetPasswordForEmail failed", {
      status: error.status ?? null,
      error: error.message,
    });
    return Response.json(
      {
        success: false,
        error: "메일 발송에 실패했습니다. 잠시 후 다시 시도해주세요.",
      },
      { status: error.status === 429 ? 429 : 500 },
    );
  }

  return Response.json(GENERIC_SUCCESS);
}
