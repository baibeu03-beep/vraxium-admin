/**
 * 실무 경험(experience) 평점 DTO 노출 smoke (2026-05-30).
 *
 *   npx tsx --env-file=.env.local scripts/smoke-cluster4-experience-rating.ts
 *
 * source: cluster4_experience_line_evaluations.rating, 매핑 = (line_target_id + user_id).
 * 검증:
 *   1) 평점 있는 experience line → rating number
 *   2) 평점 없는 line          → null
 *   3) 다른 사용자 평점 미혼입 (user_id 스코프)
 *   4) info/ability/career 에는 영향 없음 (experience part 만 매핑)
 *   + weekly-cards lines[] 에 experienceRating 포함 여부 통합 확인
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

let failed = false;
function assert(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "✅" : "❌"} ${label}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!ok) {
    failed = true;
    process.exitCode = 1;
  }
}

// weekly-cards/detail 가 쓰는 평점 조회와 동일한 스코프(= line_target_id + user_id) 재현.
async function fetchRating(lineTargetId: string, userId: string): Promise<number | null> {
  const { data } = await sb
    .from("cluster4_experience_line_evaluations")
    .select("rating")
    .eq("line_target_id", lineTargetId)
    .eq("user_id", userId)
    .maybeSingle();
  return (data as { rating: number } | null)?.rating ?? null;
}

async function main() {
  console.log("════════ 평점 매핑 스코프 (line_target_id + user_id) ════════");

  // experience target 목록
  const { data: expLines } = await sb
    .from("cluster4_lines").select("id").eq("part_type", "experience").eq("is_active", true);
  const expLineIds = (expLines ?? []).map((l: { id: string }) => l.id);
  if (expLineIds.length === 0) {
    console.log("  ⚠️ active experience 라인 없음 — DB 케이스 생략");
  } else {
    const { data: targets } = await sb
      .from("cluster4_line_targets")
      .select("id,target_user_id")
      .eq("target_mode", "user")
      .in("line_id", expLineIds);
    const targetRows = (targets ?? []) as { id: string; target_user_id: string }[];

    // 평가(evaluations) 보유 target
    const { data: evals } = await sb
      .from("cluster4_experience_line_evaluations")
      .select("line_target_id,user_id,rating");
    const evalRows = (evals ?? []) as { line_target_id: string; user_id: string; rating: number }[];
    const ratedSet = new Set(evalRows.map((e) => `${e.line_target_id}::${e.user_id}`));

    // case1: 평점 있는 target
    const rated = evalRows[0];
    if (rated) {
      const got = await fetchRating(rated.line_target_id, rated.user_id);
      assert("case1 평점 있음 → number", typeof got === "number", true);
      assert("case1 값 일치", got, rated.rating);

      // case3: 다른 사용자로 조회 → 미혼입(null)
      const otherUser = targetRows.find((t) => t.target_user_id !== rated.user_id)?.target_user_id
        ?? "00000000-0000-0000-0000-000000000000";
      const crossKey = `${rated.line_target_id}::${otherUser}`;
      if (!ratedSet.has(crossKey)) {
        const crossGot = await fetchRating(rated.line_target_id, otherUser);
        assert("case3 다른 사용자 평점 미혼입 → null", crossGot, null);
      } else {
        console.log("  ⚠️ case3: 해당 target에 다른 사용자 평가가 실제 존재 — 격리 케이스 생략");
      }
    } else {
      console.log("  ⚠️ evaluations row 없음 — case1/3 DB 케이스 생략");
    }

    // case2: 평점 없는 target
    const unrated = targetRows.find((t) => !ratedSet.has(`${t.id}::${t.target_user_id}`));
    if (unrated) {
      const got = await fetchRating(unrated.id, unrated.target_user_id);
      assert("case2 평점 없음 → null", got, null);
    } else {
      console.log("  ⚠️ 평가 없는 experience target 없음 — case2 DB 케이스 생략");
    }
  }

  console.log("\n════════ case4 + 통합: weekly-cards lines[].experienceRating ════════");
  // experience target 보유 사용자로 weekly-cards 생성 후 라인별 평점 노출 확인
  let sampleUser: string | null = null;
  if (expLineIds.length > 0) {
    const { data: t } = await sb
      .from("cluster4_line_targets")
      .select("target_user_id")
      .eq("target_mode", "user")
      .in("line_id", expLineIds)
      .limit(1);
    sampleUser = ((t ?? [])[0] as { target_user_id: string } | undefined)?.target_user_id ?? null;
  }

  if (!sampleUser) {
    console.log("  ⚠️ experience 대상 사용자 없음 — 통합 케이스 생략");
  } else {
    const cards = await getCluster4WeeklyCardsForProfileUser(sampleUser);
    const allLines = cards.flatMap((c) => c.lines);
    console.log(`  사용자 ${sampleUser}, 카드 ${cards.length}개, 라인 ${allLines.length}개`);

    // 모든 라인에 experienceRating 키 존재
    const allHaveKey = allLines.every((l) => "experienceRating" in l);
    assert("모든 라인에 experienceRating 필드 존재", allHaveKey, true);

    // case4: experience 외 part 는 항상 null
    const nonExp = allLines.filter((l) => l.partType !== "experience");
    const nonExpAllNull = nonExp.every((l) => l.experienceRating === null);
    assert("case4 info/competency/career 평점 영향 없음(null)", nonExpAllNull, true);

    // experience part 는 number 또는 null
    const expLinesDto = allLines.filter((l) => l.partType === "experience");
    const expTypeOk = expLinesDto.every(
      (l) => l.experienceRating === null || typeof l.experienceRating === "number",
    );
    assert("experience 평점 타입 number|null", expTypeOk, true);
    const ratingsShown = expLinesDto
      .map((l) => l.experienceRating)
      .filter((r) => r !== null);
    console.log(`  experience 라인 ${expLinesDto.length}개, 평점 노출 ${ratingsShown.length}개: ${JSON.stringify(ratingsShown)}`);
  }

  console.log(`\n════════ smoke ${failed ? "실패 ❌" : "완료 ✅"} ════════`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
