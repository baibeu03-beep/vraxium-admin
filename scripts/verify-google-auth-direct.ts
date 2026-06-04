/**
 * Google OAuth provider 매칭 — direct function 검증 (고객 repo resolveGoogleAccountAccess 직접 호출).
 *
 *   npx tsx --env-file=.env.local scripts/verify-google-auth-direct.ts            # 시나리오 1~2 + 정리
 *   npx tsx --env-file=.env.local scripts/verify-google-auth-direct.ts --approve  # +admin approve-new HTTP 경유 승인 → 재확인 (admin dev 서버 필요)
 *   npx tsx --env-file=.env.local scripts/verify-google-auth-direct.ts --keep     # 테스트 row 보존(HTTP 패리티 검증용)
 *
 * 시나리오:
 *  1. [merge-guard] 실존 kakao 유저의 auth_email 과 같은 email 로 Google 로그인
 *     → approved 가 아니라 pending 이어야 함(자동 병합 금지). 동시에 kakao email 매칭은
 *       google 신청 row 공존 상태에서도 여전히 approved (기존 동작 불변).
 *  2. [new-user] 신규 sub → applicants(provider='google', provider_user_id) pending 생성, 재로그인 멱등.
 *  3. [--approve] admin approve-new → 재 resolve 시 approved + auth_accounts.user_id 링크
 *     + 최초 weekly-cards snapshot 생성 확인.
 *
 * 모든 테스트 row 는 종료 시 삭제(--keep 제외).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { resolveGoogleAccountAccess } from "../../vraxium/lib/auth-account-access";
import { resolveUserProfileAccess } from "../../vraxium/lib/user-profile-access";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SUB_MERGE = "verify-google-sub-merge-guard-20260604";
const SUB_NEW = "verify-google-sub-new-user-20260604";
const NEW_EMAIL = "google-verify-20260604@example.com";
const APPROVE = process.argv.includes("--approve");
const KEEP = process.argv.includes("--keep");
const ADMIN_BASE = process.env.ADMIN_BASE ?? "http://localhost:3000";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures += 1;
}

async function cleanup(createdUserId: string | null) {
  if (KEEP) {
    console.log("⏸ --keep: 테스트 row 보존(HTTP 검증 후 --cleanup-only 로 정리)");
    return;
  }
  await sb.from("auth_accounts").delete().in("provider_user_id", [SUB_MERGE, SUB_NEW]);
  await sb.from("applicants").delete().eq("provider", "google").in("provider_user_id", [SUB_MERGE, SUB_NEW]);
  if (createdUserId) {
    await sb.from("cluster4_weekly_card_snapshots").delete().eq("user_id", createdUserId);
    await sb.from("user_profiles").delete().eq("user_id", createdUserId);
    await sb.from("users").delete().eq("id", createdUserId);
  }
  console.log("🧹 테스트 row 정리 완료");
}

async function main() {
  if (process.argv.includes("--cleanup-only")) {
    const { data: aa } = await sb
      .from("applicants")
      .select("linked_user_id")
      .eq("provider", "google")
      .eq("provider_user_id", SUB_NEW)
      .maybeSingle();
    await cleanup(aa?.linked_user_id ?? null);
    return;
  }

  // 사전: 마이그레이션 적용 확인
  const { error: tableErr } = await sb.from("auth_accounts").select("id").limit(1);
  if (tableErr) {
    console.error(`auth_accounts 미존재 — 마이그레이션 먼저 적용 필요: ${tableErr.message}`);
    process.exit(2);
  }

  // ── 시나리오 1: merge-guard ──────────────────────────────────────────
  const { data: realProfile } = await sb
    .from("user_profiles")
    .select("user_id, auth_email")
    .not("auth_email", "is", null)
    .neq("auth_email", "")
    .limit(1)
    .single();
  console.log(`merge-guard 기준 kakao 유저: user_id=${realProfile!.user_id}`);

  const mergeAccess = await resolveGoogleAccountAccess(sb, {
    providerUserId: SUB_MERGE,
    email: realProfile!.auth_email,
    name: "구글 머지가드 테스트",
    ensureApplicantOnPending: true,
  });
  check("1a. 같은 email Google 로그인 → approved 아님(자동 병합 금지)", mergeAccess.status === "pending", { status: mergeAccess.status });

  const { data: mergeAccount } = await sb
    .from("auth_accounts")
    .select("provider, provider_user_id, user_id")
    .eq("provider_user_id", SUB_MERGE)
    .single();
  check("1b. auth_accounts 저장(provider=google, user_id=null)", mergeAccount?.provider === "google" && mergeAccount?.user_id === null, mergeAccount);

  // google 신청 row 공존 상태에서 kakao email 매칭 회귀 확인 (읽기 전용)
  const kakaoAccess = await resolveUserProfileAccess(sb, { email: realProfile!.auth_email! });
  check(
    "1c. kakao email 매칭 여전히 approved(기존 동작 불변)",
    kakaoAccess.status === "approved" && kakaoAccess.profile.user_id === realProfile!.user_id,
    { status: kakaoAccess.status },
  );

  // ── 시나리오 2: 신규 Google 사용자 ───────────────────────────────────
  const newAccess1 = await resolveGoogleAccountAccess(sb, {
    providerUserId: SUB_NEW,
    email: NEW_EMAIL,
    name: "구글 신규 테스트",
    ensureApplicantOnPending: true,
  });
  check("2a. 신규 sub → pending", newAccess1.status === "pending");
  const applicantId = newAccess1.status === "pending" ? newAccess1.applicant?.id : null;

  const { data: newApplicant } = await sb
    .from("applicants")
    .select("id, provider, provider_user_id, status, email")
    .eq("provider", "google")
    .eq("provider_user_id", SUB_NEW)
    .single();
  check(
    "2b. applicants(provider=google, provider_user_id=sub, pending) 생성",
    newApplicant?.status === "pending" && newApplicant?.email === NEW_EMAIL,
    newApplicant,
  );

  const newAccess2 = await resolveGoogleAccountAccess(sb, {
    providerUserId: SUB_NEW,
    email: NEW_EMAIL,
    name: "구글 신규 테스트",
    ensureApplicantOnPending: true,
  });
  check(
    "2c. 재로그인 멱등(같은 applicant, 여전히 pending)",
    newAccess2.status === "pending" && newAccess2.applicant?.id === newApplicant?.id,
  );

  let createdUserId: string | null = null;

  // ── 시나리오 3: 승인 → approved + 링크 ──────────────────────────────
  if (APPROVE && applicantId) {
    const res = await fetch(`${ADMIN_BASE}/api/admin/applicants/${applicantId}/approve-new`, {
      method: "POST",
    });
    const body = await res.json();
    check("3a. admin approve-new 응답 ok", res.ok && body.ok === true, body);
    createdUserId = body.linked_user_id ?? null;

    const approvedAccess = await resolveGoogleAccountAccess(sb, {
      providerUserId: SUB_NEW,
      email: NEW_EMAIL,
      name: "구글 신규 테스트",
      ensureApplicantOnPending: true,
    });
    check(
      "3b. 승인 후 resolve → approved + user_id 일치",
      approvedAccess.status === "approved" && approvedAccess.profile.user_id === createdUserId,
      { status: approvedAccess.status, userId: approvedAccess.status === "approved" ? approvedAccess.profile.user_id : null },
    );

    const { data: linkedAccount } = await sb
      .from("auth_accounts")
      .select("user_id")
      .eq("provider_user_id", SUB_NEW)
      .single();
    check("3c. auth_accounts.user_id 링크", linkedAccount?.user_id === createdUserId, linkedAccount);

    const { data: snap } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("user_id, is_stale")
      .eq("user_id", createdUserId!)
      .maybeSingle();
    check("3d. 신규 유저 최초 weekly-cards snapshot 생성(kakao 승인과 동일 흐름)", !!snap, snap);

    // kakao 유저 snapshot 무영향 — 기준 유저 snapshot is_stale 변화 없음 확인
    const { data: kakaoSnap } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("is_stale")
      .eq("user_id", realProfile!.user_id)
      .maybeSingle();
    check("3e. 기존 유저 snapshot 무영향(is_stale=false 유지)", !kakaoSnap || kakaoSnap.is_stale === false, kakaoSnap);
  } else if (APPROVE) {
    check("3. 승인 시나리오 진입 실패 — applicantId 없음", false);
  }

  await cleanup(createdUserId);

  console.log(failures === 0 ? "\n결과: 전체 통과" : `\n결과: ${failures}건 실패`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
