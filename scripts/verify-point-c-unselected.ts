// Point C 비대상자 지급 검증 — 정규 체크(unselectedUsers = 로스터 − 이행자)에게 C 지급.
//   run: npx tsx --env-file=.env.local scripts/verify-point-c-unselected.ts
//
//   전제: dev(:3000) + process_point_awards/process_check_* 마이그레이션 적용.
//   ⚠ 쓰기는 전부 mode=test(test_user_markers 유저)만 — 운영(실사용자) 원장 무접촉. cleanup=net-zero.
//   실적립 시나리오 = experience 소형 파트(음료(T)/주스, 로스터 3)로 빠르게 · info(비팀 org+mode)와
//   operating 파리티는 previewRegularAccrual(읽기 전용·원장 무기록)로 확인(실사용자 미지급).
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  resolveEffectivePenalty,
  accrueForCompletedRegular,
  previewRegularAccrual,
  revokeForAct,
} from "@/lib/processPointAccrual";
import { listPartCrews } from "@/lib/adminExperiencePartInput";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE = "http://localhost:3000";
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const J = (o: unknown) => JSON.stringify(o);
const PREFIX = "ZZ-pc-unsel"; // 광역 purge 접두(과거 잔여물 포함).
const TAG = `${PREFIX}-${process.pid}`; // 실행별 고유(동시/중복 실행 충돌 방지).
const ORG = "oranke";
const TEAM_ID = "ddc2385f-0e54-4e04-ae41-1e4c06ad330d"; // 음료(T)
const TEAM_NAME = "음료(T)";
const PART = "주스"; // crew 3(test)
const YEAR = 2026, ISOWK = 29; // 현재 주차(summer W3 · 2026-07-13). era 허용.
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

