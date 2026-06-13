// 검증(HTTP, READ-ONLY) — Phase A: part-input GET actor 임퍼소네이션 + 회귀.
//   사전: dev 서버(:3000). 실행: npx tsx --env-file=.env.local scripts/verify-phaseA-impersonation-http.ts

import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { resolveActorContext } from "@/lib/adminExperiencePartInput";
import { memberStatusLabel } from "@/lib/adminMembersTypes";

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

async function findTestUserByRole(want: "team_leader" | "part_leader" | "agent") {
  const testIds = [...(await fetchTestUserMarkerIds())];
  const { data: profs } = await sb.from("user_profiles").select("user_id,role").in("user_id", testIds);
  const roleById = new Map(((profs ?? []) as any[]).map((p) => [p.user_id, p.role]));
  const { data: mems } = await sb.from("user_memberships").select("user_id,team_name,part_name,membership_level,is_current").in("user_id", testIds);
  const cur = new Map<string, any>();
  for (const m of (mems ?? []) as any[]) { const e = cur.get(m.user_id); if (!e || (m.is_current && !e.is_current)) cur.set(m.user_id, m); }
  for (const id of testIds) {
    const m = cur.get(id); if (!m) continue;
    const label = memberStatusLabel(roleById.get(id) ?? null, m.membership_level);
    const role = label === "팀장" ? "team_leader" : label === "심화(파트장)" ? "part_leader" : label === "심화(에이전트)" ? "agent" : "member";
    if (role === want) return { userId: id, team: m.team_name, part: m.part_name };
  }
  return null;
}

async function main() {
  const c = await cookie();
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/admin/cluster4/admin-org`, { headers: { cookie: c } })).status === 200) break; } catch {/* wait */}
    await new Promise((r) => setTimeout(r, 2000));
  }
  const snap = async () => (await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true })).count ?? 0;
  const before = await snap();

  const base = `${BASE}/api/admin/cluster4/experience/part-input?organization=${ORG}`;

  // ── owner 기본(임퍼 없음) actor — 회귀: impersonating=false ──
  const ownerActor = (await j(`${base}`, c)).data.actor;
  ck("[회귀] 임퍼 없음 → actor.impersonating=false", ownerActor.impersonating === false || ownerActor.impersonating === undefined, JSON.stringify({ memberRole: ownerActor.memberRole, imp: ownerActor.impersonating }));

  // ── part_leader 임퍼(mode=test) → actor 일치(direct==HTTP) ──
  const pl = await findTestUserByRole("part_leader");
  if (pl) {
    const url = `${base}&mode=test&actAsTestUserId=${pl.userId}`;
    const httpActor = (await j(url, c)).data.actor;
    const direct = await resolveActorContext(pl.userId);
    ck("[part_leader] HTTP actor.memberRole=part_leader", httpActor.memberRole === "part_leader", `role=${httpActor.memberRole}`);
    ck("[part_leader] HTTP actor.team/part 일치(direct==HTTP)", httpActor.teamName === direct.teamName && httpActor.partName === direct.partName, `${httpActor.teamName}/${httpActor.partName}`);
    ck("[part_leader] HTTP actor.impersonating=true + impersonatedUserId", httpActor.impersonating === true && httpActor.impersonatedUserId === pl.userId);
  } else ck("[part_leader] 표본", false);

  // ── agent / team_leader 임퍼 ──
  const ag = await findTestUserByRole("agent");
  if (ag) {
    const a = (await j(`${base}&mode=test&actAsTestUserId=${ag.userId}`, c)).data.actor;
    ck("[agent] HTTP actor.memberRole=agent", a.memberRole === "agent", `team=${a.teamName}`);
  }
  const tl = await findTestUserByRole("team_leader");
  if (tl) {
    const a = (await j(`${base}&mode=test&actAsTestUserId=${tl.userId}`, c)).data.actor;
    ck("[team_leader] HTTP actor.memberRole=team_leader + team 정확", a.memberRole === "team_leader" && a.teamName === tl.team, `${a.teamName}`);
  }

  // ── 실사용자 actAs → 임퍼 비활성(admin 기준 actor) ──
  const { data: rp } = await sb.from("user_profiles").select("user_id").eq("organization_slug", ORG).limit(400);
  const testSet = await fetchTestUserMarkerIds();
  const realId = ((rp ?? []) as any[]).map((r) => r.user_id).find((id) => !testSet.has(id));
  if (realId) {
    const a = (await j(`${base}&mode=test&actAsTestUserId=${realId}`, c)).data.actor;
    ck("[실사용자] HTTP 임퍼 비활성(impersonating=false)", a.impersonating === false, `imp=${a.impersonating}`);
  }

  // ── operating + 테스트 유저 actAs → 비활성 ──
  if (pl) {
    const a = (await j(`${base}&actAsTestUserId=${pl.userId}`, c)).data.actor; // mode 없음=operating
    ck("[operating] HTTP 임퍼 비활성", a.impersonating === false, `imp=${a.impersonating}`);
  }

  const after = await snap();
  ck("[격리] snapshot count 불변", after === before, `${before}→${after}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
