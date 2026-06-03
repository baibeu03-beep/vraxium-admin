/**
 * 인적사항 DTO 보강 검증 (READ + 1유저 snapshot 재계산).
 *   1) 받은평판/연계동료가 있는 카드 주인 1명 자동 선택
 *   2) direct: fetchWeeklyPeopleByWeek → fromProfile/toProfile/colleagueProfile 새 필드 출력
 *   3) snapshot 재계산 후 readWeeklyCardsSnapshot → 저장 DTO(=HTTP 응답 원천)의 같은 필드 출력
 *   4) direct vs snapshot 필드 일치 여부 비교
 *   npx tsx --env-file=.env.local scripts/diag-verify-people-profile-dto.ts [userId]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchWeeklyPeopleByWeek } from "@/lib/cluster4WeeklyPeopleData";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const FIELDS = [
  "role",
  "membershipLevel",
  "profileTagline",
  "team",
  "part",
  "school",
  "department",
  "profileImageUrl",
] as const;

function pp(p: any): string {
  if (!p) return "null";
  return FIELDS.map((f) => `${f}=${JSON.stringify(p[f])}`).join(" ");
}

async function pickOwner(arg: string | null): Promise<string | null> {
  if (arg) return arg;
  // 연계동료가 있는 카드 주인 우선(colleagueProfile 검증 가치 큼)
  const { data: col } = await supabaseAdmin
    .from("weekly_colleagues")
    .select("user_id")
    .limit(1);
  if (col && col[0]) return col[0].user_id;
  const { data: rep } = await supabaseAdmin
    .from("weekly_reputations")
    .select("target_user_id")
    .limit(1);
  return rep && rep[0] ? rep[0].target_user_id : null;
}

async function main() {
  const owner = await pickOwner(process.argv[2] || null);
  if (!owner) return console.log("❌ 평판/동료 데이터를 가진 유저를 찾지 못함");
  console.log(`대상 카드 주인: ${owner}`);

  // 이 유저가 받은평판/작성동료를 가진 week_card_id 수집
  const [{ data: reps }, { data: cols }] = await Promise.all([
    supabaseAdmin.from("weekly_reputations").select("week_card_id").eq("target_user_id", owner),
    supabaseAdmin.from("weekly_colleagues").select("week_card_id").eq("user_id", owner),
  ]);
  const weekIds = Array.from(
    new Set([...(reps ?? []), ...(cols ?? [])].map((r: any) => r.week_card_id).filter(Boolean)),
  );
  console.log(`관련 week_card_id: ${weekIds.length}개`);
  if (weekIds.length === 0) return console.log("❌ week_card_id 없음");

  // ── 2) DIRECT ──
  console.log("\n══════════ DIRECT: fetchWeeklyPeopleByWeek ══════════");
  const peopleMap = await fetchWeeklyPeopleByWeek(owner, weekIds);
  const directProfiles: any[] = [];
  for (const [weekId, wp] of peopleMap) {
    console.log(`\n[week ${weekId.slice(0, 8)}]`);
    for (const r of wp.weeklyReputations) {
      console.log(`  rep.fromProfile : ${pp(r.fromProfile)}`);
      console.log(`  rep.toProfile   : ${pp(r.toProfile)}`);
      if (r.fromProfile) directProfiles.push(r.fromProfile);
      if (r.toProfile) directProfiles.push(r.toProfile);
    }
    for (const c of wp.weeklyColleagues) {
      console.log(`  col.colleagueProfile : ${pp(c.colleagueProfile)}`);
      if (c.colleagueProfile) directProfiles.push(c.colleagueProfile);
    }
  }

  // ── 3) SNAPSHOT 재계산 + readback ──
  console.log("\n══════════ SNAPSHOT: 재계산 후 readWeeklyCardsSnapshot ══════════");
  await recomputeAndStoreWeeklyCardsSnapshot(owner);
  const snap = await readWeeklyCardsSnapshot(owner);
  console.log(`snapshot status=${snap.status}`);
  const snapProfiles: any[] = [];
  if (snap.status === "hit" || snap.status === "stale") {
    for (const card of snap.cards) {
      for (const r of card.weeklyReputations ?? []) {
        if (r.fromProfile) snapProfiles.push(r.fromProfile);
        if (r.toProfile) snapProfiles.push(r.toProfile);
      }
      for (const c of card.weeklyColleagues ?? []) {
        if (c.colleagueProfile) snapProfiles.push(c.colleagueProfile);
      }
    }
  }
  // 표본 출력
  const seen = new Set<string>();
  for (const p of snapProfiles) {
    if (seen.has(p.userId)) continue;
    seen.add(p.userId);
    console.log(`  snap ${p.userId.slice(0, 8)} : ${pp(p)}`);
  }

  // ── 4) direct vs snapshot 비교(userId별 필드 동일성) ──
  console.log("\n══════════ direct vs snapshot 일치 검증 ══════════");
  const dirByUser = new Map<string, any>();
  for (const p of directProfiles) dirByUser.set(p.userId, p);
  let mismatch = 0;
  for (const sp of snapProfiles) {
    const dp = dirByUser.get(sp.userId);
    if (!dp) continue;
    for (const f of FIELDS) {
      if (JSON.stringify(dp[f]) !== JSON.stringify(sp[f])) {
        mismatch++;
        console.log(`  ✗ ${sp.userId.slice(0, 8)}.${f}: direct=${JSON.stringify(dp[f])} snap=${JSON.stringify(sp[f])}`);
      }
    }
  }
  console.log(mismatch === 0 ? "  ✅ direct 와 snapshot 모든 필드 일치" : `  ⚠ 불일치 ${mismatch}건`);

  // 새 필드가 실제로 값 보유하는지 요약
  const nonNull = (arr: any[], f: string) => arr.filter((p) => p[f] != null).length;
  console.log("\n새 필드 값 보유(snapshot):");
  for (const f of ["role", "membershipLevel", "profileTagline"]) {
    console.log(`  ${f}: ${nonNull(snapProfiles, f)}/${snapProfiles.length}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
