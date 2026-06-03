/**
 * 주차/활동 상태 DTO 자동 전환 검증 (snapshot-only 구조).
 *
 *   npx tsx --env-file=.env.local scripts/verify-week-status-transition.ts [limit]
 *
 * 각 테스트 유저에 대해:
 *   1) DIRECT  = getCluster4WeeklyCardsForProfileUser (실시간 재계산)
 *   2) SNAPSHOT = readWeeklyCardsSnapshot (HTTP /api/cluster4/weekly-cards 가 내려주는 바로 그 값)
 * 두 결과의 주차별 userWeekStatus / statusLabel / statusTone 을 비교한다.
 *
 * DIRECT ≠ SNAPSHOT 인 주차 = stale snapshot (HTTP 가 옛 상태를 내려줌).
 * 특히 "DIRECT=tallying(집계 중) 인데 SNAPSHOT=running(진행 중)" = 시간 경과로 N주차가
 * 과거가 됐는데 재계산 트리거가 없어 전환이 누락된 케이스.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

type StatusTriple = {
  userWeekStatus: string;
  statusLabel: string;
  statusTone: string;
};

function triple(c: Cluster4WeeklyCardDto): StatusTriple {
  return {
    userWeekStatus: String(c.userWeekStatus),
    statusLabel: String(c.statusLabel),
    statusTone: String(c.statusTone),
  };
}

function keyOf(c: Cluster4WeeklyCardDto): string {
  return `${c.seasonKey ?? "?"}#${c.weekNumber}`;
}

async function pickTestUserIds(limit: number): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("test_user_markers")
    .select("user_id")
    .limit(limit);
  if (error) throw new Error(error.message);
  return ((data ?? []) as { user_id: string }[]).map((r) => r.user_id);
}

async function main() {
  const limit = Number(process.argv[2] ?? 8);
  const today = new Date().toISOString().slice(0, 10);
  console.log(`today=${today} | comparing DIRECT vs SNAPSHOT for up to ${limit} test users\n`);

  const userIds = await pickTestUserIds(limit);
  if (userIds.length === 0) {
    console.log("no test_user_markers rows found.");
    return;
  }

  let totalMismatchWeeks = 0;
  let usersWithMismatch = 0;
  let runningShouldBeTallying = 0;
  let snapshotMissing = 0;

  for (const uid of userIds) {
    let direct: Cluster4WeeklyCardDto[];
    try {
      direct = await getCluster4WeeklyCardsForProfileUser(uid);
    } catch (e) {
      console.log(`user=${uid} | DIRECT compute error: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const snap = await readWeeklyCardsSnapshot(uid);

    const snapCards =
      snap.status === "hit" || snap.status === "stale" ? snap.cards : [];
    const snapMeta =
      snap.status === "hit"
        ? `hit computed=${snap.computedAt}`
        : snap.status === "stale"
          ? `STALE(${snap.reason}) computed=${snap.computedAt}`
          : snap.status === "miss"
            ? "MISS(no row)"
            : `ERROR(${snap.message})`;

    if (snap.status === "miss" || snap.status === "error") snapshotMissing++;

    const snapByKey = new Map(snapCards.map((c) => [keyOf(c), c]));

    const mismatches: string[] = [];
    for (const dc of direct) {
      const sc = snapByKey.get(keyOf(dc));
      if (!sc) {
        mismatches.push(`${keyOf(dc)}: DIRECT=${triple(dc).userWeekStatus} | SNAPSHOT=<absent>`);
        continue;
      }
      const dt = triple(dc);
      const st = triple(sc);
      if (
        dt.userWeekStatus !== st.userWeekStatus ||
        dt.statusLabel !== st.statusLabel ||
        dt.statusTone !== st.statusTone
      ) {
        mismatches.push(
          `${keyOf(dc)}: DIRECT=[${dt.userWeekStatus}/${dt.statusLabel}/${dt.statusTone}] ` +
            `SNAPSHOT=[${st.userWeekStatus}/${st.statusLabel}/${st.statusTone}]`,
        );
        if (dt.userWeekStatus === "tallying" && st.userWeekStatus === "running") {
          runningShouldBeTallying++;
        }
      }
    }

    const flag = mismatches.length > 0 ? "  ⚠ MISMATCH" : "  ✓ match";
    console.log(
      `user=${uid} | direct=${direct.length} cards | snap=${snapCards.length} (${snapMeta})${flag}`,
    );
    for (const m of mismatches) console.log(`     ${m}`);

    if (mismatches.length > 0) {
      usersWithMismatch++;
      totalMismatchWeeks += mismatches.length;
    }
  }

  console.log(
    `\n=== SUMMARY ===\n` +
      `users checked            : ${userIds.length}\n` +
      `users with mismatch      : ${usersWithMismatch}\n` +
      `mismatched week-cards    : ${totalMismatchWeeks}\n` +
      `running→tallying lagged  : ${runningShouldBeTallying}\n` +
      `snapshot missing/error   : ${snapshotMissing}`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
