/**
 * cluster4_weekly_card_snapshots — **현재 코드의 DTO 버전으로 전량 수렴**.
 *
 * 대상 = `dto_version != WEEKLY_CARDS_DTO_VERSION` 인 행(+ 옵션으로 is_stale=true 행).
 *   · 버전 번호는 하드코딩하지 않는다 — lib/cluster4WeeklyCardsSnapshot 의 상수를 **import** 해서
 *     현재 코드 값을 그대로 쓴다(bump 때마다 스크립트 수정 불필요).
 *   · 재계산은 조회 라우트/ops 엔드포인트와 **동일 함수**(recomputeAndStoreWeeklyCardsSnapshot).
 *     계산 경로가 하나이므로 결과는 lazy 재계산과 byte-identical.
 *   · 사용자별 실패는 격리한다(upsert 미수행 → 기존 snapshot 보존). 마지막에 1회 재시도.
 *
 * ⚠ 배포 순서: **운영이 신버전 코드로 배포된 뒤** 실행할 것. 구버전이 서비스 중인 상태에서 미리
 *   수렴시키면, 구버전 인스턴스가 그 행을 version_mismatch 로 보고 백그라운드 재계산하면서
 *   구버전 값으로 되돌린다(scheduleVersionMismatchRecompute).
 *
 * 사용:
 *   npm run converge:weekly-card-snapshots -- --dry-run     # 대상 수만 조회(쓰기 없음)
 *   npm run converge:weekly-card-snapshots                  # 전량 수렴
 *   npm run converge:weekly-card-snapshots -- --limit=100   # 일부만
 *   npm run converge:weekly-card-snapshots -- --concurrency=1 --delay-ms=500  # 원본 부하 시
 */
import { createClient } from "@supabase/supabase-js";
import {
  WEEKLY_CARDS_DTO_VERSION,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

const TABLE = "cluster4_weekly_card_snapshots";
const PAGE = 1000;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const INCLUDE_STALE = args.includes("--include-stale");
const num = (flag: string, fallback: number) => {
  const raw = args.find((a) => a.startsWith(`${flag}=`))?.split("=")[1];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const LIMIT = args.some((a) => a.startsWith("--limit=")) ? num("--limit", 0) : null;
// 재계산 1건 ≈ 수십 쿼리. 동시성 3 × 수백 명은 Supabase 원본을 넘어뜨릴 수 있다
//   (2026-07-27 실측: 443건째부터 Cloudflare 520/521 — 원본 무응답 → 48건 연속 실패).
//   기본을 2로 낮추고 사용자 간 간격(--delay-ms)과 지수 백오프 재시도를 둔다.
const CONCURRENCY = num("--concurrency", 2);
const DELAY_MS = num("--delay-ms", 250);
const RETRIES = num("--retries", 3);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 5xx/네트워크성 일시 오류만 재시도 대상 — 데이터 오류(권한/스키마)는 즉시 실패로 남긴다.
const isTransient = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return /50[0-9]|52[0-9]|timeout|fetch failed|ECONN|socket hang up|Web server/i.test(m);
};

type Row = { user_id: string; dto_version: number; is_stale: boolean; computed_at: string };

/** 수렴 대상 행(버전 불일치 + 옵션 stale). 페이지네이션 — user_id asc 안정 정렬. */
async function listTargets(): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb
      .from(TABLE)
      .select("user_id,dto_version,is_stale,computed_at")
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    q = INCLUDE_STALE
      ? q.or(`dto_version.neq.${WEEKLY_CARDS_DTO_VERSION},is_stale.eq.true`)
      : q.neq("dto_version", WEEKLY_CARDS_DTO_VERSION);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return LIMIT ? rows.slice(0, LIMIT) : rows;
}

async function recomputeAll(userIds: string[]): Promise<{ ok: number; failed: string[] }> {
  let ok = 0;
  const failed: string[] = [];
  let cursor = 0;
  const t0 = Date.now();
  async function worker() {
    while (cursor < userIds.length) {
      const i = cursor++;
      const uid = userIds[i];
      let lastErr: unknown = null;
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        try {
          await recomputeAndStoreWeeklyCardsSnapshot(uid);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt === RETRIES || !isTransient(e)) break;
          // 원본 과부하에서 즉시 재시도하면 더 밀어붙이게 된다 — 지수 백오프로 숨을 준다.
          const backoff = 2000 * 2 ** attempt;
          console.warn(`  … ${uid} 일시 오류 → ${backoff}ms 후 재시도(${attempt + 1}/${RETRIES})`);
          await sleep(backoff);
        }
      }
      if (lastErr) {
        failed.push(uid);
        const m = lastErr instanceof Error ? lastErr.message : String(lastErr);
        console.warn(`  ✗ ${uid} — ${m.replace(/\s+/g, " ").slice(0, 160)}`);
      } else {
        ok++;
      }
      if (DELAY_MS > 0) await sleep(DELAY_MS);
      const done = ok + failed.length;
      if (done % 25 === 0 || done === userIds.length) {
        const rate = done / Math.max(1, (Date.now() - t0) / 1000);
        const eta = Math.round((userIds.length - done) / Math.max(rate, 0.001));
        console.log(`  … ${done}/${userIds.length} (성공 ${ok} · 실패 ${failed.length}) ETA ${eta}s`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, userIds.length) }, () => worker()));
  return { ok, failed };
}

async function run() {
  console.log(`[converge] 현재 코드 WEEKLY_CARDS_DTO_VERSION = ${WEEKLY_CARDS_DTO_VERSION} (import — 하드코딩 아님)`);

  const { count: total } = await sb.from(TABLE).select("user_id", { count: "exact", head: true });
  const targets = await listTargets();
  const byVersion = new Map<number, number>();
  for (const r of targets) byVersion.set(r.dto_version, (byVersion.get(r.dto_version) ?? 0) + 1);
  console.log(`[converge] snapshot 총 ${total}건 · 수렴 대상 ${targets.length}건`);
  for (const [v, n] of [...byVersion].sort((a, b) => a[0] - b[0])) console.log(`            v${v}: ${n}건`);
  if (INCLUDE_STALE) console.log("            (--include-stale: is_stale=true 행 포함)");

  if (targets.length === 0) {
    console.log("[converge] 이미 전량 수렴 상태 — 할 일 없음.");
    return;
  }
  if (DRY_RUN) {
    console.log("[converge] --dry-run — 쓰기 없이 종료.");
    return;
  }

  const t0 = Date.now();
  const first = await recomputeAll(targets.map((r) => r.user_id));
  let failed = first.failed;
  if (failed.length > 0) {
    console.log(`[converge] 실패 ${failed.length}건 재시도…`);
    failed = (await recomputeAll(failed)).failed;
  }

  // 결과 재검증 — 남은 버전 불일치 행을 직접 다시 센다(보고값을 믿지 않는다).
  const { count: remaining } = await sb
    .from(TABLE)
    .select("user_id", { count: "exact", head: true })
    .neq("dto_version", WEEKLY_CARDS_DTO_VERSION);
  console.log(
    `[converge] 완료 — 재계산 성공 ${first.ok}건 · 최종 실패 ${failed.length}건 · ` +
      `남은 버전 불일치 ${remaining}건 · ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  if (failed.length > 0) {
    console.log(`[converge] 실패 user_id: ${failed.join(",")}`);
    process.exitCode = 1;
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
