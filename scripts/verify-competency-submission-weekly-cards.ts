/**
 * P1 검증: weekly-cards 에서 competency 사용자 제출값(cluster4_line_submissions)이
 * lines[].submission 으로 노출되는지 — 임시 fixture 로 end-to-end 확인 후 전량 롤백.
 *
 *   npx tsx --env-file=.env.local scripts/verify-competency-submission-weekly-cards.ts
 *
 * 검증:
 *   1) competency 제출값 있음 → lines[].submission.subtitle 노출
 *   2) growthPoint 노출
 *   3) outputLinks / outputImages 노출
 *   4) 제출값 없음 → submission === null (fallback)
 *   6) admin(cluster4_lines) outputLinks/outputImages 와 user(submission) 값이 분리됨
 *
 * 주의: 테스트 유저(test_user_markers) 1명에게만 임시 라인/타깃/제출을 만들고,
 *       finally 에서 생성한 id 를 모두 삭제한다 (실 사용자/실 데이터 불변).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { listTestUsers } from "@/lib/testUsers";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

let pass = true;
function assert(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "✅" : "❌"} ${label}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!ok) { pass = false; process.exitCode = 1; }
}

async function main() {
  // 1) 테스트 유저 + 그의 weekly-cards 에 실제로 존재하는 비휴식 weekId 1개 확보.
  const testUsers = await listTestUsers();
  let userId: string | null = null;
  let weekId: string | null = null;
  for (const tu of testUsers) {
    const cards = await getCluster4WeeklyCardsForProfileUser(tu.userId);
    const card = cards.find((c) => c.weekId && !c.isRestWeek);
    if (card && card.weekId) {
      userId = tu.userId;
      weekId = card.weekId;
      break;
    }
  }
  if (!userId || !weekId) {
    console.log("⚠️ 사용 가능한 테스트 유저/주차 없음 — 검증 생략");
    return;
  }
  console.log(`테스트 유저 ${userId}, weekId ${weekId}\n`);

  // admin(라인 개설) vs user(제출) 구분용 — 일부러 서로 다른 값.
  const ADMIN_LINK = "https://admin.example/competency-output";
  const ADMIN_IMAGE = "https://admin.example/competency-output.png";
  const USER_LINKS = [
    { url: "https://user.example/comp-1", label: "사용자 링크1" },
    { url: "https://user.example/comp-2", label: "사용자 링크2" },
  ];
  const USER_IMAGES = ["https://user.example/comp-img1.png", "https://user.example/comp-img2.png"];
  const SUBTITLE = "역량 서브타이틀(테스트)";
  const GROWTH = "역량 그로스포인트(테스트)";

  let lineId: string | null = null;
  let targetId: string | null = null;
  let submissionId: string | null = null;

  try {
    // 2) 임시 competency 라인 생성 (제출 윈도우는 넓게 열어둠 — submission 표시엔 무관).
    const lineRes = await sb
      .from("cluster4_lines")
      .insert({
        part_type: "competency",
        main_title: "[P1검증] 임시 역량 라인",
        output_link_1: ADMIN_LINK,
        output_links: [{ url: ADMIN_LINK, label: "admin" }],
        output_images: [ADMIN_IMAGE],
        submission_opens_at: "2020-01-01T00:00:00Z",
        submission_closes_at: "2030-01-01T00:00:00Z",
        is_active: true,
      })
      .select("id")
      .single();
    if (lineRes.error) throw new Error(`line insert: ${lineRes.error.message}`);
    lineId = (lineRes.data as { id: string }).id;

    // 3) 타깃 배정 (user 모드).
    const targetRes = await sb
      .from("cluster4_line_targets")
      .insert({
        line_id: lineId,
        week_id: weekId,
        target_mode: "user",
        target_user_id: userId,
        target_rule: {},
      })
      .select("id")
      .single();
    if (targetRes.error) throw new Error(`target insert: ${targetRes.error.message}`);
    targetId = (targetRes.data as { id: string }).id;

    // 4) 제출 전 상태: weekly-cards 의 해당 라인 submission === null (fallback).
    {
      const cards = await getCluster4WeeklyCardsForProfileUser(userId);
      const line = cards.flatMap((c) => c.lines).find((l) => l.lineTargetId === targetId);
      console.log("── 제출 전 ──");
      assert("competency 라인이 weekly-cards 에 노출됨", Boolean(line), true);
      assert("제출 없음 → submission === null (fallback)", line?.submission ?? null, null);
    }

    // 5) 제출 insert.
    const subRes = await sb
      .from("cluster4_line_submissions")
      .insert({
        line_target_id: targetId,
        user_id: userId,
        subtitle: SUBTITLE,
        growth_point: GROWTH,
        output_links: USER_LINKS,
        output_images: USER_IMAGES,
      })
      .select("id")
      .single();
    if (subRes.error) throw new Error(`submission insert: ${subRes.error.message}`);
    submissionId = (subRes.data as { id: string }).id;

    // 6) 제출 후 상태: lines[].submission 에 제출값 노출.
    {
      const cards = await getCluster4WeeklyCardsForProfileUser(userId);
      const line = cards.flatMap((c) => c.lines).find((l) => l.lineTargetId === targetId);
      console.log("\n── 제출 후 ──");
      assert("submission 객체 존재", Boolean(line?.submission), true);
      assert("(1) submission.subtitle", line?.submission?.subtitle ?? null, SUBTITLE);
      assert("(2) submission.growthPoint", line?.submission?.growthPoint ?? null, GROWTH);
      assert("(3a) submission.outputLinks 개수", line?.submission?.outputLinks?.length ?? 0, 2);
      assert(
        "(3a) submission.outputLinks[0].url",
        line?.submission?.outputLinks?.[0]?.url ?? null,
        USER_LINKS[0].url,
      );
      assert("(3b) submission.outputImages 개수", line?.submission?.outputImages?.length ?? 0, 2);
      assert(
        "(3b) submission.outputImages[0]",
        line?.submission?.outputImages?.[0] ?? null,
        USER_IMAGES[0],
      );
      // (6) admin top-level vs user submission 분리.
      console.log("\n── admin vs user 분리 ──");
      assert("top-level outputLinks = admin 값", line?.outputLinks?.[0]?.url ?? null, ADMIN_LINK);
      assert("top-level outputImages = admin 값", line?.outputImages?.[0] ?? null, ADMIN_IMAGE);
      assert(
        "admin link !== user submission link (혼동 없음)",
        (line?.outputLinks?.[0]?.url ?? null) !== (line?.submission?.outputLinks?.[0]?.url ?? null),
        true,
      );
      // info 전용 top-level 별칭은 competency 에서 null 유지 (기존 info 동작 불변).
      assert("competency infoSubtitle 은 여전히 null (info 별칭 미오염)", line?.infoSubtitle ?? null, null);
      assert("competency infoGrowthPoint 은 여전히 null", line?.infoGrowthPoint ?? null, null);
    }

    console.log(`\n${pass ? "✅ 전체 통과" : "❌ 실패 항목 있음"}`);
  } finally {
    // 7) 생성물 전량 롤백 (제출 → 타깃 → 라인). cascade 가 있어도 명시 삭제.
    if (submissionId) await sb.from("cluster4_line_submissions").delete().eq("id", submissionId);
    if (targetId) await sb.from("cluster4_line_targets").delete().eq("id", targetId);
    if (lineId) await sb.from("cluster4_lines").delete().eq("id", lineId);
    console.log("\n🧹 임시 fixture 정리 완료 (submission/target/line 삭제).");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
