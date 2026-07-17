/**
 * weekly-cards 조회 경로 preload 병렬화 — pristine vs fixed interleaved A/B 회귀 검증.
 *
 * 목적: "독립 조회의 I/O 시작 시점만 앞당긴다"는 변경이 응답을 1바이트도 바꾸지 않음을 증명한다.
 *
 * 방식(정합 최우선):
 *   · 두 서버를 동시에 띄워 같은 DB·같은 시각에 번갈아 호출한다(interleaved) — 라운드마다 A/B 순서를
 *     뒤집어 DB 부하 drift 가 한쪽에만 유리하게 작용하지 못하게 한다.
 *   · 비교는 raw body 바이트 그대로(byte-identical) + HTTP status. 정규화하지 않는다
 *     (정규화는 차이를 숨길 수 있다 — 응답에 실행마다 달라지는 필드가 없음을 이 검증이 함께 증명한다).
 *   · 성공 응답뿐 아니라 실패 응답(잘못된 org/userId, 권한 실패, 필수 파라미터 누락)도 동일 비교한다.
 *
 * 사용:
 *   npx tsx --env-file=.env.local scripts/verify-weekly-cards-preload-parity.ts \
 *     --pristine=http://localhost:3200 --fixed=http://localhost:3300 --rounds=4 --per-org=4
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

const arg = (k: string, d: string): string =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;

const PRISTINE = arg("pristine", "http://localhost:3200");
const FIXED = arg("fixed", "http://localhost:3300");
const ROUNDS = Number(arg("rounds", "4"));
const PER_ORG = Number(arg("per-org", "4"));
const KEY = process.env.INTERNAL_API_KEY ?? "";
const ORGS = ["phalanx", "encre", "oranke"] as const;

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

type Case = { name: string; path: string; headers: Record<string, string> };
type Hit = { status: number; body: string; ms: number; sha: string };

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function call(base: string, c: Case): Promise<Hit> {
  const t = performance.now();
  const res = await fetch(`${base}${c.path}`, { headers: c.headers, cache: "no-store" });
  const body = await res.text();
  return { status: res.status, body, ms: performance.now() - t, sha: sha(body) };
}

async function main() {
  if (!KEY) throw new Error("INTERNAL_API_KEY 없음");

  // ── 코호트: org 별 실사용자(snapshot 보유) + 테스트 유저 ──
  const cohort: Array<{ org: string; userId: string; isTest: boolean }> = [];
  for (const org of ORGS) {
    const { data } = await db
      .from("user_profiles")
      .select("user_id")
      .eq("organization_slug", org)
      .limit(PER_ORG * 3);
    const ids = (data ?? []).map((r) => (r as { user_id: string }).user_id);
    const { data: snaps } = await db
      .from("cluster4_weekly_card_snapshots")
      .select("user_id")
      .in("user_id", ids.slice(0, 60));
    const withSnap = new Set((snaps ?? []).map((r) => (r as { user_id: string }).user_id));
    for (const id of ids.filter((i) => withSnap.has(i)).slice(0, PER_ORG)) {
      cohort.push({ org, userId: id, isTest: false });
    }
  }
  // 테스트 유저(마커) — mode=test / demoUserId 경로 대상
  const { data: markers } = await db.from("test_user_markers").select("user_id").limit(3);
  const testIds = (markers ?? []).map((r) => (r as { user_id: string }).user_id);

  console.log("═".repeat(80));
  console.log("weekly-cards preload 병렬화 — interleaved A/B (pristine vs fixed)");
  console.log("═".repeat(80));
  console.log(`pristine=${PRISTINE}  fixed=${FIXED}  rounds=${ROUNDS}`);
  console.log(`코호트: ${cohort.length}명 (${ORGS.join("/")} 각 ${PER_ORG}명) + 테스트유저 ${testIds.length}명`);

  // ── 케이스 구성 ──
  const cases: Case[] = [];
  const ik = { "x-internal-api-key": KEY };
  for (const c of cohort) {
    cases.push({ name: `internal ${c.org}`, path: `/api/cluster4/weekly-cards?userId=${c.userId}&mode=operating`, headers: ik });
    cases.push({ name: `internal+mode=test ${c.org}`, path: `/api/cluster4/weekly-cards?userId=${c.userId}&mode=test`, headers: ik });
    cases.push({ name: `internal+pageSlug ${c.org}`, path: `/api/cluster4/weekly-cards?userId=${c.userId}&pageSlug=cluster-4-${c.org}`, headers: ik });
  }
  for (const t of testIds) {
    cases.push({ name: "internal testuser", path: `/api/cluster4/weekly-cards?userId=${t}&mode=test`, headers: ik });
    cases.push({ name: "demoUserId", path: `/api/cluster4/weekly-cards?demoUserId=${t}`, headers: {} });
    cases.push({ name: "demoUserId+actAs", path: `/api/cluster4/weekly-cards?demoUserId=${t}&actAsTestUserId=${t}`, headers: {} });
  }
  // 실패 응답 contract
  cases.push({ name: "ERR no-auth", path: `/api/cluster4/weekly-cards?userId=${cohort[0]?.userId}`, headers: {} });
  cases.push({ name: "ERR internal no-userId", path: `/api/cluster4/weekly-cards`, headers: ik });
  cases.push({ name: "ERR bogus userId", path: `/api/cluster4/weekly-cards?userId=00000000-0000-0000-0000-000000000000`, headers: ik });
  cases.push({ name: "ERR malformed userId", path: `/api/cluster4/weekly-cards?userId=not-a-uuid`, headers: ik });
  cases.push({ name: "ERR bad pageSlug", path: `/api/cluster4/weekly-cards?userId=${cohort[0]?.userId}&pageSlug=cluster-4-entertainment`, headers: ik });
  cases.push({ name: "ERR bogus org", path: `/api/cluster4/weekly-cards?userId=${cohort[0]?.userId}&org=nope`, headers: ik });

  console.log(`케이스: ${cases.length}개 × ${ROUNDS}라운드 = ${cases.length * ROUNDS} 비교\n`);

  // ── 워밍업(양쪽 동일) ──
  await call(PRISTINE, cases[0]);
  await call(FIXED, cases[0]);

  let mismatches = 0;
  let compared = 0;
  const statusSeen = new Map<string, number>();
  const msP: number[] = [];
  const msF: number[] = [];
  const perCase = new Map<string, { p: number[]; f: number[] }>();

  for (let r = 0; r < ROUNDS; r++) {
    const fixedFirst = r % 2 === 1; // 라운드마다 순서 반전
    for (const c of cases) {
      const [a, b] = fixedFirst
        ? [await call(FIXED, c), await call(PRISTINE, c)]
        : [await call(PRISTINE, c), await call(FIXED, c)];
      const p = fixedFirst ? b : a;
      const f = fixedFirst ? a : b;
      compared++;
      statusSeen.set(`${c.name} → ${p.status}`, p.status);
      msP.push(p.ms);
      msF.push(f.ms);
      const e = perCase.get(c.name) ?? { p: [], f: [] };
      e.p.push(p.ms);
      e.f.push(f.ms);
      perCase.set(c.name, e);

      if (p.status !== f.status || p.body !== f.body) {
        mismatches++;
        console.log(`  ✗ MISMATCH r${r} [${c.name}]`);
        console.log(`      status  pristine=${p.status} fixed=${f.status}`);
        console.log(`      sha256  pristine=${p.sha} fixed=${f.sha}`);
        console.log(`      bytes   pristine=${p.body.length} fixed=${f.body.length}`);
        if (p.body !== f.body) {
          for (let i = 0; i < Math.max(p.body.length, f.body.length); i++) {
            if (p.body[i] !== f.body[i]) {
              console.log(`      first diff @${i}: …${p.body.slice(Math.max(0, i - 60), i + 60)}…`);
              console.log(`                        …${f.body.slice(Math.max(0, i - 60), i + 60)}…`);
              break;
            }
          }
        }
      }
    }
    process.stdout.write(`  round ${r + 1}/${ROUNDS} done (${fixedFirst ? "fixed-first" : "pristine-first"})\n`);
  }

  const med = (x: number[]) => [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)];
  const pct = (x: number[], q: number) => [...x].sort((a, b) => a - b)[Math.floor((x.length - 1) * q)];

  console.log(`\n${"═".repeat(80)}`);
  console.log("결과");
  console.log("═".repeat(80));
  console.log(`  비교 ${compared}건 · 불일치 ${mismatches}건 → ${mismatches === 0 ? "✅ byte-identical" : "❌ 회귀"}`);
  console.log(`\n  latency (전 케이스 혼합, 참고용):`);
  console.log(`    pristine p50=${med(msP).toFixed(0)}ms p95=${pct(msP, 0.95).toFixed(0)}ms`);
  console.log(`    fixed    p50=${med(msF).toFixed(0)}ms p95=${pct(msF, 0.95).toFixed(0)}ms`);

  console.log(`\n  케이스별 p50 (pristine → fixed):`);
  for (const [name, v] of [...perCase.entries()].sort()) {
    const a = med(v.p);
    const b = med(v.f);
    console.log(
      `    ${name.padEnd(30)} ${a.toFixed(0).padStart(5)}ms → ${b.toFixed(0).padStart(5)}ms  ${a > 0 ? `${(a / b).toFixed(2)}x` : ""}`,
    );
  }

  console.log(`\n  관측된 status (경로별 실제 실행 결과):`);
  for (const [k] of [...statusSeen.entries()].sort()) console.log(`    ${k}`);

  process.exit(mismatches === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
