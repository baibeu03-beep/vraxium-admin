import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";

// 비밀번호 재설정 메일 링크 전용 콜백.
//   Supabase verify 엔드포인트가 code 를 붙여 이곳으로 리다이렉트한다.
//   code 교환에 성공하면 recovery 세션(쿠키)이 생기고 /reset-password 로 보낸다.
//   기존 OAuth 콜백(/auth/callback)과 분리해 카카오/구글 로그인 분기 로직에
//   영향을 주지 않는다.

function forgotRedirect(origin: string, errorKey: string) {
  const url = new URL("/forgot-password", origin);
  url.searchParams.set("error", errorKey);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const errorParam = searchParams.get("error");
  const errorCode = searchParams.get("error_code");

  if (errorParam) {
    // otp_expired(만료/사용된 링크) 등 — 재요청 화면으로 안내.
    return forgotRedirect(
      origin,
      errorCode === "otp_expired" ? "link_expired" : "link_invalid",
    );
  }

  if (!code) {
    return forgotRedirect(origin, "missing_code");
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data?.user) {
    // 대표 케이스: 재설정을 요청한 브라우저와 다른 브라우저에서 링크를 연 경우
    // (PKCE code verifier 쿠키 부재).
    console.error("[auth/recovery] exchangeCodeForSession failed", {
      error: error?.message ?? null,
    });
    return forgotRedirect(origin, "exchange_failed");
  }

  return NextResponse.redirect(new URL("/reset-password", origin));
}
