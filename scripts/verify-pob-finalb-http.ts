/**
 * Po.B = 최종 B(rawB − pointC) — 전 어드민/고객 화면 실 HTTP 대조 (2026-07-13, read-only).
 *   음수 사용자(최수연/encre) 기준으로 1~8 항목 + 정렬(net) + 모드 파리티를 실제 HTTP 로 확인.
 *   npx tsx --env-file=.env.local scripts/verify-pob-finalb-http.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const INTERNAL_KEY = process.env.INTERNAL_API_KEY || "";
const ADMIN_EMAIL = "vanuatu.golden@gmail.com";
const BASE = "http://localhost:3000";
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const J = (o: unknown) => JSON.stringify(o);
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cookie() {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  const { data: v } = await brow.auth.verifyOtp({ email: ADMIN_EMAIL, token: link!.properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  const ck0 = await cookie();
  const http = async (path: string, headers: any = {}) => {
    const res = await fetch(`${BASE}${path}`, { headers: { cookie: ck0, ...headers } });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  // 로스터에 반드시 존재하는 "음수 최종B" 사용자 U = encre 로스터 poB 오름차순 최상단.
  //   (raw 였다면 poB≥0 이라 오름차순 최상단이 음수일 수 없음 → 음수면 곧 최종B(net) 증거.)
  const org = "encre";
  const sorted = await http(`/api/admin/members/roster?organization=${org}&sort=poB:asc&pageSize=5`);
  const sm = (sorted.json?.data?.members ?? []) as any[];
  const asc = sm.every((m, i) => i === 0 || sm[i - 1].poB <= m.poB);
  ck(`(정렬) roster sort=poB:asc → 오름차순 & 최상단 음수(=최종B, raw면 불가)`, sm.length > 0 && asc && sm[0].poB < 0, `top=${sm.slice(0, 3).map((m) => m.poB).join(",")}`);
  const member = sm[0];
  const user = member.userId;
  const name = member.displayName ?? member.name ?? "?";

  // (1)(2)(3) DB 원천 (U 기준)
  const weeks = (await sb.from("user_weekly_points").select("advantages,penalty").eq("user_id", user)).data as any[];
  const rawB = (weeks ?? []).reduce((s, r) => s + (r.advantages ?? 0), 0);
  const C = (weeks ?? []).reduce((s, r) => s + (r.penalty ?? 0), 0);
  const finalB = rawB - C;
  console.log(`대상 U(로스터 최소 최종B): ${name} (${user}) · ${org}`);
  console.log(`(1) rawB=${rawB}  (2) pointC=${C}  (3) rawB−C=${finalB} ← 기대 최종 B (음수)\n`);

  // (4)(5) members 로스터 API 표시값 == 최종B
  ck(`(4/5) roster API Po.B == 최종B (음수)`, member.poB === finalB && member.poC === C, `poB=${member.poB} poC=${member.poC}(C=${C})`);

  // (6) CrewDetail API (/api/admin/members/[userId])
  const crew = await http(`/api/admin/members/${user}?organization=${org}&mode=operating`);
  const d = crew.json?.data ?? crew.json;
  const clubPoB = d?.clubSummary?.poB;
  ck(`(6) CrewDetail clubSummary.poB == 최종B`, clubPoB === finalB, `status=${crew.status} clubSummary.poB=${clubPoB}${crew.status !== 200 ? " err=" + J(crew.json) : ""}`);
  // 시즌 합 = 최종B (시즌별 poB=net 합산)
  const seasonSum = (d?.seasonResults ?? []).reduce((s: number, r: any) => s + (r.poB ?? 0), 0);
  const seasonPoC = (d?.seasonResults ?? []).reduce((s: number, r: any) => s + (r.poC ?? 0), 0);
  ck(`(6b) Σ시즌 poB == 최종B (전환/휴식 포함 시즌 합)`, seasonSum === finalB, `Σ시즌poB=${seasonSum} ΣpoC=${seasonPoC}`);

  // (7) info-stats API — 리더보드 poB(=주차 1위 크루 최종B). 값>0 후보만 → 음수 아님. 응답/의미 확인.
  const info = await http(`/api/admin/members/info-stats?organization=${org}`);
  const wks = (info.json?.data?.weeks ?? info.json?.weeks ?? []) as any[];
  const leaderBs = wks.map((w) => w.weeklyPointLeaders?.poB).filter(Boolean);
  ck(`(7) info-stats API 200 & poB 리더(최종B 기준) 존재`, info.status === 200 && wks.length > 0, `주차 ${wks.length} · poB리더 ${leaderBs.length}`);

  // (8) 고객 weekly-cards — per-week shield=adv−pen (같은 사용자 최종B, 주차 단위)
  const uwpRows = (await sb.from("user_weekly_points").select("year,week_number,advantages,penalty").eq("user_id", user)).data as any[];
  const netByWk = new Map<string, number>();
  for (const r of uwpRows ?? []) netByWk.set(`${r.year}-${r.week_number}`, (r.advantages ?? 0) - (r.penalty ?? 0));
  const cust = await http(`/api/cluster4/weekly-cards?userId=${user}`, { "x-internal-api-key": INTERNAL_KEY });
  const cards = (cust.json?.data ?? []) as any[];
  const weekIds = [...new Set(cards.map((c) => c.weekId).filter(Boolean))];
  const wk = (await sb.from("weeks").select("id,iso_year,iso_week").in("id", weekIds)).data as any[];
  const isoById = new Map<string, string>((wk ?? []).map((w) => [w.id, `${w.iso_year}-${w.iso_week}`]));
  let matched = 0, mismatch = 0, neg = 0;
  for (const c of cards) {
    const shield = c.points?.shield;
    if (shield < 0) neg++;
    if (shield == null || !c.weekId) continue;
    const key = isoById.get(c.weekId);
    if (key == null || !netByWk.has(key)) continue;
    matched++; if (shield !== netByWk.get(key)) mismatch++;
  }
  ck(`(8) 고객 per-week Point B(shield)=adv−pen [${matched}주차]`, matched > 0 && mismatch === 0, `mismatch=${mismatch}, shield<0 ${neg}`);

  // (파리티) 고객 DTO 경로: internal(일반) vs mode=test — 동일 shield
  const norm = await http(`/api/cluster4/weekly-cards?userId=${user}`, { "x-internal-api-key": INTERNAL_KEY });
  const test = await http(`/api/cluster4/weekly-cards?userId=${user}&mode=test`, { "x-internal-api-key": INTERNAL_KEY });
  const shieldOf = (r: any) => (r.json?.data ?? []).map((c: any) => `${c.weekId}:${c.points?.shield}`).join("|");
  ck(`(파리티) 일반 vs mode=test 고객 Point B 동일`, shieldOf(norm) === shieldOf(test), `norm==test:${shieldOf(norm) === shieldOf(test)}`);

  console.log(`\n═══ 요약 ═══`);
  console.log(`  rawB=${rawB} · pointC=${C} · rawB−C=${finalB}`);
  console.log(`  roster API=${member?.poB} · CrewDetail=${clubPoB} · Σ시즌=${seasonSum} · (모두 최종B ${finalB})`);
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
