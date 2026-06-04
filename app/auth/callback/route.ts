import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function loginRedirect(origin: string, params: Record<string, string>) {
  const url = new URL("/login", origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url);
}

function pickName(meta: Record<string, unknown> | null | undefined) {
  if (!meta) return null;
  const candidates = [
    meta["name"],
    meta["full_name"],
    meta["preferred_username"],
    meta["nickname"],
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const { searchParams, origin } = url;
  const code = searchParams.get("code");
  const errorParam = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");
  const next = searchParams.get("next");

  if (errorParam) {
    return loginRedirect(origin, {
      error: errorDescription || errorParam,
    });
  }

  if (!code) {
    return loginRedirect(origin, { error: "missing_code" });
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data?.user) {
    console.error("[auth/callback] exchangeCodeForSession failed", error);
    return loginRedirect(origin, {
      error: error?.message ?? "exchange_failed",
    });
  }

  const user = data.user;
  const provider =
    (user.app_metadata?.provider as string | undefined) ?? "kakao";
  const email = user.email?.trim() ?? null;

  // 1) Admin (admin_users) → /admin (or ?next=).
  const { data: adminRow, error: adminLookupError } = await supabaseAdmin
    .from("admin_users")
    .select("id, is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (adminLookupError) {
    console.error("[auth/callback] admin_users lookup failed", adminLookupError);
  }

  if (adminRow?.is_active) {
    const target = next && next.startsWith("/") ? next : "/admin";
    return NextResponse.redirect(new URL(target, origin));
  }

  // 2) Already-approved app user (user_profiles) — this project is admin-only,
  //    so sign them out with an informational redirect.
  if (email) {
    const { data: profileRow } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id")
      .eq("auth_email", email)
      .maybeSingle();

    if (profileRow) {
      await supabase.auth.signOut();
      return loginRedirect(origin, { info: "approved_user_no_app" });
    }
  }

  // 3) New OAuth user → create applicants row (idempotent via unique index)
  //    and bounce to login with pending message.
  if (!email) {
    await supabase.auth.signOut();
    return loginRedirect(origin, { error: "missing_email" });
  }

  const displayName = pickName(
    user.user_metadata as Record<string, unknown> | null | undefined,
  );

  const { error: insertError } = await supabaseAdmin.from("applicants").insert({
    email,
    name: displayName,
    provider,
    status: "pending",
  });

  // 23505 = unique_violation; means an applicant for this (lower(email), provider)
  // already exists — that's the desired idempotent outcome.
  if (insertError && insertError.code !== "23505") {
    console.error("[auth/callback] applicants insert failed", insertError);
  }

  await supabase.auth.signOut();
  return loginRedirect(origin, { pending: "1" });
}
