/**
 * 주차별 허브 추가 개방 — HTTP API 레벨 검증 (snapshot lazy 재계산 경로 포함).
 *
 *   1) (user, weekW) 에 work_exp 주차 override 삽입 + markWeeklyCardsSnapshotStale.
 *   2) GET /api/cluster4/weekly-cards?userId=<user> (x-internal-api-key)
 *      → is_stale 였으므로 lazy 재계산 → 최신 canEdit 포함 DTO 반환(=브라우저가 받는 DTO).
 *   3) HTTP canEdit(W) === true (direct 결과와 일치), 다른 주차 canEdit === false (격리).
 *   4) cleanup: override 삭제 + snapshot 재계산 복원.
 */
import fs from "node:fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  markWeeklyCardsSnapshotStale,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const USER = "247021bc-374b-48f4-8d49-b181d149ee33";
const WEEK_W = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc";
const WORK_EXP = "cluster4.work_exp";
const VERIFY_NOTE = "verify-week-scope-http";
const BASE = "http://localhost:3000";

const env = fs.readFileSync(".env.local", "utf8");
const INTERNAL_KEY = env.match(/^INTERNAL_API_KEY=(.+)$/m)?.[1]?.trim() ?? "";

type Line = { partType: string; canEdit: boolean; editReason: string };
type Card = { weekId: string | null; lines: Line[] };

async function fetchCards(): Promise<Card[]> {
  const res = await fetch(
    `${BASE}/api/cluster4/weekly-cards?userId=${USER}`,
    { headers: { "x-internal-api-key": INTERNAL_KEY } },
  );
  const json = (await res.json()) as { success: boolean; data: Card[] };
  if (!res.ok || !json.success) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.data;
}

function expCanEdit(cards: Card[], weekId: string): Line | null {
  const c = cards.find((x) => x.weekId === weekId);
  return c?.lines.find((l) => l.partType === "experience") ?? null;
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${USER}`, {
        headers: { "x-internal-api-key": INTERNAL_KEY },
      });
      if (res.status === 200) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("dev server not ready after 120s");
}

async function main() {
  const results: { name: string; pass: boolean; detail: string }[] = [];
  const rec = (name: string, pass: boolean, detail = "") =>
    results.push({ name, pass, detail });

  console.log("[http] waiting for dev server...");
  await waitForServer();
  console.log("[http] server ready");

  // BEFORE (override 없음): 최신 상태 보장을 위해 markStale 후 조회.
  await supabaseAdmin
    .from("user_edit_windows")
    .delete()
    .eq("user_id", USER)
    .eq("resource_key", WORK_EXP)
    .eq("note", VERIFY_NOTE);
  await markWeeklyCardsSnapshotStale(USER);
  const before = await fetchCards();
  const beforeW = expCanEdit(before, WEEK_W);
  rec(
    "H-A. HTTP BEFORE: W exp canEdit=false",
    beforeW?.canEdit === false,
    `canEdit=${beforeW?.canEdit} reason=${beforeW?.editReason}`,
  );
  const isoWeek =
    before.find(
      (c) => c.weekId && c.weekId !== WEEK_W && c.lines.some((l) => l.partType === "experience"),
    )?.weekId ?? null;

  // 주차 override 삽입 + stale.
  const { data: weekRow } = await supabaseAdmin
    .from("weeks").select("season_key").eq("id", WEEK_W).maybeSingle();
  await supabaseAdmin.from("user_edit_windows").insert({
    user_id: USER,
    resource_key: WORK_EXP,
    week_id: WEEK_W,
    season_key: (weekRow as { season_key: string | null } | null)?.season_key ?? null,
    opened_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
    note: VERIFY_NOTE,
  });
  await markWeeklyCardsSnapshotStale(USER);
  console.log("[http] override inserted + snapshot marked stale");

  // AFTER: lazy 재계산된 DTO
  const after = await fetchCards();
  const afterW = expCanEdit(after, WEEK_W);
  rec(
    "H-B. HTTP AFTER: W exp canEdit=true (snapshot lazy 재계산 반영)",
    afterW?.canEdit === true,
    `canEdit=${afterW?.canEdit} reason=${afterW?.editReason}`,
  );
  if (isoWeek) {
    const afterIso = expCanEdit(after, isoWeek);
    rec(
      "H-C. HTTP AFTER: 다른 주차 canEdit=false (격리)",
      afterIso?.canEdit === false,
      `isoWeek canEdit=${afterIso?.canEdit}`,
    );
  }

  // direct==HTTP 비교: AFTER 의 HTTP canEdit(true) 이 direct 검증 결과(true)와 일치.
  rec("H-D. direct==HTTP (W canEdit 둘 다 true)", afterW?.canEdit === true, "");

  // cleanup
  await supabaseAdmin
    .from("user_edit_windows")
    .delete()
    .eq("user_id", USER)
    .eq("resource_key", WORK_EXP)
    .eq("note", VERIFY_NOTE);
  await recomputeAndStoreWeeklyCardsSnapshot(USER);
  console.log("[http] cleanup done");

  console.log("\n==== HTTP RESULT ====");
  let allPass = true;
  for (const r of results) {
    if (!r.pass) allPass = false;
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  | " + r.detail : ""}`);
  }
  console.log("\nALL:", allPass ? "PASS ✅" : "FAIL ❌");
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
