/**
 * weekly-cards snapshot builder 의 membership/team/part 선택 규칙(고객앱 resolver) 수정 검증.
 *
 *   npx tsx --env-file=.env.local scripts/verify-membership-resolver-fix.ts ["이유나"] ["T홍지환"] …
 *
 * 검증 흐름(요청 6항목 1:1):
 *   1) DIRECT  : getCluster4WeeklyCardsForProfileUser(실시간 재계산) → card.teamName/partName/…
 *   2) HTTP    : /api/cluster4/weekly-cards 는 snapshot-only 패스스루이므로
 *                readWeeklyCardsSnapshot(=라우트 loadWeeklyCards 와 동일 소스) 결과로 검증.
 *                INTERNAL_API_KEY + 로컬 dev 서버가 있으면 실제 HTTP 도 시도.
 *   3) DIRECT == HTTP(snapshot) 동일성.
 *   4) snapshot 영향: 재계산 전 stored snapshot 의 team/part 가 틀렸는지.
 *   5) snapshot 재계산 필요 여부 + 실제 재계산.
 *   6) 재계산 후 stored snapshot == DIRECT (= 브라우저 표시값) 수렴 확인.
 *
 * 안전: 재계산(쓰기)은 "stored != direct" 인 대상에만 수행. 그 외는 읽기 전용.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

type MemRow = {
  team_name: string | null;
  part_name: string | null;
  membership_level: string | null;
  membership_state: string | null;
  is_current: boolean | null;
  updated_at: string | null;
};

// ── 현행(구) picker: is_current → updated_at (team_name 무시) ──
function pickOld(rows: MemRow[]): MemRow | undefined {
  return [...rows].sort((a, b) => {
    const cur = Number(Boolean(b.is_current)) - Number(Boolean(a.is_current));
    if (cur !== 0) return cur;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
}

// ── 수정(신) picker: 고객앱 resolver rank (team_name 보유 우선) ──
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

async function profilesByName(name: string) {
  const { data } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,current_team_name,current_part_name")
    .ilike("display_name", `%${name}%`)
    .limit(5);
  return (data ?? []) as {
    user_id: string;
    display_name: string | null;
    current_team_name: string | null;
    current_part_name: string | null;
  }[];
}

// 버그 패턴 자동 탐색: membership 행이 2개 이상이고 old-pick team != new-pick team 인 실사용자.
async function findAffectedRealUsers(limit: number): Promise<string[]> {
  // 멀티 membership 사용자만 후보. (단일 행이면 old==new)
  const { data } = await supabaseAdmin
    .from("user_memberships")
    .select("user_id,team_name,part_name,membership_level,membership_state,is_current,updated_at");
  const byUser = new Map<string, MemRow[]>();
  for (const r of (data ?? []) as (MemRow & { user_id: string })[]) {
    const list = byUser.get(r.user_id) ?? [];
    list.push(r);
    byUser.set(r.user_id, list);
  }
  const affected: string[] = [];
  for (const [uid, rows] of byUser) {
    if (rows.length < 2) continue;
    const o = pickOld(rows);
    const n = pickNew(rows);
    if ((o?.team_name ?? null) !== (n?.team_name ?? null)) affected.push(uid);
    if (affected.length >= limit) break;
  }
  return affected;
}

async function tryHttp(userId: string): Promise<{ team: string | null; part: string | null } | null> {
  const key = process.env.INTERNAL_API_KEY;
  const base = process.env.VERIFY_BASE_URL || "http://localhost:3000";
  if (!key) return null;
  try {
    const res = await fetch(`${base}/api/cluster4/weekly-cards?userId=${userId}`, {
      headers: { "x-internal-api-key": key },
    });
    if (!res.ok) {
      console.log(`     (HTTP ${res.status} — dev 서버/키 확인)`);
      return null;
    }
    const json = (await res.json()) as { data?: { teamName: string | null; partName: string | null }[] };
    const c = json.data?.[0];
    return c ? { team: c.teamName ?? null, part: c.partName ?? null } : { team: null, part: null };
  } catch {
    return null; // dev 서버 미기동 — snapshot 직접 비교로 충분.
  }
}

function firstCardTP(cards: { teamName?: string | null; partName?: string | null; roleLabel?: string | null; membershipStatusLabel?: string | null }[]) {
  const c = cards[0];
  return {
    team: c?.teamName ?? null,
    part: c?.partName ?? null,
    role: c?.roleLabel ?? null,
    state: c?.membershipStatusLabel ?? null,
  };
}

async function verifyUser(userId: string, label: string) {
  console.log(`\n================ ${label} (${userId}) ================`);

  const { data: memData } = await supabaseAdmin
    .from("user_memberships")
    .select("team_name,part_name,membership_level,membership_state,is_current,updated_at")
    .eq("user_id", userId);
  const rows = (memData ?? []) as MemRow[];
  console.log(`[user_memberships] ${rows.length} rows`);
  for (const r of rows) {
    console.log(
      `   - is_current=${r.is_current} team=${JSON.stringify(r.team_name)} part=${JSON.stringify(r.part_name)} level=${r.membership_level} state=${r.membership_state} updated=${r.updated_at}`,
    );
  }
  const o = pickOld(rows);
  const n = pickNew(rows);
  console.log(`   OLD pick → team=${o?.team_name ?? null} part=${o?.part_name ?? null}`);
  console.log(`   NEW pick → team=${n?.team_name ?? null} part=${n?.part_name ?? null}`);

  // (4) 재계산 전 stored snapshot.
  const before = await readWeeklyCardsSnapshot(userId);
  const beforeTP =
    before.status === "hit" || before.status === "stale"
      ? firstCardTP(before.cards as any)
      : null;
  console.log(`   [snapshot BEFORE] status=${before.status} team=${beforeTP?.team ?? "—"} part=${beforeTP?.part ?? "—"}`);

  // (1) DIRECT 실시간 재계산.
  let direct;
  try {
    direct = firstCardTP((await getCluster4WeeklyCardsForProfileUser(userId)) as any);
  } catch (e) {
    console.log(`   ❌ DIRECT 계산 실패: ${e instanceof Error ? e.message : String(e)}`);
    return { userId, label, recomputed: false, ok: false };
  }
  console.log(`   [DIRECT] team=${direct.team} part=${direct.part} role=${direct.role} state=${direct.state}`);

  // (5) 재계산 필요 판정: stored != direct → 재계산.
  const needsRecompute =
    !beforeTP || beforeTP.team !== direct.team || beforeTP.part !== direct.part;
  console.log(`   snapshot 재계산 필요? ${needsRecompute ? "YES" : "no (이미 일치)"}`);

  if (needsRecompute) {
    await recomputeAndStoreWeeklyCardsSnapshot(userId);
    console.log(`   → 재계산 완료(쓰기).`);
  }

  // (6) 재계산 후 stored snapshot == DIRECT?
  const after = await readWeeklyCardsSnapshot(userId);
  const afterTP =
    after.status === "hit" || after.status === "stale"
      ? firstCardTP(after.cards as any)
      : null;
  console.log(`   [snapshot AFTER] status=${after.status} team=${afterTP?.team ?? "—"} part=${afterTP?.part ?? "—"}`);

  // (2)(3) HTTP(snapshot-only 패스스루) == DIRECT?
  const http = await tryHttp(userId);
  if (http) {
    console.log(`   [HTTP /api/cluster4/weekly-cards] team=${http.team} part=${http.part}`);
  } else {
    console.log(`   [HTTP] 실제 호출 생략(INTERNAL_API_KEY/dev 서버 없음) — 라우트는 snapshot-only 패스스루이므로 [snapshot AFTER] 와 동일.`);
  }

  const httpTeam = http ? http.team : afterTP?.team ?? null;
  const httpPart = http ? http.part : afterTP?.part ?? null;
  const ok = httpTeam === direct.team && httpPart === direct.part;
  console.log(`   ✅ DIRECT == HTTP(snapshot)? ${ok ? "YES" : "NO ❌"}`);

  return { userId, label, recomputed: needsRecompute, ok };
}

async function main() {
  const args = process.argv.slice(2);
  const names = args.length ? args : ["이유나", "T홍지환"];

  const targets: { userId: string; label: string }[] = [];
  for (const name of names) {
    const ps = await profilesByName(name);
    if (!ps.length) console.log(`⚠ "${name}" 프로필 없음`);
    for (const p of ps.slice(0, 1)) {
      targets.push({ userId: p.user_id, label: p.display_name ?? name });
    }
  }

  // 팀/파트가 null 이던 나머지 실사용자 2명(버그 패턴 자동 탐색).
  const affected = await findAffectedRealUsers(10);
  const extra = affected.filter((id) => !targets.some((t) => t.userId === id)).slice(0, 2);
  for (const id of extra) {
    const { data } = await supabaseAdmin
      .from("user_profiles")
      .select("display_name")
      .eq("user_id", id)
      .maybeSingle();
    targets.push({ userId: id, label: `(자동탐색)${(data as any)?.display_name ?? id.slice(0, 8)}` });
  }

  console.log(`총 ${targets.length}명 검증 — old≠new 영향 실사용자 후보 ${affected.length}명 중 ${extra.length}명 포함.`);

  const results = [];
  for (const t of targets) {
    results.push(await verifyUser(t.userId, t.label));
  }

  console.log("\n════════════════ 요약 ════════════════");
  for (const r of results) {
    console.log(`  ${r.ok ? "✅" : "❌"} ${r.label} | 재계산=${r.recomputed} | DIRECT==HTTP=${r.ok}`);
  }
  const allOk = results.every((r) => r.ok);
  console.log(allOk ? "\n✅ 전원 DIRECT == HTTP(snapshot) 수렴." : "\n❌ 불일치 존재 — 추가 조사 필요.");
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
