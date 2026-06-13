// 검증(HTTP, READ-ONLY) — Phase 4: teams/crews/members direct==HTTP + mode 분리.
//   사전: dev 서버(:3000). 실행: npx tsx --env-file=.env.local scripts/verify-phase4-endpoints-scope-http.ts

import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { listCrewsForTargetSelection } from "@/lib/adminExperienceLineData";
import { listMembers } from "@/lib/adminMembersData";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);
const ORG = "oranke";

let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cookie(): Promise<string> {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  const otp = link.properties?.email_otp; if (!otp) throw new Error("otp");
  const { data: v } = await browser.auth.verifyOtp({ email: ADMIN_EMAIL, token: otp, type: "magiclink" });
  const cap: Array<{ name: string; value: string }> = [];
  const srv = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}
const j = async (url: string, c: string) => (await fetch(url, { headers: { cookie: c } })).json();

async function main() {
  const c = await cookie();
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/admin/cluster4/admin-org`, { headers: { cookie: c } })).status === 200) break; } catch {/* wait */}
    await new Promise((r) => setTimeout(r, 2000));
  }
  const testSet = await fetchTestUserMarkerIds();
  const snap = async () => (await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true })).count ?? 0;
  const before = await snap();

  // ── teams ──
  const teamsOp = (await j(`${BASE}/api/admin/cluster4/teams?organization=${ORG}`, c)).data as { teamName: string }[];
  const teamsTs = (await j(`${BASE}/api/admin/cluster4/teams?organization=${ORG}&mode=test`, c)).data as { teamName: string }[];
  ck("[teams HTTP] operating (T) 0개", teamsOp.every((t) => !/\(T\)$/.test(t.teamName)), teamsOp.map((t) => t.teamName).join(","));
  ck("[teams HTTP] test = (T) 3개", teamsTs.length === 3 && teamsTs.every((t) => /\(T\)$/.test(t.teamName)), teamsTs.map((t) => t.teamName).join(","));

  // ── crews direct==HTTP ──
  const crewsOpD = await listCrewsForTargetSelection({ organization: ORG });
  const crewsOpH = (await j(`${BASE}/api/admin/cluster4/crews?organization=${ORG}`, c)).data;
  ck("[crews HTTP] operating direct==HTTP", JSON.stringify(crewsOpD) === JSON.stringify(crewsOpH), `n=${crewsOpH.length}`);
  ck("[crews HTTP] operating test 0명", (crewsOpH as { userId: string }[]).every((x) => !testSet.has(x.userId)));
  const crewsTsD = await listCrewsForTargetSelection({ organization: ORG, mode: "test" });
  const crewsTsH = (await j(`${BASE}/api/admin/cluster4/crews?organization=${ORG}&mode=test`, c)).data;
  ck("[crews HTTP] test direct==HTTP", JSON.stringify(crewsTsD) === JSON.stringify(crewsTsH), `n=${crewsTsH.length}`);
  ck("[crews HTTP] test 전원 marker", (crewsTsH as { userId: string }[]).length > 0 && (crewsTsH as { userId: string }[]).every((x) => testSet.has(x.userId)));

  // ── members direct==HTTP ──
  const memOpD = await listMembers({ organization: ORG, limit: 500 });
  const memOpH = (await j(`${BASE}/api/admin/members?organization=${ORG}&limit=500`, c)).data;
  ck("[members HTTP] operating total 일치", memOpH.total === memOpD.total, `direct=${memOpD.total} http=${memOpH.total}`);
  ck("[members HTTP] operating test 0명", (memOpH.members as { userId: string }[]).every((m) => !testSet.has(m.userId)));
  const memTsD = await listMembers({ organization: ORG, limit: 500, mode: "test" });
  const memTsH = (await j(`${BASE}/api/admin/members?organization=${ORG}&limit=500&mode=test`, c)).data;
  ck("[members HTTP] test total 일치", memTsH.total === memTsD.total, `direct=${memTsD.total} http=${memTsH.total}`);
  ck("[members HTTP] test 전원 marker", (memTsH.members as { userId: string }[]).length > 0 && (memTsH.members as { userId: string }[]).every((m) => testSet.has(m.userId)));

  const after = await snap();
  ck("[격리] snapshot count 불변", after === before, `${before}→${after}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
