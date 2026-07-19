// E2E: 동일 카페 게시물이 여러 파트 체크에 걸려도 크루당 원장 1행만 생성되는지 검증.
// ─────────────────────────────────────────────────────────────────────
//   재현 대상 버그(2026-07-13 pre-98fbd06): experience 정규 체크에서 로스터 교집합이 없어,
//     같은 게시물(review_link)이 여러 파트-스코프 status 에 매칭되면 한 크루가 파트마다 원장행을
//     얻어 **동일 액트가 화면에 중복**됐다. 수정: computeDesiredAwards 이행자 = 카페매칭 ∩ 파트 로스터
//     → 각 파트 체크는 자기 파트 크루만 이행자. 타 파트로 새어든 매칭은 그 파트 체크에서 적립 안 됨.
//
//   시나리오(현상2와 동일 조건, fresh 시드):
//     · 같은 act 를 파트 A·파트 B 두 status 로 개설(둘 다 completed).
//     · **동일 게시물**을 표현: 두 status 의 recipients(matched)에 A·B 크루를 **똑같이** 주입.
//     · 두 status 모두 실제 적립(accrueForCompletedRegular) 실행.
//   기대(불변식): A 크루는 A 체크에서만 1행, B 체크에선 0행 → 크루당 총 **1행**(중복 없음).
//     재실행해도 1행(멱등). era/scope 가드는 기존 경로 그대로.
//
//   ⚠ 쓰기는 전부 mode=test(test_user_markers)만. cleanup=revokeForAct(공식 회수)로 원장/uwp/등급/
//     snapshot 원복(net-zero) 후 시드(status/recipients/act/group) 제거. 실사용자 무접촉.
//   run: npx tsx --env-file=.env.local scripts/verify-crossscope-single-ledger-e2e.ts
import { createClient } from "@supabase/supabase-js";
import { accrueForCompletedRegular, revokeForAct } from "@/lib/processPointAccrual";
import { resolveCheckScopeRoster } from "@/lib/processCheckScopeRoster";
import { listTeamParts, listPartCrews } from "@/lib/adminExperiencePartInput";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const ORG = process.env.E2E_ORG || "oranke";
const MODE = "test" as const;
const TAG = "ZZ-xscope";
const SAME_POST = "https://cafe.naver.com/x/xscope-e2e"; // "동일 게시물"

let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

const groups: string[] = [], actIds: string[] = [], refIds: string[] = [];

