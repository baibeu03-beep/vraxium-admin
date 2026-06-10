/**
 * 주차 카드 집계 확정 == /weekly-ranking 정합 검증 (2026-spring W1~W13, 멀티 org).
 *
 *   front HTTP  : GET {FRONT}/api/weekly-league?org={ORG}   (aggregateWeeklyLeague SoT)
 *   admin direct: computeWeeklyLeagueAggregation(ORG)        (front 1:1 이식)
 *   admin HTTP  : GET {ADMIN}/api/admin/weekly-card-finalization/preview?seasonId=2026-spring&weekNumber=W&org=ORG
 *
 * 완료기준(각 org): W1~W13 전부 front == admin direct == admin HTTP (total/success/fail/rest).
 *   + oranke 기존 정합 불변, preview snapshot write 0.
 *
 * Usage: ORGS=encre,oranke npx tsx --env-file=.env.local scripts/verify-finalization-vs-ranking.ts
 *   (admin dev :3000, front dev :3001 둘 다 실행 중)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { computeWeeklyLeagueAggregation } from "@/lib/weeklyLeaguePmsAggregation";

const ADMIN = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const FRONT = process.env.FRONT_BASE_URL ?? "http://localhost:3001";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const ORGS = (process.env.ORGS ?? "encre,oranke").split(",").map((s) => s.trim());
const SEASON = "2026-spring";

function ensureEnv(n: string) { const v = process.env[n]; if (!v) throw new Error(`Missing ${n}`); return v; }
const sb = createClient(ensureEnv("NEXT_PUBLIC_SUPABASE_URL"), ensureEnv("SUPABASE_SERVICE_ROLE_KEY"));

async function makeAdminCookieHeader(): Promise<string> {
  const url = ensureEnv("NEXT_PUBLIC_SUPABASE_URL"), anon = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(url, ensureEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const browser = createClient(url, anon);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: vd } = await browser.auth.verifyOtp({ email: adminEmail, token: link!.properties!.email_otp!, type: "magiclink" });
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(url, anon, { cookies: { getAll: () => [], setAll: (it) => void captured.push(...it.map((i) => ({ name: i.name, value: i.value }))) } });
  await server.auth.setSession({ access_token: vd!.session!.access_token, refresh_token: vd!.session!.refresh_token });
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

type Quad = { total: number; success: number; fail: number; rest: number };
const fmt = (q: Quad | null) => (q ? `${q.total}/${q.success}/${q.fail}/${q.rest}` : "—");
const eqQ = (a: Quad | null, b: Quad | null) => !!a && !!b && a.total === b.total && a.success === b.success && a.fail === b.fail && a.rest === b.rest;

async function cohortSnapRows(org: string, start: string): Promise<number> {
  const { data: uws } = await sb.from("user_week_statuses").select("user_id").eq("week_start_date", start);
  const ids = Array.from(new Set(((uws ?? []) as any[]).map((r) => r.user_id)));
  const { data: profs } = await sb.from("user_profiles").select("user_id").eq("organization_slug", org).in("user_id", ids);
  const orgIds = ((profs ?? []) as any[]).map((p) => p.user_id);
  if (orgIds.length === 0) return 0;
  const { count } = await sb.from("cluster4_weekly_card_snapshots").select("user_id", { count: "exact", head: true }).in("user_id", orgIds);
  return count ?? 0;
}

async function verifyOrg(org: string, cookie: string): Promise<boolean> {
  console.log(`\n────────── ${org.toUpperCase()} 2026-spring W1~W13 ──────────`);

  const frontRes = await fetch(`${FRONT}/api/weekly-league?org=${org}`, { redirect: "follow", cache: "no-store" });
  const frontJson = await frontRes.json();
  if (!frontJson.success) { console.log(`  ✗ front API fail: ${frontJson.error}`); return false; }
  const frontByWeek = new Map<number, Quad>();
  for (const c of frontJson.cards as any[]) frontByWeek.set(c.weekNumber, { total: c.totalCrews, success: c.growthSuccess, fail: c.growthFail, rest: c.personalRest });

  const adminAgg = await computeWeeklyLeagueAggregation(org);
  const directByWeek = new Map<number, Quad>();
  for (const w of adminAgg.byWeekId.values()) directByWeek.set(w.weekNumber, { total: w.totalCrew, success: w.growthSuccess, fail: w.growthFail, rest: w.personalRest });

  const httpByWeek = new Map<number, Quad>();
  for (let w = 1; w <= 13; w++) {
    const res = await fetch(`${ADMIN}/api/admin/weekly-card-finalization/preview?${new URLSearchParams({ seasonId: SEASON, weekNumber: String(w), org })}`, { headers: { cookie }, cache: "no-store" });
    const a = (await res.json())?.data?.aggregation;
    httpByWeek.set(w, a ? { total: a.totalCrew, success: a.growthSuccess, fail: a.growthFail, rest: a.personalRest } : (null as any));
  }

  console.log("week | weekly-ranking | admin preview  | 일치");
  console.log("-----|----------------|----------------|-----");
  let allMatch = true;
  for (let w = 1; w <= 13; w++) {
    const f = frontByWeek.get(w) ?? null, d = directByWeek.get(w) ?? null, h = httpByWeek.get(w) ?? null;
    const match = eqQ(f, d) && eqQ(d, h);
    if (!match) allMatch = false;
    console.log(`W${String(w).padStart(2, "0")}  | ${fmt(f).padEnd(14)} | ${fmt(h).padEnd(14)} | ${match ? "✓" : `✗ direct=${fmt(d)}`}`);
  }

  // snapshot 읽기전용 (W13 코호트 행 수 불변)
  const w13 = adminAgg.byWeekId.size ? [...adminAgg.byWeekId.values()].find((x) => x.weekNumber === 13) : null;
  let snapOk = true;
  if (w13) {
    const before = await cohortSnapRows(org, w13.startDate);
    await fetch(`${ADMIN}/api/admin/weekly-card-finalization/preview?${new URLSearchParams({ seasonId: SEASON, weekNumber: "13", org })}`, { headers: { cookie }, cache: "no-store" });
    const after = await cohortSnapRows(org, w13.startDate);
    snapOk = before === after;
    console.log(`  ${snapOk ? "✓" : "✗"} preview snapshot write 0 (before=${before} after=${after})`);
  }
  console.log(`  ${allMatch ? "✓" : "✗"} ${org} W1~W13 전부 일치`);
  return allMatch && snapOk;
}

async function main() {
  console.log(`\n=== finalization == weekly-ranking 정합 (${ORGS.join(", ")}) ===`);
  const cookie = await makeAdminCookieHeader();
  let ok = true;
  for (const org of ORGS) ok = (await verifyOrg(org, cookie)) && ok;
  console.log(`\n=== ${ok ? "PASS" : "FAIL"} ===\n`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
