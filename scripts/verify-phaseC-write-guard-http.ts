// 검증(HTTP) — Phase C: 임퍼소네이션 write 가드(403) + write 격리.
//   사전: dev 서버(:3000). 실행: npx tsx --env-file=.env.local scripts/verify-phaseC-write-guard-http.ts
// 실패 케이스=write row 0 / 성공 케이스(part_leader 자기 파트)=저장 후 즉시 정리(net-zero).

import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { memberStatusLabel } from "@/lib/adminMembersTypes";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

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

async function findByRole(want: "team_leader" | "part_leader" | "agent") {
  const ids = [...(await fetchTestUserMarkerIds())];
  const { data: profs } = await sb.from("user_profiles").select("user_id,role,organization_slug").in("user_id", ids);
  const pById = new Map(((profs ?? []) as any[]).map((p) => [p.user_id, p]));
  const { data: mems } = await sb.from("user_memberships").select("user_id,team_name,part_name,membership_level,is_current").in("user_id", ids);
  const cur = new Map<string, any>();
  for (const m of (mems ?? []) as any[]) { const e = cur.get(m.user_id); if (!e || (m.is_current && !e.is_current)) cur.set(m.user_id, m); }
  for (const id of ids) {
    const p = pById.get(id); const m = cur.get(id); if (!p || !m) continue;
    const label = memberStatusLabel(p.role, m.membership_level);
    const r = label === "팀장" ? "team_leader" : label === "심화(파트장)" ? "part_leader" : label === "심화(에이전트)" ? "agent" : "member";
    if (r === want) return { userId: id, org: p.organization_slug as string, team: m.team_name as string, part: m.part_name as string };
  }
  return null;
}
async function teamId(org: string, team: string) {
  const { data } = await sb.from("cluster4_teams").select("id").eq("organization_slug", org).eq("team_name", team).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}