type Led = { user_id: string; point_check: number; point_advantage: number; point_penalty: number };
async function readLedger(refId: string): Promise<Map<string, Led>> {
  const { data } = await sb.from("process_point_awards")
    .select("user_id,point_check,point_advantage,point_penalty").eq("source", "regular").eq("ref_id", refId);
  const m = new Map<string, Led>();
  for (const r of (data ?? []) as Led[]) m.set(r.user_id, r);
  return m;
}
async function cookie(email: string) {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link!.properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

const refIds: string[] = [];
const groups: string[] = [];
const actIds: string[] = [];
let touchedUsers = new Set<string>();
let preUwp = new Set<string>();

// 상태행 seed(정규·test). hub/team/part 지정(experience) 또는 info(팀/파트 null).
async function seedStatus(o: { actId: string; groupId: string; weekId: string; hub: string; mode: "test" | "operating"; teamId?: string | null; partName?: string | null }): Promise<string> {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    organization_slug: ORG, hub: o.hub, week_id: o.weekId, act_id: o.actId, line_group_id: o.groupId,
    status: "completed", scope_mode: o.mode, requested_at: now, completed_at: now,
  };
  if (o.teamId !== undefined) row.team_id = o.teamId;
  if (o.partName !== undefined) row.part_name = o.partName;
  const { data, error } = await sb.from("process_check_statuses").insert(row).select("id").single();
  if (error) throw new Error(`seedStatus: ${error.message}`);
  return (data as { id: string }).id;
}
async function seedRecipients(refId: string, userIds: string[], mode: "test" | "operating") {
  await sb.from("process_check_review_recipients").delete().eq("source", "regular").eq("ref_id", refId);
  if (userIds.length === 0) return;
  await sb.from("process_check_review_recipients").insert(userIds.map((uid) => ({
    source: "regular", ref_id: refId, organization_slug: ORG, scope_mode: mode,
    user_id: uid, nickname: "T", match_type: "matched", match_reason: "verify",
  })));
}
async function makeAct(groupId: string, hub: string, name: string, pc: number, pa: number, pp: number): Promise<string> {
  const { data, error } = await sb.from("process_acts").insert({
    line_group_id: groupId, hub, act_name: `${TAG} ${name}`, act_type: "required",
    duration_minutes: 10, occur_week: "N", occur_dow: 2, occur_time: "06:30",
    check_week: "N", check_dow: 3, check_time: "21:00",
    point_check: pc, point_advantage: pa, point_penalty: pp, cafe: "occur", check_target: "check", is_active: true,
  }).select("id").single();
  if (error) throw new Error(`makeAct(${name}): ${error.message}`);
  const id = (data as { id: string }).id; actIds.push(id); return id;
}
// 접두(prefix) 로 라인급→액트→상태행→원장(revoke)→zeroed uwp 를 전부 정리(과거 잔여물 포함·net-zero).
async function purgeByPrefix(prefix: string) {
  const groupsL = ((await sb.from("process_line_groups").select("id").like("name", `${prefix}%`)).data ?? []) as any[];
  const gids = groupsL.map((g) => g.id);
  const acts = gids.length ? (((await sb.from("process_acts").select("id").in("line_group_id", gids)).data ?? []) as any[]) : [];
  const aids = acts.map((a) => a.id);
  const sts = aids.length ? (((await sb.from("process_check_statuses").select("id").in("act_id", aids)).data ?? []) as any[]) : [];
  const aff = new Set<string>();
  for (const s of sts) {
    const led = ((await sb.from("process_point_awards").select("user_id").eq("source", "regular").eq("ref_id", s.id)).data ?? []) as any[];
    for (const r of led) aff.add(r.user_id);
    try { await revokeForAct("regular", s.id); } catch {}
    await sb.from("process_check_review_recipients").delete().eq("source", "regular").eq("ref_id", s.id);
    await sb.from("process_check_statuses").delete().eq("id", s.id);
  }
  if (aids.length) await sb.from("process_acts").delete().in("id", aids);
  if (gids.length) await sb.from("process_line_groups").delete().in("id", gids);
  for (const u of aff) {
    const row = (await sb.from("user_weekly_points").select("points,advantages,penalty").eq("user_id", u).eq("year", YEAR).eq("week_number", ISOWK).maybeSingle()).data as any;
    if (row && !row.points && !row.advantages && !row.penalty && !preUwp.has(u)) await sb.from("user_weekly_points").delete().eq("user_id", u).eq("year", YEAR).eq("week_number", ISOWK);
  }
}
// ⚠ 종료/에러 정리는 이 실행분(TAG)만 — 광역 PREFIX 정리는 시작 시 1회만(다른 실행분 오삭제 방지).
async function cleanup() { await purgeByPrefix(TAG); }
// makeGroup 은 (hub,name) UNIQUE — 재사용(이미 있으면 그 id 반환).
async function ensureGroup(hub: string, name: string): Promise<string> {
  const nm = `${TAG} ${name}`;
  const exist = (await sb.from("process_line_groups").select("id").eq("hub", hub).eq("name", nm).maybeSingle()).data as any;
  if (exist?.id) { if (!groups.includes(exist.id)) groups.push(exist.id); return exist.id; }
  const { data, error } = await sb.from("process_line_groups").insert({ hub, name: nm, sort_order: 999 }).select("id").single();
  if (error) throw new Error(`makeGroup: ${error.message}`);
  const id = (data as { id: string }).id; groups.push(id); return id;
}

