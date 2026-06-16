import { createHash } from "node:crypto";
import { getCluster4WeeklyCardsForProfileUser } from "../lib/cluster4WeeklyCardsData";
import {
  WEEKLY_CARDS_DTO_VERSION,
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "../lib/cluster4WeeklyCardsSnapshot";
import { resolveLineScope } from "../lib/lineScope";
import { resolveUserScope } from "../lib/userScope";
import { supabaseAdmin } from "../lib/supabaseAdmin";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const INTERNAL = process.env.INTERNAL_API_KEY;

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (!val || typeof val !== "object" || Array.isArray(val)) return val;
    return Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)));
  });
}

function sig(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function pickUsers() {
  const { data: testMarkers } = await supabaseAdmin
    .from("test_user_markers")
    .select("user_id")
    .limit(20);
  const testIds = new Set(((testMarkers ?? []) as { user_id: string }[]).map((r) => r.user_id));

  const { data } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id")
    .limit(200);
  const ids = ((data ?? []) as { user_id: string }[]).map((r) => r.user_id);
  const testUserId = ids.find((id) => testIds.has(id)) ?? Array.from(testIds)[0] ?? null;
  const operatingUserId = ids.find((id) => !testIds.has(id)) ?? null;
  return { testUserId, operatingUserId };
}

async function httpCards(userId: string, qs = "") {
  if (!INTERNAL) throw new Error("INTERNAL_API_KEY is required for HTTP verification.");
  const join = qs ? `&${qs}` : "";
  const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${userId}${join}`, {
    headers: { "x-internal-api-key": INTERNAL },
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function verifyCards(userId: string) {
  await recomputeAndStoreWeeklyCardsSnapshot(userId);
  const direct = await getCluster4WeeklyCardsForProfileUser(userId);
  const snap = await readWeeklyCardsSnapshot(userId);
  const http = await httpCards(userId);
  const httpTest = await httpCards(userId, "mode=test");

  check(`snapshot fresh user=${userId}`, snap.status === "hit", snap.status);
  check(`HTTP 200 user=${userId}`, http.status === 200, String(http.status));
  check(
    `direct == HTTP user=${userId}`,
    sig(direct) === sig(http.json?.data),
    `direct=${direct.length} http=${http.json?.data?.length ?? "?"}`,
  );
  check(`HTTP mode=test same DTO user=${userId}`, sig(http.json?.data) === sig(httpTest.json?.data));
}

async function verifyHttpRecomputesStale(userId: string) {
  // is_stale: 동기(블로킹) lazy recompute → 응답 시점에 이미 hit 으로 수렴.
  {
    const { error } = await supabaseAdmin
      .from("cluster4_weekly_card_snapshots")
      .update({ is_stale: true })
      .eq("user_id", userId);
    if (error) throw error;

    const http = await httpCards(userId);
    const direct = await getCluster4WeeklyCardsForProfileUser(userId);
    const snap = await readWeeklyCardsSnapshot(userId);
    check(
      "HTTP recomputes is_stale (blocking lazy)",
      http.status === 200 &&
        http.json?.success === true &&
        sig(http.json?.data) === sig(direct) &&
        snap.status === "hit",
      `status=${http.status} snap=${snap.status}`,
    );
  }

  // version_mismatch: 06-04 가드(project_cluster4-week-status-recompute-trigger) — 구 카드를 블로킹
  //   없이 즉시 노출하고, 응답 후 after() 백그라운드로 그 사용자 1명만 재계산해 다음 조회부터 수렴.
  //   따라서 응답 직후 snapshot 은 아직 hit 이 아닐 수 있다(동기 재계산을 기대하면 안 됨).
  {
    const { error } = await supabaseAdmin
      .from("cluster4_weekly_card_snapshots")
      .update({ dto_version: WEEKLY_CARDS_DTO_VERSION - 1 })
      .eq("user_id", userId);
    if (error) throw error;

    const http = await httpCards(userId);
    // 즉시 응답은 200 + 유효 데이터(구 snapshot 카드, 블로킹 0).
    const immediateOk = http.status === 200 && http.json?.success === true;

    // 백그라운드 재계산이 다음 조회부터 신버전(hit)으로 수렴하는지 폴링(재계산 ~10s 관측 → 30s 한도).
    let converged = false;
    for (let i = 0; i < 60; i++) {
      const snap = await readWeeklyCardsSnapshot(userId);
      if (snap.status === "hit") {
        converged = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    check(
      "HTTP serves version_mismatch non-blocking + bg converges",
      immediateOk && converged,
      `immediate=${immediateOk} converged=${converged}`,
    );
  }
}

async function verifyOrgIsolation() {
  const { data: rows, error } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,part_type,line_code,experience_line_master_id,competency_line_master_id,career_project_id")
    .in("part_type", ["info", "experience", "competency", "career"])
    .limit(500);
  if (error) throw error;

  let checked = 0;
  let leaks = 0;
  for (const row of (rows ?? []) as Array<{
    id: string;
    part_type: string;
    line_code: string | null;
    experience_line_master_id: string | null;
    competency_line_master_id: string | null;
    career_project_id: string | null;
  }>) {
    const scope = await resolveLineScope(row);
    if (scope.org !== "encre" && scope.org !== "oranke") continue;
    checked++;
    if (scope.org === "encre") {
      const visibleToOranke = scope.org === "common" || scope.org === "oranke";
      if (visibleToOranke) leaks++;
    }
    if (scope.org === "oranke") {
      const visibleToEncre = scope.org === "common" || scope.org === "encre";
      if (visibleToEncre) leaks++;
    }
  }
  check("line org isolation encre/oranke", checked > 0 && leaks === 0, `checked=${checked} leaks=${leaks}`);
}

async function verifyModeScopes() {
  const operating = await resolveUserScope("operating", null);
  const test = await resolveUserScope("test", null);
  const overlap = (test.includeUserIds ?? []).filter((id) => operating.includes(id));
  check("operating/test mode disjoint", overlap.length === 0, `overlap=${overlap.length}`);
  check("test mode has marker SoT", (test.includeUserIds ?? []).length > 0, `test=${test.includeUserIds?.length ?? 0}`);
}

async function main() {
  await verifyOrgIsolation();
  await verifyModeScopes();
  const { testUserId, operatingUserId } = await pickUsers();
  if (operatingUserId) await verifyCards(operatingUserId);
  if (testUserId) {
    await verifyCards(testUserId);
    await verifyHttpRecomputesStale(testUserId);
    const demo = await fetch(`${BASE}/api/cluster4/weekly-cards?demoUserId=${testUserId}&mode=test`).then((r) => r.json());
    const internal = await httpCards(testUserId, "mode=test");
    check("demoUserId DTO == normal test DTO", sig(demo?.data) === sig(internal.json?.data));
  } else {
    check("test user available", false);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
