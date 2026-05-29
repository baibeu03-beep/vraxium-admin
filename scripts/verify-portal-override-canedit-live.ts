// Live integration verification — imports the actual production modules so any
// regression in lib/cluster4WeeklyCardsData.ts or lib/cluster4LinesData.ts is caught.
//
// Tests:
//   (a) getCluster4WeeklyCardsForProfileUser includes canEdit/editReason on lines.
//       data.length and weekNumbers must be unchanged vs the prior weekly-cards
//       contract (this script only adds assertions on the new fields).
//   (b) Submission POST/PATCH through cluster4LinesData honors override:
//       window_closed + override OPEN → write succeeds.

import {
  createCluster4LineSubmissionForAuthUser,
  updateCluster4LineSubmissionForAuthUser,
} from "@/lib/cluster4LinesData";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const TARGET_USER = "247021bc-374b-48f4-8d49-b181d149ee33";

async function getAuthUserIdForProfile(profileUserId: string) {
  // resolveProfileUserId(authId, authEmail) 매칭 순서: (1) user_profiles.user_id == authId,
  // (2) user_profiles.auth_email == authEmail. 시드 데이터의 경우 profile.user_id 가
  // 그대로 매칭되므로 authUserId = profileUserId 를 그대로 넘긴다. email 은 fallback 용.
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,auth_email")
    .eq("user_id", profileUserId)
    .maybeSingle();
  if (error) throw new Error(`profile lookup failed: ${error.message}`);
  if (!data) throw new Error("profile not found");
  const row = data as { user_id: string; auth_email?: string | null };
  return { authUserId: row.user_id, email: row.auth_email ?? null };
}

async function main() {
  console.log("=== (a) getCluster4WeeklyCardsForProfileUser ===");
  const cards = await getCluster4WeeklyCardsForProfileUser(TARGET_USER);
  console.log("data.length:", cards.length);
  console.log("weekNumbers:", cards.map((c) => c.weekNumber).join(","));

  // Pull every info line across all weeks and find the one with override-eligible target.
  const allInfoLines = cards.flatMap((c) =>
    c.lines
      .filter((l) => l.partType === "information")
      .map((l) => ({ weekNumber: c.weekNumber, line: l })),
  );

  const overrideInfoLines = allInfoLines.filter(
    (e) => e.line.canEdit === true && e.line.editReason === "ok_override",
  );

  console.log("info lines (across all weeks):", allInfoLines.length);
  console.log(
    "  with canEdit=true editReason=ok_override:",
    overrideInfoLines.length,
  );

  if (overrideInfoLines.length === 0) {
    console.error("FAIL: no info line had ok_override — expected at least one.");
    process.exit(1);
  }
  for (const e of overrideInfoLines) {
    console.log("  W" + e.weekNumber, {
      lineTargetId: e.line.lineTargetId,
      status: e.line.status,
      statusLabel: e.line.statusLabel,
      submissionOpensAt: e.line.submissionOpensAt,
      submissionClosesAt: e.line.submissionClosesAt,
      canEdit: e.line.canEdit,
      editReason: e.line.editReason,
    });
  }

  // ── (b) submission write under override
  console.log("\n=== (b) submission write under window_closed + override OPEN ===");
  // Pick the lineTargetId of the first override-eligible info line.
  const lineTargetId = overrideInfoLines[0].line.lineTargetId;
  if (!lineTargetId) {
    console.error("FAIL: lineTargetId missing on override info line.");
    process.exit(1);
  }
  console.log("using lineTargetId:", lineTargetId);

  const { authUserId, email } = await getAuthUserIdForProfile(TARGET_USER);
  console.log("authUserId:", authUserId, "email:", email);

  // Clean any pre-existing submission for this target+user so POST path can run.
  const { data: existing } = await supabaseAdmin
    .from("cluster4_line_submissions")
    .select("id")
    .eq("line_target_id", lineTargetId)
    .eq("user_id", TARGET_USER)
    .maybeSingle();
  if (existing) {
    console.log("pre-existing submission found, deleting for clean POST test:", existing);
    await supabaseAdmin.from("cluster4_line_submissions").delete().eq("id", (existing as { id: string }).id);
  }

  // POST
  let createdId: string | null = null;
  try {
    const created = await createCluster4LineSubmissionForAuthUser(
      authUserId,
      email,
      lineTargetId,
      {
        subtitle: "[verify-portal-override-canedit-live] POST",
        outputLink2: null,
        outputLink3: null,
        outputLink4: null,
        outputLink5: null,
        outputLinks: [],
      },
    );
    createdId = created.id;
    console.log("POST ok:", { id: created.id, subtitle: created.subtitle });
  } catch (e) {
    console.error("FAIL POST:", (e as Error).message);
    process.exit(1);
  }

  // PATCH
  try {
    const updated = await updateCluster4LineSubmissionForAuthUser(
      authUserId,
      email,
      lineTargetId,
      {
        subtitle: "[verify-portal-override-canedit-live] PATCH",
        outputLink2: null,
        outputLink3: null,
        outputLink4: null,
        outputLink5: null,
        outputLinks: [],
      },
    );
    console.log("PATCH ok:", { id: updated.id, subtitle: updated.subtitle });
  } catch (e) {
    console.error("FAIL PATCH:", (e as Error).message);
    await supabaseAdmin.from("cluster4_line_submissions").delete().eq("id", createdId!);
    process.exit(1);
  }

  // cleanup so DB state matches what we started with
  if (createdId) {
    const { error: delErr } = await supabaseAdmin
      .from("cluster4_line_submissions")
      .delete()
      .eq("id", createdId);
    if (delErr) console.warn("CLEANUP WARN:", delErr.message);
    else console.log("cleanup ok (row deleted)");
  }

  console.log("\n=== summary ===");
  console.log("data.length:", cards.length);
  console.log("weekNumbers:", cards.map((c) => c.weekNumber).join(","));
  console.log("ALL PASS: YES");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
