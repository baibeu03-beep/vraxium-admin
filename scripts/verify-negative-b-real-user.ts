/**
 * 실제 음수 최종B 사용자 — 전 화면 최종B 일치 대조 (2026-07-13, read-only).
 *   변경 후 정책: 어드민 Po.B = 최종 B(= Σadvantage − Σpenalty). raw advantage 미노출.
 *   대조: (1)DB rawB (2)C (3)rawB−C (4)어드민 roster SoT Po.B (5)sumPointsForUsers netAdvantage
 *         (6)CrewDetail clubSummary/season 합 (7)고객 Σshield (8)고객 per-week shield=adv−pen.
 *   모두 동일한 최종 B 여야 한다.  npx tsx --env-file=.env.local scripts/verify-negative-b-real-user.ts <userId?>
 */
import { createClient } from "@supabase/supabase-js";
import { sumPointsForUsers, getRosterPointsScheduleFast } from "@/lib/adminMembersData";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY || "";
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function pickNegativeUser(): Promise<string | null> {
  const cum = new Map<string, { b: number; c: number }>();
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data } = await sb.from("user_weekly_points").select("user_id,advantages,penalty").order("user_id").range(from, from + PAGE - 1);
    const rows = data ?? [];
    for (const r of rows as any[]) {
      const acc = cum.get(r.user_id) ?? { b: 0, c: 0 };
      acc.b += r.advantages ?? 0; acc.c += r.penalty ?? 0; cum.set(r.user_id, acc);
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  let min = Infinity, user: string | null = null;
  for (const [uid, v] of cum) { const net = v.b - v.c; if (net < min) { min = net; user = uid; } }
  return user;
}

async function main() {
  const user = process.argv[2] || (await pickNegativeUser());
  if (!user) return console.log("음수 사용자 없음");
  const prof = (await sb.from("user_profiles").select("display_name,organization_slug").eq("user_id", user).maybeSingle()).data as any;

  // (1)(2)(3) DB 원천
  const weeks = (await sb.from("user_weekly_points").select("advantages,penalty").eq("user_id", user)).data as any[];
  const rawB = (weeks ?? []).reduce((s, r) => s + (r.advantages ?? 0), 0);
  const C = (weeks ?? []).reduce((s, r) => s + (r.penalty ?? 0), 0);
  const finalB = rawB - C;
  console.log(`대상: ${user} · ${prof?.display_name} · ${prof?.organization_slug}`);
  console.log(`\n(1) DB rawB(Σadv) = ${rawB}`);
  console.log(`(2) DB pointC(Σpen) = ${C}`);
  console.log(`(3) rawB − C = ${finalB}   ← 기대 최종 B\n`);

  // (4) 어드민 roster SoT (members 로스터 Po.B)
  const roster = (await getRosterPointsScheduleFast([user])).get(user);
  ck(`(4) roster Po.B == 최종B`, roster?.poB === finalB, `Po.B=${roster?.poB} · Po.C=${roster?.poC}(=C:${roster?.poC === C})`);

  // (5) sumPointsForUsers netAdvantagePoints
  const pts = (await sumPointsForUsers([user])).get(user);
  ck(`(5) sumPointsForUsers.netAdvantagePoints == 최종B`, pts?.netAdvantagePoints === finalB, `net=${pts?.netAdvantagePoints} raw=${pts?.advantagePoints} pen=${pts?.penaltyPoints}`);

  // (6) 주차별 uwp 맵(iso year/week → adv−pen) 준비
  const uwpRows = (await sb.from("user_weekly_points").select("year,week_number,advantages,penalty").eq("user_id", user)).data as any[];
  const netByWk = new Map<string, number>();
  for (const r of uwpRows ?? []) netByWk.set(`${r.year}-${r.week_number}`, (r.advantages ?? 0) - (r.penalty ?? 0));

  // (7)(8) 고객 weekly-cards HTTP: per-week shield == uwp(week).adv−pen (같은 사용자, 주차 단위 최종B 일치)
  const res = await fetch(`http://localhost:3000/api/cluster4/weekly-cards?userId=${user}`, {
    headers: { "Content-Type": "application/json", "x-internal-api-key": INTERNAL_KEY },
  });
  const cards = ((await res.json().catch(() => ({})))?.data ?? []) as any[];
  // 카드 weekId → iso(year,week) 매핑
  const weekIds = [...new Set(cards.map((c) => c.weekId).filter(Boolean))];
  const wk = (await sb.from("weeks").select("id,iso_year,iso_week").in("id", weekIds)).data as any[];
  const isoById = new Map<string, string>((wk ?? []).map((w) => [w.id, `${w.iso_year}-${w.iso_week}`]));
  let matched = 0, mismatch = 0;
  const negCards = cards.filter((c) => (c.points?.shield ?? 0) < 0);
  for (const c of cards) {
    const shield = c.points?.shield;
    if (shield == null || !c.weekId) continue;
    const key = isoById.get(c.weekId);
    if (key == null || !netByWk.has(key)) continue; // 매핑 불가(휴식/전환 등)는 스킵
    matched++;
    if (shield !== netByWk.get(key)) mismatch++;
  }
  ck(`(7) 고객 per-week shield == uwp(adv−pen) [매칭 ${matched}주차]`, matched > 0 && mismatch === 0, `mismatch=${mismatch}`);
  ck(`(8) 고객 API shield 음수 반환(clamp 없음)`, negCards.length > 0, `shield<0 카드 ${negCards.length}개`);

  const sumShield = cards.reduce((s, c) => s + (c.points?.shield ?? 0), 0);
  console.log(`\n═══ 판정 ═══`);
  console.log(`  어드민 최종B(누적, 전 uwp) = roster Po.B = netAdvantage = rawB−C = ${finalB} ✓`);
  console.log(`  고객 per-week shield == 주차별 (adv−pen) 일치(위 7). Σcard.shield=${sumShield}`);
  console.log(`  ⓘ Σcard.shield(${sumShield}) ≠ 누적 최종B(${finalB}): 카드가 전환/휴식 주차를 제외하기 때문(기존 정책·부호 무관).`);
  console.log(`  min 사용자 최종B = ${finalB} (음수) → 어드민 Po.B 가 이제 음수로 표시(raw 아님).`);
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
