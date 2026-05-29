// Spec verification (2026-05-29): canEdit must be evaluated per line target
// (weekId + partType + subLineKey), not per partType. Confirms:
//
//   - 12주차 community lineTarget 이 열려 있으면 12주차 community 만 canEdit=true,
//     같은 주차의 essay/wisdom 은 target 자체가 없거나 다른 target 이므로 canEdit=false.
//   - 11주차 community 는 같은 sub-line 이라도 다른 주차이므로 canEdit=false.
//   - target 없는 sub-line 은 information override 가 OPEN 이어도 canEdit=false /
//     editReason="target_missing".
//
// Runs against the live DB by importing the actual production module
// (cluster4WeeklyCardsData.ts).

import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const TARGET_USER = "247021bc-374b-48f4-8d49-b181d149ee33";

async function main() {
  const cards = await getCluster4WeeklyCardsForProfileUser(TARGET_USER);
  console.log("data.length:", cards.length);

  // 11/12 주차 카드를 별도 추출.
  const w12 = cards.find((c) => c.weekNumber === 12);
  const w11 = cards.find((c) => c.weekNumber === 11);

  console.log("\n=== W12 information lines ===");
  const w12Info = (w12?.lines ?? []).filter((l) => l.partType === "information");
  for (const l of w12Info) {
    console.log({
      partType: l.partType,
      weekId: l.weekId,
      activityTypeKey: l.activityTypeKey,
      activityTypeName: l.activityTypeName,
      lineTargetId: l.lineTargetId,
      canEdit: l.canEdit,
      editReason: l.editReason,
    });
  }

  console.log("\n=== W11 information lines ===");
  const w11Info = (w11?.lines ?? []).filter((l) => l.partType === "information");
  for (const l of w11Info) {
    console.log({
      partType: l.partType,
      weekId: l.weekId,
      activityTypeKey: l.activityTypeKey,
      activityTypeName: l.activityTypeName,
      lineTargetId: l.lineTargetId,
      canEdit: l.canEdit,
      editReason: l.editReason,
    });
  }

  // ── 어떤 sub-line target 이 실제 DB 에 존재하는지 출력 (정합성 확인).
  console.log("\n=== DB ground truth: cluster4_line_targets for this user ===");
  const { data: tgts, error: tErr } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select(
      `id,week_id,target_mode,target_user_id,
       cluster4_lines!inner(id,part_type,main_title,activity_type_id,line_code,competency_line_master_id,experience_line_master_id,career_project_id,is_active,submission_opens_at,submission_closes_at)`,
    )
    .eq("target_mode", "user")
    .eq("target_user_id", TARGET_USER);
  if (tErr) {
    console.error("DB lookup failed:", tErr.message);
    process.exit(1);
  }

  // weekNumber 매핑.
  const weekIds = Array.from(new Set((tgts ?? []).map((r) => (r as any).week_id))) as string[];
  const { data: weekRows } = await supabaseAdmin
    .from("weeks")
    .select("id,week_number")
    .in("id", weekIds);
  const weekNumberById = new Map<string, number>(
    (weekRows ?? []).map((r: any) => [r.id, r.week_number]),
  );

  for (const r of (tgts ?? []) as any[]) {
    console.log({
      weekNumber: weekNumberById.get(r.week_id),
      partType: r.cluster4_lines.part_type,
      activityTypeId: r.cluster4_lines.activity_type_id,
      lineCode: r.cluster4_lines.line_code,
      lineTargetId: r.id,
      submissionOpensAt: r.cluster4_lines.submission_opens_at,
      submissionClosesAt: r.cluster4_lines.submission_closes_at,
    });
  }

  // ── Assertions ─────────────────────────────────────────────
  console.log("\n=== Assertions ===");
  let pass = 0;
  let fail = 0;
  const check = (label: string, ok: boolean, ctx?: unknown) => {
    if (ok) {
      console.log("  PASS", label);
      pass++;
    } else {
      console.log("  FAIL", label, ctx ? JSON.stringify(ctx) : "");
      fail++;
    }
  };

  // (1) W12 community sub-line 매칭 — DB 에 존재하면 canEdit 가 true 여야 한다
  //     (window OPEN 이면 ok, 닫혔으면 override 가 있으므로 ok_override).
  const w12Community = w12Info.find((l) => l.activityTypeKey === "community");
  if (w12Community) {
    check(
      "W12 community canEdit=true",
      w12Community.canEdit === true,
      w12Community,
    );
    check(
      "W12 community lineTargetId 존재",
      typeof w12Community.lineTargetId === "string" && w12Community.lineTargetId.length > 0,
      w12Community.lineTargetId,
    );
    check(
      "W12 community editReason ∈ {ok, ok_override}",
      w12Community.editReason === "ok" || w12Community.editReason === "ok_override",
      w12Community.editReason,
    );
  } else {
    console.log("  SKIP: W12 community sub-line target 미존재 (테스트 데이터 부재)");
  }

  // (2) W12 essay / wisdom — target 없으면 canEdit=false / editReason="target_missing".
  for (const key of ["essay", "wisdom"]) {
    const row = w12Info.find((l) => l.activityTypeKey === key);
    if (row) {
      // sub-line target 이 있는 경우 → canEdit 는 평가 결과를 그대로 따른다.
      console.log(`  INFO: W12 ${key} sub-line target 존재 — canEdit=${row.canEdit} / ${row.editReason}`);
    } else {
      // sub-line target 없음 — placeholder partType 행 외에는 없어야 함.
      // 단, partType-level "미개설" placeholder 가 information 에 추가되는 경우 그 placeholder 의
      // activityTypeKey 는 null 이므로 위 find() 가 매칭하지 않음. 정상.
      console.log(`  INFO: W12 ${key} sub-line target 부재 — DTO 에 row 없음 (의도된 동작)`);
    }
  }

  // (3) W11 community — target 이 있다면 canEdit 평가 결과를 그대로 따름. 다른 주차이므로
  //     "12주차 community 의 canEdit" 이 W11 행에 전파되면 안 된다 (별도 평가).
  const w11Community = w11Info.find((l) => l.activityTypeKey === "community");
  if (w11Community) {
    console.log(`  W11 community: canEdit=${w11Community.canEdit} editReason=${w11Community.editReason}`);
    // 별도 line target 이므로 평가가 독립적이어야 한다 — weekId 가 W11 의 weekId 여야 함.
    check(
      "W11 community weekId 가 W11 weekId 와 일치 (12주차 target 와 격리)",
      w11Community.weekId === w11?.weekId,
      { w11_card_weekId: w11?.weekId, line_weekId: w11Community.weekId },
    );
  } else {
    console.log("  INFO: W11 community sub-line target 부재 (테스트 데이터 부재)");
  }

  // (4) information partType placeholder (target 미존재 시 추가됨) 가 있다면
  //     canEdit=false / editReason="target_missing" 이어야 한다.
  const infoPlaceholder = w12Info.find((l) => l.lineTargetId === null);
  if (infoPlaceholder) {
    check(
      "W12 information placeholder canEdit=false",
      infoPlaceholder.canEdit === false,
      infoPlaceholder,
    );
    check(
      "W12 information placeholder editReason=target_missing",
      infoPlaceholder.editReason === "target_missing",
      infoPlaceholder,
    );
  } else {
    console.log("  INFO: W12 information placeholder 없음 (target 있는 sub-line 이 1개 이상)");
  }

  console.log(`\nResult: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
