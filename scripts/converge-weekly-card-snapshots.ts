/**
 * 주차 카드 snapshot 버전 수렴.
 *
 * cluster4_weekly_card_snapshots 중 dto_version 이 "현재 코드의 WEEKLY_CARDS_DTO_VERSION" 과
 * 다른(=stale/version_mismatch) 행만 재계산해 현재 버전으로 수렴시킨다. 이미 현재 버전인 행은 건너뛴다.
 *
 * ⚠ 버전 번호를 하드코딩하지 않는다 — lib/cluster4WeeklyCardsSnapshot 의 WEEKLY_CARDS_DTO_VERSION
 *    상수를 import 해 기준으로 삼는다. 재계산도 recomputeAndStoreWeeklyCardsSnapshot 이 같은 상수로
 *    dto_version 을 기록하므로, 코드 버전이 바뀌면 이 스크립트도 자동으로 그 값으로 수렴한다.
 *
 * ⚠ 배포 선행: DTO bump 는 main push→Vercel 배포 성공 후 수렴해야 한다. 배포 전 로컬 수렴 시
 *    운영(구버전) 인스턴스가 조회 경로 bg 재계산으로 구버전을 되쓸 수 있다(수렴 무효 flip). 배포 완료 후 실행.
 *
 * 사용:
 *   npx tsx --env-file=.env.local scripts/converge-weekly-card-snapshots.ts          # 수렴 실행
 *   npx tsx --env-file=.env.local scripts/converge-weekly-card-snapshots.ts --dry    # 대상 집계만(재계산 안 함)
 */
import { createClient } from "@supabase/supabase-js";
import {
  WEEKLY_CARDS_DTO_VERSION,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

const DRY = process.argv.includes("--dry");
const CONCURRENCY = 3; // 재계산 1건 ~37쿼리 → 부하 보호(backfill 동일 기준).
const PAGE = 1000;

async function main() {
  const TARGET = WEEKLY_CARDS_DTO_VERSION;
  console.log(`[converge] 현재 코드 WEEKLY_CARDS_DTO_VERSION = ${TARGET}`);

  // 1. 전체 snapshot 행의 (user_id, dto_version) 스캔 → 버전 분포 + stale 대상 수집.
  const staleUserIds: string[] = [];
  const versionCount = new Map<number, number>();
  let total = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("user_id,dto_version")
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { user_id: string; dto_version: number }[];
    for (const r of rows) {
      total++;
      versionCount.set(r.dto_version, (versionCount.get(r.dto_version) ?? 0) + 1);
      if (r.dto_version !== TARGET) staleUserIds.push(r.user_id);
    }
    if (rows.length < PAGE) break;
  }

  console.log(`[converge] snapshot 총 ${total}행 · 버전 분포:`,
    [...versionCount.entries()].sort((a, b) => a[0] - b[0]).map(([v, n]) => `v${v}=${n}`).join(" "));
  console.log(`[converge] 수렴 대상(dto_version != ${TARGET}): ${staleUserIds.length}명`);

  if (staleUserIds.length === 0) {
    console.log("[converge] 이미 전원 현재 버전 — 재계산 불필요.");
    return;
  }
  if (DRY) {
    console.log("[converge] --dry: 재계산하지 않고 종료.");
    return;
  }

  // 2. 동시성 풀 재계산(현재 버전으로 저장).
  let done = 0, ok = 0;
  const failed: string[] = [];
  const t0 = Date.now();
  let cursor = 0;
  async function worker(w: number) {
    while (cursor < staleUserIds.length) {
      const uid = staleUserIds[cursor++];
      try {
        await recomputeAndStoreWeeklyCardsSnapshot(uid);
        ok++;
      } catch (e) {
        failed.push(uid);
        console.warn(`[converge][w${w}] FAILED ${uid}:`, e instanceof Error ? e.message : e);
      } finally {
        done++;
        if (done % 50 === 0) {
          const rate = done / ((Date.now() - t0) / 1000);
          const eta = Math.round((staleUserIds.length - done) / Math.max(rate, 0.01));
          console.log(`[converge] ${done}/${staleUserIds.length} (ok=${ok} fail=${failed.length}) ~${eta}s 남음`);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, staleUserIds.length) }, (_, w) => worker(w)));

  // 3. 재검증 — 아직 현재 버전이 아닌 행 재집계.
  let remaining = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("dto_version")
      .neq("dto_version", TARGET)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { dto_version: number }[];
    remaining += rows.length;
    if (rows.length < PAGE) break;
  }

  console.log("\n========== CONVERGE SUMMARY ==========");
  console.log(`목표 버전    : v${TARGET} (코드 상수)`);
  console.log(`수렴 대상    : ${staleUserIds.length}`);
  console.log(`성공         : ${ok}`);
  console.log(`실패         : ${failed.length}${failed.length ? ` (${failed.join(", ")})` : ""}`);
  console.log(`잔존 비-현재 : ${remaining} (0이어야 완전 수렴)`);
  console.log(`총 소요      : ${Math.round((Date.now() - t0) / 1000)}s (동시성 ${CONCURRENCY})`);
  console.log("======================================");
  process.exitCode = remaining === 0 && failed.length === 0 ? 0 : 1;
}

main().catch((e) => { console.error("[converge] fatal", e); process.exit(1); });
