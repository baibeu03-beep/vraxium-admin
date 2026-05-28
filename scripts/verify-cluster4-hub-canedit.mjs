// Verify that the unified cluster4 hub canEdit helper produces the expected
// result for a real user against live DB state.
//
// Reproduces, in plain JS, the logic of:
//   - canEditCluster4Line(target, profileUserId, now)
//   - evaluateCluster4HubEdit({ target, editWindow, profileUserId, now })
// then prints per-hub finalCanEdit for the target user.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(
  get("NEXT_PUBLIC_SUPABASE_URL"),
  get("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } },
);

const TARGET = "247021bc-374b-48f4-8d49-b181d149ee33";
const NOW = Date.now();

const PART_TYPE_TO_KEY = {
  info: "cluster4.work_info",
  competency: "cluster4.work_ability",
  experience: "cluster4.work_exp",
  career: "cluster4.work_career",
};

function canEditCluster4Line(target, profileUserId, now = Date.now()) {
  if (!target) return { canEdit: false, reason: "target_missing" };
  if (target.target_mode !== "user")
    return { canEdit: false, reason: "unsupported_target_mode" };
  if (!target.line || target.line.is_active === false)
    return { canEdit: false, reason: "line_inactive" };
  if (!profileUserId || target.target_user_id !== profileUserId)
    return { canEdit: false, reason: "not_owner" };
  const opens = new Date(target.line.submission_opens_at).getTime();
  const closes = new Date(target.line.submission_closes_at).getTime();
  if (Number.isFinite(opens) && now < opens)
    return { canEdit: false, reason: "window_not_open" };
  if (Number.isFinite(closes) && now > closes)
    return { canEdit: false, reason: "window_closed" };
  return { canEdit: true, reason: "ok" };
}

function isEditWindowActive(w, now = Date.now()) {
  if (!w) return false;
  const o = new Date(w.openedAt).getTime();
  const e = new Date(w.expiresAt).getTime();
  if (!Number.isFinite(o) || !Number.isFinite(e)) return false;
  return now >= o && now <= e;
}

function evaluateCluster4HubEdit({ target, editWindow, profileUserId, now = Date.now() }) {
  const line = canEditCluster4Line(target, profileUserId, now);
  const override = isEditWindowActive(editWindow, now);
  if (line.canEdit) {
    return { canEdit: true, reason: "ok", lineWindowCanEdit: true, editWindowOpen: override };
  }
  if (override) {
    return { canEdit: true, reason: "ok_override", lineWindowCanEdit: false, editWindowOpen: true };
  }
  return { canEdit: false, reason: line.reason, lineWindowCanEdit: false, editWindowOpen: false };
}

async function main() {
  // 1) cluster4_line_targets joined with cluster4_lines for the user.
  const { data: targetRows, error: targetErr } = await sb
    .from("cluster4_line_targets")
    .select(
      `id,line_id,week_id,target_mode,target_user_id,
       cluster4_lines!inner(id,part_type,main_title,submission_opens_at,submission_closes_at,is_active)`,
    )
    .eq("target_mode", "user")
    .eq("target_user_id", TARGET);
  if (targetErr) throw new Error(`targets: ${targetErr.message}`);

  // 2) user_edit_windows for the 4 hub keys.
  const { data: windowRows, error: winErr } = await sb
    .from("user_edit_windows")
    .select("resource_key,opened_at,expires_at")
    .eq("user_id", TARGET)
    .in("resource_key", Object.values(PART_TYPE_TO_KEY));
  if (winErr) throw new Error(`windows: ${winErr.message}`);

  const windowByKey = {};
  for (const r of windowRows ?? []) {
    windowByKey[r.resource_key] = { openedAt: r.opened_at, expiresAt: r.expires_at };
  }

  console.log("\n=== input snapshot ===");
  console.log("target_user_id =", TARGET);
  console.log("nowISO         =", new Date(NOW).toISOString());
  console.log("targetRows     =", targetRows?.length ?? 0);
  for (const r of targetRows ?? []) {
    console.log("  -", {
      lineTargetId: r.id,
      partType: r.cluster4_lines.part_type,
      weekId: r.week_id,
      opens: r.cluster4_lines.submission_opens_at,
      closes: r.cluster4_lines.submission_closes_at,
      isActive: r.cluster4_lines.is_active,
    });
  }
  console.log("editWindows    =", windowByKey);

  // 3) Per-hub decision.
  console.log("\n=== per-hub finalCanEdit ===");
  const partTypes = ["info", "competency", "experience", "career"];
  const expected = {
    info: true,        // override OPEN
    competency: false, // no target, no override
    experience: true,  // override OPEN
    career: false,     // no target, no override
  };
  let allOk = true;
  for (const partType of partTypes) {
    const candidates = (targetRows ?? [])
      .filter((r) => r.cluster4_lines.part_type === partType)
      .map((r) => ({
        target_mode: r.target_mode,
        target_user_id: r.target_user_id,
        line: {
          is_active: r.cluster4_lines.is_active,
          submission_opens_at: r.cluster4_lines.submission_opens_at,
          submission_closes_at: r.cluster4_lines.submission_closes_at,
        },
      }));
    const inWindow = candidates.find((t) => {
      const o = new Date(t.line.submission_opens_at).getTime();
      const c = new Date(t.line.submission_closes_at).getTime();
      return t.line.is_active && (!Number.isFinite(o) || NOW >= o) && (!Number.isFinite(c) || NOW <= c);
    });
    const picked = inWindow ?? candidates[0] ?? null;
    const resourceKey = PART_TYPE_TO_KEY[partType];
    const editWindow = windowByKey[resourceKey] ?? null;
    const decision = evaluateCluster4HubEdit({
      target: picked,
      editWindow,
      profileUserId: TARGET,
      now: NOW,
    });

    const match = decision.canEdit === expected[partType];
    if (!match) allOk = false;
    console.log({
      partType,
      resourceKey,
      hasTarget: Boolean(picked),
      lineWindowCanEdit: decision.lineWindowCanEdit,
      editWindowOpen: decision.editWindowOpen,
      finalCanEdit: decision.canEdit,
      reason: decision.reason,
      expectedCanEdit: expected[partType],
      MATCH: match ? "✓" : "✗ MISMATCH",
    });
  }
  console.log("\nALL EXPECTATIONS MET:", allOk ? "YES" : "NO");
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
