// 26봄 PX 위즈덤 info 라인 output_link 교체에 따른 weekly-card snapshot 영향 분석 + 재계산.
//
//  1) 영향 대상 = 각 라인의 collectLineOrgAudience(org 노출 전원) ∪ user-target 크루. 합집합.
//  2) 재계산 전: 대상 snapshot 의 cards JSON 에 OLD url(유튜브)이 박혀 있는지 스캔 → 영향 여부.
//  3) invalidateWeeklyCardsForUsers(합집합) → 즉시/백그라운드 recompute.
//  4) 재계산 후: OLD url 0 / NEW url(카페) 반영 재스캔.
//
// 실행: npx tsx --env-file=.env.local scripts/recompute-wisdom-px-snapshots.ts [--apply]

import { createClient } from "@supabase/supabase-js";
import { collectLineOrgAudience } from "../lib/adminCluster4LinesData";
import { recomputeWeeklyCardsSnapshotsForUsers } from "../lib/cluster4WeeklyCardsSnapshot";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

const APPLY = process.argv.includes("--apply");
const SNAP_TABLE = "cluster4_weekly_card_snapshots";

const LINES: Array<{ week: number; lineId: string; oldUrl: string; newUrl: string }> = [
  { week: 1, lineId: "9ded1835-6987-41cd-b588-6672bf65c0e4", oldUrl: "https://www.youtube.com/watch?v=oS23Z3iAvp8", newUrl: "https://cafe.naver.com/phalanx/8440" },
  { week: 2, lineId: "c315b4a6-497e-498a-b6ed-f1d267cce6a2", oldUrl: "https://www.youtube.com/watch?v=XD98WZG8dRU", newUrl: "https://cafe.naver.com/phalanx/8530" },
  { week: 3, lineId: "cd5c3e8c-7920-4c1e-8bfd-508043509889", oldUrl: "https://www.youtube.com/watch?v=Sh002SyAm3c", newUrl: "https://cafe.naver.com/phalanx/8615" },
  { week: 4, lineId: "61579d75-e7fa-4090-ac8f-0225acac518d", oldUrl: "https://www.youtube.com/watch?v=to-VGHAxdaY", newUrl: "https://cafe.naver.com/phalanx/8716" },
  { week: 5, lineId: "b1046d2c-3c1a-4730-ab23-547d925e04af", oldUrl: "https://www.youtube.com/watch?v=4wUzCawJmMI", newUrl: "https://cafe.naver.com/phalanx/8808" },
  { week: 9, lineId: "dc7ccffc-6d44-429b-8268-b4b601b6fb78", oldUrl: "https://www.youtube.com/watch?v=KRjskY2HDrg", newUrl: "https://cafe.naver.com/phalanx/8941" },
  { week: 10, lineId: "fd7f9c1b-f8ef-4d8a-a3a6-b1b40e00b124", oldUrl: "https://www.youtube.com/watch?v=g-12S5dFldY", newUrl: "https://cafe.naver.com/phalanx/9014" },
  { week: 11, lineId: "b1eb989e-b853-4c5d-87a4-80c01ae91171", oldUrl: "https://www.youtube.com/watch?v=L3E-4X0x54E", newUrl: "https://cafe.naver.com/phalanx/9106" },
  { week: 12, lineId: "967d5278-bb45-4f29-b1da-9c36812c6d0c", oldUrl: "https://www.youtube.com/watch?v=nhmEbI0ujek", newUrl: "https://cafe.naver.com/phalanx/9208" },
  { week: 13, lineId: "a4e60985-6148-40a9-a2a5-e8f9af9bd537", oldUrl: "https://www.youtube.com/watch?v=Q1wxAVEqKJE", newUrl: "https://cafe.naver.com/phalanx/9288" },
];

const ALL_OLD = LINES.map((l) => l.oldUrl);
const ALL_NEW = LINES.map((l) => l.newUrl);

async function targetUserIds(lineId: string): Promise<string[]> {
  const { data } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("line_id", lineId)
    .eq("target_mode", "user");
  return ((data ?? []) as Array<{ target_user_id: string | null }>)
    .map((r) => r.target_user_id)
    .filter((u): u is string => Boolean(u));
}

