/**
 * verify-info-crew-edit-direct.ts  (DB 쓰기 — 임시 fixture 생성 후 반드시 cleanup)
 *
 * "개설 대상 크루 수정"(editInfoLineCrew) direct 함수 검증.
 *   - 임시 info 라인(oranke OK 토큰) + oranke 테스트 유저(test_user_markers)만 사용 → 실유저 무영향.
 *   - add(0→N) / add 중복제외 / replace(부분) / replace(0명 sentinel 복원) 전이.
 *   - 허용 주차 범위(25겨울 W1 ~ 26봄 W11) 밖 = fail-closed(403).
 *   - org 가시성 게이트(타org 라인 = 403).
 *   - snapshot 무효화(is_stale=true) 영향 확인.
 *   - 종료 시 임시 라인 삭제 + 영향 테스트 유저 snapshot 재계산(클린 복원).
 *
 * 실행: npx tsx --env-file=.env.local scripts/verify-info-crew-edit-direct.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import {
  editInfoLineCrew,
  deleteCluster4Line,
  Cluster4LineError,
} from "@/lib/adminCluster4LinesData";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { isInfoCrewEditableWeek } from "@/lib/cluster4InfoCrewEditWindow";
import { loadCrewRecordsByUserIds } from "@/lib/cluster4CafeLineMatch";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const ORG = "oranke";
const W10 = "6cc59d70-3aa6-4823-8854-5b82691d1a84"; // 2026-spring W10 (in-range)
const W13 = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc"; // 2026-spring W13 (out-of-range)
const AT = "wisdom";
const A = "13b8e55e-ff49-43f3-a01f-cb68bfb74581"; // T한지윤
const B = "28a39131-a719-4264-b2a4-96dbda64cbb6"; // T권소율
const C = "1a0b0f9e-4e10-4d06-aa56-6d26ee4b203a"; // T송태현

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};
const sortJoin = (a: string[]) => [...a].sort().join(",");

async function userTargets(lineId: string, weekId: string) {
  const { data } = await sb
    .from("cluster4_line_targets")
    .select("target_mode,target_user_id,target_rule")
    .eq("line_id", lineId)
    .eq("week_id", weekId);
  const rows = (data ?? []) as Array<{
    target_mode: string;
    target_user_id: string | null;
    target_rule: Record<string, unknown> | null;
  }>;
  return {
    users: rows
      .filter((r) => r.target_mode === "user" && r.target_user_id)
      .map((r) => r.target_user_id as string),
    sentinels: rows.filter((r) => r.target_mode === "rule").length,
  };
}

async function isStale(userId: string): Promise<boolean | null> {
  const { data } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("is_stale")
    .eq("user_id", userId)
    .maybeSingle();
  return data ? Boolean((data as { is_stale: boolean }).is_stale) : null;
}
async function clearStale(userIds: string[]) {
  await sb
    .from("cluster4_weekly_card_snapshots")
    .update({ is_stale: false })
    .in("user_id", userIds);
}

let ACTOR = ""; // 실제 admin_users.id — created_by/updated_by(uuid FK)에 사용.

async function createTempLine(token: "OK" | "EC"): Promise<string> {
  const actor = ACTOR;
  const lineCode = `IF${token}-CREWVERIFY${Date.now()}`;
  const { data, error } = await sb
    .from("cluster4_lines")
    .insert({
      part_type: "info",
      activity_type_id: AT,
      line_code: lineCode,
      main_title: "[검증용 임시 라인] 개설 대상 크루 수정",
      output_links: [{ url: "https://example.com", label: "검증" }],
      output_link_1: "https://example.com",
      submission_opens_at: new Date("2026-05-04T00:00:00Z").toISOString(),
      submission_closes_at: new Date("2026-05-10T23:59:59Z").toISOString(),
      week_id: W10,
      is_active: true,
      created_by: actor,
      updated_by: actor,
    })
    .select("id")
    .single();
  if (error) throw new Error(`temp line insert failed: ${error.message}`);
  const lineId = (data as { id: string }).id;
  // 시작 상태 = 0명 개설(zeroTarget sentinel) — add 0→N 전이 검증용.
  await sb.from("cluster4_line_targets").insert({
    line_id: lineId,
    week_id: W10,
    target_mode: "rule",
    target_user_id: null,
    target_rule: { zeroTargetOpen: true },
    created_by: actor,
    updated_by: actor,
  });
  return lineId;
}

async function main() {
  console.log("\n=== editInfoLineCrew direct 검증 (oranke · 테스트 유저 · W10) ===\n");

  const { data: adminRow } = await sb
    .from("admin_users")
    .select("id")
    .limit(1)
    .maybeSingle();
  ACTOR = (adminRow as { id: string } | null)?.id ?? "";
  if (!ACTOR) throw new Error("admin_users 행을 찾을 수 없습니다");

  // 사전: 범위 함수 sanity.
  check("W10(2026-05-04) 허용 범위 안", isInfoCrewEditableWeek("2026-05-04", "2026-05-10"));
  check("W13(2026-05-25) 허용 범위 밖", !isInfoCrewEditableWeek("2026-05-25", "2026-05-31"));
  check("25겨울 W1(2024-12-30) 허용 범위 안", isInfoCrewEditableWeek("2024-12-30", "2025-01-05"));
  check("24가을(2024-12-29 이전) 허용 범위 밖", !isInfoCrewEditableWeek("2024-12-23", "2024-12-29"));

  let lineOK: string | null = null;
  let lineEC: string | null = null;
  const result: Record<string, unknown> = {};

  try {
    lineOK = await createTempLine("OK");
    console.log(`  temp oranke line = ${lineOK}\n`);

    // 스냅샷 baseline: A,B is_stale=false 로 맞춰 invalidation 관찰 준비.
    await clearStale([A, B, C]);

    // ── 시나리오 A: add 0→N [A,B] ──
    const rA = await editInfoLineCrew({
      lineId: lineOK,
      weekId: W10,
      mode: "add",
      targetUserIds: [A, B],
      actorAdminId: ACTOR,
      organization: ORG,
      scopeMode: "test",
    });
    result.scenarioA = rA;
    check("A) add 0→N: added=[A,B]", sortJoin(rA.added) === sortJoin([A, B]), `added=${rA.added.length}`);
    check("A) alreadyPresent=[]", rA.alreadyPresent.length === 0);
    check("A) finalUserCount=2", rA.finalUserCount === 2);
    const tA = await userTargets(lineOK, W10);
    check("A) DB user targets = {A,B}", sortJoin(tA.users) === sortJoin([A, B]));
    check("A) DB sentinel 제거됨(0)", tA.sentinels === 0, `sentinels=${tA.sentinels}`);
    // "현재 개설 대상 크루" DTO(loadCrewRecordsByUserIds) — 이름/팀·파트/학교·전공 enrich.
    const crewsA = await loadCrewRecordsByUserIds([A, B]);
    result.crewDtoA = crewsA;
    check("A) crew DTO count=2", crewsA.length === 2, `len=${crewsA.length}`);
    check(
      "A) crew DTO userIds = {A,B}",
      sortJoin(crewsA.map((c) => c.userId)) === sortJoin([A, B]),
    );
    check(
      "A) crew DTO 이름 enrich(모두 non-empty)",
      crewsA.every((c) => typeof c.name === "string" && c.name.length > 0),
      crewsA.map((c) => c.name).join(","),
    );
    check(
      "A) crew DTO shape(team/part/school/major/crewNo 키 존재)",
      crewsA.every(
        (c) =>
          "teamName" in c &&
          "partName" in c &&
          "schoolName" in c &&
          "majorName" in c &&
          "crewNo" in c,
      ),
    );
    // snapshot 영향: A,B 가 stale 로 마킹됐는지(또는 snapshot 무존재 시 null 허용).
    const staleA = await isStale(A);
    const staleB = await isStale(B);
    check(
      "A) snapshot 무효화(A,B is_stale=true or no-row)",
      (staleA === true || staleA === null) && (staleB === true || staleB === null),
      `A=${staleA} B=${staleB}`,
    );

    // ── 시나리오 B: add 중복 [A(dup), C] ──
    const rB = await editInfoLineCrew({
      lineId: lineOK,
      weekId: W10,
      mode: "add",
      targetUserIds: [A, C],
      actorAdminId: ACTOR,
      organization: ORG,
      scopeMode: "test",
    });
    result.scenarioB = rB;
    check("B) add 중복: added=[C]", sortJoin(rB.added) === sortJoin([C]));
    check("B) alreadyPresent=[A] (중복 추가 안함)", sortJoin(rB.alreadyPresent) === sortJoin([A]));
    check("B) finalUserCount=3", rB.finalUserCount === 3);
    const tB = await userTargets(lineOK, W10);
    check("B) DB user targets = {A,B,C}", sortJoin(tB.users) === sortJoin([A, B, C]));

    // ── 시나리오 C: replace [B] ──
    const rC = await editInfoLineCrew({
      lineId: lineOK,
      weekId: W10,
      mode: "replace",
      targetUserIds: [B],
      actorAdminId: ACTOR,
      organization: ORG,
      scopeMode: "test",
    });
    result.scenarioC = rC;
    check("C) replace: removed=[A,C]", sortJoin(rC.removed) === sortJoin([A, C]));
    check("C) added=[], alreadyPresent=[B]", rC.added.length === 0 && sortJoin(rC.alreadyPresent) === sortJoin([B]));
    check("C) finalUserCount=1", rC.finalUserCount === 1);
    const tC = await userTargets(lineOK, W10);
    check("C) DB user targets = {B}", sortJoin(tC.users) === sortJoin([B]));
    check("C) DB sentinel 없음", tC.sentinels === 0);

    // ── 시나리오 D: replace [] → 0명, sentinel 복원 ──
    const rD = await editInfoLineCrew({
      lineId: lineOK,
      weekId: W10,
      mode: "replace",
      targetUserIds: [],
      actorAdminId: ACTOR,
      organization: ORG,
      scopeMode: "test",
    });
    result.scenarioD = rD;
    check("D) replace 0명: removed=[B]", sortJoin(rD.removed) === sortJoin([B]));
    check("D) finalUserCount=0", rD.finalUserCount === 0);
    const tD = await userTargets(lineOK, W10);
    check("D) DB user targets 없음", tD.users.length === 0);
    check("D) DB sentinel 복원(1)", tD.sentinels === 1, `sentinels=${tD.sentinels}`);

    // ── 게이트 1: 허용 범위 밖 주차(W13) = 403 fail-closed ──
    let gate1 = false;
    let gate1msg = "";
    try {
      await editInfoLineCrew({
        lineId: lineOK,
        weekId: W13,
        mode: "add",
        targetUserIds: [A],
        actorAdminId: ACTOR,
        organization: ORG,
        scopeMode: "test",
      });
    } catch (e) {
      gate1 = e instanceof Cluster4LineError && e.status === 403;
      gate1msg = e instanceof Error ? e.message : String(e);
    }
    check("게이트1) W13(범위 밖) = 403 fail-closed", gate1, gate1msg.slice(0, 40));

    // ── 게이트 2: 타org 라인(encre) = 403 ──
    lineEC = await createTempLine("EC");
    let gate2 = false;
    let gate2msg = "";
    try {
      await editInfoLineCrew({
        lineId: lineEC,
        weekId: W10,
        mode: "add",
        targetUserIds: [A],
        actorAdminId: ACTOR,
        organization: ORG, // oranke 진입인데 라인은 encre → 403
        scopeMode: "test",
      });
    } catch (e) {
      gate2 = e instanceof Cluster4LineError && e.status === 403;
      gate2msg = e instanceof Error ? e.message : String(e);
    }
    check("게이트2) 타org(encre) 라인 = 403", gate2, gate2msg.slice(0, 40));
  } finally {
    // ── cleanup: 임시 라인 삭제 + 영향 테스트 유저 snapshot 재계산(클린 복원) ──
    console.log("\n  [cleanup]");
    for (const [name, id] of [["oranke", lineOK], ["encre", lineEC]] as const) {
      if (!id) continue;
      try {
        await deleteCluster4Line(id, "test");
        const { data } = await sb.from("cluster4_lines").select("id").eq("id", id).maybeSingle();
        check(`cleanup) ${name} 임시 라인 삭제됨`, !data, id);
      } catch (e) {
        check(`cleanup) ${name} 라인 삭제`, false, e instanceof Error ? e.message : String(e));
      }
    }
    // 영향 테스트 유저 snapshot 재계산 → is_stale=false 복원(클린 상태).
    try {
      await recomputeWeeklyCardsSnapshotsForUsers([A, B, C]);
      const sA = await isStale(A);
      const sB = await isStale(B);
      const sC = await isStale(C);
      check(
        "cleanup) A,B,C snapshot 재계산 복원(is_stale=false)",
        [sA, sB, sC].every((s) => s === false || s === null),
        `A=${sA} B=${sB} C=${sC}`,
      );
    } catch (e) {
      check("cleanup) snapshot 재계산", false, e instanceof Error ? e.message : String(e));
    }
  }

  console.log(`\n=== 결과: ${pass} pass / ${fail} fail ===`);
  // 결과 JSON 저장(HTTP 스크립트와 동일 시나리오 비교용 기대값).
  const fs = await import("node:fs");
  fs.writeFileSync(
    "claudedocs/verify-info-crew-edit-direct-result.json",
    JSON.stringify({ pass, fail, result }, null, 2),
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
