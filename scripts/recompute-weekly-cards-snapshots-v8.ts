/**
 * v8 org 필터 즉시 반영: 4허브 weekly-card snapshot 재계산 + 조직별 노출 검증.
 *
 *   npx tsx --env-file=.env.local scripts/recompute-weekly-cards-snapshots-v8.ts
 *
 * 1) 기존 snapshot 중 stale / due / dto_version!=8(=v7 구캐시)을 전수 재계산(SoT 함수 재사용).
 * 2) 조직별 샘플 유저의 재계산된 snapshot.cards 를 읽어 라인 노출을 검증:
 *    - PHALANX → EC/OK 라인 0건, PX/BS·info 만
 *    - ENCRE   → OK/PX 라인 0건
 *    - ORANKE  → EC/PX 라인 0건
 *    - 과거 타 조직 라인이 stale 로 남지 않는지(재계산 후 lineCode 프리픽스로 확인)
 *
 * 검증은 DTO 의 lineCode 프리픽스(EC/OK/PX/BS)로 누수를 탐지한다. 라인 칸이 필터로 빠지면
 * not_applicable placeholder(lineId/lineCode=null)가 되므로, 외부 org 프리픽스가 하나라도
 * 남아 있으면 누수다.
 */
import { createClient } from "@supabase/supabase-js";
import { recomputeStaleOrDueSnapshots } from "@/lib/cluster4WeeklyCardsSnapshot";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";
import { parseLineCodeOrg, type LineOrgScope } from "@/lib/cluster4LineOrg";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SAMPLE_PER_ORG = 5;

type LineDto = { lineId: string | null; lineCode: string | null; partType: string };
type CardDto = { weekId: string | null; lines: LineDto[] };

async function recompute() {
  console.log(`════════ 1. snapshot 재계산 (목표 dto_version=${WEEKLY_CARDS_DTO_VERSION}) ════════`);
  // dueOlderThanMs=0 → 모든 기존 행을 due 로 간주(+ v7 은 version 불일치로도 잡힘). maxUsers 충분히 크게.
  const res = await recomputeStaleOrDueSnapshots({
    maxUsers: 100000,
    dueOlderThanMs: 0,
    concurrency: 4,
  });
  console.log(
    `  scanned=${res.scanned} recomputed=${res.recomputed} failed=${res.failed} (${res.durationMs}ms)`,
  );
  if (res.failed > 0) {
    console.log(`  ⚠ 실패 ${res.failed}건 (기존값 보존): ${res.failedUserIds.slice(0, 10).join(", ")}…`);
  }
  return res;
}

async function sampleUsersByOrg(org: OrganizationSlug): Promise<string[]> {
  // 해당 org 이고 snapshot 행이 있는 유저를 우선 샘플.
  const { data, error } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id, user_profiles!inner(organization_slug)")
    .eq("user_profiles.organization_slug", org)
    .limit(SAMPLE_PER_ORG);
  if (error) {
    console.log(`  ⚠ ${org} 샘플 조회 실패: ${error.message}`);
    return [];
  }
  return ((data ?? []) as { user_id: string }[]).map((r) => r.user_id);
}

async function readCards(userId: string): Promise<{ cards: CardDto[]; version: number; stale: boolean } | null> {
  const { data, error } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("cards, dto_version, is_stale")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { cards: unknown; dto_version: number; is_stale: boolean };
  return {
    cards: Array.isArray(row.cards) ? (row.cards as CardDto[]) : [],
    version: row.dto_version,
    stale: row.is_stale,
  };
}

// 사용자 org 기준 "노출되면 안 되는" 라인 org 집합.
function forbiddenOrgs(userOrg: OrganizationSlug): Set<LineOrgScope> {
  return new Set(ORGANIZATIONS.filter((o) => o !== userOrg) as LineOrgScope[]);
}

async function verify() {
  console.log("\n════════ 2. 조직별 노출 검증 (재계산된 snapshot) ════════");
  let leaks = 0;
  let usersChecked = 0;
  for (const org of ORGANIZATIONS) {
    const userIds = await sampleUsersByOrg(org);
    console.log(`\n  ── ORG=${org.toUpperCase()} 샘플 ${userIds.length}명 ──`);
    const forbidden = forbiddenOrgs(org);
    for (const uid of userIds) {
      const snap = await readCards(uid);
      if (!snap) {
        console.log(`   - ${uid.slice(0, 8)}: snapshot 없음`);
        continue;
      }
      usersChecked++;
      const seen = new Map<LineOrgScope, number>();
      const leakLines: string[] = [];
      for (const card of snap.cards) {
        for (const line of card.lines ?? []) {
          if (!line.lineCode) continue;
          const codeOrg = parseLineCodeOrg(line.lineCode);
          if (!codeOrg) continue;
          seen.set(codeOrg, (seen.get(codeOrg) ?? 0) + 1);
          if (forbidden.has(codeOrg)) {
            leakLines.push(`${line.partType}:${line.lineCode}`);
          }
        }
      }
      const seenStr = Array.from(seen.entries()).map(([o, n]) => `${o}×${n}`).join(" ") || "(org코드 라인 없음)";
      const staleFlag = snap.stale ? " ⚠STALE" : "";
      if (leakLines.length > 0) {
        leaks++;
        console.log(`   ❌ ${uid.slice(0, 8)} v${snap.version}${staleFlag}: 누수 ${leakLines.length}건 → ${leakLines.slice(0, 5).join(", ")} | 본:[${seenStr}]`);
      } else {
        console.log(`   ✅ ${uid.slice(0, 8)} v${snap.version}${staleFlag}: 누수 없음 | 노출 org:[${seenStr}]`);
      }
      if (snap.version !== WEEKLY_CARDS_DTO_VERSION) {
        console.log(`      ⚠ dto_version=${snap.version} (≠${WEEKLY_CARDS_DTO_VERSION}) — 재계산 누락 의심`);
      }
    }
  }
  console.log(`\n  검증 유저 ${usersChecked}명, 누수 유저 ${leaks}명.`);
  console.log(leaks === 0 ? "  ✅ 타 조직 라인 누수 없음." : "  ❌ 누수 발견 — 재확인 필요.");
  return leaks;
}

async function main() {
  await recompute();
  const leaks = await verify();
  process.exit(leaks === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
