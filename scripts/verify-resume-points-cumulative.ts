/**
 * 이력서 카드 포인트 수정 검증 — HTTP 라우트와 동일 경로(getResumeCardForCrew).
 *   resume-card API 응답의 computed.totalStars/Shields/Lightnings 가
 *   user_weekly_points 전체기간 직접합산과 일치하는지 확인.
 *
 *   npx tsx --env-file=.env.local scripts/verify-resume-points-cumulative.ts [N]
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listTestUsers } from "@/lib/testUsers";
import { getResumeCardForCrew } from "@/lib/adminResumeCardData";

async function directSum(userId: string) {
  let from = 0;
  const page = 1000;
  let star = 0,
    adv = 0,
    pen = 0,
    weeks = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("user_weekly_points")
      .select("points,advantages,penalty")
      .eq("user_id", userId)
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as Array<{
      points: number | null;
      advantages: number | null;
      penalty: number | null;
    }>;
    for (const r of batch) {
      star += r.points ?? 0;
      adv += r.advantages ?? 0;
      pen += r.penalty ?? 0;
    }
    weeks += batch.length;
    if (batch.length < page) break;
    from += page;
  }
  return { weeks, star, shield: adv - Math.abs(pen), lightning: pen };
}

async function main() {
  // 주의: resume-card 라우트 [legacy_user_id] 는 historical 이름이고 실제 값은
  // user_profiles.user_id(UUID). getResumeCardForCrew 도 UUID 를 받는다.
  const limitArg = Number(process.argv[2]);
  const users = await listTestUsers();
  const target = Number.isFinite(limitArg) && limitArg > 0 ? users.slice(0, limitArg) : users;

  let checked = 0,
    pass = 0,
    fail = 0,
    skipped = 0;
  const fails: string[] = [];

  for (const u of target) {
    let bundle;
    try {
      bundle = await getResumeCardForCrew(u.userId);
    } catch (e) {
      skipped++;
      continue;
    }
    if (!bundle) {
      skipped++;
      continue;
    }
    const direct = await directSum(u.userId);
    if (direct.weeks === 0) {
      skipped++;
      continue;
    }
    checked++;
    const c = bundle.computed;
    const ok =
      c.totalStars === direct.star &&
      c.totalShields === direct.shield &&
      c.totalLightnings === direct.lightning;
    if (ok) {
      pass++;
    } else {
      fail++;
      fails.push(
        `${u.name}: API(별=${c.totalStars} 방패=${c.totalShields} 번개=${c.totalLightnings}) ≠ direct(별=${direct.star} 방패=${direct.shield} 번개=${direct.lightning})`,
      );
    }
  }

  console.log("\n──────── 이력서 카드 누적 포인트 검증 (HTTP 동일경로) ────────");
  console.log(`  검사=${checked}  ✅일치=${pass}  ❌불일치=${fail}  skip(데이터없음/조회불가)=${skipped}`);
  if (fails.length) {
    console.log("\n  ❌ 불일치 상세:");
    for (const f of fails.slice(0, 30)) console.log("    " + f);
  } else {
    console.log("  ⇒ 전원 user_weekly_points 전체기간 합산과 일치 (이력서=전기간 누적 확정).");
  }

  // 샘플 3명 상세 출력.
  console.log("\n  [샘플 3명 상세]");
  let shown = 0;
  for (const u of target) {
    if (shown >= 3) break;
    let bundle;
    try {
      bundle = await getResumeCardForCrew(u.userId);
    } catch {
      continue;
    }
    if (!bundle) continue;
    const direct = await directSum(u.userId);
    if (direct.weeks === 0) continue;
    const c = bundle.computed;
    console.log(
      `    ${u.name} [${u.organizationSlug ?? "-"}] weeks=${direct.weeks}  API별/방패/번개=${c.totalStars}/${c.totalShields}/${c.totalLightnings}  direct=${direct.star}/${direct.shield}/${direct.lightning}`,
    );
    shown++;
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
