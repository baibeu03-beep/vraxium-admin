import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

type Json = Record<string, unknown>;

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3010";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function makeAdminCookieHeader() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const browser = createClient(supabaseUrl, anonKey);

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp) {
    throw new Error(linkError?.message ?? "Failed to generate admin magic link");
  }

  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session) {
    throw new Error(verifyError?.message ?? "Failed to verify admin OTP");
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
  const cookieHeader = await makeAdminCookieHeader();

  const summary: Record<string, unknown> = {
    baseUrl,
    adminEmail,
  };

  const tableChecks = await Promise.all([
    supabaseAdmin.from("cluster4_lines").select("id").limit(1),
    supabaseAdmin.from("cluster4_line_targets").select("id").limit(1),
    supabaseAdmin.from("cluster4_line_submissions").select("id").limit(1),
    supabaseAdmin
      .from("pg_indexes")
      .select("tablename,indexname")
      .in("tablename", ["cluster4_lines", "cluster4_line_targets", "cluster4_line_submissions"]),
  ]);

  summary.tableChecks = {
    cluster4_lines: tableChecks[0].error?.message ?? "ok",
    cluster4_line_targets: tableChecks[1].error?.message ?? "ok",
    cluster4_line_submissions: tableChecks[2].error?.message ?? "ok",
    pg_indexes: tableChecks[3].error?.message
      ? { status: "unavailable", error: tableChecks[3].error.message }
      : tableChecks[3].data,
  };

  const weeksResult = await supabaseAdmin
    .from("weeks")
    .select("id")
    .limit(2);
  const usersResult = await supabaseAdmin
    .from("user_profiles")
    .select("user_id")
    .not("user_id", "is", null)
    .limit(2);

  if (weeksResult.error || (weeksResult.data?.length ?? 0) < 1) {
    throw new Error(weeksResult.error?.message ?? "No week rows found");
  }
  if (usersResult.error || (usersResult.data?.length ?? 0) < 1) {
    throw new Error(usersResult.error?.message ?? "No user_profiles rows found");
  }

  const weekId1 = String(weeksResult.data?.[0]?.id);
  const weekId2 = String(weeksResult.data?.[1]?.id ?? weeksResult.data?.[0]?.id);
  const userId1 = String(usersResult.data?.[0]?.user_id);
  const userId2 = String(usersResult.data?.[1]?.user_id ?? usersResult.data?.[0]?.user_id);

  summary.fixtureInputs = { weekId1, weekId2, userId1, userId2 };

  const createLine = await requestJson(cookieHeader, "/api/admin/cluster4/lines", {
    method: "POST",
    body: JSON.stringify({
      part_type: "career",
      main_title: "테스트 라인",
      output_link_1: "https://example.com/test-line",
      submission_opens_at: "2026-05-26T00:00:00.000Z",
      submission_closes_at: "2026-06-30T14:59:59.000Z",
      is_active: true,
    }),
  });
  summary.createLine = createLine;

  const line = (createLine.json.data as Json | undefined)?.line as Json | undefined;
  const lineId = typeof line?.id === "string" ? line.id : null;
  if (!lineId) {
    throw new Error(`Line creation failed: ${JSON.stringify(createLine.json)}`);
  }
  summary.lineId = lineId;

  const invalidUserTarget = await supabaseAdmin.from("cluster4_line_targets").insert({
    line_id: lineId,
    week_id: weekId1,
    target_mode: "user",
    target_user_id: null,
    target_rule: {},
  });
  summary.invalidUserTargetConstraint = invalidUserTarget.error?.message ?? "unexpectedly succeeded";

  const createTarget = await requestJson(
    cookieHeader,
    `/api/admin/cluster4/lines/${encodeURIComponent(lineId)}/targets`,
    {
      method: "POST",
      body: JSON.stringify({
        week_id: weekId1,
        target_mode: "user",
        target_user_id: userId1,
      }),
    },
  );
  summary.createTarget = createTarget;

  const target = (createTarget.json.data as Json | undefined)?.target as Json | undefined;
  const targetId = typeof target?.id === "string" ? target.id : null;
  if (!targetId) {
    throw new Error(`Target creation failed: ${JSON.stringify(createTarget.json)}`);
  }
  summary.targetId = targetId;

  const directLine = await supabaseAdmin
    .from("cluster4_lines")
    .select("*")
    .eq("id", lineId)
    .maybeSingle();
  const directTarget = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("*")
    .eq("id", targetId)
    .maybeSingle();
  summary.directLookup = {
    lineError: directLine.error?.message ?? null,
    line: directLine.data,
    targetError: directTarget.error?.message ?? null,
    target: directTarget.data,
  };

  const listApi = await requestJson(cookieHeader, "/api/admin/cluster4/lines?partType=career&limit=50&offset=0");
  const getApi = await requestJson(cookieHeader, `/api/admin/cluster4/lines/${encodeURIComponent(lineId)}`);
  const targetsApi = await requestJson(
    cookieHeader,
    `/api/admin/cluster4/lines/${encodeURIComponent(lineId)}/targets`,
  );
  summary.getApis = {
    listApi,
    getApi,
    targetsApi,
  };

  const patchTarget = await requestJson(
    cookieHeader,
    `/api/admin/cluster4/targets/${encodeURIComponent(targetId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        week_id: weekId2,
        target_mode: "user",
        target_user_id: userId2,
      }),
    },
  );
  summary.patchTarget = patchTarget;

  const invalidSubmission = await supabaseAdmin.from("cluster4_line_submissions").insert({
    line_target_id: targetId,
    user_id: userId1,
    subtitle: "should fail",
  });
  summary.invalidSubmissionUserCheck = invalidSubmission.error?.message ?? "unexpectedly succeeded";

  const deleteLine = await requestJson(cookieHeader, `/api/admin/cluster4/lines/${encodeURIComponent(lineId)}`, {
    method: "DELETE",
  });
  summary.deleteLine = deleteLine;

  const afterDeleteTarget = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("id")
    .eq("id", targetId)
    .maybeSingle();
  summary.cleanupCheck = {
    targetAfterDeleteError: afterDeleteTarget.error?.message ?? null,
    targetAfterDelete: afterDeleteTarget.data,
  };

  console.log(JSON.stringify(summary, null, 2));
}

void main();
