/**
 * 실유저 무영향 증명용 baseline 캡처/비교.
 *
 *   npx tsx --env-file=.env.local scripts/capture-resume-baseline.ts capture  # 기준 저장
 *   npx tsx --env-file=.env.local scripts/capture-resume-baseline.ts compare  # 현재값과 대조
 *
 * 대상: 실유저 표본(encre 1·phalanx 2) — getCluster1Resume DTO 전체 JSON 비교.
 * (라이브 계산 DTO 라 backfill 영향이 있으면 즉시 드러난다. snapshot 카드의
 *  growthDenominator/Numerator 합도 함께 기록해 카드 측 오염도 검출.)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
import { getCluster1Resume } from "@/lib/cluster1ResumeData";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const PATH = "claudedocs/tester-backfill-realuser-baseline-20260604.json";

async function pickRealUsers(): Promise<{ user_id: string; display_name: string }[]> {
  const { data: mk } = await sb.from("test_user_markers").select("user_id");
  const testSet = new Set((mk ?? []).map((m: any) => m.user_id));
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id, display_name, organization_slug");
  const real = ((profs ?? []) as any[]).filter(
    (p) => !testSet.has(p.user_id) && p.organization_slug,
  );
  // encre 1 (이유나 — 기존 라인 보유자) + phalanx 앞 2명
  const encre = real.filter((p) => p.organization_slug === "encre").slice(0, 1);
  const phalanx = real.filter((p) => p.organization_slug === "phalanx").slice(0, 2);
  return [...encre, ...phalanx];
}

async function snapshotOf(userId: string) {
  const resume = await getCluster1Resume(userId);
  const cards = await getCluster4WeeklyCardsForProfileUser(userId);
  const cardAgg = cards.map((c) => ({
    week: c.startDate,
    status: c.userWeekStatus,
    den: c.growthDenominator,
    num: c.growthNumerator,
    lineCount: (c as any).lines?.length ?? null,
  }));
  return { resume, cardAgg };
}

async function main() {
  const cmd = process.argv[2];
  const users = await pickRealUsers();
  console.log("실유저 표본:", users.map((u) => u.display_name).join(", "));

  const current: Record<string, unknown> = {};
  for (const u of users) {
    current[u.user_id] = { name: u.display_name, ...(await snapshotOf(u.user_id)) };
  }

  if (cmd === "capture") {
    writeFileSync(PATH, JSON.stringify(current, null, 2));
    console.log("baseline 저장:", PATH);
    return;
  }
  if (cmd === "compare") {
    const base = JSON.parse(readFileSync(PATH, "utf8"));
    let diffs = 0;
    for (const [uid, cur] of Object.entries(current)) {
      const b = base[uid];
      const a = JSON.stringify(b);
      const c = JSON.stringify(cur);
      if (a === c) {
        console.log(`✓ 동일: ${(cur as any).name}`);
      } else {
        diffs++;
        console.log(`✗ 차이 발견: ${(cur as any).name} (${uid})`);
        // 어느 필드인지 간단 진단
        const bj = b as any, cj = cur as any;
        if (JSON.stringify(bj.resume) !== JSON.stringify(cj.resume)) console.log("  resume DTO 변경");
        if (JSON.stringify(bj.cardAgg) !== JSON.stringify(cj.cardAgg)) {
          for (let i = 0; i < Math.max(bj.cardAgg.length, cj.cardAgg.length); i++) {
            if (JSON.stringify(bj.cardAgg[i]) !== JSON.stringify(cj.cardAgg[i])) {
              console.log("  card diff:", JSON.stringify(bj.cardAgg[i]), "→", JSON.stringify(cj.cardAgg[i]));
            }
          }
        }
      }
    }
    console.log(diffs === 0 ? "\n결과: 실유저 무영향 ✓" : `\n결과: ${diffs}명 변경 ✗ — 원복 검토 필요`);
    process.exitCode = diffs === 0 ? 0 : 2;
    return;
  }
  console.log("usage: capture | compare");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
