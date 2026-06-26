/**
 * 검증 — [섹션.1] 조직별 탭(오랑캐·팔랑크스, encre 회귀): 공통 로직 재사용 확인.
 *   각 org: ① 누적(데이터 시작/클러빙/엘리트 null/활동중단)
 *           ② Po.A/B/C(내림차순·≤3·points>0) + 크루 ∈ 해당 org 명부 + Po.A 값=본인 snapshot star
 *           ③ direct == HTTP(cumulative 결정적 + weeks 길이)
 *   ⚠ converge(snapshot 재계산) 대비 타깃 재확인/쿠키 재시도.
 * Usage: npx tsx --env-file=.env.local scripts/verify-club-info-stats.ts [oranke|phalanx|encre ...]
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

async function cookie(): Promise<string> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const sb = createClient(URL_, SERVICE);
      const brow = createClient(URL_, ANON);
      const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
      const otp = (link as any)?.properties?.email_otp;
      if (!otp) throw new Error("magiclink null");
      const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: otp, type: "magiclink" });
      const cap: any[] = [];
      const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i: any[]) => cap.push(...i) } });
      await srv.auth.setSession({ access_token: v!.session!.access_token, refresh_token: v!.session!.refresh_token });
      return cap.map((i) => `${i.name}=${i.value}`).join("; ");
    } catch (e) { await sleep(3000); }
  }
  throw new Error("cookie 생성 실패");
}

async function clubRoster(org: string): Promise<{ names: Set<string>; idByName: Map<string, string> }> {
  const { data } = await supabaseAdmin.from("user_profiles")
    .select("user_id, display_name").eq("organization_slug", org)
    .not("activity_started_at", "is", null).or("role.is.null,role.neq.super_admin");
  const names = new Set<string>(); const idByName = new Map<string, string>();
  for (const r of (data ?? []) as any[]) if (r.display_name) { names.add(r.display_name); idByName.set(r.display_name, r.user_id); }
  return { names, idByName };
}
async function crewWeekStar(userId: string, weekId: string): Promise<number | null> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const { data } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("cards").eq("user_id", userId).maybeSingle();
    const cards = (data as any)?.cards;
    if (Array.isArray(cards)) { const c = cards.find((x: any) => x.weekId === weekId); if (c && typeof c.points?.star === "number") return c.points.star; }
    await sleep(2500);
  }
  return null;
}

async function verifyClub(org: string, ck_: string) {
  console.log(`\n══════ [${LABEL[org]}] (${org}) ══════`);
  const d = await loadMembersInfoStats({ organization: org as any, mode: "operating" });
  // ① 누적
  console.log(`   데이터 시작=${d.cumulative.dataStartWeekLabel} · 클러빙=${d.cumulative.cumulativeClubbing} · 엘리트=${d.cumulative.cumulativeElite} · 활동중단=${d.cumulative.cumulativeSuspended}`);
  ck(`[${org}] 데이터 시작 존재`, typeof d.cumulative.dataStartWeekLabel === "string" && d.cumulative.dataStartWeekLabel!.length > 0);
  ck(`[${org}] 누적 엘리트 = null`, d.cumulative.cumulativeElite === null);
  ck(`[${org}] 누적 클러빙 > 0 · 클럽수=1`, d.cumulative.cumulativeClubbing > 0 && d.cumulative.clubCount === 1);

  // ② Po.A/B/C
  const { names, idByName } = await clubRoster(org);
  const samples = d.weeks.filter((w) => w.finalized && w.weeklyTopPoints && w.weeklyTopPoints.length > 0).slice(0, 2);
  ck(`[${org}] Po 보유 확정 주차 ≥1`, samples.length >= 1);
  for (const w of samples) {
    const top = w.weeklyTopPoints!;
    console.log(`     [${w.seasonWeekName}] ${top.map((t, i) => `Po.${["A", "B", "C"][i]}=${t.name} 님 (${t.points}개)`).join(" / ")}`);
    ck(`  [${org}] ${w.seasonWeekName} 내림차순·≤3·>0`, top.length <= 3 && top.every((t, i) => t.points > 0 && (i === 0 || top[i - 1].points >= t.points)));
    ck(`  [${org}] ${w.seasonWeekName} 모든 Po 크루 ∈ ${LABEL[org]} 명부`, top.every((t) => names.has(t.name)), top.map((t) => t.name).join(","));
  }
  if (samples.length > 0) {
    const w = samples[0]; const a = w.weeklyTopPoints![0]; const uid = idByName.get(a.name);
    if (uid) { const star = await crewWeekStar(uid, w.weekId); ck(`  [${org}] Po.A(${a.name}) ${a.points}개 = 본인 snapshot star`, star === a.points, `star=${star}`); }
  }

  // ③ direct == HTTP
  const res = await fetch(`${BASE}/api/admin/members/info-stats?organization=${org}`, { headers: { cookie: ck_ }, cache: "no-store" as RequestCache });
  const json: any = await res.json();
  ck(`[${org}] HTTP 200`, res.ok && json.success === true);
  ck(`[${org}] cumulative direct == HTTP`, strip(d.cumulative) === strip(json.data?.cumulative), strip(d.cumulative) === strip(json.data?.cumulative) ? "" : `${strip(d.cumulative)} vs ${strip(json.data?.cumulative)}`);
  ck(`[${org}] weeks 길이 direct == HTTP`, d.weeks.length === (json.data?.weeks?.length ?? -1));
  return d;
}

async function main() {
  const orgs = process.argv.slice(2).filter((a) => LABEL[a]);
  const targets = orgs.length ? orgs : ["oranke", "phalanx", "encre"];
  const ck_ = await cookie();
  for (const org of targets) await verifyClub(org, ck_);
  console.log("\n── snapshot 영향/재계산: none(읽기 전용 readSnapshotCards·user_profiles/weeks read)·일반/test 동일 DTO ──");
  console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