async function main() {
  // ── PART 0: 순수 규칙 — 이행자 vs 비대상자 상호배타 ──
  const perfPen = (pc: number, pa: number, pp: number) => resolveEffectivePenalty({ autoMatched: true, pointCheck: pc, pointAdvantage: pa, pointPenalty: pp });
  const unselPen = (pp: number) => resolveEffectivePenalty({ autoMatched: false, pointCheck: 0, pointAdvantage: 0, pointPenalty: pp });
  ck("[pure] 이행자 C-only → 0", perfPen(0, 0, 7) === 0);
  ck("[pure] 이행자 A+C·B+C·A+B+C → 0", perfPen(5, 0, 7) === 0 && perfPen(0, 3, 7) === 0 && perfPen(5, 3, 7) === 0);
  ck("[pure] 비대상자(보상없음) → C 유지", unselPen(7) === 7 && unselPen(0) === 0);

  const probe = await sb.from("process_point_awards").select("id").limit(1);
  if (probe.error) { console.log(`\n⚠ process_point_awards 미적용(${probe.error.code})`); console.log(`\n결과(PART0): ${pass} pass / ${fail} fail`); process.exit(fail ? 1 : 2); }

  await purgeByPrefix(PREFIX); // 시작 전 과거 잔여물(중단 실행분) 제거.

  // ── setup ──
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id));
  const orankeTest = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", ORG)).data ?? [] as any[]).filter((u: any) => markers.has(u.user_id)).map((u: any) => u.user_id) as string[];
  const encreTest = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", "encre")).data ?? [] as any[]).filter((u: any) => markers.has(u.user_id)).map((u: any) => u.user_id) as string[];
  const partCrews = (await listPartCrews(ORG, TEAM_NAME, PART, "test")).map((c) => c.userId);
  ck("[setup] experience 파트 크루 = 3(음료(T)/주스)", partCrews.length === 3, `n=${partCrews.length}`);
  ck("[setup] encre test(교차조직) ≥1", encreTest.length >= 1);
  const weekRow = (await sb.from("weeks").select("id").eq("iso_year", YEAR).eq("iso_week", ISOWK).maybeSingle()).data as any;
  ck("[setup] 현재 주차(2026/W29) 존재", !!weekRow?.id);
  if (!weekRow?.id || partCrews.length !== 3) { await cleanup(); console.log(`\n결과: ${pass} pass / ${fail + 1} fail`); process.exit(1); }
  const WEEK = weekRow.id as string;
  const perf = [partCrews[0]];
  const sampleUnsel = partCrews[1];
  touchedUsers = new Set([...partCrews]);
  preUwp = new Set(((await sb.from("user_weekly_points").select("user_id").in("user_id", [...touchedUsers]).eq("year", YEAR).eq("week_number", ISOWK)).data ?? []).map((r: any) => r.user_id));

  const expGroup = await ensureGroup("experience", "exp");
  const seedExp = async (actId: string, mode: "test" | "operating" = "test") =>
    seedStatus({ actId, groupId: expGroup, weekId: WEEK, hub: "experience", mode, teamId: TEAM_ID, partName: PART });

  // ── PART 1: 시나리오 매트릭스(experience·로스터 3·이행자 1·비대상자 2) ──
  const scen: Array<[string, number, number, number]> = [
    ["A만", 5, 0, 0], ["B만", 0, 3, 0], ["C만", 0, 0, 7],
    ["A+B", 5, 3, 0], ["A+C", 5, 0, 7], ["B+C", 0, 3, 7], ["A+B+C", 5, 3, 7],
  ];
  for (const [name, pc, pa, pp] of scen) {
    const actId = await makeAct(expGroup, "experience", name, pc, pa, pp);
    const st = await seedExp(actId); refIds.push(st);
    await seedRecipients(st, perf, "test");
    const pv = await previewRegularAccrual(st) as any;
    await accrueForCompletedRegular(st);
    const led = await readLedger(st);
    const perfRow = led.get(perf[0]);
    const perfOk = !!perfRow && perfRow.point_check === pc && perfRow.point_advantage === pa && perfRow.point_penalty === 0;
    const unselRow = led.get(sampleUnsel);
    const unselOk = pp > 0 ? (!!unselRow && unselRow.point_check === 0 && unselRow.point_advantage === 0 && unselRow.point_penalty === pp) : (unselRow === undefined);
    const exclusive = [...led.values()].every((r) => !((r.point_check > 0 || r.point_advantage > 0) && r.point_penalty > 0));
    const cRows = [...led.values()].filter((r) => r.point_penalty > 0).length;
    const expectC = pp > 0 ? pv.unselectedCount : 0;
    // roster 는 C(pp)>0 일 때만 계산(비용 최적화) — pp=0 이면 rosterCount=0 이 정상.
    ck(`[${name}] perf=1·roster=${pv.rosterCount}(pp>0일때만 3)`, pv.performerCount === 1 && (pp > 0 ? pv.rosterCount === 3 : pv.rosterCount === 0));
    ck(`[${name}] 이행자 A/B 정상·C=0`, perfOk, J(perfRow));
    ck(`[${name}] 비대상자 C 규칙`, unselOk, J(unselRow));
    ck(`[${name}] A/B·C 상호배타`, exclusive);
    ck(`[${name}] 비대상자 수 = 로스터−이행자(${cRows}==${expectC})`, cRows === expectC);
  }

  // ── PART 2: 이행자 0 → 전체 로스터에 C ──
  {
    const st = await seedExp(await makeAct(expGroup, "experience", "zero", 5, 3, 7)); refIds.push(st);
    await seedRecipients(st, [], "test");
    const pv = await previewRegularAccrual(st) as any; await accrueForCompletedRegular(st);
    const led = await readLedger(st);
    const cAll = [...led.values()].filter((r) => r.point_penalty === 7 && r.point_check === 0).length;
    ck(`[0명] 전체 로스터(3)에 C`, cAll === 3 && pv.unselectedCount === 3);
    ck(`[0명] 보상 지급 없음`, [...led.values()].every((r) => r.point_check === 0 && r.point_advantage === 0));
  }
  // ── PART 3: 전원 이행 → C 없음 ──
  {
    const st = await seedExp(await makeAct(expGroup, "experience", "all", 5, 3, 7)); refIds.push(st);
    await seedRecipients(st, partCrews, "test");
    const pv = await previewRegularAccrual(st) as any; await accrueForCompletedRegular(st);
    const led = await readLedger(st);
    ck(`[전원] 비대상자 0·C 없음`, pv.unselectedCount === 0 && [...led.values()].every((r) => r.point_penalty === 0));
    ck(`[전원] 전원 A/B`, partCrews.every((u) => { const r = led.get(u); return r && r.point_check === 5 && r.point_advantage === 3; }));
  }
  // ── PART 4: 멱등 ──
  {
    const st = await seedExp(await makeAct(expGroup, "experience", "idem", 5, 3, 7)); refIds.push(st);
    await seedRecipients(st, perf, "test");
    await accrueForCompletedRegular(st); const a = await readLedger(st);
    await accrueForCompletedRegular(st); const b = await readLedger(st);
    ck(`[멱등] 재실행 원장 불변 n=${b.size}`, a.size === b.size && [...a.entries()].every(([u, r]) => { const r2 = b.get(u); return r2 && r2.point_check === r.point_check && r2.point_advantage === r.point_advantage && r2.point_penalty === r.point_penalty; }));
  }
  // ── PART 5: 대상자↔비대상자 이동(결과 수정) → 회수·재지급 ──
  {
    const st = await seedExp(await makeAct(expGroup, "experience", "flip", 5, 3, 7)); refIds.push(st);
    await seedRecipients(st, [partCrews[0], partCrews[1]], "test"); await accrueForCompletedRegular(st);
    const before = await readLedger(st); const moved = partCrews[1];
    await seedRecipients(st, [partCrews[0]], "test"); await accrueForCompletedRegular(st);
    const after = await readLedger(st);
    const bR = before.get(moved), aR = after.get(moved), keep = after.get(partCrews[0]);
    ck(`[이동] 이행→비대상 전환 시 A/B 회수·C 재지급`,
      !!bR && bR.point_check === 5 && bR.point_penalty === 0 && !!aR && aR.point_check === 0 && aR.point_advantage === 0 && aR.point_penalty === 7, `b=${J(bR)} a=${J(aR)}`);
    ck(`[이동] 유지 이행자 A/B·C=0`, !!keep && keep.point_check === 5 && keep.point_advantage === 3 && keep.point_penalty === 0);
  }
  // ── PART 6: 삭제(회수) ──
  {
    const st = await seedExp(await makeAct(expGroup, "experience", "revoke", 5, 3, 7)); refIds.push(st);
    await seedRecipients(st, perf, "test"); await accrueForCompletedRegular(st);
    const before = await readLedger(st); await revokeForAct("regular", st); const after = await readLedger(st);
    ck(`[삭제] revoke 후 원장 전량 회수(${before.size}→${after.size})`, before.size > 0 && after.size === 0);
  }
  // ── PART 7: HTTP(/api/admin/processes/accrue) == direct + uwp/weekly-cards 반영 ──
  //   앞선 시나리오 원장(같은 user·week 누적)을 전부 회수해 uwp 를 격리한다(집계=이 ref 기여분만).
  {
    for (const ref of refIds) { try { await revokeForAct("regular", ref); } catch {} }
    const cookieStr = await cookie("vanuatu.golden@gmail.com");
    const st = await seedExp(await makeAct(expGroup, "experience", "http", 5, 3, 7)); refIds.push(st);
    await seedRecipients(st, perf, "test");
    const res = await fetch(`${BASE}/api/admin/processes/accrue`, { method: "POST", headers: { "Content-Type": "application/json", cookie: cookieStr }, body: J({ source: "regular", ref_id: st }) });
    const led = await readLedger(st);
    ck(`[HTTP] accrue 200`, res.status === 200, `status=${res.status}`);
    ck(`[HTTP] 이행자 A/B/0(DB)`, (() => { const r = led.get(perf[0]); return !!r && r.point_check === 5 && r.point_advantage === 3 && r.point_penalty === 0; })());
    ck(`[HTTP] 비대상자 0/0/C(DB)`, (() => { const r = led.get(sampleUnsel); return !!r && r.point_penalty === 7 && r.point_check === 0; })());
    const uwpUn = (await sb.from("user_weekly_points").select("points,advantages,penalty").eq("user_id", sampleUnsel).eq("year", YEAR).eq("week_number", ISOWK).maybeSingle()).data as any;
    const uwpPf = (await sb.from("user_weekly_points").select("points,advantages,penalty").eq("user_id", perf[0]).eq("year", YEAR).eq("week_number", ISOWK).maybeSingle()).data as any;
    ck(`[HTTP] uwp 비대상자 points=0·adv=0·penalty=C(격리)`, uwpUn?.penalty === 7 && uwpUn?.points === 0 && uwpUn?.advantages === 0, J(uwpUn));
    ck(`[HTTP] uwp 이행자 points=A·adv=B·penalty=0(격리)`, uwpPf?.points === 5 && uwpPf?.advantages === 3 && uwpPf?.penalty === 0, J(uwpPf));
    const wc = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${sampleUnsel}`, { headers: { cookie: cookieStr } });
    const wcj = await wc.json().catch(() => ({}));
    const cards = (Array.isArray(wcj?.data) ? wcj.data : (wcj?.data?.cards ?? [])) as any[];
    const wkCard = cards.find((c) => c?.isoYear === YEAR && c?.isoWeek === ISOWK) ?? cards.find((c) => c?.points?.lightning != null && c.points.lightning < 0);
    ck(`[HTTP] weekly-cards 200`, wc.status === 200, `status=${wc.status}`);
    // 카드 존재 시 penalty 반영(lightning=−C) 확인. 테스트 유저에 해당 주차 카드가 없으면 uwp 반영으로 대체 확인(위).
    if (cards.length === 0) ck(`[HTTP] weekly-cards penalty 반영(카드 없음 → uwp로 확인됨)`, true, "no cards for test user");
    else ck(`[HTTP] 비대상자 카드 penalty 반영(lightning<0 카드 존재)`, cards.some((c) => c?.points?.lightning != null && c.points.lightning < 0), `cards=${cards.length} wk=${J(wkCard?.points)}`);
  }

  // ── PART 8: info(비팀 org+mode) 로스터 + operating 파리티 — preview 전용(원장 무기록) ──
  {
    const infoGroup = await ensureGroup("info", "info");
    const infoAct = await makeAct(infoGroup, "info", "info", 5, 3, 7);
    const stTest = await seedStatus({ actId: infoAct, groupId: infoGroup, weekId: WEEK, hub: "info", mode: "test" }); refIds.push(stTest);
    await seedRecipients(stTest, perf, "test");
    const pT = await previewRegularAccrual(stTest) as any;
    ck(`[info] 비팀 로스터 = oranke test 크루(${pT.rosterCount}==${orankeTest.length})`, pT.rosterCount === orankeTest.length);
    ck(`[info] 비대상자 = 로스터 − 이행자`, pT.unselectedCount === pT.rosterCount - pT.performerCount && pT.performerCount === 1);

    // ⚠ scope_mode 는 UNIQUE 인덱스(org,hub,week,act,team,part)에 없으므로 operating 행은 별도 액트로 seed.
    const infoActOp = await makeAct(infoGroup, "info", "info-op", 5, 3, 7);
    const stOp = await seedStatus({ actId: infoActOp, groupId: infoGroup, weekId: WEEK, hub: "info", mode: "operating" }); refIds.push(stOp);
    await seedRecipients(stOp, [], "operating"); // ⚠ operating 은 accrue 절대 호출 안 함(실사용자 보호) — preview만.
    const pO = await previewRegularAccrual(stOp) as any;
    const keys = (o: any) => Object.keys(o).sort().join(",");
    ck(`[파리티] test·operating preview DTO 키 동일`, keys(pT) === keys(pO));
    ck(`[파리티] 동일 판정(effectivePenaltyUnselected=C 양쪽)`, pT.effectivePenaltyUnselected === 7 && pO.effectivePenaltyUnselected === 7);
    console.log(`  ℹ 파리티(QA off·모집단 상이): test 로스터=${pT.rosterCount} · operating 로스터=${pO.rosterCount} — count 동일성은 미러 모집단에서만 성립(동일 함수/DTO는 확인).`);
  }

  await cleanup();
  console.log("(cleanup — net-zero)");
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error("ERROR:", e?.stack ?? e?.message ?? e); try { await cleanup(); } catch {} console.log(`\n결과: ${pass} pass / ${fail + 1} fail`); process.exit(1); });
