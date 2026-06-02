/**
 * weeklyReputations[].id / weeklyColleagues[].id 가 운영 DTO 에 실제 포함되고
 * DB PK(weekly_reputations.id / weekly_colleagues.id)와 일치하는지 교차검증.
 *   npx tsx --env-file=.env.local scripts/diag-cluster4-people-id-stability.ts [profileUserId]
 *
 * 1) DTO 계산 → weeklyReputations/weeklyColleagues 의 id 추출
 * 2) 그 id 로 DB 행을 역조회해 (존재 + PK 일치 + scope 컬럼 = 대상 사용자) 확인
 *    - weekly_reputations: PK=id, scope=target_user_id (admin update/delete 기준)
 *    - weekly_colleagues : PK=id, scope=user_id
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

let failed = false;
function assert(label: string, cond: boolean) {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  if (!cond) {
    failed = true;
    process.exitCode = 1;
  }
}

// 받은 평판이 있는 사용자 + 작성 동료가 있는 사용자를 각각 하나씩 찾는다.
async function pickUsers(): Promise<{ repUser: string | null; colUser: string | null }> {
  const { data: rep } = await supabaseAdmin
    .from("weekly_reputations")
    .select("target_user_id")
    .limit(1);
  const { data: col } = await supabaseAdmin
    .from("weekly_colleagues")
    .select("user_id")
    .limit(1);
  return {
    repUser: (rep?.[0] as any)?.target_user_id ?? null,
    colUser: (col?.[0] as any)?.user_id ?? null,
  };
}

async function verifyUser(profileUserId: string) {
  console.log(`\n[target] profileUserId = ${profileUserId}`);
  const cards = await getCluster4WeeklyCardsForProfileUser(profileUserId);
  const reps = cards.flatMap((c) => c.weeklyReputations);
  const cols = cards.flatMap((c) => c.weeklyColleagues);
  console.log(`  weeklyReputations total = ${reps.length}, weeklyColleagues total = ${cols.length}`);

  // ── 평판 id 교차검증 ──
  for (const r of reps) {
    assert(`weeklyReputations[].id 존재 (${r.id})`, typeof r.id === "string" && r.id.length > 0);
    const { data, error } = await supabaseAdmin
      .from("weekly_reputations")
      .select("id,target_user_id")
      .eq("id", r.id)
      .maybeSingle();
    assert(`  └ DB weekly_reputations.id 일치 + scope(target_user_id) 일치`,
      !error && !!data && (data as any).id === r.id && (data as any).target_user_id === r.toUserId);
  }

  // ── 동료 id 교차검증 ──
  for (const c of cols) {
    assert(`weeklyColleagues[].id 존재 (${c.id})`, typeof c.id === "string" && c.id.length > 0);
    const { data, error } = await supabaseAdmin
      .from("weekly_colleagues")
      .select("id,user_id")
      .eq("id", c.id)
      .maybeSingle();
    assert(`  └ DB weekly_colleagues.id 일치 + scope(user_id) 일치`,
      !error && !!data && (data as any).id === c.id && (data as any).user_id === c.fromUserId);
  }

  return { reps, cols };
}

async function main() {
  const arg = process.argv[2] || null;
  const { repUser, colUser } = arg ? { repUser: arg, colUser: arg } : await pickUsers();

  let firstRepId: string | undefined;
  let firstColId: string | undefined;

  if (repUser) {
    const { reps } = await verifyUser(repUser);
    firstRepId = reps[0]?.id;
  }
  if (colUser && colUser !== repUser) {
    const { cols } = await verifyUser(colUser);
    firstColId = cols[0]?.id;
  } else if (repUser) {
    // 같은 사용자에 동료도 있으면 거기서 집계
    const cards = await getCluster4WeeklyCardsForProfileUser(repUser);
    firstColId = cards.flatMap((c) => c.weeklyColleagues)[0]?.id;
  }

  console.log("\n──────── 검증 예시 (id 발췌) ────────");
  console.log(`weeklyReputations[0].id = ${firstRepId ?? "(없음)"}`);
  console.log(`weeklyColleagues[0].id  = ${firstColId ?? "(없음)"}`);

  console.log(`\n${failed ? "❌ 일부 실패" : "✅ 전체 통과 — id 안정적, 수정/삭제 API에 그대로 사용 가능"}`);
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
