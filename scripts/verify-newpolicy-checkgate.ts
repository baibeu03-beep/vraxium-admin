// 신정책(2026-summer W1+) checkGate 검증 — direct + HTTP + flip + 레거시 회귀.
//   run: npx tsx --env-file=.env.local scripts/verify-newpolicy-checkgate.ts
//   전제: admin dev(:3000). 테스트 사용자에게 임시 슬롯 라인 개설(검증 후 cleanup net-zero).
//   신정책 주차는 2026-summer 가 DB 에 없어, mode=test(effectiveFrom=1970)로 신정책 경로를 강제해 검증한다.
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  applyExperienceCheckGate,
  TEST_SUMMER_SIM_EFFECTIVE_FROM,
  type ExperienceGrowthVerdict,
} from "@/lib/lineAvailability";
import { getExperienceSlotsByMasterIdsRegFirst } from "@/lib/lineRegistrationLookup";
import { fetchLegacyUnifiedMasterId } from "@/lib/lineAvailability";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot, recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const J = (o: unknown) => JSON.stringify(o);
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const TAG = "ZZ-gate", PAST = "2020-01-01T00:00:00.000Z";

async function adminCookie() {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: "vanuatu.golden@gmail.com" });
  const { data: v } = await brow.auth.verifyOtp({ email: "vanuatu.golden@gmail.com", token: link!.properties.email_otp, type: "magiclink" });
  const cap: { name: string; value: string }[] = [];
  const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function cleanup() {
  const rows = (await sb.from("cluster4_lines").select("id").eq("part_type", "experience").like("line_code", `${TAG}%`)).data ?? [];
  const ids = (rows as { id: string }[]).map((x) => x.id);
  if (ids.length) { await sb.from("cluster4_line_targets").delete().in("line_id", ids); await sb.from("cluster4_lines").delete().in("id", ids); }
}

const V = (status: ExperienceGrowthVerdict["status"]): ExperienceGrowthVerdict => ({ status, requiredSlots: [], failedSlotOrders: [] });

