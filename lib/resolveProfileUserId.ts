import { supabaseAdmin } from "@/lib/supabaseAdmin";

// auth.users.id → user_profiles.user_id 해소.
//
// approve-new 플로우에서 user_profiles.user_id 는 randomUUID() 로 생성되며
// auth.users.id 와 다르다. 유일한 연결 고리는 user_profiles.auth_email.
//
// Resolution 순서:
//   1) user_profiles.user_id = authId  (직접 매칭 — 시드/테스트 데이터)
//   2) user_profiles.auth_email = authEmail  (이메일 매칭 — 실 사용자)

export async function resolveProfileUserId(
  authId: string,
  authEmail?: string | null,
): Promise<string | null> {
  const { data: direct } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .eq("user_id", authId)
    .maybeSingle();

  if (direct) {
    return (direct as { user_id: string }).user_id;
  }

  if (authEmail) {
    const { data: byEmail } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id")
      .eq("auth_email", authEmail)
      .maybeSingle();

    if (byEmail) {
      const resolved = (byEmail as { user_id: string }).user_id;
      console.log(
        "[resolveProfileUserId] email fallback: auth.id =",
        authId,
        "→ profile.user_id =",
        resolved,
      );
      return resolved;
    }
  }

  return null;
}
