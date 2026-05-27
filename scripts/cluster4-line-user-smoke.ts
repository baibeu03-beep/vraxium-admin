import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

type Json = Record<string, unknown>;

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3010";

function ensureEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function makeUserCookieHeader(email: string) {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const browser = createClient(supabaseUrl, anonKey);

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkError || !linkData?.properties?.email_otp) {
    throw new Error(linkError?.message ?? `Failed to generate magic link for ${email}`);
  }

  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session) {
    throw new Error(verifyError?.message ?? `Failed to verify OTP for ${email}`);
  }

  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return [];
      },
      setAll(items) {
        captured.push(...items.map((item) => ({ name: item.name, value: item.value })));
      },
    },
  });

  const { error: setError } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (setError) {
    throw new Error(setError.message);
  }

  return captured.map((item) => `${item.name}=${item.value}`).join("; ");
}

async function requestJson(
  cookieHeader: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookieHeader,
      ...(init?.headers ?? {}),
    },
  });
  const json = (await response.json().catch(() => ({}))) as Json;
  return { status: response.status, json };
}

async function main() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

  const summary: Record<string, unknown> = { baseUrl };

  const admins = await supabaseAdmin.from("admin_users").select("id").limit(1);
  if (admins.error || !admins.data?.[0]?.id) {
    throw new Error(admins.error?.message ?? "No admin user found");
  }
  const adminId = String(admins.data[0].id);

  const weeks = await supabaseAdmin.from("weeks").select("id").limit(2);
  if (weeks.error || (weeks.data?.length ?? 0) < 2) {
    throw new Error(weeks.error?.message ?? "Need at least 2 week rows");
  }
  const weekId1 = String(weeks.data[0].id);
  const weekId2 = String(weeks.data[1].id);

  const profiles = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,auth_email")
    .not("auth_email", "is", null)
    .limit(2);
  if (profiles.error || (profiles.data?.length ?? 0) < 2) {
    throw new Error(profiles.error?.message ?? "Need at least 2 user_profiles with auth_email");
  }

  const user1 = {
    userId: String(profiles.data[0].user_id),
    email: String(profiles.data[0].auth_email),
  };
  const user2 = {
    userId: String(profiles.data[1].user_id),
    email: String(profiles.data[1].auth_email),
  };
  summary.fixtures = { adminId, weekId1, weekId2, user1, user2 };

  const user1Cookie = await makeUserCookieHeader(user1.email);
  const user2Cookie = await makeUserCookieHeader(user2.email);

  const { data: openLine, error: openLineError } = await supabaseAdmin
    .from("cluster4_lines")
    .insert({
      part_type: "career",
      main_title: "유저 API 테스트 라인",
      output_link_1: "https://example.com/open-line",
      submission_opens_at: "2026-05-01T00:00:00.000Z",
      submission_closes_at: "2026-06-30T14:59:59.000Z",
      is_active: true,
      created_by: adminId,
      updated_by: adminId,
    })
    .select("id")
    .single();
  if (openLineError || !openLine) {
    throw new Error(openLineError?.message ?? "Failed to create open line");
  }

  const { data: closedLine, error: closedLineError } = await supabaseAdmin
    .from("cluster4_lines")
    .insert({
      part_type: "career",
      main_title: "유저 API 종료 라인",
      output_link_1: "https://example.com/closed-line",
      submission_opens_at: "2026-04-01T00:00:00.000Z",
      submission_closes_at: "2026-05-01T00:00:00.000Z",
      is_active: true,
      created_by: adminId,
      updated_by: adminId,
    })
    .select("id")
    .single();
  if (closedLineError || !closedLine) {
    throw new Error(closedLineError?.message ?? "Failed to create closed line");
  }

  const { data: openTarget, error: openTargetError } = await supabaseAdmin
    .from("cluster4_line_targets")
    .insert({
      line_id: openLine.id,
      week_id: weekId1,
      target_mode: "user",
      target_user_id: user1.userId,
      target_rule: {},
      created_by: adminId,
      updated_by: adminId,
    })
    .select("id")
    .single();
  if (openTargetError || !openTarget) {
    throw new Error(openTargetError?.message ?? "Failed to create open target");
  }

  const { data: closedTarget, error: closedTargetError } = await supabaseAdmin
    .from("cluster4_line_targets")
    .insert({
      line_id: closedLine.id,
      week_id: weekId2,
      target_mode: "user",
      target_user_id: user1.userId,
      target_rule: {},
      created_by: adminId,
      updated_by: adminId,
    })
    .select("id")
    .single();
  if (closedTargetError || !closedTarget) {
    throw new Error(closedTargetError?.message ?? "Failed to create closed target");
  }

  summary.created = {
    openLineId: openLine.id,
    openTargetId: openTarget.id,
    closedLineId: closedLine.id,
    closedTargetId: closedTarget.id,
  };

  try {
    const detailVoid = await requestJson(
      user1Cookie,
      `/api/cluster4/lines/detail?weekId=${encodeURIComponent(weekId2)}&partType=info`,
    );
    const detailPending = await requestJson(
      user1Cookie,
      `/api/cluster4/lines/detail?weekId=${encodeURIComponent(weekId1)}&partType=career`,
    );
    const createSubmission = await requestJson(
      user1Cookie,
      `/api/cluster4/lines/${encodeURIComponent(String(openTarget.id))}/submission`,
      {
        method: "POST",
        body: JSON.stringify({
          subtitle: "첫 제출",
          output_link_2: "https://example.com/out2",
          output_link_3: "https://example.com/out3",
          output_link_4: null,
          output_link_5: null,
        }),
      },
    );
    const detailSuccess = await requestJson(
      user1Cookie,
      `/api/cluster4/lines/detail?weekId=${encodeURIComponent(weekId1)}&partType=career`,
    );
    const patchSubmission = await requestJson(
      user1Cookie,
      `/api/cluster4/lines/${encodeURIComponent(String(openTarget.id))}/submission`,
      {
        method: "PATCH",
        body: JSON.stringify({
          subtitle: "수정된 제출",
          output_link_2: "https://example.com/out2-updated",
          output_link_3: "https://example.com/out3",
          output_link_4: "https://example.com/out4",
          output_link_5: null,
        }),
      },
    );
    const otherUserBlocked = await requestJson(
      user2Cookie,
      `/api/cluster4/lines/${encodeURIComponent(String(openTarget.id))}/submission`,
      {
        method: "POST",
        body: JSON.stringify({
          subtitle: "차단되어야 함",
          output_link_2: "https://example.com/blocked",
        }),
      },
    );
    const closedPostBlocked = await requestJson(
      user1Cookie,
      `/api/cluster4/lines/${encodeURIComponent(String(closedTarget.id))}/submission`,
      {
        method: "POST",
        body: JSON.stringify({
          subtitle: "종료 후 생성",
        }),
      },
    );

    const { data: closedSubmission, error: closedSubmissionError } = await supabaseAdmin
      .from("cluster4_line_submissions")
      .insert({
        line_target_id: closedTarget.id,
        user_id: user1.userId,
        subtitle: "기존 종료 제출",
      })
      .select("id")
      .single();
    if (closedSubmissionError || !closedSubmission) {
      throw new Error(closedSubmissionError?.message ?? "Failed to seed closed submission");
    }

    const closedPatchBlocked = await requestJson(
      user1Cookie,
      `/api/cluster4/lines/${encodeURIComponent(String(closedTarget.id))}/submission`,
      {
        method: "PATCH",
        body: JSON.stringify({
          subtitle: "종료 후 수정",
        }),
      },
    );

    summary.apiResults = {
      detailVoid,
      detailPending,
      createSubmission,
      detailSuccess,
      patchSubmission,
      otherUserBlocked,
      closedPostBlocked,
      closedPatchBlocked,
    };

    const directSubmission = await supabaseAdmin
      .from("cluster4_line_submissions")
      .select("id,line_target_id,subtitle,output_link_2,output_link_3,output_link_4,output_link_5,submitted_at,updated_at")
      .eq("line_target_id", openTarget.id)
      .eq("user_id", user1.userId)
      .maybeSingle();
    summary.directSubmission = {
      error: directSubmission.error?.message ?? null,
      row: directSubmission.data,
    };
  } finally {
    await supabaseAdmin.from("cluster4_lines").delete().in("id", [
      String(openLine.id),
      String(closedLine.id),
    ]);
  }

  console.log(JSON.stringify(summary, null, 2));
}

void main();
