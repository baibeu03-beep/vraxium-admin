// 전체 cluster4_weekly_card_snapshots 를 현재 코드의 WEEKLY_CARDS_DTO_VERSION 으로 수렴.
//   dry(기본): 현황만 보고.  apply: dto_version != 현재상수 인 행만 재계산(수렴).
//   run(dry)  : npx tsx --env-file=.env.local scripts/backfill-weekly-cards-snapshot-version.ts
//   run(apply): npx tsx --env-file=.env.local scripts/backfill-weekly-cards-snapshot-version.ts --apply
//   동시성    : CONC 환경변수(기본 4).
// ⚠ 버전 번호 하드코딩 금지 — 기준은 코드 상수 WEEKLY_CARDS_DTO_VERSION.
// ⚠ 파생 캐시 재생성만(source 데이터 무변경). 실패는 격리(기존 snapshot 보존). 멱등·재실행 안전.
import { createClient } from "@supabase/supabase-js";
import {
  WEEKLY_CARDS_DTO_VERSION,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const APPLY = process.argv.includes("--apply");
const CONC = Math.max(1, Number(process.env.CONC ?? 4));
const TABLE = "cluster4_weekly_card_snapshots";

async function versionHistogram(): Promise<Map<number, number>> {
  const hist = new Map<number, number>();
  let from = 0; const PAGE = 1000;
  for (;;) {
    const { data, error } = await sb.from(TABLE).select("dto_version").order("user_id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as { dto_version: number }[];
    for (const r of rows) hist.set(r.dto_version, (hist.get(r.dto_version) ?? 0) + 1);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return hist;
}

// 재계산 전 작업목록 고정(전수 fetch 후 처리 — 처리 중 set 변동 영향 없음).
async function fetchMismatchedUserIds(): Promise<string[]> {
  const ids: string[] = [];
  let from = 0; const PAGE = 1000;
  for (;;) {
    const { data, error } = await sb.from(TABLE)
      .select("user_id,dto_version")
      .neq("dto_version", WEEKLY_CARDS_DTO_VERSION)
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as { user_id: string }[];
    ids.push(...rows.map((r) => r.user_id));
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return ids;
}

async function main() {
  console.log(`=== weekly-cards snapshot 버전 수렴 ===`);
  console.log(`기준 WEEKLY_CARDS_DTO_VERSION = ${WEEKLY_CARDS_DTO_VERSION} (코드 상수)`);
  console.log(`모드 = ${APPLY ? "APPLY(재계산)" : "DRY(현황만)"} · 동시성 = ${CONC}`);

  const histBefore = await versionHistogram();
  const total = [...histBefore.values()].reduce((s, n) => s + n, 0);
  console.log(`\n[before] 전체 snapshot 행 = ${total}`);
  for (const [v, n] of [...histBefore.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`   v${v}: ${n}${v === WEEKLY_CARDS_DTO_VERSION ? "  ← 현재버전(수렴 완료)" : "  → 재계산 대상"}`);
  }

  const targets = await fetchMismatchedUserIds();
  console.log(`\n재계산 대상(dto_version != ${WEEKLY_CARDS_DTO_VERSION}) = ${targets.length}명`);
  if (!APPLY) {
    console.log(`\n(DRY) 재계산하려면 --apply 로 재실행.`);
    process.exit(0);
  }
  if (targets.length === 0) { console.log("\n수렴 완료 — 재계산 대상 없음."); process.exit(0); }

  // ── 재계산(동시성 제한·실패 격리·진행 로그) ──
  const t0 = Date.now();
  let done = 0, ok = 0, failed = 0; const failedIds: string[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const uid = targets[cursor++];
      try {
        await recomputeAndStoreWeeklyCardsSnapshot(uid); // 내부에서 WEEKLY_CARDS_DTO_VERSION 으로 저장
        ok++;
      } catch (e) {
        failed++; failedIds.push(uid);
        console.warn(`  ✗ ${uid} 재계산 실패(기존 보존): ${e instanceof Error ? e.message : String(e)}`);
      }
      done++;
      if (done % 20 === 0 || done === targets.length) {
        console.log(`  …진행 ${done}/${targets.length} (ok=${ok} fail=${failed}, ${Math.round((Date.now() - t0) / 1000)}s)`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, targets.length) }, () => worker()));

  // ── 검증: 재집계 ──
  const histAfter = await versionHistogram();
  const remaining = [...histAfter.entries()].filter(([v]) => v !== WEEKLY_CARDS_DTO_VERSION).reduce((s, [, n]) => s + n, 0);
  console.log(`\n[after] 재계산 ok=${ok} fail=${failed} (${Math.round((Date.now() - t0) / 1000)}s)`);
  console.log(`[after] 버전 분포:`);
  for (const [v, n] of [...histAfter.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`   v${v}: ${n}${v === WEEKLY_CARDS_DTO_VERSION ? "  ← 현재버전" : "  ⚠ 미수렴"}`);
  }
  console.log(`\n미수렴 잔여(현재버전 아님) = ${remaining}`);
  if (failedIds.length) console.log(`실패 userIds(재실행 시 자동 재시도): ${JSON.stringify(failedIds.slice(0, 50))}${failedIds.length > 50 ? " …" : ""}`);
  console.log(remaining === 0 ? "\n✅ 전체 수렴 완료." : "\n⚠ 잔여 존재 — 스크립트 재실행(멱등)으로 재시도 가능.");
  process.exit(remaining === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
