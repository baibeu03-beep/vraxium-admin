// Blast-radius scan (READ-ONLY) — experience 정규 원장 중 "명백히 타 팀/타 파트 스코프" 오적립 스테일 행.
//   기준(파트장 정책과 무관·안전): award→status(experience) 의 team/part 가 그 user 의 실제 소속과
//   명백히 다를 때만 플래그. (본인 팀·본인 파트·팀총괄(part=null) 행은 건드리지 않는다.)
//   → 파트장 비대상 정책 판단이 필요한 행(본인 파트/본인 팀총괄)은 절대 포함하지 않음.
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const EXCLUDED_PARTS = new Set(["일반", ""]);
function chunk<T>(a: T[], n: number): T[][] { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

async function main() {
  // 1. experience status 전부(스코프 맵).
  const { data: st, error: stErr } = await supabaseAdmin
    .from("process_check_statuses")
    .select("id,organization_slug,week_id,team_id,part_name,act_id,scope_mode")
    .eq("hub", "experience");
  if (stErr) throw stErr;
  const statuses = (st ?? []) as Array<{ id: string; organization_slug: string; week_id: string; team_id: string | null; part_name: string | null; act_id: string; scope_mode: string | null }>;
  const statusById = new Map(statuses.map((s) => [s.id, s]));
  console.log(`experience statuses: ${statuses.length}`);

  // 2. team_id → team_name.
  const teamIds = [...new Set(statuses.map((s) => s.team_id).filter((x): x is string => !!x))];
  const teamName = new Map<string, { name: string; org: string }>();
  for (const c of chunk(teamIds, 200)) {
    const { data } = await supabaseAdmin.from("cluster4_teams").select("id,team_name,organization_slug").in("id", c);
    for (const t of (data ?? []) as any[]) teamName.set(t.id, { name: t.team_name, org: t.organization_slug });
  }

  // 3. 그 status 들에 걸린 regular 원장(미취소).
  const stIds = statuses.map((s) => s.id);
  const awards: Array<{ id: string; ref_id: string; user_id: string; year: number; week_number: number; point_check: number; point_advantage: number; point_penalty: number }> = [];
  for (const c of chunk(stIds, 150)) {
    const { data } = await supabaseAdmin
      .from("process_point_awards")
      .select("id,ref_id,user_id,year,week_number,point_check,point_advantage,point_penalty")
      .eq("source", "regular").in("ref_id", c).is("cancelled_at", null);
    for (const a of (data ?? []) as any[]) awards.push(a);
  }
  console.log(`regular experience awards (uncancelled): ${awards.length}`);

  // 4. 관련 user 멤버십(team_name, part_name) — is_current 우선.
  const userIds = [...new Set(awards.map((a) => a.user_id))];
  const mem = new Map<string, { team: string | null; part: string | null }>();
  for (const c of chunk(userIds, 200)) {
    const { data } = await supabaseAdmin.from("user_memberships").select("user_id,team_name,part_name,is_current").in("user_id", c);
    for (const m of (data ?? []) as any[]) {
      const ex = mem.get(m.user_id);
      if (!ex || m.is_current) mem.set(m.user_id, { team: m.team_name, part: m.part_name });
    }
  }
  const prof = new Map<string, { name: string; role: string }>();
  for (const c of chunk(userIds, 200)) {
    const { data } = await supabaseAdmin.from("user_profiles").select("user_id,display_name,role").in("user_id", c);
    for (const p of (data ?? []) as any[]) prof.set(p.user_id, { name: p.display_name, role: p.role });
  }

  // 5. 판정 — cross_team 또는 cross_part 만 플래그.
  type Flag = { awardId: string; user: string; role: string; act: string; statusId: string; statusTeam: string | null; statusPart: string | null; userTeam: string | null; userPart: string | null; reason: string; a: number; b: number; c: number; year: number; wk: number };
  const flags: Flag[] = [];
  const actName = new Map<string, string>();
  const actIds = [...new Set(statuses.map((s) => s.act_id))];
  for (const c of chunk(actIds, 200)) {
    const { data } = await supabaseAdmin.from("process_acts").select("id,act_name").in("id", c);
    for (const a of (data ?? []) as any[]) actName.set(a.id, a.act_name);
  }

  for (const aw of awards) {
    const s = statusById.get(aw.ref_id); if (!s) continue;
    const m = mem.get(aw.user_id) ?? { team: null, part: null };
    const stTeam = s.team_id ? teamName.get(s.team_id)?.name ?? null : null;
    const crossTeam = !!stTeam && !!m.team && stTeam !== m.team;
    const stPart = s.part_name;
    const crossPart = !!stPart && !EXCLUDED_PARTS.has(stPart) && !!m.part && !EXCLUDED_PARTS.has(m.part) && stPart !== m.part;
    if (!crossTeam && !crossPart) continue;
    const reason = [crossTeam ? `cross_team(status=${stTeam}≠user=${m.team})` : "", crossPart ? `cross_part(status=${stPart}≠user=${m.part})` : ""].filter(Boolean).join(" & ");
    flags.push({ awardId: aw.id, user: prof.get(aw.user_id)?.name ?? aw.user_id, role: prof.get(aw.user_id)?.role ?? "?", act: actName.get(s.act_id) ?? s.act_id, statusId: s.id, statusTeam: stTeam, statusPart: stPart, userTeam: m.team, userPart: m.part, reason, a: aw.point_check, b: aw.point_advantage, c: aw.point_penalty, year: aw.year, wk: aw.week_number });
  }

  console.log(`\n=== CLEARLY-CROSS-SCOPE STALE AWARDS: ${flags.length} ===`);
  flags.sort((x, y) => (x.user + x.act).localeCompare(y.user + y.act));
  for (const f of flags) {
    console.log(`  award=${f.awardId} | ${f.user}(${f.role}) | "${f.act}" | ${f.reason} | A=${f.a} B=${f.b} C=${f.c} | iso(${f.year},${f.wk}) | status=${f.statusId}`);
  }
  // 사용자별 요약
  const byUser = new Map<string, number>();
  for (const f of flags) byUser.set(f.user, (byUser.get(f.user) ?? 0) + 1);
  console.log(`\n=== per-user count ===`);
  for (const [u, n] of [...byUser.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${u}: ${n}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