async function makeGroup(): Promise<string> {
  const { data, error } = await sb.from("process_line_groups").insert({ hub: "experience", name: `${TAG} 라인급`, sort_order: 999, is_active: true }).select("id").single();
  if (error) throw new Error(`makeGroup: ${error.message}`);
  const id = (data as any).id; groups.push(id); return id;
}
async function makeAct(groupId: string): Promise<string> {
  const { data, error } = await sb.from("process_acts").insert({
    line_group_id: groupId, hub: "experience", act_name: `${TAG} 파트 시작`, act_type: "required",
    duration_minutes: 5, occur_week: "N", occur_dow: 2, occur_time: "06:30",
    check_week: "N", check_dow: 3, check_time: "21:00",
    point_check: 1, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check", is_active: true,
  }).select("id").single();
  if (error) throw new Error(`makeAct: ${error.message}`);
  const id = (data as any).id; actIds.push(id); return id;
}
async function seedStatus(actId: string, groupId: string, teamId: string, weekId: string, partName: string): Promise<string> {
  const now = new Date().toISOString();
  const { data, error } = await sb.from("process_check_statuses").insert({
    organization_slug: ORG, hub: "experience", week_id: weekId, act_id: actId, line_group_id: groupId,
    team_id: teamId, part_name: partName, status: "completed", scope_mode: MODE,
    review_link: SAME_POST, requested_at: now, completed_at: now, checked_crew_count: 0,
  }).select("id").single();
  if (error) throw new Error(`seedStatus(${partName}): ${error.message}`);
  const id = (data as any).id; refIds.push(id); return id;
}
async function seedRecipients(refId: string, userIds: string[]) {
  await sb.from("process_check_review_recipients").delete().eq("source", "regular").eq("ref_id", refId);
  await sb.from("process_check_review_recipients").insert(userIds.map((uid) => ({
    source: "regular", ref_id: refId, organization_slug: ORG, scope_mode: MODE,
    user_id: uid, nickname: `T-${uid.slice(0, 4)}`, match_type: "matched", match_reason: "e2e-same-post",
  })));
}
async function ledgerRows(refId: string): Promise<Array<{ user_id: string; a: number }>> {
  const { data } = await sb.from("process_point_awards").select("user_id,point_check").eq("source", "regular").eq("ref_id", refId).is("cancelled_at", null);
  return ((data ?? []) as any[]).map((r) => ({ user_id: r.user_id, a: r.point_check }));
}
async function cleanup() {
  for (const ref of refIds) {
    try { await revokeForAct("regular", ref); } catch { /* 원장 없으면 무시 */ } // uwp/등급/snapshot 원복
    await sb.from("process_check_review_recipients").delete().eq("source", "regular").eq("ref_id", ref);
    await sb.from("process_check_statuses").delete().eq("id", ref);
  }
  if (actIds.length) await sb.from("process_acts").delete().in("id", actIds);
  if (groups.length) await sb.from("process_line_groups").delete().in("id", groups);
  // 태그 잔여물 방어 청소
  const g = ((await sb.from("process_line_groups").select("id").like("name", `${TAG}%`)).data ?? []) as any[];
  if (g.length) { const ids = g.map((x) => x.id); const a = ((await sb.from("process_acts").select("id").in("line_group_id", ids)).data ?? []) as any[]; if (a.length) { for (const ax of a) { const sts = ((await sb.from("process_check_statuses").select("id").eq("act_id", ax.id)).data ?? []) as any[]; for (const s of sts) { try { await revokeForAct("regular", s.id); } catch {} await sb.from("process_check_review_recipients").delete().eq("ref_id", s.id); } await sb.from("process_check_statuses").delete().eq("act_id", ax.id); } await sb.from("process_acts").delete().in("id", a.map((x) => x.id)); } await sb.from("process_line_groups").delete().in("id", ids); }
}

