// READ-ONLY — 실사용자 주차 결과 표(HTTP 라우트가 호출하는 바로 그 함수)를 직접 호출.
//   HTTP /api/admin/members/{id} 는 QA 모집단 스위치(QA_HIDE_REAL_USERS=true)로 실사용자 422 →
//   동일 서비스 함수를 직접 실행해 화면에 나갈 값을 그대로 확인한다.
import { getCrewWeeklyResults } from "@/lib/adminCrewWeeklyResults";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const TARGETS = [
  { id: "ef4938c2-5dfe-4500-a0bc-0d953c6f7314", name: "서유솔" },
  { id: "8cc1ae06-3110-4e34-918c-2a92674725a1", name: "최서윤" },
];

async function main() {
  const { data: ledger } = await supabaseAdmin
    .from("legacy_point_ledger")
    .select("user_id,week_id,star,shield,entry_type")
    .in("user_id", TARGETS.map((t) => t.id))
    .range(0, 9999);
  const { data: weeks } = await supabaseAdmin.from("weeks").select("id,start_date").range(0, 999);
  const startById = new Map(((weeks ?? []) as Array<{ id: string; start_date: string }>).map((w) => [w.id, w.start_date]));
  const recon = new Map<string, { a: number; adv: number; pen: number }>();
  for (const r of ((ledger ?? []) as Array<{ user_id: string; week_id: string | null; star: number; shield: number; entry_type: string }>)) {
    if (!r.week_id) continue;
    const s = startById.get(r.week_id);
    if (!s) continue;
    const k = `${r.user_id}::${s}`;
    const e = recon.get(k) ?? { a: 0, adv: 0, pen: 0 };
    e.a += Number(r.star ?? 0);
    if (r.entry_type === "POINTLOG") {
      const sh = Number(r.shield ?? 0);
      if (sh > 0) e.adv += sh; else if (sh < 0) e.pen += -sh;
    }
    recon.set(k, e);
  }

  for (const t of TARGETS) {
    const rows = await getCrewWeeklyResults(t.id);
    console.log(`\n=== ${t.name} 주차 결과 표 ${rows.length}행 (현재 화면값 vs PMS 원장 재구성) ===`);
    let restNz = 0, restRows = 0, actNz = 0, actRows = 0;
    for (const r of rows) {
      const rest = r.growthResultLabel === "공식 휴식";
      const nz = r.points.poA !== 0 || r.points.poB !== 0 || r.points.poC !== 0;
      if (rest) { restRows++; if (nz) restNz++; } else { actRows++; if (nz) actNz++; }
    }
    // weekId → start_date 로 원장 대조
    const { data: wrows } = await supabaseAdmin.from("weeks").select("id,start_date").range(0, 999);
    const sById = new Map(((wrows ?? []) as Array<{ id: string; start_date: string }>).map((w) => [w.id, w.start_date]));
    for (const r of rows) {
      const start = r.weekId ? sById.get(r.weekId) : undefined;
      const exp = start ? recon.get(`${t.id}::${start}`) : undefined;
      console.log(
        `  ${(r.weekName ?? "").padEnd(24)} ${r.growthResultLabel.padEnd(9)} ` +
          `화면 A=${String(r.points.poA).padStart(4)} B=${String(r.points.poB).padStart(4)} C=${String(r.points.poC).padStart(3)}` +
          `   원장 A=${String(exp?.a ?? 0).padStart(4)} adv=${String(exp?.adv ?? 0).padStart(3)} pen=${String(exp?.pen ?? 0).padStart(3)}` +
          `${exp && exp.a !== r.points.poA ? "   ← 불일치" : ""}`,
      );
    }
    console.log(`  → 공식휴식 ${restRows}행 중 값있음 ${restNz} · 그 외 ${actRows}행 중 값있음 ${actNz}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
