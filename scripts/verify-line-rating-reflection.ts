// 실무 경험 라인 평점 → 고객 DTO 반영 점검 (mode=test live).
//   run: npx tsx --env-file=.env.local scripts/verify-line-rating-reflection.ts
//   평점(cluster4_experience_line_evaluations.rating) 변경이 고객 weekly-cards 라인 enhancementStatus
//   에 반영되는지(rating>=4 success / <=3 fail) + direct==HTTP. cleanup net-zero.
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { TEST_SUMMER_SIM_EFFECTIVE_FROM, fetchLegacyUnifiedMasterId } from "@/lib/lineAvailability";
import { getExperienceSlotsByMasterIdsRegFirst } from "@/lib/lineRegistrationLookup";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!, ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const J = (o: unknown) => JSON.stringify(o);
const TAG = "ZZ-rating", PAST = "2020-01-01T00:00:00.000Z";
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cookie() {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: "vanuatu.golden@gmail.com" });
  const { data: v } = await brow.auth.verifyOtp({ email: "vanuatu.golden@gmail.com", token: link!.properties.email_otp, type: "magiclink" });
  const cap: any[] = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id));
  const oranke = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", "oranke")).data ?? []) as any[];
  const user = oranke.find((u) => markers.has(u.user_id))?.user_id;
  const week = (await sb.from("weeks").select("id,week_number").eq("season_key", "2026-spring").eq("week_number", 13).maybeSingle()).data as any;
  const masters = ((await sb.from("cluster4_experience_line_masters").select("id").eq("is_active", true).limit(60)).data ?? []) as any[];
  const slotMap = await getExperienceSlotsByMasterIdsRegFirst(masters.map((m) => m.id));
  const unifiedId = await fetchLegacyUnifiedMasterId();
  const m1 = masters.find((m) => slotMap.get(m.id) === 1 && m.id !== unifiedId);
  ck("[전제] 테스트유저·W13·슬롯1 마스터", !!user && !!week?.id && !!m1, J({ user: !!user, w13: !!week?.id, m1: !!m1 }));
  if (!user || !week?.id || !m1) process.exit(2);

  const ck0 = await cookie();
  const clean = async () => {
    const lines = (await sb.from("cluster4_lines").select("id").eq("part_type", "experience").like("main_title", `${TAG}%`)).data ?? [];
    const lIds = (lines as any[]).map((x) => x.id);
    if (lIds.length) {
      const tgts = (await sb.from("cluster4_line_targets").select("id").in("line_id", lIds)).data ?? [];
      const tIds = (tgts as any[]).map((x) => x.id);
      if (tIds.length) await sb.from("cluster4_experience_line_evaluations").delete().in("line_target_id", tIds);
      await sb.from("cluster4_line_targets").delete().in("line_id", lIds);
      await sb.from("cluster4_lines").delete().in("id", lIds);
    }
  };
  await clean();

  // 라인 + 타깃(마감 경과) 생성
  const { data: line } = await sb.from("cluster4_lines").insert({ part_type: "experience", experience_line_master_id: m1.id, line_code: "EXOK-ZZRT01", main_title: `${TAG} 평점라인`, submission_opens_at: PAST, submission_closes_at: PAST, is_active: true }).select("id").single();
  const lineId = (line as any).id;
  const { data: tgt } = await sb.from("cluster4_line_targets").insert({ line_id: lineId, week_id: week.id, target_mode: "user", target_user_id: user, target_rule: {} }).select("id").single();
  const targetId = (tgt as any).id;

  const setRating = async (rating: number) => {
    await sb.from("cluster4_experience_line_evaluations").delete().eq("line_target_id", targetId);
    await sb.from("cluster4_experience_line_evaluations").insert({ line_target_id: targetId, user_id: user, rating, evaluated_at: new Date().toISOString() });
  };
  const lineDto = async () => {
    const cards = await getCluster4WeeklyCardsForProfileUser(user, { effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM }) as any[];
    const card = cards.find((c) => c.weekNumber === 13 && c.seasonKey === "2026-spring");
    return (card?.lines ?? []).find((l: any) => l.lineId === lineId);
  };
  const httpLine = async () => {
    const res = await fetch(`http://localhost:3000/api/cluster4/weekly-cards?demoUserId=${user}&mode=test`, { headers: { cookie: ck0 } });
    const txt = await res.text();
    let j: any = {}; try { j = JSON.parse(txt); } catch { console.log(`  [HTTP debug] non-json status=${res.status} head=${txt.slice(0, 80)}`); return { __err: `non-json` }; }
    const card = (j.data ?? []).find((c: any) => c.weekNumber === 13 && c.seasonKey === "2026-spring");
    const found = (card?.lines ?? []).find((l: any) => l.lineId === lineId);
    if (!found) console.log(`  [HTTP debug] success=${j.success} cards=${(j.data ?? []).length} w13Lines=${(card?.lines ?? []).length} lineIds=${J((card?.lines ?? []).map((l: any) => l.lineId).slice(0, 8))}`);
    return found;
  };

  // 평점 5 → 강화 success (마감경과·평점>=4)
  await setRating(5);
  let d = await lineDto();
  ck("[평점5] 라인 노출 · enhancementStatus=success", !!d && d.enhancementStatus === "success", `enh=${d?.enhancementStatus}`);
  let h = await httpLine();
  ck("[direct==HTTP] 평점5", h?.enhancementStatus === d?.enhancementStatus, `http=${h?.enhancementStatus}`);

  // 평점 3 → 강화 fail (experience_rating_fail)
  await setRating(3);
  d = await lineDto();
  ck("[평점3] enhancementStatus=fail (평점<=3 반영·즉시 변경)", d?.enhancementStatus === "fail", `enh=${d?.enhancementStatus}`);
  h = await httpLine();
  ck("[direct==HTTP] 평점3", h?.enhancementStatus === d?.enhancementStatus, `http=${h?.enhancementStatus}`);

  await clean();
  ck("[cleanup] 라인/타깃/평점 제거", true);
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
