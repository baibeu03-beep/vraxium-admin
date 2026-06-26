/**
 * 검증 — Po.A/B/C = 포인트 종류별 "1위 크루"(합계/Top3 아님)·원천 일치.
 *   DTO weeklyPointLeaders.{poA,poB,poC} 를 원천 user_weekly_points 의 종류별 max 크루와 비교.
 *   Po.A=max points · Po.B=max advantages · Po.C=max penalty (값>0, 동점 이름순).
 * Usage: npx tsx --env-file=.env.local scripts/verify-info-stats-pointleaders.ts [phalanx oranke encre]
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadMembersInfoStats } from "@/lib/adminMembersInfoStats";

const BASE = "http://localhost:3000";
const EMAIL = "vanuatu.golden@gmail.com";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const LABEL: Record<string, string> = { encre: "엥크레", oranke: "오랑캐", phalanx: "팔랑크스" };
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const strip = (d: any) => { const { generatedAt, ...r } = d ?? {}; return JSON.stringify(r); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const J = (x: any) => JSON.stringify(x);

async function cookie(): Promise<string> {
  for (let a = 1; a <= 4; a++) {
    try {
      const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
      const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
      const otp = (link as any)?.properties?.email_otp; if (!otp) throw new Error("null");
      const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: otp, type: "magiclink" });
      const cap: any[] = []; const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i: any[]) => cap.push(...i) } });
      await srv.auth.setSession({ access_token: v!.session!.access_token, refresh_token: v!.session!.refresh_token });
      return cap.map((i) => `${i.name}=${i.value}`).join("; ");
    } catch { await sleep(2500); }
  }
  throw new Error("cookie 실패");
}
async function clubRoster(org: string) {
  const out: { id: string; name: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabaseAdmin.from("user_profiles").select("user_id, display_name")
      .eq("organization_slug", org).not("activity_started_at", "is", null).or("role.is.null,role.neq.super_admin")
      .order("user_id", { ascending: true }).range(from, from + 999);
    const rows = (data ?? []) as any[]; out.push(...rows.map((r) => ({ id: r.user_id, name: r.display_name ?? "-" })));
    if (rows.length < 1000) break;
  }
  const { data: tm } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const t = new Set((tm ?? []).map((r: any) => r.user_id));
  return out.filter((r) => !t.has(r.id));
}
// 원천 종류별 max 크루 — value>0, 동점 이름순.
function maxBy(list: { name: string; value: number }[]) {
  let best: { name: string; points: number } | null = null;
  for (const r of list) {
    if (r.value <= 0) continue;
    if (best == null || r.value > best.points || (r.value === best.points && r.name.localeCompare(best.name, "ko") < 0)) best = { name: r.name, points: r.value };
  }
  return best;
}
async function sourceLeaders(roster: { id: string; name: string }[], iy: number, iw: number) {
  const nameById = new Map(roster.map((r) => [r.id, r.name])); const ids = roster.map((r) => r.id);
  const A: { name: string; value: number }[] = [], B: { name: string; value: number }[] = [], C: { name: string; value: number }[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await supabaseAdmin.from("user_weekly_points").select("user_id, points, advantages, penalty")
      .eq("year", iy).eq("week_number", iw).in("user_id", ids.slice(i, i + 300));
    for (const r of (data ?? []) as any[]) {
      const nm = nameById.get(r.user_id) ?? "-";
      A.push({ name: nm, value: Number(r.points) || 0 });
      B.push({ name: nm, value: Number(r.advantages) || 0 });
      C.push({ name: nm, value: Number(r.penalty) || 0 });
    }
  }
  return { poA: maxBy(A), poB: maxBy(B), poC: maxBy(C) };
}

async function main() {
  const orgs = process.argv.slice(2).filter((a) => LABEL[a]);
  const targets = orgs.length ? orgs : ["phalanx", "oranke", "encre"];
  const ck_ = await cookie();
  for (const org of targets) {
    console.log(`\n════════ [${LABEL[org]}] (${org}) ════════`);
    const d = await loadMembersInfoStats({ organization: org as any, mode: "operating" });
    const pf = d.partialFailure?.snapshotUnavailable ?? 0;
    console.log(`   partialFailure=${pf}`);
    ck(`[${org}] 미조회 0`, pf === 0, `pf=${pf}`);
    const roster = await clubRoster(org);
    const samples = d.weeks.filter((w: any) => w.finalized).slice(0, 3);
    for (const w of samples) {
      const pl = w.weeklyPointLeaders;
      const isLeaders = pl && "poA" in pl && "poB" in pl && "poC" in pl && !Array.isArray(pl);
      ck(`[${org}] ${w.seasonWeekName} weeklyPointLeaders 구조(종류별 1위)`, !!isLeaders);
      const { data: wk } = await supabaseAdmin.from("weeks").select("iso_year, iso_week").eq("id", w.weekId).maybeSingle();
      const src = await sourceLeaders(roster, (wk as any).iso_year, (wk as any).iso_week);
      const eq = (a: any, b: any) => J(a ?? null) === J(b ?? null);
      console.log(`   ${w.seasonWeekName}: DTO A=${J(pl?.poA)} B=${J(pl?.poB)} C=${J(pl?.poC)}`);
      console.log(`                 원천 A=${J(src.poA)} B=${J(src.poB)} C=${J(src.poC)}`);
      ck(`[${org}] ${w.seasonWeekName} Po.A=원천 max A포인트`, eq(pl?.poA, src.poA));
      ck(`[${org}] ${w.seasonWeekName} Po.B=원천 max Advantage`, eq(pl?.poB, src.poB));
      ck(`[${org}] ${w.seasonWeekName} Po.C=원천 max Penalty`, eq(pl?.poC, src.poC));
    }
    const res = await fetch(`${BASE}/api/admin/members/info-stats?organization=${org}`, { headers: { cookie: ck_ }, cache: "no-store" as RequestCache });
    const j: any = await res.json();
    ck(`[${org}] HTTP 200`, res.ok && j.success === true);
    ck(`[${org}] direct == HTTP`, strip(d) === strip(j.data));
  }
  console.log("\n── snapshot 영향/재계산: none(읽기 전용·snapshot 무접촉)·일반/test 동일 DTO ──");
  console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
