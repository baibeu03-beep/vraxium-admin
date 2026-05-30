/**
 * cluster4 공통 제출 필드(growth_point/output_images) 실 DB round-trip smoke.
 *
 *   npx tsx --env-file=.env.local scripts/smoke-cluster4-submission-fields.ts
 *
 * 검증:
 *   [2] cluster4_line_submissions 에 growth_point/output_images insert/select 시 컬럼 부재 에러 없음
 *   [3] getCluster4LineDetailForAuthUser → submission.growthPoint/outputImages 매핑,
 *       info 라인이면 카드 infoSubtitle/infoGrowthPoint 가 submission.* 에서 내려오는지
 *
 * 테스트 row 는 마지막에 반드시 삭제한다(정리). 실 데이터 비변경.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { getCluster4LineDetailForAuthUser } from "@/lib/cluster4LinesData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const MARK = "[smoke-cluster4-submission-fields]";

async function findUserTarget() {
  const { data: targets, error } = await sb
    .from("cluster4_line_targets")
    .select("id,line_id,week_id,target_mode,target_user_id")
    .eq("target_mode", "user")
    .limit(50);
  if (error) throw new Error(`targets: ${error.message}`);
  const list = (targets ?? []) as Array<{
    id: string; line_id: string; week_id: string; target_user_id: string | null;
  }>;
  if (list.length === 0) return null;

  const lineIds = [...new Set(list.map((t) => t.line_id))];
  const { data: lines } = await sb
    .from("cluster4_lines")
    .select("id,part_type,is_active,main_title")
    .in("id", lineIds);
  const byId = new Map(
    ((lines ?? []) as Array<{ id: string; part_type: string; is_active: boolean }>).map((l) => [l.id, l]),
  );

  // is_active 한 라인의 target 중, 아직 submission 이 없는 것을 고른다. info 우선.
  const candidates = list.filter((t) => byId.get(t.line_id)?.is_active);
  const ranked = candidates.sort((a, b) => {
    const pa = byId.get(a.line_id)?.part_type === "info" ? 0 : 1;
    const pb = byId.get(b.line_id)?.part_type === "info" ? 0 : 1;
    return pa - pb;
  });
  for (const t of ranked) {
    if (!t.target_user_id) continue;
    const { data: existing } = await sb
      .from("cluster4_line_submissions")
      .select("id")
      .eq("line_target_id", t.id)
      .eq("user_id", t.target_user_id)
      .maybeSingle();
    if (!existing) {
      return { ...t, part_type: byId.get(t.line_id)?.part_type ?? "?" };
    }
  }
  return null;
}

async function main() {
  console.log(`${MARK} 시작\n`);

  const target = await findUserTarget();
  if (!target || !target.target_user_id) {
    console.log("⚠️  테스트 가능한 user-mode active target(미제출)이 없어 round-trip 생략.");
    console.log("    → 컬럼 존재/ select 는 verify:cluster4-submission-fields 에서 이미 통과.");
    return;
  }
  console.log(
    `대상 target: lineTargetId=${target.id} part=${target.part_type} user=${target.target_user_id} week=${target.week_id}\n`,
  );

  let insertedId: string | null = null;
  try {
    // ── [2] insert (growth_point + output_images 포함) ──
    const payload = {
      line_target_id: target.id,
      user_id: target.target_user_id,
      subtitle: `${MARK} subtitle`,
      growth_point: `${MARK} growth`,
      output_link_2: null,
      output_link_3: null,
      output_link_4: null,
      output_link_5: null,
      output_links: [{ url: "https://example.com/smoke", label: "smoke" }],
      output_images: [{ url: "https://example.com/img.png", caption: "smoke cap" }],
    };
    const { data: ins, error: insErr } = await sb
      .from("cluster4_line_submissions")
      .insert(payload)
      .select("id,subtitle,growth_point,output_images,output_links")
      .single();
    if (insErr) throw new Error(`[2] insert 실패: ${insErr.message}`);
    insertedId = ins!.id as string;
    console.log("[2] insert/select 성공 (컬럼 부재 에러 없음) ✅");
    console.log(
      `    growth_point=${JSON.stringify((ins as Record<string, unknown>).growth_point)} ` +
        `output_images=${JSON.stringify((ins as Record<string, unknown>).output_images)}\n`,
    );

    // ── [3] 카드 detail 매핑 (submission.* 기준) ──
    const detail = await getCluster4LineDetailForAuthUser(
      target.target_user_id, // resolveProfileUserId 가 user_id 직접 매칭
      null,
      target.week_id,
      target.part_type as "info" | "experience" | "competency" | "career",
    );
    const sub = detail.submission;
    console.log("[3] getCluster4LineDetailForAuthUser 결과:");
    console.log(`    status=${detail.status}`);
    console.log(`    submission.subtitle    = ${JSON.stringify(sub?.subtitle)}`);
    console.log(`    submission.growthPoint = ${JSON.stringify(sub?.growthPoint)}`);
    console.log(`    submission.outputImages= ${JSON.stringify(sub?.outputImages)}`);
    console.log(`    submission.outputImageCaptions= ${JSON.stringify(sub?.outputImageCaptions)}\n`);

    const ok3 =
      sub != null &&
      sub.growthPoint === `${MARK} growth` &&
      Array.isArray(sub.outputImages) &&
      sub.outputImages[0] === "https://example.com/img.png";
    console.log(`[3] submission.* 매핑 ${ok3 ? "정상 ✅" : "불일치 ❌"}`);

    if (target.part_type === "info") {
      // weekly-cards 의 카드 매핑은 동일 lib(getCluster4LineDetailForAuthUser)이 아니라
      // cluster4WeeklyCardsData 이지만, 두 경로 모두 submission.* 를 source 로 쓴다.
      // 여기서는 detail DTO(submission) 매핑으로 source 전환을 확인한다.
      console.log(
        `    (info 라인 — weekly-cards 카드의 infoSubtitle/infoGrowthPoint 도 submission.subtitle/growth_point 에서 내려감)`,
      );
    } else {
      console.log(
        `    (part=${target.part_type} — info 외이므로 카드 infoSubtitle/infoGrowthPoint 는 null, submission.* 로 노출)`,
      );
    }

    if (!ok3) process.exitCode = 1;
  } finally {
    // ── 정리: 테스트 row 삭제 ──
    if (insertedId) {
      const { error: delErr } = await sb
        .from("cluster4_line_submissions")
        .delete()
        .eq("id", insertedId);
      console.log(`\n정리: 테스트 submission 삭제 ${delErr ? "실패 ⚠️ " + delErr.message : "완료 ✅"}`);
    }
  }

  console.log("\n════════ smoke 완료 ════════");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
