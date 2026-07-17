/**
 * weekly-cards preload 병렬화 — snapshot HIT / MISS / stale(2종) 경로 A/B 검증.
 *
 * 실사용자 snapshot 은 읽기만 한다:
 *   · HIT  = 운영 사용자 행을 그대로 조회(무변경).
 *   · MISS = snapshot 행이 없는 합성 UUID 로 호출(쓰기 없음). lazy 재계산 시도 → user_profiles 없음
 *            → 404 → cards=[] 폴백까지 함께 탄다.
 *   · stale = user_id 에 FK 가 있어 합성 fixture 행을 넣을 수 없다. 그래서 "테스트 마커 유저"의
 *            행만 사용하며, 원본(cards/dto_version/is_stale/computed_at)을 백업 → 플래그만 세팅 →
 *            검증 후 원본 그대로 복원하고 복원 여부를 확인한다. 운영 사용자 행은 건드리지 않는다.
 *
 * 검증 항목(경로별 pristine vs fixed):
 *   · HTTP status / body byte-identical (정규화 없이 raw 비교)
 *
 * 사용:
 *   npx tsx --env-file=.env.local scripts/verify-weekly-cards-preload-snapshot-paths.ts \
 *     --pristine=http://localhost:3200 --fixed=http://localhost:3300
 */
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const PRISTINE = arg("pristine", "http://localhost:3200");
const FIXED = arg("fixed", "http://localhost:3300");
const KEY = process.env.INTERNAL_API_KEY ?? "";
const TABLE = "cluster4_weekly_card_snapshots";

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function call(base: string, userId: string) {
  const t = performance.now();
  const res = await fetch(
    `${base}/api/cluster4/weekly-cards?userId=${userId}&mode=operating`,
    { headers: { "x-internal-api-key": KEY }, cache: "no-store" },
  );
  const body = await res.text();
  return { status: res.status, body, ms: performance.now() - t, sha: sha(body) };
}

async function compare(label: string, userId: string, expect: string) {
  // 라운드 2회 · 순서 반전(interleaved)
  const r1p = await call(PRISTINE, userId);
  const r1f = await call(FIXED, userId);
  const r2f = await call(FIXED, userId);
  const r2p = await call(PRISTINE, userId);

  const ok =
    r1p.status === r1f.status &&
    r1p.body === r1f.body &&
    r2p.status === r2f.status &&
    r2p.body === r2f.body;

  console.log(`\n── ${label} (기대 경로: ${expect}) ──`);
  console.log(`   userId   = ${userId}`);
  console.log(`   pristine = status ${r1p.status} · ${r1p.body.length}B · sha ${r1p.sha} · ${r1p.ms.toFixed(0)}ms`);
  console.log(`   fixed    = status ${r1f.status} · ${r1f.body.length}B · sha ${r1f.sha} · ${r1f.ms.toFixed(0)}ms`);
  console.log(`   round2   = ${r2p.sha === r2f.sha ? "동일" : "차이"} (순서 반전)`);
  console.log(`   ⇒ ${ok ? "✅ byte-identical" : "❌ 불일치"}`);
  return ok;
}

