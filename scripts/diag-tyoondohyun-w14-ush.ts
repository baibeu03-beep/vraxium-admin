// T윤도현 W14(2026-06-01) 라인 상세 + user_season_histories + 일반 유저 비교
import { config } from "dotenv";
config({ path: ".env.local" });

const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad"; // T윤도현

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // 1. user_season_histories (front /api/profile fallback 소스)
  const { data: ush, error: ushErr } = await sb
    .from("user_season_histories")
    .select("*")
    .eq("user_id", UID);
  console.log("=== user_season_histories ===", ushErr?.message ?? "");
  for (const r of ush ?? []) console.log(JSON.stringify(r));

  // 2. snapshot W14 카드 라인 전체 dump
  const { readWeeklyCardsSnapshot } = await import("../lib/cluster4WeeklyCardsSnapshot");
  const snap = await readWeeklyCardsSnapshot(UID);
  const cards = "cards" in snap ? (snap as any).cards : [];
  const w14 = cards.find((c: any) => c.startDate === "2026-06-01");
  console.log("\n=== T윤도현 snapshot W14 (2026-06-01) ===");
  if (!w14) console.log("카드 없음");
  else {
    const { lines, ...head } = w14;
    console.log("HEAD:", JSON.stringify(head, null, 1));
    console.log(`lines (${lines.length}):`);
    for (const l of lines) {
      console.log(
        ` part=${l.partType} slot=${l.slotOrder ?? "-"} lineName=${JSON.stringify(l.lineName)} status=${l.status ?? "-"} enh=${l.enhancementStatus ?? "-"} num/den=${l.numerator}/${l.denominator} canEdit=${l.canEdit} editReason=${l.editReason ?? "-"} hasContent=${l.hasContent ?? "-"} contentTitle=${JSON.stringify(l.contentTitle ?? null)}`,
      );
    }
    console.log("W14 full first line sample:", JSON.stringify(lines[0], null, 1));
  }

  // 3. 일반 유저(테스터 아님) 한 명의 W14 카드 비교
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testerIds = new Set((markers ?? []).map((m: any) => m.user_id));
  const { data: snaps } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id, computed_at")
    .order("computed_at", { ascending: false })
    .limit(200);
  const normalIds = (snaps ?? []).map((s: any) => s.user_id).filter((id: string) => !testerIds.has(id));
  console.log(`\n비교용 일반 유저 후보: ${normalIds.length}`);
  for (const nid of normalIds.slice(0, 3)) {
    const s2 = await readWeeklyCardsSnapshot(nid);
    const cs = "cards" in s2 ? (s2 as any).cards : [];
    const w = cs.find((c: any) => c.startDate === "2026-06-01");
    if (!w) { console.log(`user=${nid.slice(0, 8)} W14 카드 없음`); continue; }
    console.log(
      `user=${nid.slice(0, 8)} W14: status=${w.userWeekStatus} isRest=${w.isRestWeek} lines=${w.lines.length} growth=${w.growthNumerator}/${w.growthDenominator} label="${w.displayWeekProgressLabel}" canEditAny=${w.lines.some((l: any) => l.canEdit)}`,
    );
  }

  // 4. T윤도현 W14 canEdit 라인 여부 정리
  if (w14) {
    const editable = w14.lines.filter((l: any) => l.canEdit);
    console.log(`\nT윤도현 W14 canEdit=true 라인 수: ${editable.length}`);
    for (const l of editable) console.log(` part=${l.partType} lineName=${JSON.stringify(l.lineName)} editReason=${l.editReason}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
