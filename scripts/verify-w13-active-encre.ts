/**
 * verify-w13-active-encre.ts (READ-ONLY)
 * 25가을 W13 에 카드가 있는 encre 사용자들이 이제 위즈덤/캘린더/아카데미 3개 info 라인을 모두
 * 보는지 + direct==snapshot 인지 확인. (수정·재계산 후 검증)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const W13 = "4cc9eecb-32aa-40ea-9c7f-7aafac777542";

function infoOf(cards: any[]) {
  const c = (cards ?? []).find((x) => x.weekId === W13);
  if (!c) return null;
  const infos = (c.lines ?? []).filter((l: any) => l.partType === "information");
  return infos.map((l: any) => `${l.displayLineCode}/${l.status}`).sort();
}

async function main() {
  // encre 사용자 전수
  const enc: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("user_profiles").select("user_id").eq("organization_slug", "encre").order("user_id").range(from, from + 999);
    const rows = (data ?? []) as Array<{ user_id: string }>;
    enc.push(...rows.map((r) => r.user_id));
    if (rows.length < 1000) break;
  }

  // snapshot 에서 W13 카드가 있는 encre 사용자 추출 + info 라인 분포 집계
  let w13Active = 0;
  const dist = new Map<number, number>(); // info 라인 수 → 사용자 수
  const samples: Array<{ uid: string; snapCodes: string[] }> = [];
  for (let i = 0; i < enc.length; i += 50) {
    const chunk = enc.slice(i, i + 50);
    const { data } = await sb.from("cluster4_weekly_card_snapshots").select("user_id,cards").in("user_id", chunk);
    for (const r of (data ?? []) as Array<{ user_id: string; cards: any[] }>) {
      const codes = infoOf(r.cards);
      if (codes === null) continue;
      w13Active++;
      dist.set(codes.length, (dist.get(codes.length) ?? 0) + 1);
      if (samples.length < 6) samples.push({ uid: r.user_id, snapCodes: codes });
    }
  }
  console.log(`encre ${enc.length}명 중 25가을W13 카드 보유 = ${w13Active}명`);
  console.log("W13 info 라인 수 분포(snapshot):", JSON.stringify([...dist.entries()].sort((a, b) => a[0] - b[0])));

  console.log("\n[표본 direct==snapshot 검증]");
  let ok = 0;
  for (const s of samples) {
    const live = infoOf(await getCluster4WeeklyCardsForProfileUser(s.uid));
    const eq = JSON.stringify(live) === JSON.stringify(s.snapCodes);
    if (eq) ok++;
    console.log(`  ${s.uid.slice(0, 8)}: snap=${s.snapCodes.length}건 ${JSON.stringify(s.snapCodes)} | direct==snap:${eq}`);
  }
  console.log(`  ⇒ ${ok}/${samples.length} direct==snapshot 일치`);
}

main().catch((e) => { console.error("ERR", e instanceof Error ? e.stack : e); process.exit(1); });