async function curWeekId() {
  const { data } = await sb.from("weeks").select("id").order("start_date", { ascending: false }).limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

async function main() {
  const c = await cookie();
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/admin/cluster4/admin-org`, { headers: { cookie: c } })).status === 200) break; } catch {/* wait */}
    await new Promise((r) => setTimeout(r, 2000));
  }
  const snap = async () => (await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true })).count ?? 0;
  const snapBefore = await snap();

  const pl = await findByRole("part_leader");
  const ag = await findByRole("agent");
  const tl = await findByRole("team_leader");
  if (!pl || !ag || !tl) { console.log("역할 표본 부족", { pl: !!pl, ag: !!ag, tl: !!tl }); }

  const weekId = await curWeekId();
  const partInputPost = (bodyObj: any) =>
    fetch(`${BASE}/api/admin/cluster4/experience/part-input`, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(bodyObj) });
  const teamOverallPost = (bodyObj: any) =>
    fetch(`${BASE}/api/admin/cluster4/experience/team-overall`, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(bodyObj) });

  // 헤더 존재 여부(part submission) 카운트.
  const hdrCount = async (org: string, tid: string, partName: string) =>
    (await sb.from("cluster4_experience_part_submissions").select("id", { count: "exact", head: true })
      .eq("organization_slug", org).eq("week_id", weekId).eq("team_id", tid).eq("part_name", partName)).count ?? 0;

  // ── part_leader: 자기 파트 저장(성공) → 정리 / 다른 파트·다른 팀(403, write 0) ──
  if (pl && weekId) {
    const ownTid = await teamId(pl.org, pl.team);
    // 다른 팀(같은 org 의 다른 (T) 팀) 찾기.
    const { data: otherTeam } = await sb.from("cluster4_teams").select("id,team_name").eq("organization_slug", pl.org).neq("team_name", pl.team).ilike("team_name", "%(T)%").limit(1).maybeSingle();
    const otherTid = (otherTeam as any)?.id ?? null;
    // 자기 파트의 테스트 크루 1명(셀 대상).
    const { data: crewMem } = await sb.from("user_memberships").select("user_id").eq("team_name", pl.team).eq("part_name", pl.part).limit(1).maybeSingle();
    const crewId = (crewMem as { user_id: string } | null)?.user_id ?? pl.userId;

    if (ownTid) {
      const before = await hdrCount(pl.org, ownTid, pl.part);
      const okRes = await partInputPost({ organization: pl.org, week_id: weekId, team_id: ownTid, team_name: pl.team, part: pl.part, mode: "test", actAsTestUserId: pl.userId, cells: [{ crewUserId: crewId, lineType: "derivation", checked: true, score: 5 }] });
      ck("[part_leader] 자기 팀+자기 파트 저장 성공(201)", okRes.status === 201, `status=${okRes.status}`);
      // 정리(net-zero) — 이 테스트로 생성됐다면 삭제.
      if (before === 0) {
        await sb.from("cluster4_experience_part_submissions").delete().eq("organization_slug", pl.org).eq("week_id", weekId).eq("team_id", ownTid).eq("part_name", pl.part);
      }
      ck("[part_leader] 정리 후 net-zero", (await hdrCount(pl.org, ownTid, pl.part)) === before, `before=${before}`);

      // 다른 파트(403, write 0)
      const otherPart = "__다른파트__";
      const beforeOther = await hdrCount(pl.org, ownTid, otherPart);
      const denyRes = await partInputPost({ organization: pl.org, week_id: weekId, team_id: ownTid, team_name: pl.team, part: otherPart, mode: "test", actAsTestUserId: pl.userId, cells: [{ crewUserId: crewId, lineType: "derivation", checked: true, score: 5 }] });
      ck("[part_leader] 다른 파트 저장 → 403", denyRes.status === 403, `status=${denyRes.status}`);
      ck("[part_leader] 다른 파트 실패 시 write 0", (await hdrCount(pl.org, ownTid, otherPart)) === beforeOther);
    }
    if (otherTid) {
      const denyTeam = await partInputPost({ organization: pl.org, week_id: weekId, team_id: otherTid, team_name: (otherTeam as any).team_name, part: "아무파트", mode: "test", actAsTestUserId: pl.userId, cells: [{ crewUserId: crewId, lineType: "derivation", checked: true, score: 5 }] });
      ck("[part_leader] 다른 팀 저장 → 403", denyTeam.status === 403, `status=${denyTeam.status}`);
    }
  }

  // ── agent: part_save 403 / 다른 팀 review 403 / open 403 ──
  if (ag && weekId) {
    const tid = await teamId(ag.org, ag.team);
    if (tid) {
      const r1 = await partInputPost({ organization: ag.org, week_id: weekId, team_id: tid, team_name: ag.team, part: ag.part ?? "아무파트", mode: "test", actAsTestUserId: ag.userId, cells: [] });
      ck("[agent] part_save → 403", r1.status === 403, `status=${r1.status}`);
      const r2 = await teamOverallPost({ action: "open", organization: ag.org, week_id: weekId, team_id: tid, team_name: ag.team, mode: "test", actAsTestUserId: ag.userId, leaderCells: [], outputs: [] });
      ck("[agent] open → 403", r2.status === 403, `status=${r2.status}`);
      // 다른 팀 review 403
      const { data: otherTeam } = await sb.from("cluster4_teams").select("id,team_name").eq("organization_slug", ag.org).neq("team_name", ag.team).ilike("team_name", "%(T)%").limit(1).maybeSingle();
      if (otherTeam) {
        const r3 = await teamOverallPost({ action: "review", organization: ag.org, week_id: weekId, team_id: (otherTeam as any).id, team_name: (otherTeam as any).team_name, mode: "test", actAsTestUserId: ag.userId, leaderCells: [], outputs: [] });
        ck("[agent] 다른 팀 review → 403", r3.status === 403, `status=${r3.status}`);
      }
    }
  }

  // ── team_leader: 다른 팀 open 403 ──
  if (tl && weekId) {
    const { data: otherTeam } = await sb.from("cluster4_teams").select("id,team_name").eq("organization_slug", tl.org).neq("team_name", tl.team).ilike("team_name", "%(T)%").limit(1).maybeSingle();
    if (otherTeam) {
      const r = await teamOverallPost({ action: "open", organization: tl.org, week_id: weekId, team_id: (otherTeam as any).id, team_name: (otherTeam as any).team_name, mode: "test", actAsTestUserId: tl.userId, leaderCells: [], outputs: [] });
      ck("[team_leader] 다른 팀 open → 403", r.status === 403, `status=${r.status}`);
    }
  }

  // ── owner/admin(임퍼 없음): part 저장 성공(기존 경로) → 정리 ──
  if (pl && weekId) {
    const ownTid = await teamId(pl.org, pl.team);
    if (ownTid) {
      const before = await hdrCount(pl.org, ownTid, pl.part);
      const r = await partInputPost({ organization: pl.org, week_id: weekId, team_id: ownTid, team_name: pl.team, part: pl.part, mode: "test", cells: [] }); // actAs 없음=임퍼 비활성
      ck("[owner/admin] 임퍼 없음 part 저장 성공(201)", r.status === 201, `status=${r.status}`);
      if (before === 0) await sb.from("cluster4_experience_part_submissions").delete().eq("organization_slug", pl.org).eq("week_id", weekId).eq("team_id", ownTid).eq("part_name", pl.part);
      ck("[owner/admin] 정리 후 net-zero", (await hdrCount(pl.org, ownTid, pl.part)) === before);
    }
  }

  const snapAfter = await snap();
  ck("[격리] snapshot count 불변", snapAfter === snapBefore, `${snapBefore}→${snapAfter}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
