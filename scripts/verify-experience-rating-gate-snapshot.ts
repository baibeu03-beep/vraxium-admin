// 실무 경험 평점 게이트 — snapshot-only 구조(고객앱 DTO) 검증 (실데이터·동일 경로 direct==HTTP).
//   run: npx tsx --env-file=.env.local scripts/verify-experience-rating-gate-snapshot.ts
//
// 목적: 기존 verify-experience-rating-gate.ts 의 [10] direct==HTTP 실패는 그 스크립트의
//   DIRECT 가 summer-sim override(신정책 시뮬·3슬롯)를 쓰고 HTTP 는 snapshot-only(W13=레거시)
//   라 "서로 다른 verdict 생산자"를 비교해 생긴 하네스 불일치다(06-16 snapshot-only 일원화 부작용).
//   본 스크립트는 production 과 동일하게 **override 없이** W13 을 레거시 통합 라인 경로로 두고,
//   direct(readWeeklyCardsSnapshot)와 HTTP(?demoUserId&mode=test)가 **같은 snapshot** 을 보므로
//   반드시 일치함을 보이며, 그 위에서 평점 게이트가 고객 DTO(experienceGrowth.status·userWeekStatus)
//   에 반영되는지 확인한다. 실무 정보 라인은 영향 0(experience 전용).
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { fetchLegacyUnifiedMasterId } from "@/lib/lineAvailability";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!, ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const J = (o: unknown) => JSON.stringify(o);
const TAG = "ZZ-rgsnap", PAST = "2020-01-01T00:00:00.000Z";
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cookie() {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: "vanuatu.golden@gmail.com" });
  const { data: v } = await brow.auth.verifyOtp({ email: "vanuatu.golden@gmail.com", token: link!.properties.email_otp, type: "magiclink" });
  const cap: any[] = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id));
  const oranke = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", "oranke")).data ?? []) as any[];
  const user = oranke.find((u) => markers.has(u.user_id))?.user_id;
  const week = (await sb.from("weeks").select("id,iso_year,iso_week,week_number,start_date").eq("season_key", "2026-spring").eq("week_number", 13).maybeSingle()).data as any;
  const unifiedId = await fetchLegacyUnifiedMasterId();
  ck("[전제] 테스트유저·W13·통합마스터", !!user && !!week?.id && !!unifiedId, J({ user: !!user, week: !!week?.id, unifiedId: !!unifiedId }));
  if (!user || !week?.id || !unifiedId) process.exit(2);

  const ck0 = await cookie();
  const httpCard = async () => {
    const res = await fetch(`http://localhost:3000/api/cluster4/weekly-cards?demoUserId=${user}&mode=test`, { headers: { cookie: ck0 } });
    const j: any = await res.json().catch(() => ({}));
    return (j?.data ?? []).find((x: any) => x.weekNumber === 13 && x.seasonKey === "2026-spring") ?? null;
  };
  const directCard = async () => {
    const snap = await readWeeklyCardsSnapshot(user);
    const cards: any[] = (snap as any).cards ?? [];
    return cards.find((x) => x.weekNumber === 13 && x.seasonKey === "2026-spring") ?? null;
  };

  const clean = async () => {
    const lines = (await sb.from("cluster4_lines").select("id").like("main_title", `${TAG}%`)).data ?? [];
    const lIds = (lines as any[]).map((x) => x.id);
    if (lIds.length) {
      const tg = (await sb.from("cluster4_line_targets").select("id").in("line_id", lIds)).data ?? [];
      const tIds = (tg as any[]).map((x) => x.id);
      if (tIds.length) await sb.from("cluster4_experience_line_evaluations").delete().in("line_target_id", tIds);
      await sb.from("cluster4_line_targets").delete().in("line_id", lIds);
      await sb.from("cluster4_lines").delete().in("id", lIds);
    }
  };
  await clean();

  // 레거시 통합 라인(마감 경과) + 본인 타깃 — W13 레거시 verdict 경로(reduceLegacyUnifiedVerdict).
  const { data: uline } = await sb.from("cluster4_lines").insert({ part_type: "experience", experience_line_master_id: unifiedId, line_code: "EXOK-ZZRGU", main_title: `${TAG} unified`, submission_opens_at: PAST, submission_closes_at: PAST, is_active: true }).select("id").single();
  const { data: utgt } = await sb.from("cluster4_line_targets").insert({ line_id: (uline as any).id, week_id: week.id, target_mode: "user", target_user_id: user, target_rule: {} }).select("id").single();
  const uTargetId = (utgt as any).id;

  // checkGate 기준값 (owt → weeks.check_threshold → 30) + 본인 W13 uwp 행 보존.
  const owt = (await sb.from("org_week_thresholds").select("check_threshold").eq("week_id", week.id).eq("organization_slug", "oranke").maybeSingle()).data as any;
  const wkThr = (await sb.from("weeks").select("check_threshold").eq("id", week.id).maybeSingle()).data as any;
  const threshold = owt?.check_threshold ?? wkThr?.check_threshold ?? 30;
  const iso = { y: week.iso_year as number, w: week.iso_week as number };
  const origRow = (await sb.from("user_weekly_points").select("id,points,advantages,penalty,checks_migrated").eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any;
  const setPoints = async (p: number) => sb.from("user_weekly_points").upsert({ user_id: user, year: iso.y, week_number: iso.w, week_start_date: week.start_date, points: p, advantages: 0, penalty: 0, checks_migrated: true }, { onConflict: "user_id,year,week_number" });

  const setRating = async (rating: number | null) => {
    await sb.from("cluster4_experience_line_evaluations").delete().eq("line_target_id", uTargetId);
    if (rating !== null) await sb.from("cluster4_experience_line_evaluations").insert({ line_target_id: uTargetId, user_id: user, rating, evaluated_at: new Date().toISOString() });
    await recomputeAndStoreWeeklyCardsSnapshot(user);
  };

  const verdict = (c: any) => c?.experienceGrowth?.status ?? null;

  // checkGate 통과 상태(points>=threshold·이관)로 고정 — 평점 변수만 분리 관찰.
  await setPoints(threshold);

  // ── rating 3 + checkGate 통과 → 고객 DTO verdict fail (평점 게이트 · snapshot-only) ──
  await setRating(3);
  let d = await directCard(); let h = await httpCard();
  ck("[1] rating 3 + points>=threshold → experienceGrowth.status fail", verdict(d) === "fail", `direct=${verdict(d)} pts>=${threshold}`);
  ck("[2] rating 3 → direct == HTTP (snapshot-only 동일 경로)", verdict(d) === verdict(h) && d?.userWeekStatus === h?.userWeekStatus, `d=${verdict(d)}/${d?.userWeekStatus} h=${verdict(h)}/${h?.userWeekStatus}`);

  // ── rating 5 + checkGate 통과 → verdict pass ──
  await setRating(5);
  d = await directCard(); h = await httpCard();
  ck("[3] rating 5 + points>=threshold → experienceGrowth.status pass", verdict(d) === "pass", `direct=${verdict(d)}`);
  ck("[4] rating 5 → direct == HTTP", verdict(d) === verdict(h) && d?.userWeekStatus === h?.userWeekStatus, `d=${verdict(d)}/${d?.userWeekStatus} h=${verdict(h)}/${h?.userWeekStatus}`);

  // ── rating 5 + points<threshold(enforced) → checkGate 로 fail (게이트 동시 적용) ──
  await setPoints(threshold - 1);
  await recomputeAndStoreWeeklyCardsSnapshot(user);
  d = await directCard(); h = await httpCard();
  ck("[5] rating 5 + points<threshold → fail(checkGate 동시 적용)", verdict(d) === "fail", `direct=${verdict(d)}`);
  ck("[6] (checkGate fail) direct == HTTP", verdict(d) === verdict(h), `d=${verdict(d)} h=${verdict(h)}`);

  // cleanup — uwp 행 원복 + TAG 라인 제거 + snapshot 재계산.
  await clean();
  if (origRow) await sb.from("user_weekly_points").update({ points: origRow.points, advantages: origRow.advantages, penalty: origRow.penalty, checks_migrated: origRow.checks_migrated }).eq("id", origRow.id);
  else await sb.from("user_weekly_points").delete().eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w);
  await recomputeAndStoreWeeklyCardsSnapshot(user);
  ck("[cleanup] 라인/타깃/평점/uwp 원복 + snapshot 재계산", true);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
