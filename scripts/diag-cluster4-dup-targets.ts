/**
 * READ-ONLY: 동일 (user, week) 에서 중복 experience target / 같은 slot·master 공유 라인이 있는지.
 * 있으면 lines[].length(=available)는 N인데 프론트가 lineId/slot 기준으로 접어 보여주는 칸은 < N → 헤더 불일치.
 *   npx tsx --env-file=.env.local scripts/diag-cluster4-dup-targets.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // 모든 user-mode 타깃 + 라인 part/slot
  const { data: targets } = await sb
    .from("cluster4_line_targets")
    .select("id,week_id,line_id,target_mode,target_user_id,cluster4_lines!inner(part_type,experience_line_master_id,is_active)")
    .eq("cluster4_lines.is_active", true);
  type Row = {
    id: string; week_id: string; line_id: string; target_mode: string; target_user_id: string | null;
    cluster4_lines: { part_type: string; experience_line_master_id: string | null } | null;
  };
  const rows = (targets ?? []) as unknown as Row[];
  console.log(`active 라인 타깃 ${rows.length}건\n`);

  // master → slot
  const masterIds = [...new Set(rows.map((r) => r.cluster4_lines?.experience_line_master_id).filter(Boolean) as string[])];
  const slotByMaster = new Map<string, number>();
  if (masterIds.length) {
    const { data: m } = await sb.from("cluster4_experience_line_masters").select("id,experience_slot_order").in("id", masterIds);
    for (const x of (m ?? []) as { id: string; experience_slot_order: number | null }[]) if (x.experience_slot_order != null) slotByMaster.set(x.id, x.experience_slot_order);
  }

  // 1) 동일 (user, week, line) 중복 target
  const dupKey = new Map<string, number>();
  for (const r of rows) {
    if (r.target_mode !== "user" || !r.target_user_id) continue;
    const k = `${r.target_user_id}|${r.week_id}|${r.line_id}`;
    dupKey.set(k, (dupKey.get(k) ?? 0) + 1);
  }
  const dups = [...dupKey.entries()].filter(([, n]) => n > 1);
  console.log(`동일 (user,week,line) 중복 target: ${dups.length}건`);
  for (const [k, n] of dups.slice(0, 10)) console.log(`  ${k.slice(0, 40)} → ${n}회`);

  // 2) 동일 (user, week) 에서 experience slot 충돌 (서로 다른 line 이 같은 slot)
  type ExpRow = { user: string; week: string; line: string; slot: number | undefined };
  const exp: ExpRow[] = rows
    .filter((r) => r.target_mode === "user" && r.target_user_id && r.cluster4_lines?.part_type === "experience")
    .map((r) => ({ user: r.target_user_id!, week: r.week_id, line: r.line_id, slot: r.cluster4_lines?.experience_line_master_id ? slotByMaster.get(r.cluster4_lines.experience_line_master_id) : undefined }));

  const slotCollide = new Map<string, Set<string>>(); // user|week|slot → distinct lineIds
  const nullSlot = new Map<string, number>(); // user|week → experience lines with no slot
  for (const e of exp) {
    if (e.slot == null) {
      const k = `${e.user}|${e.week}`;
      nullSlot.set(k, (nullSlot.get(k) ?? 0) + 1);
      continue;
    }
    const k = `${e.user}|${e.week}|slot${e.slot}`;
    let s = slotCollide.get(k); if (!s) { s = new Set(); slotCollide.set(k, s); }
    s.add(e.line);
  }
  const collisions = [...slotCollide.entries()].filter(([, s]) => s.size > 1);
  console.log(`\n동일 (user,week) experience 같은 slot 에 서로 다른 라인 ${collisions.length}건`);
  for (const [k, s] of collisions.slice(0, 10)) console.log(`  ${k.slice(0, 48)} → ${s.size} distinct lines`);
  const nullSlots = [...nullSlot.entries()].filter(([, n]) => n > 0);
  console.log(`\nexperience slot 미분류(master/slot 없음) 라인 보유 (user,week): ${nullSlots.length}건`);
  for (const [k, n] of nullSlots.slice(0, 10)) console.log(`  ${k.slice(0, 40)} → ${n}개`);

  // 3) experience 라인별 slot 분포 (5슬롯 정상 매핑 여부)
  const { data: expLines } = await sb.from("cluster4_lines").select("id,experience_line_master_id").eq("part_type", "experience").eq("is_active", true);
  const slotDist = new Map<string, number>();
  for (const l of (expLines ?? []) as { id: string; experience_line_master_id: string | null }[]) {
    const s = l.experience_line_master_id ? slotByMaster.get(l.experience_line_master_id) : undefined;
    const key = s == null ? "NULL" : `slot${s}`;
    slotDist.set(key, (slotDist.get(key) ?? 0) + 1);
  }
  console.log(`\nactive experience 라인 slot 분포: ${JSON.stringify([...slotDist.entries()])}`);

  console.log("\n══ 종료(읽기 전용) ══");
}
main().catch((e) => { console.error(e); process.exit(1); });
