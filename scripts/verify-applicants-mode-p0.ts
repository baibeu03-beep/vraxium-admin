import { chromium } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { approveApplicant, listApplicants, searchUserProfiles } from "@/lib/adminApplicantData";
import { listAppUsers } from "@/lib/adminAppUsersData";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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
  if (!response.ok) {
    throw new Error(`${path} -> ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function insertFixture(email: string, name: string) {
  const { data, error } = await supabaseAdmin
    .from("applicants")
    .insert({
      email,
      name,
      provider: "kakao",
      status: "pending",
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

async function main() {
  const cleanupApplicantIds: string[] = [];
  const cookies = await makeAdminCookies();
  const { data: marker } = await supabaseAdmin
    .from("test_user_markers")
    .select("user_id")
    .limit(1)
    .single();
  assert(marker?.user_id, "No test_user_markers row found");
  const { data: profile } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,auth_email,contact_email,organization_slug")
    .eq("user_id", marker.user_id)
    .single();
  assert(profile, "Test profile not found");
  const email = profile.auth_email ?? profile.contact_email;
  assert(email, "Test profile has no email");
  const searchTerm = profile.display_name ?? email;

  const { data: snapshotBefore } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("*")
    .eq("user_id", profile.user_id)
    .maybeSingle();

  try {
    const [directOperating, directTest, httpOperating, httpTest] = await Promise.all([
      searchUserProfiles(searchTerm, "operating"),
      searchUserProfiles(searchTerm, "test"),
      httpJson(
        `/api/admin/user-profiles/search?q=${encodeURIComponent(searchTerm)}`,
        cookies,
      ),
      httpJson(
        `/api/admin/user-profiles/search?q=${encodeURIComponent(searchTerm)}&mode=test`,
        cookies,
      ),
    ]);
    assert(!directOperating.some((row) => row.userId === profile.user_id), "direct operating leaked test user");
    assert(directTest.some((row) => row.userId === profile.user_id), "direct test missed test user");
    assert(
      JSON.stringify(httpOperating.users) === JSON.stringify(directOperating),
      "candidate operating direct/http mismatch",
    );
    assert(
      JSON.stringify(httpTest.users) === JSON.stringify(directTest),
      "candidate test direct/http mismatch",
    );

    const [directAppOperating, directAppTest, httpAppOperating, httpAppTest] =
      await Promise.all([
        listAppUsers({ mode: "operating" }),
        listAppUsers({ mode: "test" }),
        httpJson("/api/admin/app-users", cookies),
        httpJson("/api/admin/app-users?mode=test", cookies),
      ]);
    assert(
      JSON.stringify(httpAppOperating.data) === JSON.stringify(directAppOperating.data),
      "app-users operating direct/http mismatch",
    );
    assert(
      JSON.stringify(httpAppTest.data) === JSON.stringify(directAppTest.data),
      "app-users test direct/http mismatch",
    );
    assert(httpAppOperating.total === directAppOperating.total, "operating total mismatch");
    assert(httpAppTest.total === directAppTest.total, "test total mismatch");

    const directFixtureId = await insertFixture(email, "P0 direct email mapping");
    cleanupApplicantIds.push(directFixtureId);
    const directApproval = await approveApplicant(
      directFixtureId,
      profile.user_id,
      "test",
    );
    assert(directApproval.profile.userId === profile.user_id, "direct approval linked wrong user");
    const { data: directApproved } = await supabaseAdmin
      .from("applicants")
      .select("status,linked_user_id,approved_at")
      .eq("id", directFixtureId)
      .single();
    assert(
      directApproved?.status === "approved" &&
        directApproved.linked_user_id === profile.user_id &&
        directApproved.approved_at,
      "direct approval DB state invalid",
    );
    await supabaseAdmin.from("applicants").delete().eq("id", directFixtureId);
    cleanupApplicantIds.splice(cleanupApplicantIds.indexOf(directFixtureId), 1);

    const httpFixtureId = await insertFixture(email, "P0 HTTP email mapping");
    cleanupApplicantIds.push(httpFixtureId);
    const httpApproval = await httpJson(
      `/api/admin/applicants/${httpFixtureId}/approve-existing?mode=test`,
      cookies,
      {
        method: "POST",
        body: JSON.stringify({ user_id: profile.user_id }),
      },
    );
    assert(httpApproval.linked_user_id === profile.user_id, "HTTP approval linked wrong user");
    const { data: httpApproved } = await supabaseAdmin
      .from("applicants")
      .select("status,linked_user_id,approved_at")
      .eq("id", httpFixtureId)
      .single();
    assert(
      httpApproved?.status === "approved" &&
        httpApproved.linked_user_id === profile.user_id &&
        httpApproved.approved_at,
      "HTTP approval DB state invalid",
    );
    await supabaseAdmin.from("applicants").delete().eq("id", httpFixtureId);
    cleanupApplicantIds.splice(cleanupApplicantIds.indexOf(httpFixtureId), 1);

    const autoFixtureId = await insertFixture(email, "P0 approve-new auto mapping");
    cleanupApplicantIds.push(autoFixtureId);
    const autoApproval = await httpJson(
      `/api/admin/applicants/${autoFixtureId}/approve-new?mode=test`,
      cookies,
      { method: "POST" },
    );
    assert(autoApproval.approval_kind === "existing", "approve-new did not auto-map email");
    assert(autoApproval.linked_user_id === profile.user_id, "approve-new auto-map linked wrong user");
    const { data: autoApproved } = await supabaseAdmin
      .from("applicants")
      .select("status,linked_user_id,approved_at")
      .eq("id", autoFixtureId)
      .single();
    assert(
      autoApproved?.status === "approved" &&
        autoApproved.linked_user_id === profile.user_id &&
        autoApproved.approved_at,
      "approve-new auto-map DB state invalid",
    );
    await supabaseAdmin.from("applicants").delete().eq("id", autoFixtureId);
    cleanupApplicantIds.splice(cleanupApplicantIds.indexOf(autoFixtureId), 1);

    const browserFixtureId = await insertFixture(email, "P0 browser mode fixture");
    cleanupApplicantIds.push(browserFixtureId);
    const [directApplicantsOperating, directApplicantsTest, httpApplicantsOperating, httpApplicantsTest] =
      await Promise.all([
        listApplicants("pending", "operating"),
        listApplicants("pending", "test"),
        httpJson("/api/admin/applicants?status=pending", cookies),
        httpJson("/api/admin/applicants?status=pending&mode=test", cookies),
      ]);
    assert(
      JSON.stringify(httpApplicantsOperating.data) ===
        JSON.stringify(directApplicantsOperating),
      "applicants operating direct/http mismatch",
    );
    assert(
      JSON.stringify(httpApplicantsTest.data) === JSON.stringify(directApplicantsTest),
      "applicants test direct/http mismatch",
    );
    assert(
      !directApplicantsOperating.some((row) => row.id === browserFixtureId),
      "operating applicants leaked test-email fixture",
    );
    assert(
      directApplicantsTest.some((row) => row.id === browserFixtureId),
      "test applicants missed test-email fixture",
    );

    const { data: organizations } = await supabaseAdmin
      .from("organizations")
      .select("slug")
      .neq("slug", profile.organization_slug ?? "")
      .limit(1);
    const temporaryOrg = organizations?.[0]?.slug;
    assert(temporaryOrg, "No alternate organization found");
    await httpJson(
      `/api/admin/user-profiles/${profile.user_id}/organization?mode=test`,
      cookies,
      {
        method: "PATCH",
        body: JSON.stringify({ organization_slug: temporaryOrg }),
      },
    );
    const { data: changedProfile } = await supabaseAdmin
      .from("user_profiles")
      .select("organization_slug")
      .eq("user_id", profile.user_id)
      .single();
    assert(changedProfile?.organization_slug === temporaryOrg, "organization PATCH not persisted");
    await httpJson(
      `/api/admin/user-profiles/${profile.user_id}/organization?mode=test`,
      cookies,
      {
        method: "PATCH",
        body: JSON.stringify({ organization_slug: profile.organization_slug }),
      },
    );

    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
      await context.addCookies(
        cookies.map(({ name, value }) => ({
          name,
          value,
          domain: "localhost",
          path: "/",
        })),
      );
      const page = await context.newPage();
      await page.goto(`${baseUrl}/admin/users/applicants?mode=test`, {
        waitUntil: "networkidle",
      });
      let body = await page.locator("body").innerText();
      assert(body.includes("P0 browser mode fixture"), "browser test applicants missing fixture");
      await page.goto(`${baseUrl}/admin/users/applicants`, { waitUntil: "networkidle" });
      body = await page.locator("body").innerText();
      assert(!body.includes("P0 browser mode fixture"), "browser operating applicants leaked fixture");
      await page.goto(`${baseUrl}/admin/users/applicants?tab=app-users&mode=test`, {
        waitUntil: "networkidle",
      });
      body = await page.locator("body").innerText();
      assert(body.includes(searchTerm), "browser test app-users missing test user");
      assert(body.includes(`총 ${directAppTest.total}명`), "browser test total is inaccurate");
      await page.goto(`${baseUrl}/admin/users/applicants?tab=app-users`, {
        waitUntil: "networkidle",
      });
      body = await page.locator("body").innerText();
      assert(!body.includes(searchTerm), "browser operating app-users leaked test user");
      assert(
        body.includes(`전체 ${directAppOperating.total}명 중 ${directAppOperating.displayedCount}명 표시`),
        "browser operating displayed/total count is inaccurate",
      );
      await context.close();
    } finally {
      await browser.close();
    }

    const { data: snapshotAfter } = await supabaseAdmin
      .from("cluster4_weekly_card_snapshots")
      .select("*")
      .eq("user_id", profile.user_id)
      .maybeSingle();
    assert(
      JSON.stringify(snapshotAfter) === JSON.stringify(snapshotBefore),
      "existing approval or organization PATCH changed snapshot",
    );

    console.log(
      JSON.stringify(
        {
          ok: true,
          sample: profile,
          candidates: {
            operating: directOperating.length,
            test: directTest.length,
          },
          appUsers: {
            operating: {
              total: directAppOperating.total,
              displayedCount: directAppOperating.displayedCount,
            },
            test: {
              total: directAppTest.total,
              displayedCount: directAppTest.displayedCount,
            },
          },
          directApproval: directApproved,
          httpApproval: httpApproved,
          approveNewAutoMapping: autoApproved,
          organizationPatchRestoredTo: profile.organization_slug,
          snapshotUnchanged: true,
          browserVerified: true,
        },
        null,
        2,
      ),
    );
  } finally {
    if (cleanupApplicantIds.length > 0) {
      const { error } = await supabaseAdmin
        .from("applicants")
        .delete()
        .in("id", cleanupApplicantIds);
      if (error) console.error("fixture cleanup failed", error.message);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
