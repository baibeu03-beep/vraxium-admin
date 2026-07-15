/**
 * APPLY: 라인 개설 Point A·B 소급 보정 실행. ⚠ dry-run 검토·승인 후에만 실행.
 *   npx tsx --env-file=.env.local scripts/backfill-line-open-payout-apply.ts --apply
 *   (--apply 없으면 실행 계획만 출력하고 종료 — 안전장치)
 *
 * 방식(요구사항 준수):
 *   · 별도 insert 로직 없음 — 공통 함수 payLineOpenTargetsOnce(lineId) 만 호출.
 *   · 전체 라인 ID 페이지네이션 순회(1000행 cap 회피). 배치 단위 처리(거대 단일 트랜잭션 없음).
 *   · 멱등성·scope·era·config·pay-once 전부 공통 함수가 담당 → 재실행 안전(이미 지급분 자동 skip).
 *   · 라인별 try/catch — 실패(예: QA 중 실사용자 라인 422)는 기록만 하고 계속. 부분 성공분 회수 없음.
 *   · snapshot 조회/생성 경로 미사용(공통 함수는 write 시점 무효화만 수행).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { payLineOpenTargetsOnce } from "@/lib/processPointAccrual";
import * as fs from "node:fs";

const APPLY = process.argv.includes("--apply");
const BATCH = 50;

async function allLineIds(): Promise<string[]> {
  const ids: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_lines").select("id").order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ id: string }>;
    ids.push(...rows.map((r) => r.id));
    if (rows.length < PAGE) break;
  }
  return ids;
}

async function main() {
  const ids = await allLineIds();
  console.log(`[backfill] lines=${ids.length} apply=${APPLY} batch=${BATCH}`);
  if (!APPLY) { console.log("DRY: --apply 플래그가 없어 실행하지 않고 종료합니다."); process.exit(0); }

  let paidLines = 0, paidPairs = 0, noop = 0;
  const failures: Array<{ lineId: string; error: string }> = [];
  const paidDetail: Array<{ lineId: string; users: number }> = [];

  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    for (const lineId of batch) {
      try {
        const res = await payLineOpenTargetsOnce(lineId);
        const n = res.ok && !("skipped" in res && res.skipped) ? res.accruedUserIds.length : 0;
        if (n > 0) { paidLines++; paidPairs += n; paidDetail.push({ lineId, users: n }); }
        else noop++;
      } catch (e) {
        failures.push({ lineId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    console.log(`[backfill] ${Math.min(i + BATCH, ids.length)}/${ids.length} · paidPairs=${paidPairs} · fail=${failures.length}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = { finishedAt: new Date().toISOString(), totalLines: ids.length, paidLines, paidPairs, noopLines: noop, failures, paidDetail };
  if (!fs.existsSync("claudedocs")) fs.mkdirSync("claudedocs", { recursive: true });
  const path = `claudedocs/line-payout-backfill-apply-${stamp}.json`;
  fs.writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\n[backfill] DONE paidLines=${paidLines} paidPairs=${paidPairs} noop=${noop} fail=${failures.length}`);
  if (failures.length) console.log("failures(sample):", JSON.stringify(failures.slice(0, 10), null, 2));
  console.log(`[files] ${path}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
