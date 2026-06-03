/** READ-ONLY: 실제 HTTP API 응답에서 profileTagline 추출 (서버 :3000). */
async function main() {
  const key = process.env.INTERNAL_API_KEY!;
  const owners = ["ee9bf53b", "247021bc"]; // 검증된 owner prefix
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data } = await sb.from("cluster4_weekly_card_snapshots").select("user_id");
  const ids = (data ?? []).map((r: any) => r.user_id);
  for (const pre of owners) {
    const uid = ids.find((id: string) => id.startsWith(pre));
    if (!uid) { console.log(`owner ${pre} 없음`); continue; }
    const res = await fetch(`http://localhost:3000/api/cluster4/weekly-cards?userId=${uid}`, {
      headers: { "x-internal-api-key": key },
    });
    const json: any = await res.json();
    console.log(`\n[owner=${pre}] http=${res.status} success=${json.success} cards=${json.data?.length}`);
    let shown = 0;
    for (const c of json.data ?? []) {
      for (const col of c.weeklyColleagues ?? []) {
        const t = col.colleagueProfile?.profileTagline;
        if (t != null && String(t).trim() !== "" && shown < 4) {
          console.log(`  week=${String(c.weekId).slice(0,8)} colleague=${String(col.colleagueUserId).slice(0,8)} → colleagueProfile.profileTagline="${t}"`);
          shown++;
        }
      }
      for (const rep of c.weeklyReputations ?? []) {
        const tf = rep.fromProfile?.profileTagline;
        if (tf != null && String(tf).trim() !== "" && shown < 6) {
          console.log(`  week=${String(c.weekId).slice(0,8)} reviewer=${String(rep.fromUserId).slice(0,8)} → fromProfile.profileTagline="${tf}"`);
          shown++;
        }
      }
    }
    if (shown === 0) console.log("  (이 owner 카드엔 tagline 값 가진 임베드 프로필 없음)");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