async function main() {
  // ── PART 1: 순수 applyExperienceCheckGate (flip 로직 진리표) ──
  const below = applyExperienceCheckGate(V("pass"), { required: 30, earned: 10, enforced: true });
  ck("[direct·pure] pass+earned<req+enforced → fail · passed=false", below.status === "fail" && below.checkGate?.passed === false, J(below.checkGate));
  const meet = applyExperienceCheckGate(V("pass"), { required: 30, earned: 30, enforced: true });
  ck("[direct·pure] pass+earned>=req+enforced → pass · passed=true", meet.status === "pass" && meet.checkGate?.passed === true);
  const overL = applyExperienceCheckGate(V("pass"), { required: 30, earned: 10, enforced: false });
  ck("[direct·pure] pass+earned<req+!enforced(legacy) → pass 보존 · passed=false", overL.status === "pass" && overL.checkGate?.passed === false);
  ck("[direct·pure] fail verdict → 무변경·게이트 미부착", applyExperienceCheckGate(V("fail"), { required: 30, earned: 0, enforced: true }).status === "fail" && applyExperienceCheckGate(V("fail"), { required: 30, earned: 0, enforced: true }).checkGate === undefined);
  ck("[direct·pure] pending/na → 무변경", applyExperienceCheckGate(V("pending"), { required: 30, earned: 0, enforced: true }).status === "pending" && applyExperienceCheckGate(V("not_applicable"), { required: 30, earned: 0, enforced: true }).status === "not_applicable");

  // ── PART 2: 셋업 — 테스트 유저 + 슬롯1/2/3 마스터 + W12 라인 개설(과거 마감) ──
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id));
  const oranke = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", "oranke")).data ?? []) as any[];
  const user = oranke.find((u) => markers.has(u.user_id))?.user_id;
  const week = (await sb.from("weeks").select("id,iso_year,iso_week,week_number,start_date").eq("season_key", "2026-spring").eq("week_number", 12).maybeSingle()).data as any;
  // 활성 마스터 후보 → 실제 resolved slot 으로 1/2/3 각 1개 선택.
  const masters = ((await sb.from("cluster4_experience_line_masters").select("id,line_code").eq("is_active", true).limit(60)).data ?? []) as any[];
  const slotMap = await getExperienceSlotsByMasterIdsRegFirst(masters.map((m) => m.id));
  const unifiedId = await fetchLegacyUnifiedMasterId(); // 레거시 통합 마스터는 신정책 슬롯 매핑에서 제외됨 → 후보 제외
  const pickForSlot = (n: number) => masters.find((m) => slotMap.get(m.id) === n && m.id !== unifiedId);
  const m1 = pickForSlot(1), m2 = pickForSlot(2), m3 = pickForSlot(3);
  ck("[셋업] 테스트유저·W12·슬롯1/2/3 마스터 확보", !!user && !!week?.id && !!m1 && !!m2 && !!m3, J({ user: !!user, w12: week?.week_number, m1: !!m1, m2: !!m2, m3: !!m3 }));
  if (!user || !week?.id || !m1 || !m2 || !m3) { console.log("⚠ 셋업 부족 — 중단(슬롯 마스터 부재 가능)"); await cleanup(); process.exit(2); }

  await cleanup();
  for (const [i, m] of [m1, m2, m3].entries()) {
    const { data: line } = await sb.from("cluster4_lines").insert({
      part_type: "experience", experience_line_master_id: m.id, line_code: `${TAG}-S${i + 1}`,
      main_title: `${TAG} slot${i + 1}`, submission_opens_at: PAST, submission_closes_at: PAST, is_active: true,
    }).select("id").single();
    await sb.from("cluster4_line_targets").insert({ line_id: (line as any).id, week_id: week.id, target_mode: "user", target_user_id: user, target_rule: {} });
  }

  // 원본 포인트 보존 + 조회
  const iso = { y: week.iso_year as number, w: week.iso_week as number };
  const origRow = (await sb.from("user_weekly_points").select("id,points,advantages,penalty,checks_migrated").eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any;
  // 게이트는 success→fail 강등만(승격 없음). 양방향 flip 시연을 위해 베이스 uws 를 success 로 고정(저장/복원).
  const origUws = (await sb.from("user_week_statuses").select("id,status").eq("user_id", user).eq("week_start_date", week.start_date).maybeSingle()).data as any;
  const setUws = async (status: string) => {
    if (origUws) await sb.from("user_week_statuses").update({ status }).eq("id", origUws.id);
    else await sb.from("user_week_statuses").upsert({ user_id: user, year: iso.y, week_number: week.week_number, week_start_date: week.start_date, status, season_key: "2026-spring" }, { onConflict: "user_id,year,week_number" });
  };
  await setUws("success");

  const cardOf = async (override?: string) => {
    const cards = await getCluster4WeeklyCardsForProfileUser(user, override ? { effectiveFromOverride: override } : {});
    return (cards as any[]).find((c) => c.weekNumber === 12 && c.seasonKey === "2026-spring");
  };
  const setPoints = async (pts: number) => {
    await sb.from("user_weekly_points").upsert({ user_id: user, year: iso.y, week_number: iso.w, week_start_date: week.start_date, points: pts, advantages: 0, penalty: 0, checks_migrated: false }, { onConflict: "user_id,year,week_number" });
  };

  // ── PART 3: 신정책(mode=test) verdict pass + checkGate 채움 ──
  await setPoints(0);
  let c = await cardOf(TEST_SUMMER_SIM_EFFECTIVE_FROM);
  const slotsOk = (c?.experienceGrowth?.requiredSlots ?? []).every((s: any) => s.enhancementStatus === "success");
  ck("[direct·신정책] W12 필수슬롯 3개 success(verdict pass 후보)", slotsOk && (c?.experienceGrowth?.requiredSlots ?? []).length === 3, J((c?.experienceGrowth?.requiredSlots ?? []).map((s: any) => s.enhancementStatus)));
  ck("[direct·신정책] checkGate 채워짐(enforced=true)", !!c?.experienceGrowth?.checkGate && c.experienceGrowth.checkGate.enforced === true, J(c?.experienceGrowth?.checkGate));
  const threshold = c?.experienceGrowth?.checkGate?.required ?? 30;

  // ── PART 4: flip (points<threshold → fail / >=threshold → success) + direct==HTTP ──
  const cookie = await adminCookie();
  const httpCard = async (mode: boolean) => {
    const res = await fetch(`http://localhost:3000/api/cluster4/weekly-cards?demoUserId=${user}${mode ? "&mode=test" : ""}`, { headers: { cookie } });
    const j = await res.json();
    return (j.data ?? []).find((x: any) => x.weekNumber === 12 && x.seasonKey === "2026-spring");
  };
  // 고객앱 API = 프론트 프록시(:3001) → admin 업스트림(쿼리 forward + internal-key). 고객앱이 실제 받는 응답.
  const frontCard = async () => {
    const res = await fetch(`http://localhost:3001/api/cluster4/weekly-cards?userId=${user}&demoUserId=${user}&mode=test`, { headers: { "Content-Type": "application/json" } });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, card: (j.data ?? []).find((x: any) => x.weekNumber === 12 && x.seasonKey === "2026-spring") };
  };

  await setPoints(threshold - 1);
  c = await cardOf(TEST_SUMMER_SIM_EFFECTIVE_FROM);
  let h = await httpCard(true);
  ck("[flip·미달] points<threshold → 주차 fail (direct)", c?.userWeekStatus === "fail" && c?.experienceGrowth?.checkGate?.passed === false, `status=${c?.userWeekStatus} earned=${c?.experienceGrowth?.checkGate?.earned}/${threshold}`);
  ck("[direct==HTTP·미달] 동일", h?.userWeekStatus === c?.userWeekStatus && h?.experienceGrowth?.checkGate?.passed === c?.experienceGrowth?.checkGate?.passed && h?.experienceGrowth?.checkGate?.earned === c?.experienceGrowth?.checkGate?.earned, `http=${h?.userWeekStatus}/${h?.experienceGrowth?.checkGate?.passed}`);

  await setPoints(threshold);
  c = await cardOf(TEST_SUMMER_SIM_EFFECTIVE_FROM);
  h = await httpCard(true);
  ck("[flip·충족] points>=threshold → 주차 success (direct)", c?.userWeekStatus === "success" && c?.experienceGrowth?.checkGate?.passed === true, `status=${c?.userWeekStatus} earned=${c?.experienceGrowth?.checkGate?.earned}/${threshold}`);
  ck("[direct==HTTP·충족] 동일(demoUserId==일반 빌더)", h?.userWeekStatus === c?.userWeekStatus && h?.experienceGrowth?.checkGate?.passed === c?.experienceGrowth?.checkGate?.passed, `http=${h?.userWeekStatus}/${h?.experienceGrowth?.checkGate?.passed}`);

  // ── 고객앱 API(프론트 프록시 :3001) 반영 — 브라우저가 실제 받는 응답 체인 ──
  const fp = await frontCard();
  ck("[고객앱·프록시] :3001 → admin 게이트 반영(success·passed=true)", fp.status === 200 && fp.card?.userWeekStatus === "success" && fp.card?.experienceGrowth?.checkGate?.passed === true, `status=${fp.status} week=${fp.card?.userWeekStatus} gate=${J(fp.card?.experienceGrowth?.checkGate)}`);

  // ── PART 5: 레거시/operating 회귀 — operating(override 없음)은 points 변동에 불변 ──
  await setPoints(threshold - 1);
  const opBefore = await cardOf();         // operating live(레거시 경로)
  await setPoints(threshold);
  const opAfter = await cardOf();
  ck("[레거시·operating] points 변동에도 operating W12 주차상태 불변(신게이트 미적용)", opBefore?.userWeekStatus === opAfter?.userWeekStatus, `before=${opBefore?.userWeekStatus} after=${opAfter?.userWeekStatus}`);
  ck("[레거시·operating] operating W12 checkGate enforced≠강제true(레거시 규칙)", !opAfter?.experienceGrowth?.checkGate || opAfter.experienceGrowth.checkGate.enforced === false, J(opAfter?.experienceGrowth?.checkGate));

  // ── PART 6: snapshot — dto_version 21 재계산 → hit ──
  await recomputeAndStoreWeeklyCardsSnapshot(user);
  const snap = await readWeeklyCardsSnapshot(user);
  ck("[snapshot] 재계산 후 status=hit(dto_version 21)", snap.status === "hit", `status=${snap.status}`);

  // ── cleanup: 라인/타깃 삭제 + 포인트 원복 + snapshot 재계산 ──
  await cleanup();
  if (origRow) {
    await sb.from("user_weekly_points").update({ points: origRow.points, advantages: origRow.advantages, penalty: origRow.penalty, checks_migrated: origRow.checks_migrated }).eq("id", origRow.id);
  } else {
    await sb.from("user_weekly_points").delete().eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w);
  }
  if (origUws) await sb.from("user_week_statuses").update({ status: origUws.status }).eq("id", origUws.id);
  else await sb.from("user_week_statuses").delete().eq("user_id", user).eq("week_start_date", week.start_date);
  await recomputeAndStoreWeeklyCardsSnapshot(user);
  ck("[cleanup] 라인/포인트 원복 완료", true);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { await cleanup().catch(() => {}); console.error("FATAL:", e?.stack ?? e); process.exit(1); });
