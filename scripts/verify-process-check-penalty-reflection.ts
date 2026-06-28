/**
 * 프로세스 체크 자동 포인트 적립 → 운영/고객 화면 반영 검증 (penalty 포함).
 *   정책(2026-06-28): 검수완료 자동적립 유지 · penalty(point_c)도 동일 적립경로 · 여름W1 era 게이트 유지.
 *   기존 E2E(verify-process-point-accrual.ts)는 point_a(check)만 다룸 → 본 스크립트가 penalty 경로 보강.
 *
 *   안전 레인: test 모드 W13(2026-spring) · 테스트유저만 · 전 과정 cleanup/원복(운영 데이터 무접촉).
 *   주의: 적립 시 invalidateWeeklyCardsForUsers 가 해당 테스트유저 snapshot 을 재계산함(테스트유저 1명).
 *
 *   체인:
 *     [grant-ab] 검수완료 자동적립(manual_grant, point_mode=ab) → point_a=CHECK, point_b=ADV
 *     [grant-c ] 검수완료 자동적립(manual_grant, point_mode=c ) → point_c=PEN   (penalty 동일경로)
 *     → user_weekly_points(W13) = {points:CHECK, advantages:ADV, penalty:PEN}
 *     → 고객 SoT: card.points = {star:CHECK, shield:ADV−PEN(net), lightning:−PEN}  (direct==snapshot==HTTP)
 *     → 운영 SoT: cluster4_roster_card_stats(po_a/b/c) == 직접 Σ user_weekly_points(=sumPointsForUsers SoT)
 *     → revoke(삭제) → 원복 · ledger 0
 *
 *   npx tsx --env-file=.env.local scripts/verify-process-check-penalty-reflection.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { isAccrualAllowedWeek } from "@/lib/processPointAccrual";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot, recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ADMIN_EMAIL = "vanuatu.golden@gmail.com";
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const J = (o: unknown) => JSON.stringify(o);
const CHECK = 7, ADV = 5, PEN = 3;
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cookie() {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  const { data: v } = await brow.auth.verifyOtp({ email: ADMIN_EMAIL, token: link!.properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  // ── 0. era 게이트(정책 #1) — 순수 함수 검증(DB 무관) ──
  const W13 = { start_date: "2026-05-25", season_key: "2026-spring", week_number: 13 };
  const SUMMER = { start_date: "2026-06-29", season_key: "2026-summer", week_number: 1 };
  ck("[era] operating + W13 → 차단(여름 이전 무적립)", isAccrualAllowedWeek("operating", W13) === false);
  ck("[era] test + W13 → 허용(검증 레인)", isAccrualAllowedWeek("test", W13) === true);
  ck("[era] operating + summer W1 → 허용(정책 #1)", isAccrualAllowedWeek("operating", SUMMER) === true);

  // ── 1. 셋업: test 유저(oranke) + W13 ──
  const markers = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id));
  const oranke = ((await sb.from("user_profiles").select("user_id").eq("organization_slug", "oranke")).data ?? []) as any[];
  const user = oranke.find((u) => markers.has(u.user_id))?.user_id;
  const week = (await sb.from("weeks").select("id,iso_year,iso_week,start_date").eq("season_key", "2026-spring").eq("week_number", 13).maybeSingle()).data as any;
  ck("[셋업] test유저·W13 존재", !!user && !!week?.id, J({ user: user?.slice(0, 8), week: week?.id?.slice(0, 8) }));
  if (!user || !week?.id) { console.log(`\n결과: ${pass} pass / ${fail} fail (셋업 실패)`); process.exit(2); }
  const iso = { y: week.iso_year as number, w: week.iso_week as number };
  const startDate = week.start_date as string;

  // 원본 보존(원복용) + baseline(이 테스트유저 W13 에 기존 적립/포인트가 이미 있을 수 있어 delta 로 검증)
  const origRow = (await sb.from("user_weekly_points").select("id,points,advantages,penalty,checks_migrated").eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any;
  const base = { points: origRow?.points ?? 0, advantages: origRow?.advantages ?? 0, penalty: origRow?.penalty ?? 0 };
  const baseLedgerCount = (await sb.from("process_point_awards").select("id", { count: "exact", head: true }).eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w)).count ?? 0;
  if (base.points || base.advantages || base.penalty || baseLedgerCount) {
    console.log(`  ℹ baseline(기존 잔여): uwp=${J(base)} · 기존 원장 ${baseLedgerCount}행 — delta 기준으로 검증(기존 데이터 무삭제).`);
  }
  const exp = { points: base.points + CHECK, advantages: base.advantages + ADV, penalty: base.penalty + PEN };

  // ── 2. 적립(검수완료 자동적립) — HTTP manual_grant 2건(ab + c) ──
  const ck0 = await cookie();
  const api = async (path: string, init: any = {}) => {
    const res = await fetch(`http://localhost:3000${path}`, { ...init, headers: { "Content-Type": "application/json", cookie: ck0, ...(init.headers ?? {}) } });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const grant = async (mode: "ab" | "c", a: number, b: number, c: number) =>
    api("/api/admin/processes/check/irregular", { method: "POST", body: J({ organization: "oranke", mode: "test", kind: "manual_grant", act_name: `ZZ-penverify-${mode}`, target_user_ids: [user], point_mode: mode, point_a: a, point_b: b, point_c: c }) });

  const gAb = await grant("ab", CHECK, ADV, 0);
  ck("[적립1] manual_grant ab(검수완료 자동적립) 201", gAb.status === 201 && !!gAb.json?.data?.id, `status=${gAb.status}`);
  const gC = await grant("c", 0, 0, PEN);
  ck("[적립2] manual_grant c(penalty 동일경로) 201", gC.status === 201 && !!gC.json?.data?.id, `status=${gC.status}`);
  const ids = [gAb.json?.data?.id, gC.json?.data?.id].filter(Boolean) as string[];

  // ── 3. user_weekly_points 재계산 반영 (delta = +CHECK/+ADV/+PEN) ──
  const uwp = (await sb.from("user_weekly_points").select("points,advantages,penalty").eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any;
  ck("[uwp] W13 = baseline + {CHECK,ADV,PEN}", uwp?.points === exp.points && uwp?.advantages === exp.advantages && uwp?.penalty === exp.penalty, `uwp=${J(uwp)} exp=${J(exp)}`);

  // 내가 만든 ledger 2행(ref_id 한정) 합 = CHECK/ADV/PEN
  const ledger = (await sb.from("process_point_awards").select("point_check,point_advantage,point_penalty,ref_id").eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w).in("ref_id", ids)).data as any[];
  const Lc = (ledger ?? []).reduce((s, r) => s + (r.point_check || 0), 0);
  const La = (ledger ?? []).reduce((s, r) => s + (r.point_advantage || 0), 0);
  const Lp = (ledger ?? []).reduce((s, r) => s + (r.point_penalty || 0), 0);
  ck("[ledger] 신규 원장 2행 합 = CHECK/ADV/PEN", (ledger ?? []).length === 2 && Lc === CHECK && La === ADV && Lp === PEN, `rows=${(ledger ?? []).length} sum=${Lc}/${La}/${Lp}`);

  // ── 4. 고객 SoT: direct card points = {star, shield=net, lightning=−pen} (baseline 반영) ──
  const findCard = (cards: any[]) => cards.find((c) => c.startDate === startDate) ?? cards.find((c) => c.weekNumber === 13 && c.seasonKey === "2026-spring");
  const direct = findCard(await getCluster4WeeklyCardsForProfileUser(user) as any[]);
  const expPoints = { star: exp.points, shield: exp.advantages - exp.penalty, lightning: -exp.penalty };
  ck("[고객-direct] card.points = {star, shield:net(adv−pen), lightning:−pen}", !!direct && direct.points?.star === expPoints.star && direct.points?.shield === expPoints.shield && direct.points?.lightning === expPoints.lightning, `points=${J(direct?.points)} exp=${J(expPoints)}`);

  // ── 5. 고객 SoT: snapshot(저장본) == direct (적립이 snapshot 재계산까지 반영) ──
  const snap = await readWeeklyCardsSnapshot(user);
  const snapCard = (snap.status === "hit" || snap.status === "stale") ? findCard(snap.cards as any[]) : null;
  ck("[고객-snapshot] 저장 snapshot hit & points == direct", snap.status === "hit" && !!snapCard && snapCard.points?.star === expPoints.star && snapCard.points?.shield === expPoints.shield && snapCard.points?.lightning === expPoints.lightning, `snapStatus=${snap.status} points=${J(snapCard?.points)}`);

  // ── 6. 고객 SoT: HTTP == direct (snapshot-only 라우트가 같은 값 노출) ──
  const httpRes = await api(`/api/cluster4/weekly-cards?demoUserId=${user}&mode=test`);
  const httpCard = findCard(httpRes.json?.data ?? []);
  ck("[고객-HTTP] /api/cluster4/weekly-cards points == direct", httpRes.status === 200 && !!httpCard && httpCard.points?.star === expPoints.star && httpCard.points?.shield === expPoints.shield && httpCard.points?.lightning === expPoints.lightning, `http=${httpRes.status} points=${J(httpCard?.points)}`);

  // ── 7. 운영 SoT: roster slim(po_a/b/c) == 직접 Σ user_weekly_points(=admin members Po.A/B/C SoT) ──
  const allRows = (await sb.from("user_weekly_points").select("points,advantages,penalty").eq("user_id", user)).data as any[];
  const sumA = (allRows ?? []).reduce((s, r) => s + (r.points || 0), 0);
  const sumB = (allRows ?? []).reduce((s, r) => s + (r.advantages || 0), 0);
  const sumC = (allRows ?? []).reduce((s, r) => s + (r.penalty || 0), 0);
  const slim = (await sb.from("cluster4_roster_card_stats").select("po_a,po_b,po_c").eq("user_id", user).maybeSingle()).data as any;
  if (slim && (slim.po_a != null || slim.po_c != null)) {
    ck("[운영] roster slim po_a/b/c == 직접 Σ user_weekly_points", slim.po_a === sumA && slim.po_b === sumB && slim.po_c === sumC, `slim=${slim.po_a}/${slim.po_b}/${slim.po_c} Σ=${sumA}/${sumB}/${sumC}`);
    ck("[운영] penalty(Po.C) 반영됨(Σ penalty ⊇ PEN)", sumC >= PEN, `ΣPo.C=${sumC} (≥${PEN})`);
  } else {
    console.log(`  ⚠ roster slim po_* 미기록(마이그레이션/백필 상태) — 운영 Po.C 직접 Σ=${sumC} 만 확인(≥${PEN}: ${sumC >= PEN ? "✓" : "✗"})`);
    ck("[운영] 직접 Σ penalty 반영(Po.C SoT)", sumC >= PEN, `ΣPo.C=${sumC}`);
  }

  // ── 8. revoke(삭제) → 원복 ──
  for (const id of ids) await api("/api/admin/processes/check/irregular", { method: "DELETE", body: J({ id, organization: "oranke", mode: "test" }) });
  const uwpAfter = (await sb.from("user_weekly_points").select("points,advantages,penalty").eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w).maybeSingle()).data as any;
  const back = origRow ? (uwpAfter?.points === origRow.points && uwpAfter?.advantages === origRow.advantages && uwpAfter?.penalty === origRow.penalty) : (!uwpAfter || (uwpAfter.points === 0 && uwpAfter.advantages === 0 && uwpAfter.penalty === 0));
  ck("[revoke] 삭제 → user_weekly_points 원복", back, `after=${J(uwpAfter)} orig=${J(origRow ? { points: origRow.points, advantages: origRow.advantages, penalty: origRow.penalty } : "(none)")}`);

  // ── 9. cleanup: ledger·act·recipients 잔여 제거 + snapshot/등급 원복 ──
  await sb.from("process_point_awards").delete().eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w).in("ref_id", ids);
  for (const id of ids) { await sb.from("process_check_review_recipients").delete().eq("ref_id", id); await sb.from("process_irregular_acts").delete().eq("id", id); }
  if (origRow) await sb.from("user_weekly_points").update({ points: origRow.points, advantages: origRow.advantages, penalty: origRow.penalty, checks_migrated: origRow.checks_migrated }).eq("id", origRow.id);
  else await sb.from("user_weekly_points").delete().eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w);
  await recomputeAndStoreWeeklyCardsSnapshot(user);
  try { const { syncGradeStats } = await import("@/lib/cluster3ClubRankData"); await syncGradeStats(user); } catch {}
  const ledgerLeft = (await sb.from("process_point_awards").select("id", { count: "exact", head: true }).eq("user_id", user).eq("year", iso.y).eq("week_number", iso.w)).count ?? 0;
  ck("[cleanup] 신규 ledger 제거(기존 잔여만 유지) · snapshot 원복", ledgerLeft === baseLedgerCount, `ledgerLeft=${ledgerLeft} baseline=${baseLedgerCount}`);
  if (baseLedgerCount > 0) console.log(`  ⚠ 이 테스트유저 W13 에 기존 원장 ${baseLedgerCount}행(과거 E2E 잔여 추정) — 삭제하지 않음(내가 만들지 않은 데이터). 정리 필요 시 별도 판단.`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
