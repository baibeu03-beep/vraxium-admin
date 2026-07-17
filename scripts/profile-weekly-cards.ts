/**
 * /api/cluster4/weekly-cards 실측 프로파일러 (계측 전용 — 어떤 데이터도 쓰지 않는다).
 *
 * 목적: crew 레포 /weekly-league 가 실제로 하는 호출을 그대로 재현해
 *   "병목이 HTTP 인지 / Weekly Cards 계산인지 / Supabase 조회인지" 를 수치로 가른다.
 *
 * crew 실제 호출 형태 (vraxium/lib/weekly-league.ts:162 loadGrowthMetricSnapshots):
 *   GET {ADMIN}/api/cluster4/weekly-cards?userId=<uuid>&mode=<operating|test>
 *   headers: x-internal-api-key
 *   concurrency 12, slice 단위 await Promise.all (= 배리어 웨이브)
 *
 * 사용:
 *   1) 다른 터미널에서: WEEKLY_CARDS_TRACE=1 npm run dev   (라우트가 span 트리를 콘솔에 출력)
 *   2) npm run profile:weekly-cards
 *
 * 옵션: --users=30 --concurrency=12 --base=http://localhost:3000 --repeat=5
 */
import { createClient } from "@supabase/supabase-js";

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;

const USERS = Number(arg("users", "30"));
const CONCURRENCY = Number(arg("concurrency", "12"));
const BASE = arg("base", "http://localhost:3000");
const REPEAT = Number(arg("repeat", "5"));
const MODE = arg("mode", "operating");

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const KEY = process.env.INTERNAL_API_KEY ?? "";

type CallResult = {
  userId: string;
  ms: number;
  status: number;
  bytes: number;
  cards: number;
  startedAt: number;
  endedAt: number;
};

async function callOnce(userId: string, t0: number): Promise<CallResult> {
  const url = new URL("/api/cluster4/weekly-cards", BASE);
  url.searchParams.set("userId", userId);
  url.searchParams.set("mode", MODE);
  const startedAt = performance.now() - t0;
  const s = performance.now();
  const res = await fetch(url, {
    headers: { "x-internal-api-key": KEY },
    cache: "no-store",
  });
  const text = await res.text();
  const ms = performance.now() - s;
  let cards = 0;
  try {
    const body = JSON.parse(text) as { data?: unknown[] };
    cards = Array.isArray(body.data) ? body.data.length : 0;
  } catch {
    /* ignore */
  }
  return {
    userId,
    ms,
    status: res.status,
    bytes: Buffer.byteLength(text, "utf8"),
    cards,
    startedAt,
    endedAt: performance.now() - t0,
  };
}

