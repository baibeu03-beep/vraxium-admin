// APPLY — 명백히 타 팀/타 파트 스코프 오적립 스테일 원장만 소프트취소(회수).
//   · 파트장 정책/[가이드 적용] 무관 — 본인 팀·본인 파트·팀총괄 행은 절대 대상 아님.
//   · 삭제 아님(soft-cancel): cancelled_at 각인 → 공통 recompute(취소행 제외) → 성장 재판정 → snapshot 재생성.
//   · 멱등: 이미 취소된 행은 softCancelActAwards 가 스킵.
//   DRY-RUN 기본. 실제 적용은  APPLY=1 환경변수.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { softCancelActAwards } from "@/lib/processPointAccrual";

const APPLY = process.env.APPLY === "1";
const CANCELLED_BY = "c28b2409-4118-49fc-a42e-68e18dbd194c"; // 이 체크들을 실행한 운영 관리자(requested_by)
const REASON = "배포 이전(pre-98fbd06) 로스터 미적용 · 타 팀/파트 교차 스코프 오적립 스테일 회수";
const EXCLUDED_PARTS = new Set(["일반", ""]);
function chunk<T>(a: T[], n: number): T[][] { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

async function flagged() {
  const { data: st } = await supabaseAdmin.from("process_check_statuses").select("id,week_id,team_id,part_name,act_id").eq("hub", "experience");
  const statuses = (st ?? []) as any[];
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const teamIds = [...new Set(statuses.map((s) => s.team_id).filter(Boolean))] as string[];
  const tName = new Map<string, string>();
  for (const c of chunk(teamIds, 200)) { const { data } = await supabaseAdmin.from("cluster4_teams").select("id,team_name").in("id", c); for (const t of (data ?? []) as any[]) tName.set(t.id, t.team_name); }
  const stIds = statuses.map((s) => s.id);
  const awards: any[] = [];
  for (const c of chunk(stIds, 150)) { const { data } = await supabaseAdmin.from("process_point_awards").select("id,ref_id,user_id,week_number,year").eq("source", "regular").in("ref_id", c).is("cancelled_at", null); for (const a of (data ?? []) as any[]) awards.push(a); }
  const uids = [...new Set(awards.map((a) => a.user_id))];
  const mem = new Map<string, { team: string | null; part: string | null }>();
  for (const c of chunk(uids, 200)) { const { data } = await supabaseAdmin.from("user_memberships").select("user_id,team_name,part_name,is_current").in("user_id", c); for (const m of (data ?? []) as any[]) { const ex = mem.get(m.user_id); if (!ex || m.is_current) mem.set(m.user_id, { team: m.team_name, part: m.part_name }); } }
  const out: Array<{ awardId: string; userId: string; weekId: string }> = [];
  for (const aw of awards) {
    const s = byId.get(aw.ref_id); if (!s) continue;
    const m = mem.get(aw.user_id) ?? { team: null, part: null };
    const stTeam = s.team_id ? tName.get(s.team_id) ?? null : null;
    const crossTeam = !!stTeam && !!m.team && stTeam !== m.team;
    const crossPart = !!s.part_name && !EXCLUDED_PARTS.has(s.part_name) && !!m.part && !EXCLUDED_PARTS.has(m.part) && s.part_name !== m.part;
    if (crossTeam || crossPart) out.push({ awardId: aw.id, userId: aw.user_id, weekId: s.week_id });
  }
  return out;
}

async function main() {
  const rows = await flagged();
  console.log(`flagged cross-scope stale awards: ${rows.length}  (mode=${APPLY ? "APPLY" : "DRY-RUN"})`);
  const byUser = new Map<string, { weekId: string; ids: string[] }>();
  for (const r of rows) { const e = byUser.get(r.userId) ?? { weekId: r.weekId, ids: [] }; e.ids.push(r.awardId); byUser.set(r.userId, e); }

  for (const [userId, { weekId, ids }] of byUser) {
    console.log(`\nuser=${userId} weekId=${weekId} awards=${ids.length} [${ids.join(", ")}]`);
    if (!APPLY) continue;
    const res = await softCancelActAwards({ awardIds: ids, userId, weekId, cancelledBy: CANCELLED_BY, reason: REASON });
    console.log(`  → cancelledCount=${res.cancelledCount} growth=${res.growth ? JSON.stringify(res.growth) : "null"}`);
  }
  console.log(`\n${APPLY ? "APPLIED" : "DRY-RUN complete (set APPLY=1 to execute)"}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