// 대상 user 들의 snapshot cards JSON 텍스트에서 url 셋 등장 횟수(사용자 수 기준) 집계.
async function scanSnapshots(userIds: string[], urls: string[]): Promise<{ usersWithAny: number; matchCounts: Record<string, number>; scanned: number; impactedUserIds: string[] }> {
  const matchCounts: Record<string, number> = Object.fromEntries(urls.map((u) => [u, 0]));
  const impactedUserIds: string[] = [];
  let scanned = 0;
  const CHUNK = 50;
  for (let i = 0; i < userIds.length; i += CHUNK) {
    const chunk = userIds.slice(i, i + CHUNK);
    const { data, error } = await sb
      .from(SNAP_TABLE)
      .select("user_id,cards")
      .in("user_id", chunk);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ user_id: string; cards: unknown }>) {
      scanned += 1;
      const text = JSON.stringify(r.cards ?? null);
      let any = false;
      for (const u of urls) {
        if (text.includes(u)) {
          matchCounts[u] += 1;
          any = true;
        }
      }
      if (any) impactedUserIds.push(r.user_id);
    }
  }
  return { usersWithAny: impactedUserIds.length, matchCounts, scanned, impactedUserIds };
}

async function main() {
  console.log(`=== recompute-wisdom-px-snapshots (${APPLY ? "APPLY" : "DRY-RUN"}) ===\n`);

  // 1) 영향 대상 합집합
  const affected = new Set<string>();
  const perLine: Array<{ week: number; lineId: string; audience: number; targets: number }> = [];
  for (const l of LINES) {
    const audience = await collectLineOrgAudience(l.lineId);
    const targets = await targetUserIds(l.lineId);
    audience.forEach((u) => affected.add(u));
    targets.forEach((u) => affected.add(u));
    perLine.push({ week: l.week, lineId: l.lineId, audience: audience.length, targets: targets.length });
  }
  const affectedIds = Array.from(affected);
  console.log("── 라인별 영향 대상 ──");
  for (const p of perLine) {
    console.log(`  W${p.week} ${p.lineId}  orgAudience=${p.audience}  userTargets=${p.targets}`);
  }
  console.log(`\n합집합 영향 대상(snapshot 보유 가능): ${affectedIds.length}명\n`);

  // 2) 재계산 전 OLD url 스캔 → 실제로 OLD url 이 박힌 사용자(정확한 재계산 대상) 산출
  const before = await scanSnapshots(affectedIds, ALL_OLD);
  console.log("── 재계산 전: snapshot cards 에 OLD(유튜브) url 잔존 ──");
  console.log(`  스캔된 snapshot 행: ${before.scanned}`);
  console.log(`  OLD url 1개 이상 포함 사용자: ${before.usersWithAny}`);
  for (const l of LINES) {
    const c = before.matchCounts[l.oldUrl];
    if (c > 0) console.log(`    W${l.week} OLD ${l.oldUrl} → ${c} snapshots`);
  }
  const beforeNew = await scanSnapshots(affectedIds, ALL_NEW);
  console.log(`  (참고) 재계산 전 NEW(카페) url 포함 사용자: ${beforeNew.usersWithAny}`);

  // 재계산 대상 = OLD url 이 실제로 박힌 사용자(이 라인 변경이 보이는 카드 보유자). 그 외 audience 는
  //   이 라인 output_link 를 카드에 노출하지 않으므로(변경 무관) 재계산 불필요.
  const recomputeTargets = before.impactedUserIds;
  console.log(`\n→ snapshot 영향 여부: ${before.usersWithAny > 0 ? "YES" : "NO"} (OLD url 보유 ${before.usersWithAny}명)`);
  console.log(`→ snapshot 재계산 필요 여부: ${recomputeTargets.length > 0 ? "YES" : "NO"} (재계산 대상 ${recomputeTargets.length}명)`);

  if (!APPLY) {
    console.log("\nDRY-RUN: 재계산 미실행. --apply 로 recomputeWeeklyCardsSnapshotsForUsers 실행.");
    return;
  }

  // 3) 재계산 — 영향 사용자만 동기 재계산(>10 이라도 cron/after 의존 없이 즉시 반영).
  console.log("\n── recomputeWeeklyCardsSnapshotsForUsers 실행(동기, concurrency=4) ──");
  const res = await recomputeWeeklyCardsSnapshotsForUsers(recomputeTargets, { concurrency: 2 });
  console.log(`  requested=${res.requested} recomputed=${res.recomputed} failed=${res.failed}`);
  if (res.failed > 0) console.log(`  failedUserIds=${res.failedUserIds.join(",")}`);

  // 4) 재계산 후 스캔(영향 사용자 + 전체 audience 둘 다)
  const afterOld = await scanSnapshots(affectedIds, ALL_OLD);
  const afterNew = await scanSnapshots(affectedIds, ALL_NEW);
  console.log("\n── 재계산 후 (전체 audience 재스캔) ──");
  console.log(`  OLD url 포함 사용자: ${afterOld.usersWithAny} (기대 0)`);
  console.log(`  NEW url 포함 사용자: ${afterNew.usersWithAny}`);
  for (const l of LINES) {
    const c = afterNew.matchCounts[l.newUrl];
    if (c > 0) console.log(`    W${l.week} NEW ${l.newUrl} → ${c} snapshots`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