function stats(xs: number[]): { p50: number; p95: number; min: number; max: number; avg: number } {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
  return {
    p50: at(0.5),
    p95: at(0.95),
    min: s[0],
    max: s[s.length - 1],
    avg: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

const f = (n: number) => `${n.toFixed(0)}ms`;

// crew 와 동일한 배리어 웨이브 팬아웃 재현.
async function fanoutLikeCrew(userIds: string[], concurrency: number) {
  const t0 = performance.now();
  const out: CallResult[] = [];
  const waves: number[] = [];
  for (let off = 0; off < userIds.length; off += concurrency) {
    const wStart = performance.now();
    const slice = userIds.slice(off, off + concurrency);
    const r = await Promise.all(slice.map((u) => callOnce(u, t0)));
    out.push(...r);
    waves.push(performance.now() - wStart);
  }
  return { total: performance.now() - t0, results: out, waves };
}

async function main() {
  if (!KEY) throw new Error("INTERNAL_API_KEY 없음 (.env.local 확인)");

  // 대상: snapshot 행이 있는 실사용자 — weekly-league 로스터와 같은 모집단 성격.
  const { data, error } = await supabase
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,card_count,is_stale,dto_version,computed_at")
    .order("computed_at", { ascending: false })
    .limit(USERS);
  if (error) throw new Error(`snapshot 조회 실패: ${error.message}`);
  const rows = (data ?? []) as Array<{
    user_id: string;
    card_count: number | null;
    is_stale: boolean;
    dto_version: number;
    computed_at: string;
  }>;
  const userIds = rows.map((r) => r.user_id);
  if (userIds.length === 0) throw new Error("snapshot 행 없음");

  console.log("═".repeat(78));
  console.log(`profile-weekly-cards  base=${BASE}  users=${userIds.length}  mode=${MODE}`);
  console.log(
    `snapshot 상태: is_stale=${rows.filter((r) => r.is_stale).length}/${rows.length}` +
      `  dto_versions=${[...new Set(rows.map((r) => r.dto_version))].join(",")}` +
      `  avg_cards=${(rows.reduce((s, r) => s + (r.card_count ?? 0), 0) / rows.length).toFixed(1)}`,
  );
  console.log("═".repeat(78));

  // 워밍업(dev 컴파일·커넥션 예열 제외).
  console.log("\n[warmup] ...");
  await callOnce(userIds[0], performance.now());
  await callOnce(userIds[0], performance.now());

  // ── Phase 1: 단건 순차 — 1콜의 순수 비용 ──
  console.log(`\n── Phase 1: 단건 순차 ×${REPEAT} (동일 유저, 캐시/스냅샷 HIT 경로) ──`);
  const single: number[] = [];
  for (let i = 0; i < REPEAT; i++) {
    const r = await callOnce(userIds[0], performance.now());
    single.push(r.ms);
    console.log(`  #${i + 1} ${f(r.ms)}  status=${r.status}  cards=${r.cards}  ${(r.bytes / 1024).toFixed(1)}KB`);
  }
  const s1 = stats(single);
  console.log(`  → p50=${f(s1.p50)} avg=${f(s1.avg)} min=${f(s1.min)} max=${f(s1.max)}`);

  // ── Phase 2: 서로 다른 30명 순차 — 유저별 편차(=stale/miss 재계산 유무) ──
  console.log(`\n── Phase 2: 서로 다른 ${userIds.length}명 순차 1콜씩 ──`);
  const seq: CallResult[] = [];
  const seqT0 = performance.now();
  for (const u of userIds) seq.push(await callOnce(u, seqT0));
  const seqTotal = performance.now() - seqT0;
  const s2 = stats(seq.map((r) => r.ms));
  console.log(
    `  총 ${f(seqTotal)} | p50=${f(s2.p50)} p95=${f(s2.p95)} min=${f(s2.min)} max=${f(s2.max)} avg=${f(s2.avg)}`,
  );
  const slow = seq.filter((r) => r.ms > s2.p50 * 3);
  if (slow.length) {
    console.log(`  ⚠ p50의 3배 초과(재계산 의심) ${slow.length}건:`);
    for (const r of slow.slice(0, 8)) console.log(`     ${r.userId} ${f(r.ms)} cards=${r.cards}`);
  }

  // ── Phase 3: crew 재현 (concurrency 12 배리어 웨이브) ──
  console.log(`\n── Phase 3: crew 재현 — ${userIds.length}명 / concurrency=${CONCURRENCY} 배리어 웨이브 ──`);
  const p3 = await fanoutLikeCrew(userIds, CONCURRENCY);
  const s3 = stats(p3.results.map((r) => r.ms));
  console.log(`  ⏱ 전체 wall = ${f(p3.total)}   ← crew 가 체감하는 admin 팬아웃 시간`);
  console.log(`  웨이브별: ${p3.waves.map((w, i) => `W${i + 1}=${f(w)}`).join("  ")}`);
  console.log(
    `  콜 단위: p50=${f(s3.p50)} p95=${f(s3.p95)} min=${f(s3.min)} max=${f(s3.max)} avg=${f(s3.avg)}`,
  );
  console.log(
    `  응답합계 ${(p3.results.reduce((s, r) => s + r.bytes, 0) / 1024 / 1024).toFixed(2)}MB` +
      `  (평균 ${(p3.results.reduce((s, r) => s + r.bytes, 0) / p3.results.length / 1024).toFixed(1)}KB/콜)`,
  );
  const sumMs = p3.results.reduce((s, r) => s + r.ms, 0);
  console.log(
    `  직렬화 지표: Σ콜 = ${f(sumMs)} vs wall ${f(p3.total)} → 실효 병렬도 ${(sumMs / p3.total).toFixed(2)}x` +
      ` (이론상 ${CONCURRENCY}x)`,
  );

  // ── Phase 4: 무제한 동시 — concurrency 12 캡이 병목인지 판정 ──
  console.log(`\n── Phase 4: 동일 ${userIds.length}명 / concurrency=${userIds.length} (캡 해제) ──`);
  const p4 = await fanoutLikeCrew(userIds, userIds.length);
  const s4 = stats(p4.results.map((r) => r.ms));
  console.log(`  ⏱ 전체 wall = ${f(p4.total)}   (Phase 3 대비 ${(p3.total / p4.total).toFixed(2)}x)`);
  console.log(`  콜 단위: p50=${f(s4.p50)} p95=${f(s4.p95)} max=${f(s4.max)} avg=${f(s4.avg)}`);

  // ── 결론 수치 ──
  console.log(`\n${"═".repeat(78)}`);
  console.log("판정 근거 요약");
  console.log("═".repeat(78));
  console.log(`  1콜 단독(p50)                : ${f(s1.p50)}`);
  console.log(`  30콜 순차 합                 : ${f(seqTotal)}`);
  console.log(`  30콜 c=12 웨이브 wall        : ${f(p3.total)}`);
  console.log(`  30콜 c=30 wall               : ${f(p4.total)}`);
  console.log(
    `  이상적 batch 하한(1콜 비용) : ${f(s1.p50)}  ← 30명 계산이 완전 병렬이라면 이 근처`,
  );
  console.log(
    `  이상적 batch 하한(계산 순차): ${f(s1.p50 * userIds.length)}  ← 계산이 직렬이면 이 근처`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
