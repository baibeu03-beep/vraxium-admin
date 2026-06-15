// 정규 프로세스 체크 worker 적립 검증 (ledger 멱등 + W13 테스트 예외 + flip + cleanup).
//   run: npx tsx --env-file=.env.local scripts/verify-regular-worker-accrual.ts
//   전제: admin(:3000) + process_point_awards.sql + process_check v2/v3 적용.
//   worker runOnce 에 crawlAndMatch(매칭 주입) + accrue(직접 TS) 주입 → 완료→적립 전 경로 검증.
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { runOnce } from "./process-check-worker.mjs";
import { accrueForCompletedRegular } from "@/lib/processPointAccrual";
import { TEST_SUMMER_SIM_EFFECTIVE_FROM, fetchLegacyUnifiedMasterId } from "@/lib/lineAvailability";
import { getExperienceSlotsByMasterIdsRegFirst } from "@/lib/lineRegistrationLookup";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot, recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const J = (o: unknown) => JSON.stringify(o);
const TAG = "ZZ-rworker", PAST = "2020-01-01T00:00:00.000Z";
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const accrue = (source: string, refId: string) => accrueForCompletedRegular(refId); // worker 주입(직접 TS)

async function cookie() {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: "vanuatu.golden@gmail.com" });
  const { data: v } = await brow.auth.verifyOtp({ email: "vanuatu.golden@gmail.com", token: link!.properties.email_otp, type: "magiclink" });
  const cap: any[] = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  const probe = await sb.from("process_point_awards").select("id").limit(1);
  if (probe.error) { console.log(`⚠ process_point_awards 미적용(${probe.error.code})`); process.exit(2); }

  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id));
  const oranke = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", "oranke")).data ?? []) as any[];
  const user = oranke.find((u) => markers.has(u.user_id))?.user_id;
  const realUser = oranke.find((u) => !markers.has(u.user_id))?.user_id;
  const week = (await sb.from("weeks").select("id,iso_year,iso_week,week_number,start_date,check_threshold").eq("season_key", "2026-spring").eq("week_number", 13).maybeSingle()).data as any;
  const team = (await sb.from("cluster4_teams").select("id,team_name").eq("organization_slug", "oranke").eq("is_active", true).in("team_name", ["과일(T)", "음료(T)", "콘텐츠실험(T)"]).limit(1).maybeSingle()).data as any;
  const masters = ((await sb.from("cluster4_experience_line_masters").select("id").eq("is_active", true).limit(60)).data ?? []) as any[];
  const slotMap = await getExperienceSlotsByMasterIdsRegFirst(masters.map((m) => m.id));
  const unifiedId = await fetchLegacyUnifiedMasterId();
  const pick = (n: number) => masters.find((m) => slotMap.get(m.id) === n && m.id !== unifiedId);
  const sm = [pick(1), pick(2), pick(3)];
  ck("[셋업] test유저·실유저·W13·(T)팀·슬롯1/2/3", !!user && !!realUser && !!week?.id && !!team?.id && sm.every(Boolean), J({ user: !!user, real: !!realUser, team: team?.team_name, sm: sm.map(Boolean) }));
  if (!user || !realUser || !week?.id || !team?.id || !sm.every(Boolean)) process.exit(2);

  const owt = (await sb.from("org_week_thresholds").select("check_threshold").eq("week_id", week.id).eq("organization_slug", "oranke").maybeSingle()).data as any;
  const threshold = owt?.check_threshold ?? (week.check_threshold ?? 30);
  const iso = { y: week.iso_year as number, w: week.iso_week as number };
  const PER = Math.min(20, threshold); const expSum = PER * 2;
  const ck0 = await cookie();
  const api = async (path: string, init: any = {}) => {
    const res = await fetch(`http://localhost:3000${path}`, { ...init, headers: { "Content-Type": "application/json", cookie: ck0, ...(init.headers ?? {}) } });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const pointsOf = async () => ((await sb.from("user_weekly_points").select("points").eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any)?.points ?? 0;
  const w13Card = async () => ((await getCluster4WeeklyCardsForProfileUser(user, { effectiveFromOverride: TEST_SUMMER_SIM_EFFECTIVE_FROM })) as any[]).find((c) => c.weekNumber === 13 && c.seasonKey === "2026-spring");

  // 원본 보존
  const origRow = (await sb.from("user_weekly_points").select("id,points,advantages,penalty,checks_migrated").eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any;
  const origUws = (await sb.from("user_week_statuses").select("id,status").eq("user_id", user).eq("week_start_date", week.start_date).maybeSingle()).data as any;
  const gradeBefore = (await sb.from("user_grade_stats").select("updated_at").eq("user_id", user).maybeSingle()).data as any;

  const cleanup = async () => {
    // 시드 정규 상태/액트/그룹/슬롯라인/recipients/ledger 제거
    const g = (await sb.from("process_line_groups").select("id").eq("hub", "experience").like("name", `${TAG}%`)).data ?? [];
    const gIds = (g as any[]).map((x) => x.id);
    if (gIds.length) {
      const acts = (await sb.from("process_acts").select("id").in("line_group_id", gIds)).data ?? [];
      const aIds = (acts as any[]).map((x) => x.id);
      if (aIds.length) {
        const sts = (await sb.from("process_check_statuses").select("id").in("act_id", aIds)).data ?? [];
        const sIds = (sts as any[]).map((x) => x.id);
        for (const sid of sIds) { await sb.from("process_check_review_recipients").delete().eq("ref_id", sid); await sb.from("process_point_awards").delete().eq("source", "regular").eq("ref_id", sid); }
        await sb.from("process_check_statuses").delete().in("act_id", aIds);
        await sb.from("process_acts").delete().in("id", aIds);
      }
      await sb.from("process_line_groups").delete().in("id", gIds);
    }
    const lines = (await sb.from("cluster4_lines").select("id").eq("part_type", "experience").like("line_code", `${TAG}%`)).data ?? [];
    const lIds = (lines as any[]).map((x) => x.id);
    if (lIds.length) { await sb.from("cluster4_line_targets").delete().in("line_id", lIds); await sb.from("cluster4_lines").delete().in("id", lIds); }
  };
  await cleanup();

  // 슬롯 라인 3 + uws success (verdict pass)
  for (const [i, m] of sm.entries()) {
    const { data: line } = await sb.from("cluster4_lines").insert({ part_type: "experience", experience_line_master_id: (m as any).id, line_code: `${TAG}-S${i + 1}`, main_title: `${TAG} slot${i + 1}`, submission_opens_at: PAST, submission_closes_at: PAST, is_active: true }).select("id").single();
    await sb.from("cluster4_line_targets").insert({ line_id: (line as any).id, week_id: week.id, target_mode: "user", target_user_id: user, target_rule: {} });
  }
  if (origUws) await sb.from("user_week_statuses").update({ status: "success" }).eq("id", origUws.id);
  else await sb.from("user_week_statuses").upsert({ user_id: user, year: iso.y, week_number: week.week_number, week_start_date: week.start_date, status: "success", season_key: "2026-spring" }, { onConflict: "user_id,year,week_number" });

  // 정규 체크 액트 2개(point_check=PER) + 상태행 2개(W13, test, pending, scheduled past)
  const cg = await api("/api/admin/processes/line-groups", { method: "POST", body: J({ hub: "experience", name: `${TAG} 라인급` }) });
  const groupId = cg.json.data?.id;
  const mkAct = async (n: number) => (await api("/api/admin/processes/acts", { method: "POST", body: J({ line_group_id: groupId, hub: "experience", act_name: `${TAG} 액트${n}`, duration_minutes: 10, occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00", point_check: PER, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "required", overview: null, remarks: null }) })).json.data;
  const act1 = await mkAct(1); const act2 = await mkAct(2);
  const mkStatus = async (actId: string, mode = "test", weekId = week.id) => {
    const { data } = await sb.from("process_check_statuses").insert({ organization_slug: "oranke", hub: "experience", week_id: weekId, line_group_id: groupId, act_id: actId, team_id: team.id, scope_mode: mode, status: "pending", review_link: "https://cafe.naver.com/x/1", scheduled_check_at: PAST }).select("id").single();
    return (data as any).id;
  };
  const s1 = await mkStatus(act1.id); const s2 = await mkStatus(act2.id);
  ck("[셋업] 정규 액트2 + 상태행2(pending·W13·test)", !!groupId && !!act1?.id && !!act2?.id && !!s1 && !!s2);

  // ── worker 1회 실행 (matched=test유저 주입) → 완료 + 적립 ──
  const crawl = async () => ({ matched: [{ userId: user, nickname: "t", reason: "matched" }], review: [] });
  const r1 = await runOnce({ sb, modes: ["test"], onlyIds: [s1, s2], crawlAndMatch: crawl, accrue, log: () => {} });
  ck("[worker] 1회 실행 — due/eligible/succeeded", r1.succeeded === 2 && r1.failed === 0, J(r1));

  // (3) recipients
  const recs = (await sb.from("process_check_review_recipients").select("user_id,match_type").eq("source", "regular").in("ref_id", [s1, s2])).data ?? [];
  ck("[3] recipients(source=regular, matched, test유저)", recs.length === 2 && (recs as any[]).every((x) => x.user_id === user && x.match_type === "matched"), `n=${recs.length}`);
  // (4) ledger
  const led = (await sb.from("process_point_awards").select("point_check").eq("source", "regular").in("ref_id", [s1, s2])).data ?? [];
  ck("[4] process_point_awards 2행(point_check=process_acts.point_check)", led.length === 2 && (led as any[]).every((x) => x.point_check === PER), `n=${led.length} pc=${(led as any[])[0]?.point_check}`);
  // (5) user_weekly_points
  ck("[5] user_weekly_points.points = Σ ledger", (await pointsOf()) === expSum, `points=${await pointsOf()}/${expSum}`);
  // (6) snapshot
  const snap = await readWeeklyCardsSnapshot(user);
  ck("[6] snapshot 재계산(hit)", snap.status === "hit", `status=${snap.status}`);
  // (7) DTO flip
  let c = await w13Card();
  ck("[7] DTO W13 star=Σ·checkGate.passed=true·success", c?.points?.star === expSum && c?.experienceGrowth?.checkGate?.passed === true && c?.userWeekStatus === "success", `star=${c?.points?.star} gate=${J(c?.experienceGrowth?.checkGate)} st=${c?.userWeekStatus}`);

  // (등급) 정규 worker 적립 후 당사자 user_grade_stats 갱신(hook)
  const gradeAfter = (await sb.from("user_grade_stats").select("updated_at").eq("user_id", user).maybeSingle()).data as any;
  ck("[등급] 정규 worker 적립 후 당사자 user_grade_stats 갱신", !!gradeAfter && gradeAfter.updated_at !== gradeBefore?.updated_at, `before=${gradeBefore?.updated_at} after=${gradeAfter?.updated_at}`);

  // (8) worker 2회 실행 → 상태 completed → 재처리 0 (중복 적립 0)
  const r2 = await runOnce({ sb, modes: ["test"], onlyIds: [s1, s2], crawlAndMatch: crawl, accrue, log: () => {} });
  const dup1 = await pointsOf();
  // + 직접 재적립 2회(멱등 직접 확인)
  await accrueForCompletedRegular(s1); await accrueForCompletedRegular(s1);
  ck("[8] 중복 적립 0 (worker 재실행 eligible 0 · 직접 재적립 불변)", r2.succeeded === 0 && dup1 === expSum && (await pointsOf()) === expSum, `r2=${J(r2)} points=${await pointsOf()}`);

  // (10) direct == HTTP — 엔드포인트 경유 적립 == 직접
  const httpAcc = await api("/api/admin/processes/accrue", { method: "POST", body: J({ source: "regular", ref_id: s1 }) });
  ck("[10] direct == HTTP (accrue 엔드포인트 동일 결과·멱등)", httpAcc.status === 200 && httpAcc.json?.success === true && (await pointsOf()) === expSum, `status=${httpAcc.status} points=${await pointsOf()}`);

  // (9) operating + W13 → era_blocked (직접 적립 레이어). operating 상태는 별도 act 로(상태행 UNIQUE 회피).
  let op9 = false;
  {
    const actOp = await mkAct(9);
    const sop = await mkStatus(actOp.id, "operating");
    await sb.from("process_check_review_recipients").insert({ source: "regular", ref_id: sop, organization_slug: "oranke", scope_mode: "operating", user_id: realUser, nickname: "op", match_type: "matched", match_reason: "auto" });
    const res: any = await accrueForCompletedRegular(sop);
    const ledOp = (await sb.from("process_point_awards").select("id", { count: "exact", head: true }).eq("source", "regular").eq("ref_id", sop)).count ?? 0;
    op9 = res?.skipped === true && String(res?.reason).startsWith("era_blocked") && ledOp === 0;
    ck("[9] operating+W13 → era_blocked · ledger 0", op9, `skipped=${res?.reason} led=${ledOp}`);
  }

  // (11) mode 혼입 — test 상태에 실사용자 매칭 주입 → worker scope 가드 throw(미완료·미적립)
  {
    const actMix = await mkAct(11);
    const smix = await mkStatus(actMix.id, "test");
    const crawlReal = async () => ({ matched: [{ userId: realUser, nickname: "r", reason: "matched" }], review: [] });
    const rmix = await runOnce({ sb, modes: ["test"], onlyIds: [smix], crawlAndMatch: crawlReal, accrue, log: () => {} });
    const ledMix = (await sb.from("process_point_awards").select("id", { count: "exact", head: true }).eq("source", "regular").eq("ref_id", smix)).count ?? 0;
    const st = (await sb.from("process_check_statuses").select("status").eq("id", smix).maybeSingle()).data as any;
    ck("[11] test 모드에 실사용자 매칭 → 차단(미완료·ledger 0)", rmix.failed === 1 && rmix.succeeded === 0 && ledMix === 0 && st?.status === "pending", `failed=${rmix.failed} led=${ledMix} st=${st?.status}`);
  }

  // (12) cleanup 원복
  await cleanup();
  await sb.from("process_point_awards").delete().eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w);
  if (origRow) await sb.from("user_weekly_points").update({ points: origRow.points, advantages: origRow.advantages, penalty: origRow.penalty, checks_migrated: origRow.checks_migrated }).eq("id", origRow.id);
  else await sb.from("user_weekly_points").delete().eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w);
  if (origUws) await sb.from("user_week_statuses").update({ status: origUws.status }).eq("id", origUws.id);
  else await sb.from("user_week_statuses").delete().eq("user_id", user).eq("week_start_date", week.start_date);
  await recomputeAndStoreWeeklyCardsSnapshot(user);
  const { syncGradeStats } = await import("@/lib/cluster3ClubRankData");
  await syncGradeStats(user); // 등급 캐시 원복(복원된 points 기준)
  const ledgerLeft = (await sb.from("process_point_awards").select("id", { count: "exact", head: true }).eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w)).count ?? 0;
  ck("[12] cleanup — ledger 0 · user_weekly_points 원복", ledgerLeft === 0 && (await pointsOf()) === (origRow?.points ?? 0), `ledger=${ledgerLeft} points=${await pointsOf()}/${origRow?.points ?? "(none)"}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
