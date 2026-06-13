/**
 * v11 일괄 재계산 후 정합성 검증 (2026-06-04).
 *
 *   npx tsx --env-file=.env.local scripts/verify-v11-snapshot-consistency.ts
 *
 * snapshot 보유 유저 중 실사용자 3명 + 테스트(T) 3명을 뽑아, 각각:
 *   1) snapshot read = hit (v11, 비-stale)
 *   2) direct(getCluster4WeeklyCardsForProfileUser) == snapshot (정책 핵심 축)
 *   3) snapshot == HTTP(GET /api/cluster4/weekly-cards — snapshot-only 경로)
 * 재계산은 하지 않는다 — 일괄 재계산이 저장한 snapshot 그대로 검증(read-only).
 */
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  readWeeklyCardsSnapshot,
  WEEKLY_CARDS_DTO_VERSION,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

const TABLE = "cluster4_weekly_card_snapshots";

// 정책 핵심 축만 비교 (verify-cluster4-line-open-policy-v11.ts 의 lineKey 와 동일 기준).
// canEdit 등 시간 민감 필드 제외.
function lineKey(card: Cluster4WeeklyCardDto): string {
  return JSON.stringify(
    card.lines.map((l) => ({
      p: l.partType,
      s: l.status,
      e: l.enhancementStatus,
      sub: l.submissionStatus,
      slot: l.experienceSlotOrder,
      n: l.numerator,
      d: l.denominator,
      r: l.rate,
      lt: l.lineTargetId,
    })),
  );
}

function cardKey(c: Cluster4WeeklyCardDto): string {
  return `${c.userWeekStatus}|${c.growthNumerator}/${c.growthDenominator}@${c.weeklyGrowthRate}|${lineKey(c)}`;
}

function compare(
  labelA: string,
  a: Cluster4WeeklyCardDto[],
  labelB: string,
  b: Cluster4WeeklyCardDto[],
): number {
  const byStartB = new Map(b.map((c) => [c.startDate, c]));
  let mismatches = 0;
  if (a.length !== b.length) {
    console.log(`    ✗ 카드 수 불일치: ${labelA}=${a.length} vs ${labelB}=${b.length}`);
    mismatches++;
  }
  for (const ca of a) {
    const cb = byStartB.get(ca.startDate);
    if (!cb) {
      console.log(`    ✗ ${ca.startDate}: ${labelB} 에 카드 없음`);
      mismatches++;
      continue;
    }
    if (cardKey(ca) !== cardKey(cb)) {
      console.log(`    ✗ ${ca.startDate} 불일치 (${labelA} vs ${labelB})`);
      mismatches++;
    }
  }
  return mismatches;
}

async function fetchHttp(userId: string): Promise<Cluster4WeeklyCardDto[]> {
  const key = process.env.INTERNAL_API_KEY;
  if (!key) throw new Error("INTERNAL_API_KEY 미설정");
  const res = await fetch(
    `http://localhost:3000/api/cluster4/weekly-cards?userId=${encodeURIComponent(userId)}`,
    { headers: { "x-internal-api-key": key } },
  );
  const body = (await res.json()) as {
    success: boolean;
    data: Cluster4WeeklyCardDto[];
    error: unknown;
  };
  if (!res.ok || !body.success) {
    throw new Error(`HTTP 실패 status=${res.status} error=${JSON.stringify(body.error)}`);
  }
  return body.data;
}

async function pickUsers(): Promise<{ real: { id: string; name: string }[]; test: { id: string; name: string }[] }> {
  const { data: snaps } = await supabaseAdmin.from(TABLE).select("user_id");
  const snapIds = ((snaps ?? []) as { user_id: string }[]).map((r) => r.user_id);

  // 라인 타깃 보유 유저 우선 (비교가 의미 있는 카드).
  const { data: tgts } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("target_mode", "user")
    .not("target_user_id", "is", null)
    .limit(3000);
  const targetCnt = new Map<string, number>();
  for (const t of (tgts ?? []) as { target_user_id: string }[]) {
    targetCnt.set(t.target_user_id, (targetCnt.get(t.target_user_id) ?? 0) + 1);
  }

  const [{ data: profs }, testSet] = await Promise.all([
    supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name")
      .in("user_id", snapIds),
    fetchTestUserMarkerIds(), // 테스트 유저 판정 SoT = test_user_markers (이름 휴리스틱 폐기).
  ]);
  const rows = ((profs ?? []) as { user_id: string; display_name: string | null }[])
    .map((p) => ({
      id: p.user_id,
      name: p.display_name ?? "(이름 없음)",
      isTest: testSet.has(p.user_id),
      targets: targetCnt.get(p.user_id) ?? 0,
    }))
    .sort((x, y) => y.targets - x.targets);

  const real = rows.filter((r) => !r.isTest).slice(0, 3);
  const test = rows.filter((r) => r.isTest).slice(0, 3);
  return { real, test };
}

async function verifyUser(
  kind: string,
  u: { id: string; name: string },
): Promise<boolean> {
  console.log(`\n▸ [${kind}] ${u.name} (${u.id})`);

  // 1) snapshot read = hit(v11, 비-stale)
  const snap = await readWeeklyCardsSnapshot(u.id);
  if (snap.status !== "hit") {
    console.log(`    ✗ snapshot 상태=${snap.status} (hit/v${WEEKLY_CARDS_DTO_VERSION} 이어야 함)`);
    return false;
  }
  console.log(`    snapshot=hit cards=${snap.cards.length} computedAt=${snap.computedAt}`);

  // 2) direct == snapshot
  const direct = await getCluster4WeeklyCardsForProfileUser(u.id);
  const m1 = compare("direct", direct, "snapshot", snap.cards);
  console.log(`    direct == snapshot → 불일치 ${m1}건`);

  // 3) snapshot == HTTP
  const http = await fetchHttp(u.id);
  const m2 = compare("snapshot", snap.cards, "http", http);
  console.log(`    snapshot == HTTP   → 불일치 ${m2}건`);

  return m1 === 0 && m2 === 0;
}

async function main() {
  const { real, test } = await pickUsers();
  console.log(
    `대상 — 실사용자: ${real.map((r) => r.name).join(", ")} / 테스트: ${test.map((r) => r.name).join(", ")}`,
  );
  let pass = true;
  for (const u of real) pass = (await verifyUser("실사용자", u)) && pass;
  for (const u of test) pass = (await verifyUser("테스트", u)) && pass;
  console.log(`\n결과: ${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
