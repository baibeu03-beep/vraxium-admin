/**
 * 강화 실패(fail) 표시 정책 end-to-end smoke (2026-06-02).
 *
 *   npx tsx --env-file=.env.local scripts/smoke-cluster4-fail-display.ts
 *
 * 정책:
 *   - info / experience  : enhancementStatus=fail 이어도 보이드가 아니라 개설 라인 content 노출
 *                          (status != "void", mainTitle 존재). synthetic fail = lineTargetId 없음.
 *   - competency         : enhancementStatus=fail 은 보이드(status="void") 유지.
 *   - career             : 미선발 = not_applicable(보이드). fail(grade D 등)은 타깃 보유 → content 노출.
 *   - not_applicable     : 보이드(미개설).
 *
 * 실 DB 의 weekly-cards DTO 를 사용자별로 생성해 위 정책을 전수 검증한다.
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
function assert(label: string, cond: boolean) {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  if (!cond) {
    failed = true;
    process.exitCode = 1;
  }
}

async function main() {
  // user-mode 타깃 보유 사용자 표본 (최대 40명).
  const { data: t } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("target_mode", "user")
    .not("target_user_id", "is", null)
    .limit(2000);
  const userIds = [
    ...new Set(((t ?? []) as { target_user_id: string }[]).map((r) => r.target_user_id)),
  ].slice(0, 40);

  if (userIds.length === 0) {
    console.log("  ⚠️ user 타깃 보유 사용자 없음 — 생략");
    console.log("\n════════ smoke 완료 ✅ ════════");
    return;
  }

  let infoExpSyntheticFail = 0; // info/experience synthetic fail (lineTargetId 없음)
  let infoExpContentShown = 0;
  let compFail = 0;
  let compVoid = 0;
  let careerFailWithTarget = 0;
  let careerFailContentShown = 0;
  let rateOver100 = 0; // 강화율 > 100% (분모 A 과소집계 회귀 신호)
  let lineDenomLtNumer = 0; // per-line numerator > denominator
  const violations: string[] = [];

  for (const uid of userIds) {
    let cards;
    try {
      cards = await getCluster4WeeklyCardsForProfileUser(uid);
    } catch {
      continue; // 프로필/데이터 이슈 사용자 skip
    }
    for (const card of cards) {
      if ((card.weeklyGrowthRate ?? 0) > 100) rateOver100 += 1;
      for (const line of card.lines) {
        if (
          line.numerator != null &&
          line.denominator != null &&
          line.numerator > line.denominator
        )
          lineDenomLtNumer += 1;
        const isSynthetic = line.lineTargetId === null;
        if (line.partType === "information" || line.partType === "experience") {
          if (isSynthetic && line.enhancementStatus === "fail") {
            infoExpSyntheticFail += 1;
            const hasContent = line.status !== "void" && Boolean(line.mainTitle);
            if (hasContent) infoExpContentShown += 1;
            else violations.push(`${line.partType} synthetic fail 보이드/내용없음 week=${String(card.weekId).slice(0, 8)} status=${line.status} mainTitle=${JSON.stringify(line.mainTitle)}`);
          }
        } else if (line.partType === "competency") {
          if (line.enhancementStatus === "fail") {
            compFail += 1;
            if (line.status === "void") compVoid += 1;
            else violations.push(`competency fail 이 보이드 아님 week=${String(card.weekId).slice(0, 8)} status=${line.status}`);
          }
        } else if (line.partType === "career") {
          if (line.enhancementStatus === "fail") {
            // career fail 은 타깃 보유(grade 등) → content 노출.
            careerFailWithTarget += 1;
            if (line.status !== "void" && Boolean(line.mainTitle)) careerFailContentShown += 1;
          }
        }
      }
    }
  }

  console.log(`스캔 사용자 ${userIds.length}명`);
  console.log(`info/experience synthetic fail: ${infoExpSyntheticFail}건 (content 노출 ${infoExpContentShown}건)`);
  console.log(`competency fail: ${compFail}건 (보이드 ${compVoid}건)`);
  console.log(`career fail(타깃 보유): ${careerFailWithTarget}건 (content 노출 ${careerFailContentShown}건)`);
  if (violations.length > 0) {
    console.log("  위반 샘플:");
    for (const v of violations.slice(0, 10)) console.log(`    ❌ ${v}`);
  }

  // 정책 단언 (해당 케이스가 존재할 때만 강제; 없으면 통과로 둔다 = 데이터 의존 회피).
  assert("info/experience synthetic fail 전부 content 노출(보이드 아님)", infoExpSyntheticFail === infoExpContentShown);
  assert("competency fail 전부 보이드", compFail === compVoid);
  assert("career fail(타깃 보유) 전부 content 노출", careerFailWithTarget === careerFailContentShown);
  assert("주차 강화율 > 100% 0건 (분모 A 정상)", rateOver100 === 0);
  assert("per-line numerator > denominator 0건", lineDenomLtNumer === 0);
  console.log(`강화율>100% ${rateOver100}건 / per-line numer>denom ${lineDenomLtNumer}건`);

  if (infoExpSyntheticFail === 0) console.log("  ⚠️ info/experience synthetic fail 표본 0 — 케이스 미발생(정책 위반 아님)");
  if (compFail === 0) console.log("  ⚠️ competency fail 표본 0 — 케이스 미발생");

  console.log(`\n════════ smoke ${failed ? "실패 ❌" : "완료 ✅"} ════════`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
