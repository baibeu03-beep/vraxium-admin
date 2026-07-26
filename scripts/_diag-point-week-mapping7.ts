// READ-ONLY — 2026-07-25 마이그레이션 적용 증거 확정.
//   §3 이 만드는 함수 public.sync_cumulative_points_for_user 존재 여부(있으면 = 적용됨).
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main() {
  // ⚠ 쓰기 금지 — 일부러 **잘못된 인자명**으로 호출한다. 함수가 없으면 PGRST202 에 후보 힌트가 없고,
  //   존재하면 PostgREST 가 "perhaps you meant ...(p_user_id)" 힌트를 돌려준다. 어느 쪽이든 실행 0.
  const { error } = await supabaseAdmin.rpc("sync_cumulative_points_for_user", { p_bogus_arg: 1 });
  console.log(`RPC probe code=${(error as { code?: string } | null)?.code ?? "none"}`);
  console.log(`  message: ${error?.message ?? "(성공?)"}`);
  console.log(`  hint   : ${(error as { hint?: string } | null)?.hint ?? "-"}`);

  // roster slim 갱신 시각 분포(§4 실행 흔적)
  const { data: rs } = await supabaseAdmin
    .from("cluster4_roster_card_stats").select("updated_at").range(0, 999);
  const b = new Map<string, number>();
  for (const r of (rs ?? []) as Array<{ updated_at: string }>) {
    const k = r.updated_at?.slice(0, 13) ?? "null";
    b.set(k, (b.get(k) ?? 0) + 1);
  }
  console.log("\nroster_card_stats updated_at 상위:");
  [...b.entries()].sort((a, c) => c[1] - a[1]).slice(0, 8).forEach(([k, v]) => console.log(`  ${k}  ${v}`));

  const { data: cp } = await supabaseAdmin.from("user_cumulative_points").select("updated_at").range(0, 999);
  const b2 = new Map<string, number>();
  for (const r of (cp ?? []) as Array<{ updated_at: string }>) {
    const k = r.updated_at?.slice(0, 19) ?? "null";
    b2.set(k, (b2.get(k) ?? 0) + 1);
  }
  console.log("\nuser_cumulative_points updated_at 상위:");
  [...b2.entries()].sort((a, c) => c[1] - a[1]).slice(0, 8).forEach(([k, v]) => console.log(`  ${k}  ${v}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
