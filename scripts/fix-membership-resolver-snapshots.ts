/**
 * 전수 스캔 + 보정: 저장된 weekly-cards snapshot 의 team/part 가 신규 고객앱 resolver 결과와
 * 다른(=구 picker 로 잘못 저장된) 사용자를 찾아 재계산한다.
 *
 *   탐색만:        npx tsx --env-file=.env.local scripts/fix-membership-resolver-snapshots.ts
 *   탐색+재계산:   npx tsx --env-file=.env.local scripts/fix-membership-resolver-snapshots.ts --apply
 *
 * "expected" = pickNew(membership rows).team ?? user_profiles.current_team_name (resolver 규칙 1~5).
 * stored snapshot 의 첫 카드 teamName/partName 과 비교해 mismatch 면 affected.
 * 재계산은 affected 에만 수행(읽기 비용으로 전체 스캔 → 쓰기는 영향분만).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

type MemRow = {
  user_id: string;
  team_name: string | null;
  part_name: string | null;
  is_current: boolean | null;
  updated_at: string | null;
};

function rank(r: MemRow): number {
  const cur = Boolean(r.is_current);
  const team = typeof r.team_name === "string" && r.team_name.trim() !== "";
  if (cur && team) return 0;
  if (team) return 1;
  if (cur) return 2;
  return 3;
}
function pickNew(rows: MemRow[]): MemRow | undefined {
  return [...rows].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
}
function pref(...v: Array<string | null | undefined>): string | null {
  for (const x of v) if (typeof x === "string" && x.trim() !== "") return x;
  return null;
}

async function main() {
  const apply = process.argv.includes("--apply");

  // 1) 모든 snapshot (user_id + 첫 카드 team/part).
  const { data: snaps, error: snapErr } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,cards");
  if (snapErr) throw new Error(snapErr.message);
  const storedByUser = new Map<string, { team: string | null; part: string | null }>();
  for (const s of (snaps ?? []) as { user_id: string; cards: unknown }[]) {
    const c0 = Array.isArray(s.cards) ? (s.cards[0] as any) : null;
    storedByUser.set(s.user_id, {
      team: c0?.teamName ?? null,
      part: c0?.partName ?? null,
    });
  }
  const userIds = [...storedByUser.keys()];
  console.log(`snapshot 보유 사용자 ${userIds.length}명 스캔.`);

  // 2) membership rows + profile current_* 일괄 로드.
  const { data: mems } = await supabaseAdmin
    .from("user_memberships")
    .select("user_id,team_name,part_name,is_current,updated_at");
  const memByUser = new Map<string, MemRow[]>();
  for (const r of (mems ?? []) as MemRow[]) {
    const l = memByUser.get(r.user_id) ?? [];
    l.push(r);
    memByUser.set(r.user_id, l);
  }
  const { data: profs } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,current_team_name,current_part_name");
  const profByUser = new Map<string, { name: string | null; ct: string | null; cp: string | null }>();
  for (const p of (profs ?? []) as any[]) {
    profByUser.set(p.user_id, {
      name: p.display_name ?? null,
      ct: p.current_team_name ?? null,
      cp: p.current_part_name ?? null,
    });
  }

  // 3) expected(신 resolver) vs stored 비교.
  const affected: { userId: string; name: string | null; stored: any; expected: any }[] = [];
  for (const uid of userIds) {
    const rows = memByUser.get(uid) ?? [];
    const prof = profByUser.get(uid);
    const picked = pickNew(rows);
    const expTeam = pref(picked?.team_name, prof?.ct);
    const expPart = pref(picked?.part_name, prof?.cp);
    const stored = storedByUser.get(uid)!;
    // expected 가 산출 가능한데(non-null) stored 가 다르면 affected.
    const teamMismatch = expTeam !== null && stored.team !== expTeam;
    const partMismatch = expPart !== null && stored.part !== expPart;
    if (teamMismatch || partMismatch) {
      affected.push({
        userId: uid,
        name: prof?.name ?? null,
        stored,
        expected: { team: expTeam, part: expPart },
      });
    }
  }

  console.log(`\n영향(stored ≠ 신 resolver) 사용자: ${affected.length}명`);
  for (const a of affected) {
    console.log(
      `   - ${a.name ?? a.userId.slice(0, 8)} (${a.userId.slice(0, 8)}): stored[team=${a.stored.team} part=${a.stored.part}] → expected[team=${a.expected.team} part=${a.expected.part}]`,
    );
  }

  if (!apply) {
    console.log(`\n(탐색 전용. 재계산하려면 --apply 추가.)`);
    process.exit(0);
  }

  console.log(`\n──── 재계산(쓰기) 시작: ${affected.length}명 ────`);
  let ok = 0;
  const failed: string[] = [];
  for (const a of affected) {
    try {
      await recomputeAndStoreWeeklyCardsSnapshot(a.userId);
      ok++;
    } catch (e) {
      failed.push(a.userId);
      console.log(`   ❌ ${a.userId.slice(0, 8)} 재계산 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n재계산 완료: 성공 ${ok}명 / 실패 ${failed.length}명.`);

  // 4) 재검증: 재계산 후 stored 다시 읽어 expected 와 일치하는지.
  const { data: snaps2 } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,cards")
    .in("user_id", affected.map((a) => a.userId));
  const after = new Map<string, { team: string | null; part: string | null }>();
  for (const s of (snaps2 ?? []) as { user_id: string; cards: unknown }[]) {
    const c0 = Array.isArray(s.cards) ? (s.cards[0] as any) : null;
    after.set(s.user_id, { team: c0?.teamName ?? null, part: c0?.partName ?? null });
  }
  let resolved = 0;
  for (const a of affected) {
    const af = after.get(a.userId);
    if (af && af.team === a.expected.team && af.part === a.expected.part) resolved++;
    else console.log(`   ⚠ ${a.userId.slice(0, 8)} 재계산 후에도 불일치: ${JSON.stringify(af)} vs ${JSON.stringify(a.expected)}`);
  }
  console.log(`재검증: ${resolved}/${affected.length}명 일치.`);
  process.exit(resolved === affected.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
