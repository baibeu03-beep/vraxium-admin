// 진단: /admin/members 크루 목록 roster — 단계별 프로파일링 + 품계(live) 분석 + 고객 parity.
//   npx tsx --env-file=.env.local scripts/diag-members-roster.ts [org|all]
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listMembersRoster, sumPointsForUsers } from "@/lib/adminMembersData";
import { listAdminCrewDtos } from "@/lib/adminCrewData";
import { getGrowthRosterBatch, getGrowthRosterBatchFast } from "@/lib/cluster3GrowthData";
import { getClubRank, getClubRankGradeBatch } from "@/lib/cluster3ClubRankData";
import { getScheduleReliabilityRateBatch } from "@/lib/cluster1ResumeData";
import { readWeeklyCardsSnapshotBatch } from "@/lib/cluster4WeeklyCardsSnapshot";
import { deriveRosterCardStats, rosterActivityRate } from "@/lib/rosterCardStats";

type Org = "encre" | "oranke" | "phalanx";

async function profileSteps(org: Org | undefined) {
  const label = org ?? "ALL";
  console.log(`\n===== 프로파일링 (org=${label}, mode=operating) =====`);

  let s = Date.now();
  const crews = await listAdminCrewDtos(org, "operating");
  const userIds = crews.map((c) => c.userId);
  console.log(`1) listAdminCrewDtos: ${Date.now() - s}ms (users=${userIds.length})`);

  const ID_CHUNK = 200;

  s = Date.now();
  for (let i = 0; i < userIds.length; i += ID_CHUNK) {
    await getGrowthRosterBatch(userIds.slice(i, i + ID_CHUNK));
  }
  console.log(`2) getGrowthRosterBatch(fat, snapshot 카드): ${Date.now() - s}ms`);

  s = Date.now();
  for (let i = 0; i < userIds.length; i += ID_CHUNK) {
    await getGrowthRosterBatchFast(userIds.slice(i, i + ID_CHUNK));
  }
  console.log(`2b) getGrowthRosterBatchFast(slim 우선, 미적용 시 fat 폴백): ${Date.now() - s}ms`);

  await verifySlimDerivation(userIds);

  s = Date.now();
  await getClubRankGradeBatch(userIds);
  console.log(`3) getClubRankGradeBatch(품계 live 1-pass): ${Date.now() - s}ms`);

  s = Date.now();
  await sumPointsForUsers(userIds);
  console.log(`4) Po.A/B/C(sumPointsForUsers): ${Date.now() - s}ms`);

  s = Date.now();
  await getScheduleReliabilityRateBatch(userIds);
  console.log(`5) getScheduleReliabilityRateBatch: ${Date.now() - s}ms`);

  s = Date.now();
  const { members } = await listMembersRoster({
    organization: org ?? null,
    mode: "operating",
    profile: true,
  });
  console.log(`>> listMembersRoster 총합(병렬): ${Date.now() - s}ms (members=${members.length})`);

  return members;
}

// slim 파생(deriveRosterCardStats)이 fat 경로(getGrowthRosterBatch)와 동일한지 직접 비교.
// 표/마이그레이션 없이도 검증 가능 — 같은 snapshot 카드로 두 방식을 돌려 a/e/활동완료율 일치 확인.
async function verifySlimDerivation(userIds: string[]) {
  console.log(`\n===== slim 파생 == fat 동일성 검증(deriveRosterCardStats vs getGrowthRosterBatch) =====`);
  const todayIso = new Date().toISOString().slice(0, 10);
  const fat = await getGrowthRosterBatch(userIds);
  const fatById = new Map(fat.map((r) => [r.userId, r]));
  const snapByUser = await readWeeklyCardsSnapshotBatch(userIds);
  let checked = 0;
  let mismatch = 0;
  for (const uid of userIds) {
    const f = fatById.get(uid);
    const snap = snapByUser.get(uid);
    if (!f || !snap || (snap.status !== "hit" && snap.status !== "stale")) continue;
    const stats = deriveRosterCardStats(snap.cards, todayIso);
    if (!stats) continue;
    checked++;
    const slimRate = rosterActivityRate(stats.activityAvailable, stats.activityCompleted);
    if (
      stats.successWeeks !== f.successWeeks ||
      stats.growableWeeks !== f.growableWeeks ||
      slimRate !== f.activityRate
    ) {
      mismatch++;
      if (mismatch <= 8) {
        console.log(
          `   ✗ ${uid}: slim(a=${stats.successWeeks},e=${stats.growableWeeks},act=${slimRate}) vs fat(a=${f.successWeeks},e=${f.growableWeeks},act=${f.activityRate})`,
        );
      }
    }
  }
  console.log(`   비교 ${checked}명 · 불일치 ${mismatch}명 → ${mismatch === 0 ? "동일 ✓" : "검토 필요"}`);
}

async function gradeAnalysis(members: Awaited<ReturnType<typeof listMembersRoster>>["members"]) {
  console.log(`\n===== 품계 분석 (live, user_grade_stats 캐시 미사용) =====`);
  const total = members.length;
  const withRank = members.filter((m) => m.rankGradeNumber != null);
  console.log(`1) roster 대상 user 수: ${total}`);
  console.log(`2) 품계 산출됨: ${withRank.length} / 미산출(null=온보딩/포인트부족): ${total - withRank.length}`);

  const { count: cacheCount } = await supabaseAdmin
    .from("user_grade_stats")
    .select("user_id", { count: "exact", head: true });
  console.log(`   (참고) user_grade_stats 캐시 행 수: ${cacheCount} — 고객/어드민 모두 미참조`);

  const nulls = members.filter((m) => m.rankGradeNumber == null);
  console.log(`3) 품계 null user(표본 10):`);
  for (const m of nulls.slice(0, 10)) {
    console.log(`   - ${m.displayName} growth=${m.displayGrowthStatus} success=${m.successWeeks} growable=${m.growableWeeks}`);
  }

  console.log(`\n===== 고객 parity (단건 live getClubRank vs roster 배치 품계) =====`);
  const sample = [...withRank.slice(0, 4), ...nulls.slice(0, 2)];
  let mismatch = 0;
  for (const m of sample) {
    const live = await getClubRank(m.userId);
    const liveLabel = live.rankGrade ?? "—";
    const rosterLabel = m.rankGradeLabel ?? "—";
    const ok = liveLabel === rosterLabel;
    if (!ok) mismatch++;
    console.log(`   ${m.displayName}: roster=${rosterLabel}(${m.rankGradeNumber ?? "null"}) / 단건live=${liveLabel} frozen=${live.isFrozen} ${ok ? "OK" : "✗MISMATCH"}`);
  }
  console.log(`   parity: ${sample.length - mismatch}/${sample.length} 일치`);
}

async function main() {
  const arg = process.argv[2];
  const org = arg === "all" ? undefined : ((arg as Org) || "encre");
  const members = await profileSteps(org);
  await gradeAnalysis(members);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
