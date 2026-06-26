/**
 * 검증 — 집계 RPC 적용 후: 미조회 0 · Po==원천 · 통합=합산 · direct==HTTP · timeout 미재현.
 * Usage: npx tsx --env-file=.env.local scripts/verify-info-stats-rpc-fix.ts
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
const LABEL: Record<string, string> = { all: "통합", encre: "엥크레", oranke: "오랑캐", phalanx: "팔랑크스" };

let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const strip = (d: any) => { const { generatedAt, ...r } = d ?? {}; return JSON.stringify(r); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
async function sourceTop(roster: { id: string; name: string }[], iy: number, iw: number) {
  const nameById = new Map(roster.map((r) => [r.id, r.name])); const ids = roster.map((r) => r.id);
  const list: { name: string; points: number }[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await supabaseAdmin.from("user_weekly_points").select("user_id, points").eq("year", iy).eq("week_number", iw).in("user_id", ids.slice(i, i + 300));
    for (const r of (data ?? []) as any[]) { const p = Number(r.points); if (p > 0) list.push({ name: nameById.get(r.user_id) ?? "-", points: p }); }
  }
  list.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, "ko"));
  return list.slice(0, 3);
}

async function main() {
  const ck_ = await cookie();
  const dtos: Record<string, any> = {};

  // ── 각 org: 시간측정 · 미조회 0 · direct==HTTP · Po==원천 ──
  for (const org of ["all", "encre", "oranke", "phalanx"]) {
    console.log(`\n════════ [${LABEL[org]}] (${org}) ════════`);
    const t0 = Date.now();
    const d = await loadMembersInfoStats({ organization: org as any, mode: "operating" });
    const ms = Date.now() - t0;
    dtos[org] = d;
    const pf = d.partialFailure?.snapshotUnavailable ?? 0;
    console.log(`   direct ${ms}ms · partialFailure=${pf} · weeks=${d.weeks.length}`);
    ck(`[${org}] 미조회 0 (경고 없음)`, pf === 0, `partialFailure=${pf}`);
    ck(`[${org}] timeout 미재현(<20s)`, ms < 20000, `${ms}ms`);

    // direct == HTTP
    const qs = org === "all" ? "" : `?organization=${org}`;
    const res = await fetch(`${BASE}/api/admin/members/info-stats${qs}`, { headers: { cookie: ck_ }, cache: "no-store" as RequestCache });
    const j: any = await res.json();
    ck(`[${org}] HTTP 200 · partialFailure 0`, res.ok && j.success === true && (j.data?.partialFailure?.snapshotUnavailable ?? 0) === 0);
    ck(`[${org}] direct == HTTP`, strip(d) === strip(j.data), strip(d) === strip(j.data) ? "" : "불일치(converge 중일 수 있음)");

    // Po == 원천 (조직별 탭만)
    if (org !== "all") {
      const roster = await clubRoster(org);
      const samples = d.weeks.filter((w: any) => w.finalized && w.weeklyTopPoints?.length).slice(0, 2);
      for (const w of samples) {
        const { data: wk } = await supabaseAdmin.from("weeks").select("iso_year, iso_week").eq("id", w.weekId).maybeSingle();
        const src = await sourceTop(roster, (wk as any).iso_year, (wk as any).iso_week);
        const m = JSON.stringify(w.weeklyTopPoints.map((t: any) => [t.name, t.points])) === JSON.stringify(src.map((t) => [t.name, t.points]));
        ck(`[${org}] ${w.seasonWeekName} Po == 원천 Top3`, m, m ? "" : `DTO=${JSON.stringify(w.weeklyTopPoints)} 원천=${JSON.stringify(src)}`);
      }
    }
  }

  // ── 통합 = 합산 ──
  console.log("\n════════ 통합 = 엥크레+오랑캐+팔랑크스 ════════");
  const a = dtos.all, e = dtos.encre, o = dtos.oranke, p = dtos.phalanx;
  ck("누적 클러빙 합산", a.cumulative.cumulativeClubbing === e.cumulative.cumulativeClubbing + o.cumulative.cumulativeClubbing + p.cumulative.cumulativeClubbing,
    `${a.cumulative.cumulativeClubbing} = ${e.cumulative.cumulativeClubbing}+${o.cumulative.cumulativeClubbing}+${p.cumulative.cumulativeClubbing}`);
  const idx = (d: any) => new Map(d.weeks.map((w: any) => [w.weekId, w]));
  const mE = idx(e), mO = idx(o), mP = idx(p);
  let mism = 0;
  for (const w of a.weeks) {
    if (!w.finalized) continue;
    for (const f of ["growthSuccess", "growthFail", "weeklyRest", "seasonalRest", "clubbing"]) {
      const sum = [mE, mO, mP].reduce((s, m) => s + ((m.get(w.weekId) as any)?.[f] ?? 0), 0);
      if ((w[f] ?? 0) !== sum) mism++;
    }
  }
  ck(`확정 주차 all=en+ok+px (불일치 ${mism})`, mism === 0);

  console.log("\n── snapshot 영향/재계산: none(읽기 전용 RPC·snapshot 무접촉) ──");
  console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
