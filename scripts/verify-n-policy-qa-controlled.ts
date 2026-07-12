/**
 * [QA 통제 검증] 주차 성공 기준값 = recognition_count_n(N). phalanx W1(2026-summer) 테스트 코호트만.
 *   운영 실사용자 무접촉: cluster4_week_opening_configs 는 phalanx/oranke W1 만 생성 후 삭제(복원),
 *   encre 운영 N(164)은 절대 미접촉. uws 는 scope="qa" 로 테스트 유저만 생성 → 검증 후 원복.
 *   ⚠ 전역 공표(result_published_at) 안 함 — finalizeWeekUws 를 직접 구동(= HTTP 검수의 uws 판정 단계
 *     와 동일 함수). N 없음 차단만 실제 HTTP(POST .../review?mode=test)로 확인(공표 前 throw).
 *
 *   검증:
 *     S1) N 없음 → HTTP 422 recognition_missing + uws/points/snapshot 쓰기 0
 *     S2) required === recognition_count_n (threshold/30 미혼입) · earned<N→fail / =N→success / >N→success
 *     S3) N 변경 → 재-finalize 시 최신 N 기준 재판정(uws 갱신)
 *     S4) 사용자 조직 기준 N (phalanx 유저는 phalanx N, encre 164 아님)
 *     S5) N 없는 상태 read-time 조회는 uws 무변경(enforced=false)
 *
 *   npx tsx --env-file=.env.local scripts/verify-n-policy-qa-controlled.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import {
  finalizeWeekUws,
  UwsFinalizeBlockedError,
} from "@/lib/adminWeekUwsFinalize";
import {
  fetchExperienceRequiredSlotStatusByWeek,
  fetchWeekRecognitionRequiredByOrg,
} from "@/lib/lineAvailability";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const BASE = "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const W1_START = "2026-06-29";
const SEASON = "2026-summer";

let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

async function cookie(): Promise<string> {
  const { data: adm } = await supabaseAdmin.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as any)?.email;
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const sv = createServerClient(u, a, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it.map(({ name, value }: any) => ({ name, value }))) } });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c: any) => `${c.name}=${c.value}`).join("; ");
}

async function main() {
  const { data: wk } = await supabaseAdmin.from("weeks")
    .select("id,start_date,end_date,season_key,iso_year,iso_week,is_official_rest,result_published_at,result_reviewed_at")
    .eq("start_date", W1_START).maybeSingle();
  const W: any = wk;
  ck("W1 확보 · 미공표(공표 안 함 보장)", !!W && W.result_published_at == null, { id: W?.id?.slice(0,8), published: W?.result_published_at });
  if (!W) process.exit(2);
  const finalizeRow = { id: W.id, start_date: W.start_date, end_date: W.end_date, season_key: W.season_key, iso_year: W.iso_year, iso_week: W.iso_week, is_official_rest: W.is_official_rest };

  const testIds = await fetchTestUserMarkerIds();

  // N 세터(테스트 전용 · phalanx/oranke 만) / 클리어(행 삭제 복원).
  const setN = async (org: string, n: number) => {
    await supabaseAdmin.from("cluster4_week_opening_configs").upsert(
      { week_id: W.id, organization_slug: org, config: {}, open_confirmed: true, min_points_a: n, exec_points_b: n, recognition_count_n: n, recognition_calc_version: 1 },
      { onConflict: "week_id,organization_slug" },
    );
  };
  const clearN = async (org: string) => {
    await supabaseAdmin.from("cluster4_week_opening_configs").delete().eq("week_id", W.id).eq("organization_slug", org);
  };

  // 원상복구 대상 캡처: 테스트 유저 W1 uws 원본(없으면 삭제로 복원).
  const capTestUws = async () => {
    const { data } = await supabaseAdmin.from("user_week_statuses").select("id,user_id,status").eq("week_start_date", W1_START);
    return (data ?? []).filter((r: any) => testIds.has(r.user_id)) as any[];
  };
  const uwsBefore = await capTestUws();
  const uwsBeforeIds = new Set(uwsBefore.map((r) => r.id));
  console.log(`   (사전 테스트 uws ${uwsBefore.length}건 캡처)`);

  // phalanx 그룹1(슬롯 pass) 사용자 1명 + earned 확보.
  const { data: phProfs } = await supabaseAdmin.from("user_profiles").select("user_id").eq("organization_slug", "phalanx").limit(300);
  let phUser: string | null = null, earned = 0;
  for (const p of (phProfs ?? []) as any[]) {
    if (!testIds.has(p.user_id)) continue;
    const v = (await fetchExperienceRequiredSlotStatusByWeek(p.user_id, [W.id], Date.now(), { organizationSlug: "phalanx" })).get(W.id);
    // 슬롯 pass 여야 checkGate 로 earned>=N 판정이 관측됨. (N 아직 없음 → enforced=false 상태)
    if (v && v.status === "pass") {
      const { data: pts } = await supabaseAdmin.from("user_weekly_points").select("points").eq("user_id", p.user_id).eq("year", W.iso_year).eq("week_number", W.iso_week).maybeSingle();
      phUser = p.user_id; earned = (pts as any)?.points ?? 0; break;
    }
  }
  ck("phalanx 슬롯 pass 테스트 유저 확보", !!phUser, { phUser: phUser?.slice(0,8), earned });
  if (!phUser) { console.log("슬롯 pass 유저 없음 — 시드 확인 필요"); process.exit(2); }

  try {
    // ── S5 + S1: N 없는 상태 ──
    // read-time 조회는 uws 무변경 + enforced=false (과거 결과 보존).
    const vNoN = (await fetchExperienceRequiredSlotStatusByWeek(phUser, [W.id], Date.now(), { organizationSlug: "phalanx" })).get(W.id);
    ck("[S5] N 없음 → checkGate 미부착/enforced=false(강등 없음)", !vNoN?.checkGate || vNoN.checkGate.enforced === false, { gate: vNoN?.checkGate });

    // S1: HTTP 검수 → 422 recognition_missing (phalanx/oranke N 없음), 공표/uws 무접촉.
    const h = await cookie();
    const uwsCntBefore = (await capTestUws()).length;
    const res = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${W.id}/review?club=phalanx&mode=test`, { method: "POST", headers: { cookie: h } });
    const json: any = await res.json();
    ck("[S1] HTTP 검수 422", res.status === 422, { status: res.status });
    ck("[S1] 오류 메시지 '오픈 확인을 먼저 완료'", /오픈 확인을 먼저 완료/.test(json?.error ?? ""), { error: json?.error });
    const { data: wkAfter } = await supabaseAdmin.from("weeks").select("result_published_at,result_reviewed_at").eq("id", W.id).maybeSingle();
    ck("[S1] 공표/검수 무접촉", (wkAfter as any).result_published_at == null && (wkAfter as any).result_reviewed_at == null);
    ck("[S1] uws 쓰기 0건", (await capTestUws()).length === uwsCntBefore, { before: uwsCntBefore });

    // ── 코호트 전 org N 필요(차단 회피). encre=164(운영·미접촉), oranke=999(고정), phalanx=가변 ──
    await setN("oranke", 999); // oranke 테스트 유저는 관측 대상 아님(높게 두어 fail 무방)

    // ── S2/S3/S4: phalanx N 을 earned±1 로 통제하여 경계 관측 ──
    const runFinalizeAndRead = async (phN: number) => {
      await setN("phalanx", phN);
      // required 관측(사용자 조직=phalanx 기준).
      const v = (await fetchExperienceRequiredSlotStatusByWeek(phUser!, [W.id], Date.now(), { organizationSlug: "phalanx" })).get(W.id);
      const gate = v?.checkGate;
      // finalizeWeekUws(scope=qa) = HTTP 검수의 uws 판정 단계와 동일 함수(공표 없음).
      //   allowIncompleteTestData: 적립/mass-fail 안전장치만 bypass(QA) — N-block 은 우회 안 됨.
      await finalizeWeekUws(finalizeRow, "qa", null, { allowIncompleteTestData: true });
      const { data: uwsRow } = await supabaseAdmin.from("user_week_statuses").select("status").eq("week_start_date", W1_START).eq("user_id", phUser!).maybeSingle();
      return { required: gate?.required, enforced: gate?.enforced, verdictStatus: v?.status, uws: (uwsRow as any)?.status };
    };

    // earned > N → success
    const gt = await runFinalizeAndRead(Math.max(0, earned - 1));
    console.log(`   [earned>N] N=${earned - 1} earned=${earned}`, JSON.stringify(gt));
    ck("[S2/S4] required === phalanx N(earned-1) (encre 164/threshold/30 미혼입)", gt.required === earned - 1, { required: gt.required });
    ck("[S2] earned>N → uws success", gt.uws === "success", { uws: gt.uws });

    // earned == N → success
    const eq = await runFinalizeAndRead(earned);
    console.log(`   [earned=N] N=${earned} earned=${earned}`, JSON.stringify(eq));
    ck("[S3] N 변경 → required 갱신(=earned)", eq.required === earned, { required: eq.required });
    ck("[S2] earned==N → uws success", eq.uws === "success", { uws: eq.uws });

    // earned < N → fail
    const lt = await runFinalizeAndRead(earned + 1);
    console.log(`   [earned<N] N=${earned + 1} earned=${earned}`, JSON.stringify(lt));
    ck("[S3] N 변경 → required 갱신(=earned+1)", lt.required === earned + 1, { required: lt.required });
    ck("[S2/S3] earned<N → uws fail(재검수로 결과 변경)", lt.uws === "fail", { uws: lt.uws });
    ck("[S2] enforced=true (N 있음)", lt.enforced === true);
  } finally {
    // ── 원상복구 ──
    // 1) 내가 만든 phalanx/oranke W1 config 삭제(encre 164 미접촉).
    await clearN("phalanx");
    await clearN("oranke");
    // 2) finalize 가 생성한 테스트 uws 중 사전에 없던 것 삭제(복원).
    const nowUws = await capTestUws();
    const toDelete = nowUws.filter((r) => !uwsBeforeIds.has(r.id)).map((r) => r.id);
    for (let i = 0; i < toDelete.length; i += 100) {
      await supabaseAdmin.from("user_week_statuses").delete().in("id", toDelete.slice(i, i + 100));
    }
    // 3) 사전 uws status 복원(finalize 가 갱신했을 수 있음).
    for (const r of uwsBefore) {
      await supabaseAdmin.from("user_week_statuses").update({ status: r.status }).eq("id", r.id);
    }
    console.log(`   (복구: config 삭제 phalanx/oranke · uws 삭제 ${toDelete.length} · 사전 ${uwsBefore.length} 복원 · encre 164 미접촉)`);
    // 검증: encre 164 유지
    const { data: enc } = await supabaseAdmin.from("cluster4_week_opening_configs").select("recognition_count_n").eq("week_id", W.id).eq("organization_slug", "encre").maybeSingle();
    ck("[복구] encre W1 N=164 불변", (enc as any)?.recognition_count_n === 164, { n: (enc as any)?.recognition_count_n });
    const { data: wkFin } = await supabaseAdmin.from("weeks").select("result_published_at").eq("id", W.id).maybeSingle();
    ck("[복구] W1 미공표 유지(운영 카드 무영향)", (wkFin as any)?.result_published_at == null);
  }

  console.log(`\n${failed === 0 ? "🎉 ALL PASS" : `❌ ${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
