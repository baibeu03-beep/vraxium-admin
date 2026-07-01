/**
 * recompute-test-user-card-snapshots.ts
 *   QA 라인 누수 수정(lib/cluster4WeeklyCardsData lineInProfileScope) 반영을 위해 test_user_markers
 *   등재 유저의 weekly-cards snapshot 만 재계산한다. DTO 버전 bump 없이(=운영 snapshot 무영향)
 *   테스트 유저 행만 갱신해 고객앱 테스트 모드 카드가 즉시 신정책(운영 라인 미노출)으로 수렴하게 한다.
 *
 *   ⚠ 안전장치: test_user_markers 에 등재된 user_id 만 대상. 실유저는 절대 건드리지 않는다.
 *   재계산 자체는 순수 계산 후 그 유저 행만 upsert(다른 유저 무영향). 실패는 유저별 격리(기존 보존).
 *
 *   npx tsx --env-file=.env.local scripts/recompute-test-user-card-snapshots.ts
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

async function main() {
  const markers = await fetchTestUserMarkerIds();
  const ids = Array.from(markers);
  console.log(`test_user_markers: ${ids.length}명 — snapshot 재계산 시작(운영 무접촉)`);
  const res = await recomputeWeeklyCardsSnapshotsForUsers(ids, { concurrency: 3 });
  console.log(
    `완료: 요청 ${res.requested} · 재계산 ${res.recomputed} · 실패 ${res.failed}` +
    (res.failed ? ` · 실패ID ${res.failedUserIds.slice(0, 10).join(",")}` : ""),
  );
  process.exit(res.failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("ERR", e instanceof Error ? e.stack : e); process.exit(1); });
