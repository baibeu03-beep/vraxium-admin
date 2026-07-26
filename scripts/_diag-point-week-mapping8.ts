// READ-ONLY — HTTP 검증 대상자 선정: 소실량 상위 실사용자 + 이름/조직/스냅샷 상태.
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type Num = number | null;

async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function main() {
  const roster = await pageAll<{ user_id: string; po_a: Num; updated_at: string | null }>((f, t) =>
    supabaseAdmin.from("cluster4_roster_card_stats").select("user_id,po_a,updated_at").order("user_id").range(f, t));
  const uwp = await pageAll<{ user_id: string; points: Num }>((f, t) =>
    supabaseAdmin.from("user_weekly_points").select("user_id,points").order("id").range(f, t));
  const cur = new Map<string, number>();
  for (const r of uwp) cur.set(r.user_id, (cur.get(r.user_id) ?? 0) + (r.points ?? 0));

  const profiles = await pageAll<{ user_id: string; display_name: string | null; organization_slug: string | null; growth_status: string | null }>(
    (f, t) => supabaseAdmin.from("user_profiles").select("user_id,display_name,organization_slug,growth_status").order("user_id").range(f, t));
  const pmap = new Map(profiles.map((p) => [p.user_id, p]));

  const rows = roster
    .filter((r) => r.updated_at && r.updated_at < "2026-07-25T04:52:05")
    .map((r) => ({ id: r.user_id, before: r.po_a ?? 0, now: cur.get(r.user_id) ?? 0, p: pmap.get(r.user_id) }))
    .filter((r) => r.before - r.now > 0)
    .sort((a, b) => b.before - b.now - (a.before - a.now));

  console.log("소실 상위 20명 (roster 이전 A → 현재 uwp A):");
  for (const r of rows.slice(0, 20)) {
    console.log(
      `  ${r.id}  ${(r.p?.display_name ?? "?").padEnd(10)} ${(r.p?.organization_slug ?? "?").padEnd(8)} ` +
        `${String(r.p?.growth_status ?? "").padEnd(10)} before=${r.before} now=${r.now} 소실=${r.before - r.now}`,
    );
  }
  console.log(`\n총 소실 사용자 ${rows.length}명`);
}

main().catch((e) => { console.error(e); process.exit(1); });
