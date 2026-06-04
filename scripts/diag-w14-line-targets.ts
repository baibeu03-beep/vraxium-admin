// W14 (2026-spring, 2026-06-01) 라인 개설 원장 확인: cluster4_lines + targets + T윤도현 배정
import { config } from "dotenv";
config({ path: ".env.local" });

const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad";
const W14 = "286ddd42-aa7c-4df8-bcff-c7c1a9f5425e";

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: lines, error } = await sb
    .from("cluster4_lines")
    .select("id, week_id, part_type, line_name, line_code, status, opened_at, created_at")
    .eq("week_id", W14);
  console.log("=== cluster4_lines (week=W14 2026-spring) ===", error?.message ?? "");
  for (const l of lines ?? []) console.log(JSON.stringify(l));
  console.log("count:", (lines ?? []).length);

  const lineIds = (lines ?? []).map((l: any) => l.id);
  if (lineIds.length > 0) {
    const { data: targets } = await sb
      .from("cluster4_line_targets")
      .select("id, line_id, user_id, target_mode")
      .in("line_id", lineIds);
    console.log(`\n=== targets (${(targets ?? []).length}) ===`);
    const mine = (targets ?? []).filter((t: any) => t.user_id === UID);
    console.log("T윤도현 배정 target:", mine.length);
    for (const t of mine) console.log(JSON.stringify(t));
    const byLine = new Map<string, number>();
    for (const t of targets ?? []) byLine.set(t.line_id, (byLine.get(t.line_id) ?? 0) + 1);
    for (const [lid, n] of byLine) console.log(`line=${lid.slice(0, 8)} targets=${n}`);
  }

  // 라인 detail 함수가 demo 경로에서 휴식 주차에 뭘 반환하는지 direct 확인
  const { getCluster4LineDetailForProfileUser } = await import("../lib/cluster4LinesData");
  for (const part of ["info", "experience", "competency", "career"] as const) {
    try {
      const d: any = await getCluster4LineDetailForProfileUser(UID, W14, part);
      const summary = Array.isArray(d?.lines)
        ? `lines=${d.lines.length} [${d.lines.map((x: any) => `${x.lineName ?? x.line_name ?? "?"}:${x.status ?? "?"}`).join(", ")}]`
        : JSON.stringify(d)?.slice(0, 300);
    console.log(`\n[lines/detail direct] part=${part}: ${summary}`);
    } catch (e: any) {
      console.log(`\n[lines/detail direct] part=${part}: ERROR ${e.message}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