async function main() {
  const probe = await sb.from("process_point_awards").select("id").limit(1);
  if (probe.error) { console.log(`⚠ process_point_awards 미적용(${probe.error.code}) — skip`); process.exit(2); }
  await cleanup();

  // ── 2개 이상 파트(각 ≥1 크루)를 가진 test experience 팀 발굴 ──
  const teams = ((await sb.from("cluster4_teams").select("id,team_name").eq("organization_slug", ORG).eq("is_active", true)).data ?? []) as any[];
  let picked: { teamId: string; teamName: string; partA: string; partB: string; crewsA: string[]; crewsB: string[] } | null = null;
  for (const t of teams) {
    const parts = await listTeamParts(ORG, t.team_name, MODE);
    if (parts.length < 2) continue;
    const withCrews: Array<{ part: string; crews: string[] }> = [];
    for (const p of parts) { const c = (await listPartCrews(ORG, t.team_name, p, MODE)).map((x) => x.userId); if (c.length) withCrews.push({ part: p, crews: c }); if (withCrews.length === 2) break; }
    if (withCrews.length === 2) { picked = { teamId: t.id, teamName: t.team_name, partA: withCrews[0].part, partB: withCrews[1].part, crewsA: withCrews[0].crews, crewsB: withCrews[1].crews }; break; }
  }
  ck(`[setup] ${ORG} 2파트(각≥1크루) 팀 발굴`, !!picked, picked ? `team=${picked.teamName} A=${picked.partA}(${picked.crewsA.length}) B=${picked.partB}(${picked.crewsB.length})` : "없음");

  // ── era 허용 주차(2026-summer) ──
  const week = (await sb.from("weeks").select("id,iso_year,iso_week,start_date").eq("season_key", "2026-summer").eq("week_number", 4).maybeSingle()).data as any;
  ck("[setup] era 허용 주차(2026-summer W4) 존재", !!week?.id, week ? `${week.start_date} iso(${week.iso_year},${week.iso_week})` : "없음");
  if (!picked || !week?.id) { await cleanup(); console.log(`\n결과: ${pass} pass / ${fail} fail — setup 부족`); process.exit(1); }

  const inScopeA = picked.crewsA[0]; // 파트 A 소속 크루
  const inScopeB = picked.crewsB[0]; // 파트 B 소속 크루
  const samePostMatched = [inScopeA, inScopeB]; // "동일 게시물"이 A·B 크루 모두를 매칭

  // ── 시드: 같은 act, 파트 A·B 두 status, 동일 게시물 recipients ──
  const grp = await makeGroup();
  const actId = await makeAct(grp);
  const stA = await seedStatus(actId, grp, picked.teamId, week.id, picked.partA);
  const stB = await seedStatus(actId, grp, picked.teamId, week.id, picked.partB);
  await seedRecipients(stA, samePostMatched);
  await seedRecipients(stB, samePostMatched);

  // 원천 집계 불변: 두 status 모두 matched 2명 그대로.
  const rawA = (await sb.from("process_check_review_recipients").select("user_id").eq("ref_id", stA).eq("match_type", "matched")).data ?? [];
  const rawB = (await sb.from("process_check_review_recipients").select("user_id").eq("ref_id", stB).eq("match_type", "matched")).data ?? [];
  ck("[원천] 두 파트 status 에 동일 게시물 매칭 2명씩 주입", rawA.length === 2 && rawB.length === 2, `A=${rawA.length} B=${rawB.length}`);

  // 로스터 교집합 사전 확인.
  const rosterA = await resolveCheckScopeRoster({ hub: "experience", organization: ORG as any, mode: MODE, teamId: picked.teamId, partName: picked.partA });
  const rosterB = await resolveCheckScopeRoster({ hub: "experience", organization: ORG as any, mode: MODE, teamId: picked.teamId, partName: picked.partB });
  ck("[로스터] A크루∈partA·∉partB", rosterA.includes(inScopeA) && !rosterB.includes(inScopeA));
  ck("[로스터] B크루∈partB·∉partA", rosterB.includes(inScopeB) && !rosterA.includes(inScopeB));

  // ── 실제 적립(두 status) ──
  await accrueForCompletedRegular(stA);
  await accrueForCompletedRegular(stB);

  const ledA = await ledgerRows(stA);
  const ledB = await ledgerRows(stB);
  const rowsForA = [...ledA, ...ledB].filter((r) => r.user_id === inScopeA);
  const rowsForB = [...ledA, ...ledB].filter((r) => r.user_id === inScopeB);

  ck("[불변식] A크루: 파트A 체크에서만 1행", ledA.filter((r) => r.user_id === inScopeA).length === 1 && ledB.filter((r) => r.user_id === inScopeA).length === 0);
  ck("[불변식] B크루: 파트B 체크에서만 1행", ledB.filter((r) => r.user_id === inScopeB).length === 1 && ledA.filter((r) => r.user_id === inScopeB).length === 0);
  ck("[핵심] A크루 총 원장 1행(동일 게시물 다중 파트에도 중복 X)", rowsForA.length === 1, `n=${rowsForA.length}`);
  ck("[핵심] B크루 총 원장 1행", rowsForB.length === 1, `n=${rowsForB.length}`);
  ck("[교차차단] 타 파트 체크엔 상대 크루 원장 없음", !ledA.some((r) => r.user_id === inScopeB) && !ledB.some((r) => r.user_id === inScopeA));

  // ── 멱등: 재적립해도 1행 유지 ──
  await accrueForCompletedRegular(stA);
  await accrueForCompletedRegular(stB);
  const led2A = await ledgerRows(stA);
  const led2B = await ledgerRows(stB);
  const again = [...led2A, ...led2B].filter((r) => r.user_id === inScopeA).length;
  ck("[멱등] 재집계 2회 후에도 A크루 1행", again === 1, `n=${again}`);

  await cleanup();
  // cleanup 검증 — 시드 원장 0.
  const leftA = (await sb.from("process_point_awards").select("id", { count: "exact", head: true }).eq("source", "regular").eq("ref_id", stA)).count ?? 0;
  const leftB = (await sb.from("process_point_awards").select("id", { count: "exact", head: true }).eq("source", "regular").eq("ref_id", stB)).count ?? 0;
  ck("[cleanup] 시드 원장 회수 완료(0)", leftA === 0 && leftB === 0, `A=${leftA} B=${leftB}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error("FATAL:", e?.stack ?? e); try { await cleanup(); } catch {} process.exit(1); });
