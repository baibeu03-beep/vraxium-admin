// 버그 영향 정밀 측정: 이미 buggy 코드로 재작성된 v24 snapshot(261건) 표본을
// 수정 후 fixed 재계산과 canonical 비교한다. 같은 dto_version 이므로 차이=오직 lineAvailability 버그 효과.
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = canonical(o[k]);
    return out;
  }
  return v;
}
const canon = (v: unknown) => JSON.stringify(canonical(v));

function expSig(cards: any[]) {
  let s = 0, f = 0, na = 0, v = 0, n = 0;
  for (const c of cards ?? []) for (const ln of c.lines ?? []) {
    if ((ln.partType ?? ln.part_type) !== "experience") continue;
    n++;
    const st = ln.enhancementStatus ?? ln.status;
    if (st === "success") s++; else if (st === "fail") f++; else if (st === "not_applicable") na++; else if (st === "void") v++;
  }
  return `exp n=${n} s=${s} f=${f} na=${na} v=${v}`;
}

async function main() {
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testSet = new Set((markers ?? []).map((m: any) => m.user_id));
  // v24(buggy 재작성분) user_id 목록 — cards 미선택(타임아웃 회피)
  const { data: idRows } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,card_count")
    .eq("dto_version", WEEKLY_CARDS_DTO_VERSION)
    .gte("card_count", 1)
    .order("card_count", { ascending: false })
    .range(0, 4999);
  const all = ((idRows ?? []) as any[]);
  const real = all.filter((r) => !testSet.has(r.user_id));
  const test = all.filter((r) => testSet.has(r.user_id));
  // 표본: 실사용자 10 + 테스트 4 (card_count 큰 쪽 위주 + 분산)
  const pick = (arr: any[], n: number) => {
    const step = Math.max(1, Math.floor(arr.length / n));
    const out: any[] = [];
    for (let i = 0; i < arr.length && out.length < n; i += step) out.push(arr[i]);
    return out;
  };
  const sample = [...pick(real, 10), ...pick(test, 4)];
  console.log(`v24(buggy 재작성) ${all.length}건 중 표본 ${sample.length}명 (실 ${real.length}/테스트 ${test.length}) — 저장(buggy) vs 수정후 재계산 비교\n`);

  let changed = 0;
  const changedList: string[] = [];
  for (const r of sample) {
    const { data: one } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("cards")
      .eq("user_id", r.user_id)
      .maybeSingle();
    const stored = ((one as any)?.cards ?? []) as any[];
    const fixed = await getCluster4WeeklyCardsForProfileUser(r.user_id);
    const eq = canon(stored) === canon(fixed);
    if (!eq) { changed++; changedList.push(r.user_id); }
    const tag = testSet.has(r.user_id) ? "test" : "real";
    console.log(`  ${eq ? "동일 ✅" : "변화 ⚠"} ${r.user_id} (${tag}, cards=${r.card_count})`);
    if (!eq) {
      console.log(`        buggy : ${expSig(stored)}`);
      console.log(`        fixed : ${expSig(fixed)}`);
    }
  }
  console.log(`\n표본 ${sample.length}명 중 버그로 인해 달라지는(=수정 후 교정될) 사용자: ${changed}명`);
  if (changedList.length) console.log(`  → ${changedList.join(", ")}`);
  console.log(`\n해석: 변화 0 = 현재 시점 버그의 고객 카드 영향 없음(여름 정책 주차 미시작) — 그래도 수정은 여름 대비 필수.`);
  console.log(`      변화 >0 = 그 사용자들은 buggy degraded → 수정 후 교정. 전원 수렴으로 261건 포함 전부 재작성 필요.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
