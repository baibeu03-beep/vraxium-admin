/** 팀장/앰배서더 관리(5) 슬롯 게이트 수정 검증 + 스냅샷 수렴.
 *  - direct(getCluster4WeeklyCardsForProfileUser, role-aware 게이트) vs 저장 snapshot(HTTP 서빙 원천) 비교
 *  - canonical(키정렬) 비교로 변경 사용자/주차/슬롯 식별
 *  - --apply 시 변경 사용자 snapshot 재계산 후 direct==snapshot 재검증
 *  run:  tsx --env-file=.env.local scripts/verify-team-leader-management-snapshot.ts [--apply]
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";
import { fetchManagementSlotOpen } from "@/lib/lineAvailability";

const APPLY = process.argv.includes("--apply");

// 재귀 키 정렬 canonical 직렬화 (Postgres jsonb 키 순서 미보존 대응)
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.keys(o).sort().reduce((acc, k) => {
      acc[k] = canonical(o[k]);
      return acc;
    }, {} as Record<string, unknown>);
  }
  return v;
}
const eq = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// 관리(5) 슬롯 라인 상태 요약(주차별)
function mgmtSummary(cards: any[]): string {
  const parts: string[] = [];
  for (const c of cards ?? []) {
    const lines = (c.lines ?? []).filter((l: any) => l.experienceSlotOrder === 5 || l.experienceCategory === "management");
    if (lines.length === 0) continue;
    const st = lines.map((l: any) => l.enhancementStatus ?? l.status ?? "?").join(",");
    parts.push(`${c.periodLabel ?? c.weekId?.slice(0, 8)}:${st}`);
  }
  return parts.join(" | ") || "(관리 라인 없음)";
}

async function main() {
  const { data: profs } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, display_name, role, organization_slug")
    .in("role", ["team_leader", "ambassador"]);
  const rows = profs ?? [];

  const changed: string[] = [];
  let snapMissing = 0, noChange = 0, computeErr = 0;

  for (const p of rows) {
    const gateOpen = await fetchManagementSlotOpen(p.user_id);
    let direct: any[];
    try {
      direct = await getCluster4WeeklyCardsForProfileUser(p.user_id);
    } catch (e: any) {
      computeErr++;
      console.log(`  [compute-err] ${p.display_name} (${p.role}): ${e?.message ?? e}`);
      continue;
    }
    const snap = await readWeeklyCardsSnapshot(p.user_id);
    if (snap.status === "miss") {
      snapMissing++;
      console.log(`  [snap-miss] ${p.display_name} (${p.role}/${p.organization_slug}) gateOpen=${gateOpen} — 스냅샷 없음(미생성)`);
      continue;
    }
    const stored = (snap as any).cards ?? [];
    if (eq(direct, stored)) {
      noChange++;
      continue;
    }
    changed.push(p.user_id);
    console.log(`  [CHANGED] ${p.display_name} (${p.role}/${p.organization_slug}) gateOpen=${gateOpen} snap=${snap.status}`);
    console.log(`     stored mgmt: ${mgmtSummary(stored)}`);
    console.log(`     direct mgmt: ${mgmtSummary(direct)}`);
  }

  console.log(`\n대상 운영진(팀장/앰배서더): ${rows.length} | 변경=${changed.length} 무변경=${noChange} 스냅없음=${snapMissing} 계산오류=${computeErr}`);

  if (APPLY && changed.length > 0) {
    console.log(`\n=== --apply: ${changed.length}명 snapshot 재계산 ===`);
    let ok = 0, mismatch = 0;
    for (const uid of changed) {
      await recomputeAndStoreWeeklyCardsSnapshot(uid);
      const direct = await getCluster4WeeklyCardsForProfileUser(uid);
      const snap = await readWeeklyCardsSnapshot(uid);
      const stored = (snap as any).cards ?? [];
      const match = snap.status === "hit" && eq(direct, stored);
      if (match) ok++; else { mismatch++; console.log(`  [재검증 불일치] ${uid} status=${snap.status}`); }
    }
    console.log(`재계산 후 direct==snapshot(hit): ok=${ok} mismatch=${mismatch}`);
  } else if (changed.length > 0) {
    console.log(`(dry-run) --apply 로 ${changed.length}명 재계산 필요`);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
