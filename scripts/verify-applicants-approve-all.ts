// 전체 승인(approve-all) 검증 — direct 함수 == HTTP, mode/org 분리, 멱등, 신규생성 부수효과,
//   목록 반영, snapshot 영향, 브라우저 동작까지 한 스크립트로 확인한다.
//   전제: 운영/테스트 pending 모두 0(블라스트 0). 모든 fixture 는 finally 에서 정리.
import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  approveAllPendingApplicants,
  listApplicants,
} from "@/lib/adminApplicantData";
import { listAppUsers } from "@/lib/adminAppUsersData";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error("ASSERT FAILED: " + message);
}

async function makeAdminCookies() {
  const { data: admins, error: adminError } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  if (adminError) throw new Error(adminError.message);
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email found");

  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError || !link.properties?.email_otp) {
    throw new Error(linkError?.message ?? "generateLink failed");
  }
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verified.session) {
    throw new Error(verifyError?.message ?? "verifyOtp failed");
  }

  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) => {
        captured.push(...items.map(({ name, value }) => ({ name, value })));
      },
    },
  });
  const { error } = await server.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  if (error) throw new Error(error.message);
  return captured;
}

function cookieHeader(cookies: Array<{ name: string; value: string }>) {
  return cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}

async function httpJson(
  path: string,
  cookies: Array<{ name: string; value: string }>,
  init?: RequestInit,
) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Cookie: cookieHeader(cookies),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const json = await response.json();
  return { status: response.status, json };
}

