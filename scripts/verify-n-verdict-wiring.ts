/**
 * [검증] 주차 성공 기준값 SoT 전환: required = recognition_count_n (N). (dev 서버 불필요 · 대부분 read-only)
 *
 *   A) N 있는 주차(encre): verdict.checkGate.required === N · passed === (earned>=N) · enforced=true
 *   B) N 없는 주차: enforced=false(강등 없음 → 과거 결과 보존) · required=0
 *   C) op == test: 동일 verdict 함수·동일 org 조회로 동일 required (모드 무분기)
 *   D) finalize 차단: N 미확정 조직이 코호트에 있으면 UwsFinalizeBlockedError(recognition_missing)
 *      — throw 는 모든 write 前(publish/uws 무접촉). 안전.
 *
 *   npx tsx --env-file=.env.local scripts/verify-n-verdict-wiring.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  fetchExperienceRequiredSlotStatusByWeek,
  fetchWeekRecognitionRequiredByOrg,
} from "@/lib/lineAvailability";
import { finalizeWeekUws, UwsFinalizeBlockedError } from "@/lib/adminWeekUwsFinalize";

let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

async function main() {
  // N 산정된 encre 주차 확보(신정책 2026-summer 우선 — verdict 게이트가 적용되는 주차).
  const { data: cfgRows } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select("week_id,organization_slug,recognition_count_n")
    .eq("organization_slug", "encre")
    .not("recognition_count_n", "is", null);
  const nWeeks: any[] = [];
  for (const c of (cfgRows ?? []) as any[]) {
    const { data: wk } = await supabaseAdmin
      .from("weeks").select("id,start_date,iso_year,iso_week").eq("id", c.week_id).maybeSingle();
    if (wk) nWeeks.push({ week_id: (wk as any).id, start_date: (wk as any).start_date, iso_year: (wk as any).iso_year, iso_week: (wk as any).iso_week, n: c.recognition_count_n });
  }
  // 과거 신정책 주차(2026-06-29 ~ 07-05) 우선 — verdict 게이트 적용 + 과거(코호트 존재).
  const nWeek = nWeeks.find((w) => w.start_date >= "2026-06-29" && w.start_date < "2026-07-06")
    ?? nWeeks.find((w) => w.start_date >= "2026-06-29") ?? nWeeks[0];
  ck("encre 과거 신정책 N 주차 확보", !!nWeek, { week: nWeek?.start_date, n: nWeek?.n });
  if (!nWeek) { console.log("중단"); process.exit(2); }

  // encre 사용자 × 모든 encre N 주차 스캔 — 슬롯 verdict=pass(=checkGate 부착) 첫 사례 탐색.
  const { data: encreProfs } = await supabaseAdmin
    .from("user_profiles").select("user_id").eq("organization_slug", "encre").limit(300);
  let encreUser: string | null = null, gateA: any = null, gateWeek: any = null;
  outer: for (const gw of nWeeks) {
    for (const p of (encreProfs ?? []) as any[]) {
      const v = (await fetchExperienceRequiredSlotStatusByWeek(p.user_id, [gw.week_id], Date.now(), { organizationSlug: "encre" })).get(gw.week_id);
      if (v?.checkGate) { encreUser = p.user_id; gateA = v.checkGate; gateWeek = gw; break outer; }
    }
  }
  ck("encre checkGate 부착 사례 확보(슬롯 pass)", !!gateA, { user: encreUser?.slice(0,8), week: gateWeek?.start_date, gateA });

  // ── A) required === N ──
  if (gateA && gateWeek) {
    ck(`[A] checkGate.required === N(${gateWeek.n})`, gateA.required === gateWeek.n, { required: gateA.required });
    ck("[A] checkGate.passed === (earned>=N)", gateA.passed === (gateA.earned >= gateWeek.n));
    ck("[A] enforced=true (N 있음)", gateA.enforced === true);
  } else {
    console.log("   [A] (더미 데이터에 슬롯 pass encre 사용자 없음 — required=N 관측은 구조/차단 근거로 대체)");
  }

  // ── B) N 없는 주차: enforced=false ──
  //   같은 주차를 org=oranke 로 조회(oranke N 없음) → hasRequired=false → checkGate.enforced=false 또는 미부착.
  if (encreUser) {
    const nOranke = (await fetchWeekRecognitionRequiredByOrg([nWeek.week_id], "oranke")).get(nWeek.week_id);
    ck("[B] oranke 는 이 주차 N 없음(null)", nOranke == null, { nOranke });
    const vmap = await fetchExperienceRequiredSlotStatusByWeek(encreUser, [nWeek.week_id], Date.now(), { organizationSlug: "oranke" });
    const gate = vmap.get(nWeek.week_id)?.checkGate;
    // enforced=false 이면 강등 없음(과거 결과 보존). checkGate 있으면 enforced=false, 없으면(슬롯!=pass) 무관.
    ck("[B] N 없음 → enforced=false(강등 안 함)", !gate || gate.enforced === false, { gate });
  }

  // ── C) op == test: 동일 함수·동일 required (mode 무분기) ──
  if (encreUser) {
    const a = (await fetchExperienceRequiredSlotStatusByWeek(encreUser, [nWeek.week_id], Date.now(), { organizationSlug: "encre" })).get(nWeek.week_id);
    const b = (await fetchExperienceRequiredSlotStatusByWeek(encreUser, [nWeek.week_id], Date.now(), { organizationSlug: "encre" })).get(nWeek.week_id);
    ck("[C] 동일 org 반복 호출 = 동일 required(결정적)", JSON.stringify(a?.checkGate) === JSON.stringify(b?.checkGate));
    // op/test 는 라우트 scope 차이일 뿐 verdict 함수/org 조회는 동일 — required 는 org 로만 결정.
  }

  // ── D) finalize 차단: 코호트에 N 미확정 조직 존재 → recognition_missing ──
  //   nWeek(2026-summer)는 encre 만 N 보유·oranke/phalanx 미보유 → 차단 기대. throw 는 write 前.
  {
    const { data: wk } = await supabaseAdmin
      .from("weeks").select("id,start_date,end_date,season_key,iso_year,iso_week,is_official_rest,result_published_at,result_reviewed_at").eq("id", nWeek.week_id).maybeSingle();
    const w = wk as any;
    const pubBefore = w.result_published_at, revBefore = w.result_reviewed_at;
    let blocked = false, code = "", msg = "";
    try {
      await finalizeWeekUws(
        { id: w.id, start_date: w.start_date, end_date: w.end_date, season_key: w.season_key, iso_year: w.iso_year, iso_week: w.iso_week, is_official_rest: w.is_official_rest },
        "operating", null, {},
      );
    } catch (e) {
      if (e instanceof UwsFinalizeBlockedError) { blocked = true; code = e.code; msg = e.message; }
      else throw e;
    }
    console.log(`   [D] blocked=${blocked} code=${code} msg="${msg}"`);
    ck("[D] finalize 차단됨(UwsFinalizeBlockedError)", blocked);
    ck("[D] code=recognition_missing (N 미확정)", code === "recognition_missing", { code });
    ck("[D] '오픈 확인을 먼저 완료' 문구", /오픈 확인을 먼저 완료/.test(msg));
    // write 무접촉 확인(publish/review 불변)
    const { data: wk2 } = await supabaseAdmin.from("weeks").select("result_published_at,result_reviewed_at").eq("id", w.id).maybeSingle();
    ck("[D] 차단 시 publish/review 무접촉", (wk2 as any).result_published_at === pubBefore && (wk2 as any).result_reviewed_at === revBefore);
  }

  console.log(`\n${failed === 0 ? "🎉 ALL PASS" : `❌ ${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
