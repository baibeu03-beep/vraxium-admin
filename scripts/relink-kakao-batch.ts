/**
 * 7명 엥크레 테스트 사용자 카카오 이메일 연결을 빈 placeholder → 의도한 T사용자로 이전.
 *   npx tsx --env-file=.env.local scripts/relink-kakao-batch.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/relink-kakao-batch.ts --apply  # 적용 + 직접검증
 *
 * 각 건:
 *  1. placeholder user_profiles.auth_email/contact_email → .test 플레이스홀더(이메일 해제, row 보존)
 *  2. T사용자 user_profiles.auth_email/contact_email → 카카오 이메일
 *  3. applicants.linked_user_id → T사용자 (provider=kakao, status approved 유지)
 * 순서: 1 → 2 → 3 (auth_email 동시 중복 방지). auth_accounts 는 kakao 미사용(무접촉).
 * test_user_markers 무변경. snapshot/앱코드 무접촉.
 */
import { createClient } from "@supabase/supabase-js";
import { resolveUserProfileAccess } from "../../vraxium/lib/user-profile-access";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const APPLY = process.argv.includes("--apply");

type Job = {
  name: string;
  email: string;
  tUserId: string;
  placeholderId: string;
  applicantId: string;
};

// inspect-kakao-link-batch.ts 실측값 고정
const JOBS: Job[] = [
  { name: "T임시우", email: "ar220919.kaka@gmail.com", tUserId: "a80ea67a-8836-4c13-8568-66dff79d7a66", placeholderId: "1ca828bd-ffd3-4008-ba45-cf37c01171fb", applicantId: "bfd10b95-8ff1-4342-a596-60f41f60e1d0" },
  { name: "T황민서", email: "appley13@kakao.com", tUserId: "614f78f4-c372-4c11-a17f-46b9e7bd4523", placeholderId: "60698e6b-34f9-47b0-9c78-2c22f7c08a93", applicantId: "28c724d4-d1d1-44f9-9d8d-bc829610693b" },
  { name: "T조예린", email: "cozypen09@kakao.com", tUserId: "98807fea-2137-4160-ba5c-dedcbdced0e8", placeholderId: "69fbb2b3-9821-46da-b0d2-7d43b1e1e2b5", applicantId: "25028e54-d541-4458-90c0-199e984fa5de" },
  { name: "T임다인", email: "miraeum26@kakao.com", tUserId: "42864260-e4ea-4150-a87f-cff545b02af1", placeholderId: "c3ca54c0-1fb7-4b2d-9ed1-b6e7c9775d73", applicantId: "943fd3fb-4b65-414c-a18e-bffd1c24e7a9" },
  { name: "T장소율", email: "project_service@kakao.com", tUserId: "f980b257-12b1-4f9c-ae71-307336071785", placeholderId: "9a02951e-c5ee-4778-929c-8da5e0956c77", applicantId: "840809da-193d-486c-aa6b-fc36fe7ac8a1" },
  { name: "T정하은", email: "ddfjlaeia_fadg@kakao.com", tUserId: "fff3941f-071c-4cca-b99a-da8bd6d2fae2", placeholderId: "3e737e89-02da-4c95-8fe5-68a06d62019a", applicantId: "77bbff88-b98b-48d0-88e8-6235023c1d23" },
  { name: "T정시현", email: "adjfeualdq.kfka@kakao.com", tUserId: "70abfec0-660b-4af3-a940-5d318f76bd4e", placeholderId: "f7fdd629-0304-4cd3-a0c5-48d78a56e628", applicantId: "105bba87-4b1b-4366-b3f6-e2355bee367e" },
];

let failures = 0;
const ck = (ok: boolean, label: string, detail?: unknown) => {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures += 1;
};

async function main() {
  console.log(`모드: ${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  // ── 사전 안전 재확인 (각 건) ──
  for (const job of JOBS) {
    const { data: t } = await sb.from("user_profiles").select("display_name, organization_slug, auth_email").eq("user_id", job.tUserId).maybeSingle();
    const { data: ph } = await sb.from("user_profiles").select("display_name, auth_email").eq("user_id", job.placeholderId).maybeSingle();
    const okT = t?.display_name === job.name && t?.organization_slug === "encre";
    const okPh = ph?.auth_email?.toLowerCase() === job.email.toLowerCase();
    // T사용자가 이미 다른 auth_accounts/applicant 에 연결?
    const { data: tAa } = await sb.from("auth_accounts").select("id").eq("user_id", job.tUserId);
    const { data: tAp } = await sb.from("applicants").select("id").eq("linked_user_id", job.tUserId);
    const tFree = (tAa ?? []).length === 0 && (tAp ?? []).length === 0;
    if (!okT || !okPh || !tFree) {
      console.log(`▶ ${job.name}: 사전검증 실패 — 중단`);
      ck(okT, "T사용자 일치/encre", t);
      ck(okPh, "placeholder 가 해당 이메일 보유", ph);
      ck(tFree, "T사용자 미연결", { tAa, tAp });
      process.exit(2);
    }
  }
  console.log("사전 안전검증 7/7 통과\n");

  if (!APPLY) {
    console.log("DRY-RUN: --apply 로 적용하세요.");
    return;
  }

  // ── 적용 ──
  for (const job of JOBS) {
    console.log(`▶ ${job.name} / ${job.email}`);
    const placeholderEmail = `kakao-placeholder-${job.placeholderId.slice(0, 8)}@vraxium.test`;
    // 1) placeholder 해제
    {
      const { error } = await sb.from("user_profiles").update({ auth_email: placeholderEmail, contact_email: placeholderEmail }).eq("user_id", job.placeholderId);
      ck(!error, `placeholder 이메일 해제 → ${placeholderEmail}`, error?.message);
    }
    // 2) T사용자 설정
    {
      const { error } = await sb.from("user_profiles").update({ auth_email: job.email, contact_email: job.email }).eq("user_id", job.tUserId);
      ck(!error, `T사용자 auth/contact = ${job.email}`, error?.message);
    }
    // 3) applicant 재지정
    {
      const { error } = await sb.from("applicants").update({ linked_user_id: job.tUserId, status: "approved" }).eq("id", job.applicantId);
      ck(!error, `applicant.linked_user_id → T사용자`, error?.message);
    }
  }

  // ── 사후 직접검증 ──
  console.log("\n── 사후 직접검증 ──");
  for (const job of JOBS) {
    console.log(`▶ ${job.name} / ${job.email}`);
    const access = await resolveUserProfileAccess(sb, { email: job.email });
    ck(access.status === "approved" && access.profile.user_id === job.tUserId, "resolveUserProfileAccess → approved & T사용자", { status: access.status, user_id: access.status === "approved" ? access.profile.user_id : null });

    const { data: authMatches } = await sb.from("user_profiles").select("user_id").eq("auth_email", job.email);
    ck((authMatches ?? []).length === 1 && authMatches![0].user_id === job.tUserId, "auth_email 정확히 1명(T사용자)", authMatches);

    const { data: marker } = await sb.from("test_user_markers").select("user_id").eq("user_id", job.tUserId).maybeSingle();
    ck(!!marker, "test_user_markers 유지", marker);

    const { data: snap } = await sb.from("cluster4_weekly_card_snapshots").select("is_stale, dto_version").eq("user_id", job.tUserId).maybeSingle();
    ck(!!snap && snap.is_stale === false, "snapshot not stale(재계산 불필요)", snap);
  }

  console.log(failures === 0 ? "\n결과: 전체 통과 ✅" : `\n결과: ${failures}건 실패 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
