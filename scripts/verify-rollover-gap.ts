/**
 * 시간 경과 전환(running→tallying) 갭 정량화.
 *   npx tsx --env-file=.env.local scripts/verify-rollover-gap.ts
 *
 * 저장된 snapshot 에서 userWeekStatus="running"(현재 진행 주차) 카드를 모두 찾는다.
 * 이 카드들은 주차가 N+1 로 넘어가는 순간(다음 주 월요일) "tallying(집계 중)"으로
 * 전환돼야 하지만, 조회는 snapshot-only 이고 그 시점에 재계산 트리거(관리자 쓰기/공표/cron)가
 * 없으면 계속 "running"으로 남는다. 순수 resolver 로 "롤오버 후" 상태를 계산해 차이를 보인다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveWeekResultStatus } from "@/lib/growthCore";

type Card = {
  weekNumber?: number;
  seasonKey?: string | null;
  userWeekStatus?: string;
  statusLabel?: string;
  isRestWeek?: boolean;
};

async function main() {
  const { data, error } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,cards,is_stale,computed_at,dto_version");
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as {
    user_id: string;
    cards: Card[];
    is_stale: boolean;
    computed_at: string;
    dto_version: number;
  }[];

  let totalCards = 0;
  let runningCards = 0;
  const examples: string[] = [];

  for (const r of rows) {
    const cards = Array.isArray(r.cards) ? r.cards : [];
    totalCards += cards.length;
    for (const c of cards) {
      if (c.userWeekStatus === "running") {
        runningCards++;
        // 롤오버 후 = 더 이상 현재주 아님(isCurrentWeek=false), 아직 미공표(isPublished=false).
        const after = resolveWeekResultStatus({
          uwsStatus: null, // running 은 보통 uws 미확정 — weeks 기준
          isCurrentWeek: false,
          isPublished: false,
          weekIsOfficialRest: false,
          experienceVerdictStatus: null,
        });
        if (examples.length < 12) {
          examples.push(
            `user=${r.user_id} wk${c.weekNumber}[${c.seasonKey}] ` +
              `snapshot=running(진행 중) → 롤오버후=${after.status}(집계 중) | snapStale=${r.is_stale}`,
          );
        }
      }
    }
  }

  console.log(`snapshots=${rows.length} totalCards=${totalCards}`);
  console.log(`현재 "running"(진행 중) 카드 수 = ${runningCards}`);
  console.log(
    `→ 이 카드들은 다음 주차 경계에서 "tallying(집계 중)"으로 전환돼야 함.\n` +
      `  순수 resolver 확인: isCurrentWeek=false & 미공표 ⇒ "${
        resolveWeekResultStatus({
          uwsStatus: null,
          isCurrentWeek: false,
          isPublished: false,
          weekIsOfficialRest: false,
          experienceVerdictStatus: null,
        }).status
      }"\n`,
  );
  for (const e of examples) console.log("  " + e);
  if (runningCards === 0) {
    console.log(
      "  (현재 running 카드 없음 — 이번 주 현재주가 휴식/전환주이거나 시즌 갭일 수 있음)",
    );
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
