/**
 * diag-demo-vs-direct-divergence.ts  (READ-ONLY — write 0, 재계산 0)
 *
 * 목적: /admin/test-users(demoUserId) 진입과 Vercel 직접 진입의 주차카드 표시값 divergence 진단.
 *   snapshot-only 구조에서 다음을 한 테스트 유저에 대해 비교한다:
 *     (A) direct function (normal)      = getCluster4WeeklyCardsForProfileUser(uid)            ← snapshot 의 SoT
 *     (B) snapshot 저장본 (readWeeklyCardsSnapshot)                                            ← HTTP no-mode 가 반환
 *     (C) direct function (mode=test)   = ...({ effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM })
 *     (D) HTTP  no-mode   GET /api/cluster4/weekly-cards?demoUserId=<uid>
 *     (E) HTTP  mode=test GET /api/cluster4/weekly-cards?demoUserId=<uid>&mode=test
 *
 *   판정:
 *     · A == B  → snapshot 이 fresh(SoT 와 일치). 다르면 snapshot stale/version_mismatch.
 *     · B == D  → HTTP(snapshot 경로) 가 저장본을 그대로 반환(분기 없음).
 *     · C == E  → HTTP(test 경로) 가 live summer-sim 을 그대로 반환.
 *     · D vs E  → 두 진입경로(mode 유무)의 실제 divergence 크기(핵심).
 *
 * 실행: npx tsx --env-file=.env.local scripts/diag-demo-vs-direct-divergence.ts [userId]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { TEST_SUMMER_SIM_EFFECTIVE_FROM } from "@/lib/lineAvailability";
import {
  WEEKLY_CARDS_DTO_VERSION,
  readWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? "";

// 카드 비교용 안정 키 — 표시에 영향 주는 핵심 필드만 추려 주차별로 직렬화한다.
function cardFingerprint(c: Cluster4WeeklyCardDto): Record<string, unknown> {
  return {
    weekNumber: c.weekNumber,
    seasonKey: (c as Record<string, unknown>).seasonKey ?? null,
    resultStatus: (c as Record<string, unknown>).resultStatus ?? null,
    statusLabel: (c as Record<string, unknown>).statusLabel ?? null,
    teamName: c.teamName ?? null,
    partName: c.partName ?? null,
    roleLabel: (c as Record<string, unknown>).roleLabel ?? null,
    points: c.points ?? null,
    cumulativeInjeolmi: (c as Record<string, unknown>).cumulativeInjeolmi ?? null,
    growth: `${(c as Record<string, unknown>).growthNumerator ?? "?"}/${(c as Record<string, unknown>).growthDenominator ?? "?"}`,
    weeklyGrowthRate: (c as Record<string, unknown>).weeklyGrowthRate ?? null,
    lineCount: Array.isArray(c.lines) ? c.lines.length : 0,
    lines: (Array.isArray(c.lines) ? c.lines : []).map((l) => ({
      partType: l.partType,
      lineCode: (l as Record<string, unknown>).lineCode ?? null,
      numerator: (l as Record<string, unknown>).numerator ?? null,
      denominator: (l as Record<string, unknown>).denominator ?? null,
      enhancementStatus: (l as Record<string, unknown>).enhancementStatus ?? null,
    })),
  };
}

function diffCards(
  labelL: string,
  L: Cluster4WeeklyCardDto[],
  labelR: string,
  R: Cluster4WeeklyCardDto[],
): { same: boolean; lines: string[] } {
  const out: string[] = [];
  const byWeekL = new Map(L.map((c) => [c.weekNumber, c]));
  const byWeekR = new Map(R.map((c) => [c.weekNumber, c]));
  const weeks = Array.from(
    new Set([...byWeekL.keys(), ...byWeekR.keys()]),
  ).sort((a, b) => (b ?? 0) - (a ?? 0));
  let diffs = 0;
  out.push(`  카드 수: ${labelL}=${L.length}  ${labelR}=${R.length}`);
  for (const w of weeks) {
    const cl = byWeekL.get(w);
    const cr = byWeekR.get(w);
    if (!cl) { out.push(`  W${w}: ${labelL}에 없음`); diffs++; continue; }
    if (!cr) { out.push(`  W${w}: ${labelR}에 없음`); diffs++; continue; }
    const fl = JSON.stringify(cardFingerprint(cl));
    const fr = JSON.stringify(cardFingerprint(cr));
    if (fl !== fr) {
      diffs++;
      out.push(`  W${w}: DIFF`);
      out.push(`     ${labelL}: ${fl}`);
      out.push(`     ${labelR}: ${fr}`);
    }
  }
  return { same: diffs === 0, lines: out };
}

async function httpCards(qs: string): Promise<{ status: number; cards: Cluster4WeeklyCardDto[]; raw: unknown }> {
  const res = await fetch(`${BASE}/api/cluster4/weekly-cards${qs}`, {
    headers: { "x-internal-api-key": INTERNAL_KEY },
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, cards: (json?.data ?? []) as Cluster4WeeklyCardDto[], raw: json };
}

async function pickTestUser(explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  const markers = ((await sb.from("test_user_markers").select("user_id")).data ?? []).map(
    (x: { user_id: string }) => x.user_id,
  );
  if (markers.length === 0) return null;
  // snapshot 보유 + 카드가 실제로 있는 테스트 유저 우선.
  const { data: snaps } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,card_count")
    .in("user_id", markers.slice(0, 500))
    .order("card_count", { ascending: false })
    .limit(1);
  return snaps?.[0]?.user_id ?? markers[0];
}

async function main() {
  const explicit = process.argv[2];
  const uid = await pickTestUser(explicit);
  if (!uid) { console.log("테스트 유저 없음 — 중단"); process.exit(2); }

  const prof = (await sb.from("user_profiles").select("display_name,organization_slug").eq("user_id", uid).maybeSingle()).data;
  console.log(`\n=== 대상 테스트 유저 ===`);
  console.log(`  userId = ${uid}`);
  console.log(`  name   = ${prof?.display_name ?? "?"}   org = ${prof?.organization_slug ?? "?"}`);
  console.log(`  DTO_VERSION(현재) = ${WEEKLY_CARDS_DTO_VERSION}`);
  console.log(`  INTERNAL_KEY 설정 = ${INTERNAL_KEY ? "예" : "아니오"}\n`);

  // ── snapshot 메타
  const snapRow = (await sb
    .from("cluster4_weekly_card_snapshots")
    .select("dto_version,is_stale,computed_at,card_count")
    .eq("user_id", uid)
    .maybeSingle()).data;
  console.log(`=== snapshot 행 메타 ===`);
  console.log(`  ${JSON.stringify(snapRow)}\n`);

  // ── (A) direct normal / (B) snapshot 저장본 / (C) direct mode=test
  const A = await getCluster4WeeklyCardsForProfileUser(uid);
  const snapOutcome = await readWeeklyCardsSnapshot(uid);
  const B = "cards" in snapOutcome ? snapOutcome.cards : [];
  const C = await getCluster4WeeklyCardsForProfileUser(uid, {
    effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM,
  });
  console.log(`=== snapshot readOutcome.status = ${snapOutcome.status}${"reason" in snapOutcome ? `(${snapOutcome.reason})` : ""} ===\n`);

  // ── (D) HTTP no-mode / (E) HTTP mode=test
  const D = await httpCards(`?demoUserId=${uid}`);
  const E = await httpCards(`?demoUserId=${uid}&mode=test`);
  console.log(`=== HTTP status: no-mode=${D.status}  mode=test=${E.status} ===\n`);

  const checks: Array<{ label: string; r: { same: boolean; lines: string[] } }> = [
    { label: "[A direct-normal] vs [B snapshot 저장본]  (snapshot freshness)", r: diffCards("A:direct", A, "B:snap", B) },
    { label: "[B snapshot 저장본] vs [D HTTP no-mode]    (HTTP=snapshot 무분기)", r: diffCards("B:snap", B, "D:http", D.cards) },
    { label: "[C direct-summer-sim] vs [E HTTP mode=test] (HTTP test=live 무분기)", r: diffCards("C:directT", C, "E:httpT", E.cards) },
    { label: "[D HTTP no-mode] vs [E HTTP mode=test]      ★두 진입경로 divergence", r: diffCards("D:http", D.cards, "E:httpT", E.cards) },
  ];

  console.log(`============== 비교 결과 ==============`);
  let allCore = true;
  for (const c of checks) {
    const core = !c.label.includes("★"); // ★ 는 의도된 divergence 일 수 있어 통과 집계 제외
    const mark = c.r.same ? "✓ 동일" : "✗ 다름";
    console.log(`\n${mark}  ${c.label}`);
    for (const l of c.r.lines) console.log(l);
    if (core && !c.r.same) allCore = false;
  }

  console.log(`\n============== 요약 ==============`);
  console.log(`  A==B (snapshot fresh)      : ${checks[0].r.same ? "예" : "아니오 → snapshot stale/version_mismatch"}`);
  console.log(`  B==D (HTTP=snapshot)       : ${checks[1].r.same ? "예" : "아니오 → 조회경로 분기 의심"}`);
  console.log(`  C==E (HTTP test=live)      : ${checks[2].r.same ? "예" : "아니오"}`);
  console.log(`  D vs E (mode 유무 divergence): ${checks[3].r.same ? "동일(영향 없음)" : "다름 ← 진입경로별 mode 차이가 표시값 차이의 원인"}`);
  console.log(`\n  핵심 결론: 두 진입경로가 다르게 보이는 이유는 = ${checks[3].r.same ? "mode 외 다른 요인(snapshot stale 등)" : "한쪽이 mode=test(live summer-sim), 다른쪽이 snapshot 이기 때문"}`);
  process.exit(allCore ? 0 : 1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
