import { isDeepStrictEqual } from "node:util";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { listCluster4Users } from "@/lib/adminCluster4UsersData";
import {
  getCluster4Line,
  listCluster4Lines,
  listCluster4LineTargets,
} from "@/lib/adminCluster4LinesData";
import { listCareerEvaluationTargetsForLine } from "@/lib/adminCareerEvaluationsData";
import {
  getExperienceWorkflowSummary,
  listExperienceDrafts,
} from "@/lib/adminExperienceDraftData";
import { getCrewDetailDto } from "@/lib/adminCrewDetailData";
import { getCrewNote } from "@/lib/adminCrewManagementNotes";
import { getAdminCrewDtoByLegacyUserId } from "@/lib/adminCrewData";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const service = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string) {
  assert(isDeepStrictEqual(actual, expected), message);
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
  assert(link.properties?.email_otp && !linkError, linkError?.message ?? "generateLink failed");
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  assert(verified.session && !verifyError, verifyError?.message ?? "verifyOtp failed");

  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        captured.push(...items.map(({ name, value }) => ({ name, value }))),
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

async function http(
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
    cache: "no-store",
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function scopedUsers() {
  const { data: markers, error: markerError } = await service
    .from("test_user_markers")
    .select("user_id");
  if (markerError) throw markerError;
  const testIds = new Set((markers ?? []).map((row) => row.user_id as string));
  assert(testIds.size > 0, "No test_user_markers rows");

  const { data: profiles, error: profileError } = await service
    .from("user_profiles")
    .select("user_id,display_name")
    .order("created_at", { ascending: false });
  if (profileError) throw profileError;
  const test = profiles?.find((row) => testIds.has(row.user_id));
  const operating = profiles?.find((row) => !testIds.has(row.user_id));
  assert(test?.user_id, "No test profile");
  assert(operating?.user_id, "No operating profile");
  return { test, operating, testIds };
}

async function rowFingerprint(table: string, column: string, value: string) {
  const { data, error } = await service
    .from(table)
    .select("*")
    .eq(column, value);
  if (error) throw error;
  return data ?? [];
}

async function snapshotFingerprint(userId: string) {
  return rowFingerprint("cluster4_weekly_card_snapshots", "user_id", userId);
}

async function main() {
  const cookies = await makeAdminCookies();
  const { test, operating, testIds } = await scopedUsers();
  const checks: string[] = [];
  const pass = (message: string) => {
    checks.push(message);
    console.log(`PASS ${message}`);
  };

  for (const mode of ["operating", "test"] as const) {
    const directUsers = await listCluster4Users({ mode });
    const usersHttp = await http(
      `/api/admin/cluster4/users${mode === "test" ? "?mode=test" : ""}`,
      cookies,
    );
    assert(usersHttp.status === 200, `cluster4/users ${mode}: ${usersHttp.status}`);
    equal(usersHttp.body.data, directUsers, `cluster4/users ${mode} direct/http mismatch`);
    assert(
      directUsers.every((row) =>
        mode === "test" ? testIds.has(row.userId) : !testIds.has(row.userId),
      ),
      `cluster4/users ${mode} leaked opposite scope`,
    );
    pass(`cluster4/users ${mode} direct=HTTP and scope-separated`);

    const directLines = await listCluster4Lines({ limit: 50, offset: 0, mode });
    const linesHttp = await http(
      `/api/admin/cluster4/lines?limit=50&offset=0${mode === "test" ? "&mode=test" : ""}`,
      cookies,
    );
    assert(linesHttp.status === 200, `cluster4/lines ${mode}: ${linesHttp.status}`);
    equal(linesHttp.body.data, directLines, `cluster4/lines ${mode} direct/http mismatch`);
    pass(`cluster4/lines ${mode} direct=HTTP`);
  }

  const { data: draftSeed, error: draftSeedError } = await service
    .from("cluster4_experience_line_drafts")
    .select("id,week_id,target_user_id,memo")
    .order("created_at", { ascending: false })
    .limit(500);
  if (draftSeedError) throw draftSeedError;
  const draftRows = draftSeed ?? [];
  const weekId = draftRows[0]?.week_id as string | undefined;
  if (weekId) {
    for (const mode of ["operating", "test"] as const) {
      const directDrafts = await listExperienceDrafts({ weekId, mode });
      const draftsHttp = await http(
        `/api/admin/cluster4/experience-drafts?week_id=${weekId}${mode === "test" ? "&mode=test" : ""}`,
        cookies,
      );
      assert(draftsHttp.status === 200, `experience-drafts ${mode}: ${draftsHttp.status}`);
      equal(draftsHttp.body.data, directDrafts, `experience-drafts ${mode} direct/http mismatch`);
      const directSummary = await getExperienceWorkflowSummary(weekId, null, mode);
      const summaryHttp = await http(
        `/api/admin/cluster4/experience-workflow-summary?week_id=${weekId}${mode === "test" ? "&mode=test" : ""}`,
        cookies,
      );
      assert(summaryHttp.status === 200, `workflow-summary ${mode}: ${summaryHttp.status}`);
      equal(summaryHttp.body.data, directSummary, `workflow-summary ${mode} direct/http mismatch`);
      pass(`experience drafts/summary ${mode} direct=HTTP`);
    }
  } else {
    console.log("SKIP experience list equality: no draft rows");
  }

  const memberCases = [
    { user: test, mode: "operating" },
    { user: operating, mode: "test" },
  ] as const;
  for (const item of memberCases) {
    const query = item.mode === "test" ? "?mode=test" : "";
    const response = await http(`/api/admin/members/${item.user.user_id}${query}`, cookies);
    assert(response.status === 422, `members opposite scope returned ${response.status}`);
  }
  pass("members GET rejects both opposite-scope directions with 422");

  const directCrew = await getAdminCrewDtoByLegacyUserId(test.user_id);
  assert(directCrew?.userId === test.user_id, "crew direct lookup mismatch");
  const crewRejected = await http(`/api/admin/crews/${test.user_id}`, cookies);
  assert(crewRejected.status === 422, `crew opposite scope returned ${crewRejected.status}`);
  const crewAccepted = await http(`/api/admin/crews/${test.user_id}?mode=test`, cookies);
  assert(crewAccepted.status === 200, `crew test GET returned ${crewAccepted.status}`);
  equal(crewAccepted.body.data, directCrew, "crew direct/http mismatch");
  pass("crew direct=HTTP in test and operating is 422");

  const directDetail = await getCrewDetailDto(test.user_id, { generatedBy: null });
  assert(directDetail, "Test member detail missing");
  const directNote = await getCrewNote(test.user_id);
  const memberHttp = await http(`/api/admin/members/${test.user_id}?mode=test`, cookies);
  assert(memberHttp.status === 200, `test member GET failed: ${memberHttp.status}`);
  equal(
    memberHttp.body.data,
    { ...directDetail, note: directNote },
    "member detail direct/http mismatch",
  );
  pass("members test detail direct=HTTP");

  const noteBefore = await rowFingerprint("crew_management_notes", "user_id", test.user_id);
  const noteSnapshotsBefore = await snapshotFingerprint(test.user_id);
  const rejectedNote = await http(`/api/admin/members/${test.user_id}/note`, cookies, {
    method: "PUT",
    body: JSON.stringify({ note: directNote.note }),
  });
  assert(rejectedNote.status === 422, `note opposite scope returned ${rejectedNote.status}`);
  equal(
    await rowFingerprint("crew_management_notes", "user_id", test.user_id),
    noteBefore,
    "rejected note request changed DB",
  );
  equal(
    await snapshotFingerprint(test.user_id),
    noteSnapshotsBefore,
    "rejected note request changed snapshots",
  );
  pass("note opposite-scope write is 422 with DB/snapshot unchanged");

  const acceptedNote = await http(
    `/api/admin/members/${test.user_id}/note?mode=test`,
    cookies,
    { method: "PUT", body: JSON.stringify({ note: directNote.note }) },
  );
  assert(acceptedNote.status === 200, `note in-scope write returned ${acceptedNote.status}`);
  assert(acceptedNote.body.data.note === directNote.note, "note in-scope result mismatch");
  equal(
    await snapshotFingerprint(test.user_id),
    noteSnapshotsBefore,
    "successful note save changed snapshots",
  );
  pass("note in-scope write succeeds without snapshot invalidation/recompute");

  const testTarget = draftRows.find((row) => testIds.has(row.target_user_id as string));
  if (testTarget) {
    const draftBefore = await rowFingerprint(
      "cluster4_experience_line_drafts",
      "id",
      testTarget.id as string,
    );
    const snapshotsBefore = await snapshotFingerprint(testTarget.target_user_id as string);
    const rejectedDraft = await http(
      `/api/admin/cluster4/experience-drafts/${testTarget.id}`,
      cookies,
      {
        method: "PATCH",
        body: JSON.stringify({ memo: testTarget.memo ?? null }),
      },
    );
    assert(rejectedDraft.status === 422, `draft opposite scope returned ${rejectedDraft.status}`);
    equal(
      await rowFingerprint("cluster4_experience_line_drafts", "id", testTarget.id as string),
      draftBefore,
      "rejected draft request changed DB",
    );
    equal(
      await snapshotFingerprint(testTarget.target_user_id as string),
      snapshotsBefore,
      "rejected draft request changed snapshots",
    );
    pass("experience draft opposite-scope PATCH is 422 with DB/snapshot unchanged");

    const reviewRejected = await http(
      `/api/admin/cluster4/experience-drafts/${testTarget.id}/review`,
      cookies,
      {
        method: "PATCH",
        body: JSON.stringify({ review_status: "approved" }),
      },
    );
    assert(reviewRejected.status === 422, `draft review opposite scope returned ${reviewRejected.status}`);
    equal(
      await rowFingerprint("cluster4_experience_line_drafts", "id", testTarget.id as string),
      draftBefore,
      "rejected draft review changed DB",
    );
    equal(
      await snapshotFingerprint(testTarget.target_user_id as string),
      snapshotsBefore,
      "rejected draft review changed snapshots",
    );
    pass("experience draft review opposite-scope PATCH is fail-closed");
  } else {
    console.log("SKIP draft write guard: no test-user draft");
  }

  let operatingDraft = draftRows.find((row) => !testIds.has(row.target_user_id as string));
  if (!operatingDraft) {
    const markerIds = Array.from(testIds);
    let operatingDraftQuery = service
      .from("cluster4_experience_line_drafts")
      .select("id,week_id,target_user_id,memo")
      .limit(1);
    if (markerIds.length > 0) {
      operatingDraftQuery = operatingDraftQuery.not(
        "target_user_id",
        "in",
        `(${markerIds.join(",")})`,
      );
    }
    const { data: operatingDraftRows, error: operatingDraftError } =
      await operatingDraftQuery;
    if (operatingDraftError) throw operatingDraftError;
    operatingDraft = operatingDraftRows?.[0];
  }
  if (testTarget && operatingDraft) {
    const mixedIds = [testTarget.id as string, operatingDraft.id as string];
    const mixedBefore = await Promise.all(
      mixedIds.map((id) => rowFingerprint("cluster4_experience_line_drafts", "id", id)),
    );
    const mixedSnapshotsBefore = await Promise.all([
      snapshotFingerprint(testTarget.target_user_id as string),
      snapshotFingerprint(operatingDraft.target_user_id as string),
    ]);
    const mixedRejected = await http(
      "/api/admin/cluster4/experience-drafts/open",
      cookies,
      {
        method: "POST",
        body: JSON.stringify({ draft_ids: mixedIds }),
      },
    );
    assert(mixedRejected.status === 422, `mixed draft open returned ${mixedRejected.status}`);
    equal(
      await Promise.all(
        mixedIds.map((id) => rowFingerprint("cluster4_experience_line_drafts", "id", id)),
      ),
      mixedBefore,
      "mixed draft open partially changed DB",
    );
    equal(
      await Promise.all([
        snapshotFingerprint(testTarget.target_user_id as string),
        snapshotFingerprint(operatingDraft.target_user_id as string),
      ]),
      mixedSnapshotsBefore,
      "mixed draft open changed snapshots",
    );
    pass("mixed experience draft open fails whole request with DB/snapshot unchanged");
  } else {
    console.log("SKIP mixed draft open: both scopes are not represented");
  }

  const { data: targets, error: targetsError } = await service
    .from("cluster4_line_targets")
    .select("id,target_user_id")
    .eq("target_mode", "user")
    .not("target_user_id", "is", null)
    .limit(1000);
  if (targetsError) throw targetsError;
  const testLineTarget = targets?.find((row) => testIds.has(row.target_user_id as string));
  if (testLineTarget) {
    const targetBefore = await rowFingerprint(
      "cluster4_line_targets",
      "id",
      testLineTarget.id,
    );
    const snapshotsBefore = await snapshotFingerprint(testLineTarget.target_user_id as string);
    const rejectedTarget = await http(
      `/api/admin/cluster4/targets/${testLineTarget.id}`,
      cookies,
      {
        method: "PATCH",
        body: JSON.stringify({ target_user_id: testLineTarget.target_user_id }),
      },
    );
    assert(rejectedTarget.status === 422, `target opposite scope returned ${rejectedTarget.status}`);
    equal(
      await rowFingerprint("cluster4_line_targets", "id", testLineTarget.id),
      targetBefore,
      "rejected target request changed DB",
    );
    equal(
      await snapshotFingerprint(testLineTarget.target_user_id as string),
      snapshotsBefore,
      "rejected target request changed snapshots",
    );
    pass("generic target opposite-scope PATCH is 422 with DB/snapshot unchanged");
  } else {
    console.log("SKIP target write guard: no test-user target");
  }

  const targetRows = (targets ?? []) as Array<{
    id: string;
    line_id?: string;
    target_user_id: string | null;
  }>;
  const lineIds = Array.from(
    new Set(
      targetRows
        .map((row) => row.line_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  if (lineIds.length === 0) {
    const { data: fullTargets, error: fullTargetsError } = await service
      .from("cluster4_line_targets")
      .select("id,line_id,target_user_id")
      .eq("target_mode", "user")
      .not("target_user_id", "is", null)
      .limit(5000);
    if (fullTargetsError) throw fullTargetsError;
    targetRows.splice(0, targetRows.length, ...((fullTargets ?? []) as typeof targetRows));
  }
  const byLine = new Map<string, typeof targetRows>();
  for (const target of targetRows) {
    if (!target.line_id) continue;
    byLine.set(target.line_id, [...(byLine.get(target.line_id) ?? []), target]);
  }
  const testOnlyLine = Array.from(byLine).find(([, rows]) =>
    rows.length > 0 && rows.every((row) => testIds.has(row.target_user_id as string)),
  );
  const anyTestLine = Array.from(byLine).find(([, rows]) =>
    rows.some((row) => testIds.has(row.target_user_id as string)),
  );
  if (anyTestLine) {
    const [lineId] = anyTestLine;
    const lineRejected = await http(`/api/admin/cluster4/lines/${lineId}`, cookies);
    const targetsRejected = await http(`/api/admin/cluster4/lines/${lineId}/targets`, cookies);
    assert(lineRejected.status === 422, `line opposite scope returned ${lineRejected.status}`);
    assert(targetsRejected.status === 422, `line targets opposite scope returned ${targetsRejected.status}`);
    pass("line and line-target single GETs reject test-target lines in operating");
  }
  if (testOnlyLine) {
    const [lineId] = testOnlyLine;
    const lineRejected = await http(`/api/admin/cluster4/lines/${lineId}`, cookies);
    const targetsRejected = await http(`/api/admin/cluster4/lines/${lineId}/targets`, cookies);
    assert(lineRejected.status === 422, `line opposite scope returned ${lineRejected.status}`);
    assert(targetsRejected.status === 422, `line targets opposite scope returned ${targetsRejected.status}`);
    const directLine = await getCluster4Line(lineId);
    const directTargets = await listCluster4LineTargets(lineId, "test");
    const lineAccepted = await http(`/api/admin/cluster4/lines/${lineId}?mode=test`, cookies);
    const targetsAccepted = await http(
      `/api/admin/cluster4/lines/${lineId}/targets?mode=test`,
      cookies,
    );
    assert(lineAccepted.status === 200 && targetsAccepted.status === 200, "test line GET failed");
    equal(lineAccepted.body.data.line, directLine, "line direct/http mismatch");
    equal(targetsAccepted.body.data, directTargets, "line targets direct/http mismatch");
    pass("line and line-target single GETs are guarded and direct=HTTP");
  } else {
    console.log("SKIP line single GET: no test-only user-target line");
  }

  const testLineIds = Array.from(byLine)
    .filter(([, rows]) => rows.length > 0 && rows.every((row) => testIds.has(row.target_user_id as string)))
    .map(([lineId]) => lineId);
  if (testLineIds.length > 0) {
    const { data: careerLines, error: careerLineError } = await service
      .from("cluster4_lines")
      .select("id")
      .in("id", testLineIds)
      .eq("part_type", "career")
      .limit(1);
    if (careerLineError) throw careerLineError;
    const careerLineId = careerLines?.[0]?.id as string | undefined;
    if (careerLineId) {
      const directCareer = await listCareerEvaluationTargetsForLine(careerLineId, "test");
      const acceptedCareer = await http(
        `/api/admin/cluster4/career-evaluations?line_id=${careerLineId}&mode=test`,
        cookies,
      );
      const rejectedCareer = await http(
        `/api/admin/cluster4/career-evaluations?line_id=${careerLineId}`,
        cookies,
      );
      assert(acceptedCareer.status === 200, `career test GET returned ${acceptedCareer.status}`);
      assert(rejectedCareer.status === 422, `career operating GET returned ${rejectedCareer.status}`);
      equal(acceptedCareer.body.data.targets, directCareer, "career direct/http mismatch");
      const careerTarget = directCareer[0];
      if (careerTarget) {
        const evaluationBefore = await rowFingerprint(
          "cluster4_career_line_evaluations",
          "line_target_id",
          careerTarget.lineTargetId,
        );
        const snapshotsBefore = await snapshotFingerprint(careerTarget.userId);
        const rejectedSave = await http("/api/admin/cluster4/career-evaluations", cookies, {
          method: "POST",
          body: JSON.stringify({
            line_target_id: careerTarget.lineTargetId,
            user_id: careerTarget.userId,
            grade: careerTarget.grade ?? "A",
          }),
        });
        assert(rejectedSave.status === 422, `career opposite-scope POST returned ${rejectedSave.status}`);
        equal(
          await rowFingerprint(
            "cluster4_career_line_evaluations",
            "line_target_id",
            careerTarget.lineTargetId,
          ),
          evaluationBefore,
          "rejected career evaluation changed DB",
        );
        equal(
          await snapshotFingerprint(careerTarget.userId),
          snapshotsBefore,
          "rejected career evaluation changed snapshots",
        );
      }
      pass("career evaluations GET/POST scope guard and direct=HTTP");
    } else {
      console.log("SKIP career guard: no test-only career line");
    }
  }

  const linesContainingTestUsers = Array.from(byLine)
    .filter(([, rows]) => rows.some((row) => testIds.has(row.target_user_id as string)))
    .map(([lineId]) => lineId);
  if (linesContainingTestUsers.length > 0) {
    const { data: careerLines, error: careerLineError } = await service
      .from("cluster4_lines")
      .select("id")
      .in("id", linesContainingTestUsers)
      .eq("part_type", "career")
      .limit(1);
    if (careerLineError) throw careerLineError;
    const careerLineId = careerLines?.[0]?.id as string | undefined;
    const careerTarget = careerLineId
      ? byLine
          .get(careerLineId)
          ?.find((row) => testIds.has(row.target_user_id as string))
      : null;
    if (careerTarget?.target_user_id) {
      const evaluationBefore = await rowFingerprint(
        "cluster4_career_line_evaluations",
        "line_target_id",
        careerTarget.id,
      );
      const snapshotsBefore = await snapshotFingerprint(careerTarget.target_user_id);
      const rejectedSave = await http("/api/admin/cluster4/career-evaluations", cookies, {
        method: "POST",
        body: JSON.stringify({
          line_target_id: careerTarget.id,
          user_id: careerTarget.target_user_id,
          grade: "A",
        }),
      });
      assert(rejectedSave.status === 422, `career opposite-scope POST returned ${rejectedSave.status}`);
      equal(
        await rowFingerprint(
          "cluster4_career_line_evaluations",
          "line_target_id",
          careerTarget.id,
        ),
        evaluationBefore,
        "rejected career evaluation changed DB",
      );
      equal(
        await snapshotFingerprint(careerTarget.target_user_id),
        snapshotsBefore,
        "rejected career evaluation changed snapshots",
      );
      pass("career evaluation opposite-scope POST is 422 with DB/snapshot unchanged");
    } else {
      console.log("SKIP career POST guard: no career target for a test user");
    }
  }

  console.log(`\nP1 mode verification complete: ${checks.length} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