async function insertFixture(email: string, name: string) {
  const { data, error } = await supabaseAdmin
    .from("applicants")
    .insert({ email, name, provider: "kakao", status: "pending" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

// approvalKind 분포만 비교(순서/ID 무관) — direct/http 동등성 판정.
function kindHistogram(results: Array<{ ok: boolean; approvalKind?: string; status?: number }>) {
  const h: Record<string, number> = {};
  for (const r of results) {
    const key = r.ok ? `ok:${r.approvalKind}` : `fail:${r.status}`;
    h[key] = (h[key] ?? 0) + 1;
  }
  return h;
}

async function main() {
  const cleanupApplicantIds: string[] = [];
  const cleanupUserIds: string[] = [];
  const out: Record<string, unknown> = {};

  // 전제: pending 0 (블라스트 0)
  assert((await listApplicants("pending", "operating")).length === 0, "precondition: operating pending must be 0");
  assert((await listApplicants("pending", "test")).length === 0, "precondition: test pending must be 0");

  const cookies = await makeAdminCookies();

  // 테스트 유저(이메일 매핑 대상) 확보 — 이메일 일치 시 신규생성 없이 existing 연결.
  const { data: marker } = await supabaseAdmin
    .from("test_user_markers").select("user_id").limit(1).single();
  assert(marker?.user_id, "No test_user_markers row found");
  const { data: testProfile } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,auth_email,contact_email")
    .eq("user_id", marker.user_id).single();
  assert(testProfile, "Test profile not found");
  const testEmail = (testProfile.auth_email ?? testProfile.contact_email) as string;
  assert(testEmail, "Test profile has no email");

  // 테스트 프로필 snapshot 사전 캡처(existing 연결은 snapshot 무변경이어야 함).
  const { data: snapBefore } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots").select("*")
    .eq("user_id", testProfile.user_id).maybeSingle();

  try {
    // ── 1) mode 분리: 테스트 이메일 fixture 는 test pending 에만, operating 엔 없음.
    const sepId = await insertFixture(testEmail, "[전체승인검증] mode 분리");
    cleanupApplicantIds.push(sepId);
    assert(!(await listApplicants("pending", "operating")).some((a) => a.id === sepId), "operating leaked test-email fixture");
    assert((await listApplicants("pending", "test")).some((a) => a.id === sepId), "test missed test-email fixture");
    await supabaseAdmin.from("applicants").delete().eq("id", sepId);
    cleanupApplicantIds.splice(cleanupApplicantIds.indexOf(sepId), 1);
    out.modeSeparation = "ok";

    // ── 2) direct == HTTP 동등성 (test 모드, 이메일 매핑 → existing 연결, 신규생성 없음)
    //   두 라운드를 동일 입력으로 구성해 요약/분포가 같은지 비교(가변 집합이라 순차 1회씩).
    const K = 3;
    // Round HTTP
    const httpFixtureIds: string[] = [];
    for (let i = 0; i < K; i++) {
      const id = await insertFixture(testEmail, `[전체승인검증] HTTP ${i}`);
      httpFixtureIds.push(id); cleanupApplicantIds.push(id);
    }
    const httpRes = await httpJson("/api/admin/applicants/approve-all?mode=test", cookies, { method: "POST" });
    assert(httpRes.status === 200 && httpRes.json.ok, "approve-all HTTP not ok: " + JSON.stringify(httpRes.json));
    const httpSummary = httpRes.json as { total: number; succeeded: number; failed: number; results: Array<{ ok: boolean; approvalKind?: string; status?: number; linkedUserId?: string }> };
    // 모두 existing 연결, 신규유저 미생성
    assert(httpSummary.total === K && httpSummary.succeeded === K && httpSummary.failed === 0, "HTTP summary counts wrong: " + JSON.stringify(httpSummary));
    assert(httpSummary.results.every((r) => r.ok && r.approvalKind === "existing" && r.linkedUserId === testProfile.user_id), "HTTP results not all existing→test user");
    // DB 반영: fixture 들이 approved + linked
    for (const id of httpFixtureIds) {
      const { data } = await supabaseAdmin.from("applicants").select("status,linked_user_id,approved_at").eq("id", id).single();
      assert(data?.status === "approved" && data.linked_user_id === testProfile.user_id && data.approved_at, "HTTP fixture DB state invalid for " + id);
    }
    // cleanup HTTP fixtures
    await supabaseAdmin.from("applicants").delete().in("id", httpFixtureIds);
    for (const id of httpFixtureIds) cleanupApplicantIds.splice(cleanupApplicantIds.indexOf(id), 1);

    // Round DIRECT (동일 입력)
    const directFixtureIds: string[] = [];
    for (let i = 0; i < K; i++) {
      const id = await insertFixture(testEmail, `[전체승인검증] DIRECT ${i}`);
      directFixtureIds.push(id); cleanupApplicantIds.push(id);
    }
    const directSummary = await approveAllPendingApplicants("test");
    assert(directSummary.total === K && directSummary.succeeded === K && directSummary.failed === 0, "DIRECT summary counts wrong: " + JSON.stringify(directSummary));
    await supabaseAdmin.from("applicants").delete().in("id", directFixtureIds);
    for (const id of directFixtureIds) cleanupApplicantIds.splice(cleanupApplicantIds.indexOf(id), 1);

    // 동등성: total/succeeded/failed + approvalKind 분포 일치
    assert(httpSummary.total === directSummary.total, "direct/http total mismatch");
    assert(httpSummary.succeeded === directSummary.succeeded, "direct/http succeeded mismatch");
    assert(httpSummary.failed === directSummary.failed, "direct/http failed mismatch");
    assert(JSON.stringify(kindHistogram(httpSummary.results)) === JSON.stringify(kindHistogram(directSummary.results)), "direct/http approvalKind histogram mismatch");
    out.directEqualsHttp = { http: { total: httpSummary.total, succeeded: httpSummary.succeeded, failed: httpSummary.failed }, direct: { total: directSummary.total, succeeded: directSummary.succeeded, failed: directSummary.failed }, histogram: kindHistogram(httpSummary.results) };

    // ── 3) 멱등성: pending 0 상태에서 다시 호출 → total 0(중복 승인 없음)
    const idem = await httpJson("/api/admin/applicants/approve-all?mode=test", cookies, { method: "POST" });
    assert(idem.status === 200 && idem.json.ok && idem.json.total === 0, "idempotent re-run should yield total 0: " + JSON.stringify(idem.json));
    out.idempotent = "ok (re-run total=0)";

    // ── 4) test existing 연결은 snapshot 무변경
    const { data: snapAfter } = await supabaseAdmin
      .from("cluster4_weekly_card_snapshots").select("*")
      .eq("user_id", testProfile.user_id).maybeSingle();
    assert(JSON.stringify(snapAfter) === JSON.stringify(snapBefore), "existing-link approval changed snapshot");
    out.snapshotUnchangedForExistingLink = true;

    // ── 5) operating 신규생성 경로(단건 approve-new 와 동일 부수효과) + 목록 반영 + snapshot 생성
    const uniqueEmail = `approve-all-verify+${marker.user_id}@example.invalid`;
    // 사전 정리(이전 실패 잔재)
    {
      const { data: prev } = await supabaseAdmin.from("user_profiles").select("user_id").or(`auth_email.ilike.${uniqueEmail},contact_email.ilike.${uniqueEmail}`);
      for (const p of (prev ?? []) as Array<{ user_id: string }>) {
        await supabaseAdmin.from("cluster4_weekly_card_snapshots").delete().eq("user_id", p.user_id);
        await supabaseAdmin.from("user_profiles").delete().eq("user_id", p.user_id);
        await supabaseAdmin.from("users").delete().eq("id", p.user_id);
      }
    }
    const newId = await insertFixture(uniqueEmail, "[전체승인검증] 신규생성");
    cleanupApplicantIds.push(newId);
    const opRes = await httpJson("/api/admin/applicants/approve-all", cookies, { method: "POST" });
    assert(opRes.status === 200 && opRes.json.ok, "operating approve-all not ok: " + JSON.stringify(opRes.json));
    const opSummary = opRes.json as { total: number; succeeded: number; failed: number; results: Array<{ id: string; ok: boolean; approvalKind?: string; linkedUserId?: string }> };
    const created = opSummary.results.find((r) => r.id === newId);
    assert(created?.ok && created.approvalKind === "new" && created.linkedUserId, "operating fixture not created as new: " + JSON.stringify(opSummary));
    const newUserId = created!.linkedUserId!;
    cleanupUserIds.push(newUserId);
    // 부수효과: users + user_profiles 생성 (DTO 동일)
    const { data: prof } = await supabaseAdmin.from("user_profiles").select("user_id,display_name,auth_email,contact_email,status,growth_status,activity_started_at").eq("user_id", newUserId).single();
    assert(prof && prof.auth_email === uniqueEmail && prof.contact_email === uniqueEmail && prof.status === "active" && prof.growth_status === "active" && prof.activity_started_at, "new profile fields invalid: " + JSON.stringify(prof));
    const { data: userRow } = await supabaseAdmin.from("users").select("id").eq("id", newUserId).single();
    assert(userRow?.id === newUserId, "users row not created");
    // applicant approved + linked
    const { data: appRow } = await supabaseAdmin.from("applicants").select("status,linked_user_id").eq("id", newId).single();
    assert(appRow?.status === "approved" && appRow.linked_user_id === newUserId, "operating applicant not approved/linked");
    out.operatingNewUser = { approvalKind: "new", newUserId };

    // snapshot 생성됨(신규유저 쓰기 시점 부수효과)
    const { data: newSnap } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("user_id").eq("user_id", newUserId).maybeSingle();
    out.newUserSnapshotCreated = Boolean(newSnap);
    assert(newSnap, "new user snapshot was not created (expected recompute side-effect)");

    // 목록 반영: 가입된 사용자(app-users) 목록에 신규 유저 등장
    const appUsers = await listAppUsers({ mode: "operating" });
    assert(appUsers.data.some((u) => u.userId === newUserId), "new user not in app-users list");
    out.appearsInUserList = true;

    // cleanup operating new user + applicant
    //   순서 주의: applicants.linked_user_id → user FK(RESTRICT) 때문에 applicant 를 먼저 삭제해야
    //   user_profiles/users 삭제가 막히지 않는다.
    await supabaseAdmin.from("applicants").delete().eq("id", newId);
    cleanupApplicantIds.splice(cleanupApplicantIds.indexOf(newId), 1);
    await supabaseAdmin.from("cluster4_weekly_card_snapshots").delete().eq("user_id", newUserId);
    await supabaseAdmin.from("user_profiles").delete().eq("user_id", newUserId);
    await supabaseAdmin.from("users").delete().eq("id", newUserId);
    cleanupUserIds.splice(cleanupUserIds.indexOf(newUserId), 1);

    // ── 6) 브라우저: 버튼 + 확인모달 + 결과 + 목록 새로고침
    const browserIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = await insertFixture(testEmail, `[전체승인검증] 브라우저 ${i}`);
      browserIds.push(id); cleanupApplicantIds.push(id);
    }
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
      await context.addCookies(cookies.map(({ name, value }) => ({ name, value, domain: "localhost", path: "/" })));
      const page = await context.newPage();
      await page.goto(`${baseUrl}/admin/users/applicants?mode=test`, { waitUntil: "networkidle" });
      // 버튼 노출 + 카운트
      const btn = page.getByRole("button", { name: /전체 승인/ });
      await btn.waitFor({ state: "visible" });
      const btnText = (await btn.innerText()).trim();
      assert(/전체 승인 \(2\)/.test(btnText), "button count not (2): " + btnText);
      await btn.click();
      // 확인 모달 문구
      const dialog = page.getByRole("alertdialog");
      await dialog.waitFor({ state: "visible" });
      const dialogText = await dialog.innerText();
      assert(dialogText.includes("현재 필터 조건의 승인 대기 지원자 2명을 전체 승인하시겠습니까?"), "confirm copy missing: " + dialogText);
      // 전체 승인 클릭
      await dialog.getByRole("button", { name: "전체 승인" }).click();
      // 결과 배너
      await page.getByText(/전체 승인 완료 — 성공 2명 \/ 실패 0명/).waitFor({ state: "visible", timeout: 15000 });
      // 목록 새로고침 → fixture 사라짐(pending 0)
      await page.waitForTimeout(1000);
      const body = await page.locator("body").innerText();
      assert(body.includes("조회된 신청자가 없습니다") || !body.includes("[전체승인검증] 브라우저"), "list did not refresh after approve-all");
      out.browser = "ok (button + modal + result + refresh)";
      await context.close();
    } finally {
      await browser.close();
    }
    await supabaseAdmin.from("applicants").delete().in("id", browserIds);
    for (const id of browserIds) cleanupApplicantIds.splice(cleanupApplicantIds.indexOf(id), 1);

    console.log(JSON.stringify({ ok: true, ...out }, null, 2));
  } finally {
    // 안전망 정리 — applicants 를 먼저 지워 linked_user_id FK(RESTRICT) 해제 후 user 삭제.
    if (cleanupApplicantIds.length) {
      const { error } = await supabaseAdmin.from("applicants").delete().in("id", cleanupApplicantIds);
      if (error) console.error("fixture cleanup failed", error.message);
    }
    if (cleanupUserIds.length) {
      for (const uid of cleanupUserIds) {
        await supabaseAdmin.from("cluster4_weekly_card_snapshots").delete().eq("user_id", uid);
        await supabaseAdmin.from("user_profiles").delete().eq("user_id", uid);
        await supabaseAdmin.from("users").delete().eq("id", uid);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