async function main() {
  if (!KEY) throw new Error("INTERNAL_API_KEY 없음");
  console.log("═".repeat(78));
  console.log("weekly-cards preload — snapshot HIT / stale / miss 3경로 A/B");
  console.log("═".repeat(78));

  const results: Array<[string, boolean]> = [];

  // ── 1) HIT: 실제 운영 사용자(읽기만) ──
  const { data: hitRow } = await db
    .from(TABLE)
    .select("user_id")
    .eq("is_stale", false)
    .order("computed_at", { ascending: false })
    .limit(1);
  const hitUser = (hitRow?.[0] as { user_id: string } | undefined)?.user_id;
  if (hitUser) results.push(["HIT", await compare("① snapshot HIT", hitUser, "hit · lazyRan=false")]);

  // ── 2) MISS: snapshot 행이 없는 합성 user_id (쓰기 없음) ──
  const missUser = randomUUID();
  results.push(["MISS", await compare("② snapshot MISS", missUser, "miss · lazy 시도 → 404 → cards=[]")]);

  // ── 3) STALE / 4) version_mismatch ──
  // user_id 에 FK 가 걸려 합성 UUID fixture 를 넣을 수 없다 → "테스트 마커 유저"의 행을 쓰되,
  //   ① 원본 행을 먼저 전량 백업하고 ② 각 호출 직전에 stale 플래그만 세팅하고
  //   ③ 검증 후 원본을 그대로 복원한다(cards/dto_version/is_stale/computed_at 원값).
  //   stale 판정은 snapshot 을 읽는 쪽 분기라 A/B 양쪽에 동일하게 필요하므로, 서버별 호출 직전에
  //   매번 다시 stale 로 만든다(첫 호출이 재계산으로 stale 을 지워 두 번째가 HIT 이 되는 것을 방지).
  const { data: tm } = await db.from("test_user_markers").select("user_id").limit(20);
  const tmIds = (tm ?? []).map((r) => (r as { user_id: string }).user_id);
  const { data: cand } = await db
    .from(TABLE)
    .select("user_id,cards,card_count,dto_version,is_stale,computed_at")
    .in("user_id", tmIds)
    .limit(1);
  const orig = cand?.[0] as
    | { user_id: string; cards: unknown; card_count: number; dto_version: number; is_stale: boolean; computed_at: string }
    | undefined;

  if (!orig) {
    console.log("\n⚠ 테스트 마커 유저의 snapshot 행 없음 → stale 경로 미검증");
  } else {
    const restore = async () => {
      const { error } = await db
        .from(TABLE)
        .update({
          cards: orig.cards,
          card_count: orig.card_count,
          dto_version: orig.dto_version,
          is_stale: orig.is_stale,
          computed_at: orig.computed_at,
        })
        .eq("user_id", orig.user_id);
      return error;
    };
    const setStale = async (patch: Record<string, unknown>) =>
      db.from(TABLE).update(patch).eq("user_id", orig.user_id);

    try {
      console.log(`\n[fixture] 대상 테스트유저 ${orig.user_id} · 원본 백업 완료`);
      console.log(`[fixture]   dto_version=${orig.dto_version} is_stale=${orig.is_stale} computed_at=${orig.computed_at}`);

      // ③ is_stale=true → 블로킹 lazy 재계산 경로
      await setStale({ is_stale: true });
      const sp = await call(PRISTINE, orig.user_id);
      await setStale({ is_stale: true });
      const sf = await call(FIXED, orig.user_id);
      const okStale = sp.status === sf.status && sp.body === sf.body;
      console.log(`\n── ③ snapshot STALE (is_stale=true) — 블로킹 lazy 재계산 ──`);
      console.log(`   pristine = status ${sp.status} · ${sp.body.length}B · sha ${sp.sha} · ${sp.ms.toFixed(0)}ms`);
      console.log(`   fixed    = status ${sf.status} · ${sf.body.length}B · sha ${sf.sha} · ${sf.ms.toFixed(0)}ms`);
      console.log(`   ⇒ ${okStale ? "✅ byte-identical" : "❌ 불일치"}`);
      results.push(["STALE(is_stale)", okStale]);

      // ④ dto_version 구버전 → version_mismatch (블로킹 0 + after() 배경 재계산)
      await setStale({ dto_version: 1, is_stale: false });
      const vp = await call(PRISTINE, orig.user_id);
      await setStale({ dto_version: 1, is_stale: false });
      const vf = await call(FIXED, orig.user_id);
      const okVm = vp.status === vf.status && vp.body === vf.body;
      console.log(`\n── ④ snapshot STALE (version_mismatch) — 구카드 즉시 노출 + 배경 재계산 ──`);
      console.log(`   pristine = status ${vp.status} · ${vp.body.length}B · sha ${vp.sha} · ${vp.ms.toFixed(0)}ms`);
      console.log(`   fixed    = status ${vf.status} · ${vf.body.length}B · sha ${vf.sha} · ${vf.ms.toFixed(0)}ms`);
      console.log(`   ⇒ ${okVm ? "✅ byte-identical" : "❌ 불일치"}`);
      results.push(["STALE(version_mismatch)", okVm]);
    } finally {
      // 배경 재계산(after())이 끝난 뒤 덮어쓰도록 잠시 대기 후 복원.
      await new Promise((r) => setTimeout(r, 6000));
      const err = await restore();
      const { data: after } = await db
        .from(TABLE)
        .select("dto_version,is_stale,computed_at")
        .eq("user_id", orig.user_id)
        .maybeSingle();
      const a = after as { dto_version: number; is_stale: boolean; computed_at: string } | null;
      const restored =
        !err &&
        a?.dto_version === orig.dto_version &&
        a?.is_stale === orig.is_stale &&
        a?.computed_at === orig.computed_at;
      console.log(`\n[restore] ${restored ? "✅ 원본 복원 확인" : `⚠ 복원 검증 실패 ${err?.message ?? JSON.stringify(a)}`}`);
    }
  }

  console.log(`\n${"═".repeat(78)}`);
  const bad = results.filter(([, ok]) => !ok);
  for (const [k, ok] of results) console.log(`  ${ok ? "✅" : "❌"} ${k}`);
  console.log(bad.length === 0 ? "\n전 경로 byte-identical" : `\n❌ ${bad.length}개 경로 회귀`);
  process.exit(bad.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
