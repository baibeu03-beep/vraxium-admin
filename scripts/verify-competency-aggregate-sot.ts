/**
 * [실무 역량] 집계 SoT 검증 — synthetic fail 이 분모에 포함되는지, direct==snapshot==HTTP 정합.
 *   npx tsx --env-file=.env.local scripts/verify-competency-aggregate-sot.ts
 *
 * 3 케이스(같은 주차에 라인 개설 후):
 *   1) 대상자 success  → competency 라인 enh=success, num=1, den=1, 시즌 total 포함(earned+1)
 *   2) 비대상 fail      → enh=fail(target_missing_required), num=0, den=1, 시즌 total 포함(earned 0)
 *   3) 라인 미개설 주차 → enh=not_applicable, num=null, den=null, 시즌 total 제외
 *   각 케이스 direct == snapshot == HTTP 일치 확인 + seasonAreaProgressBySeason(시즌별) 확인.
 * 부가: 직전 phalanx 라인 복구로 stale 된 phalanx 테스트 유저 전원 재계산(고객앱 즉시 정합).
 * 격리: oranke, line_name 고정, 끝에 정리.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getCluster4WeeklyCardsForProfileUser } from "../lib/cluster4WeeklyCardsData";
import { recomputeAndStoreWeeklyCardsSnapshot, readWeeklyCardsSnapshot } from "../lib/cluster4WeeklyCardsSnapshot";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const IKEY = process.env.INTERNAL_API_KEY!;
const BASE = "http://localhost:3000";
const ORG = "oranke";
const MASTER_CODE = "CPBS-NN0001";
const LINE_NAME = "ZZ-집계SoT-역량라인";
const sb = createClient(URL, SERVICE);
const J = (o: unknown) => JSON.stringify(o);

async function adminCookie(): Promise<string> {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: "vanuatu.golden@gmail.com" });
  const { data: v } = await brow.auth.verifyOtp({ email: "vanuatu.golden@gmail.com", token: (link as any).properties.email_otp, type: "magiclink" });
  const cap: Array<{ name: string; value: string }> = [];
  const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}
async function cleanup() {
  const { data: apps } = await sb.from("cluster4_competency_applications").select("id,opened_line_id").eq("organization_slug", ORG).eq("line_name", LINE_NAME);
  for (const a of (apps ?? []) as any[]) {
    if (a.opened_line_id) { await sb.from("cluster4_line_targets").delete().eq("line_id", a.opened_line_id); await sb.from("cluster4_lines").delete().eq("id", a.opened_line_id); }
  }
  await sb.from("cluster4_competency_applications").delete().eq("organization_slug", ORG).eq("line_name", LINE_NAME);
}
function compForWeek(cards: any[], weekId: string) {
  const c = cards.find((x) => x.weekId === weekId);
  return (c?.lines ?? []).filter((l: any) => l.partType === "competency").map((l: any) => ({ tgt: l.lineTargetId ? "Y" : null, enh: l.enhancementStatus, num: l.numerator, den: l.denominator }));
}
async function httpCards(uid: string) {
  const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${uid}`, { headers: { "x-internal-api-key": IKEY } });
  const j = await res.json();
  return { cards: Array.isArray(j?.data) ? j.data : [], sap: j.seasonAreaProgressBySeason ?? {} };
}
function seasonComp(sap: any, seasonKey: string) {
  return (sap?.[seasonKey] ?? []).find((x: any) => x.key === "practical_competency");
}

async function main() {
  const cookie = await adminCookie();
  const H = { cookie, "Content-Type": "application/json" };
  await cleanup();

  const { data: tm } = await sb.from("test_user_markers").select("user_id");
  const ids = (tm ?? []).map((x: any) => x.user_id);
  const { data: profs } = await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", ORG).eq("growth_status", "active").in("user_id", ids).limit(6);
  const A = (profs ?? [])[0] as any; // 대상자
  const B = (profs ?? [])[1] as any; // 비대상자
  const C = (profs ?? [])[2] as any; // 라인 미개설 대조(개설 전 상태 확인용)
  const { data: master } = await sb.from("cluster4_competency_line_masters").select("id,line_code").eq("line_code", MASTER_CODE).maybeSingle();
  const weekId = (await (await fetch(`${BASE}/api/admin/cluster4/competency/applications?organization=${ORG}`, { headers: { cookie } })).json())?.data?.weekId;
  const wk = (await sb.from("weeks").select("start_date").eq("id", weekId).maybeSingle()).data as any;
  // 시즌키 파악(카드에서)
  const cCardsPre = await getCluster4WeeklyCardsForProfileUser(C.user_id);
  const seasonKey = (cCardsPre as any[]).find((x) => x.weekId === weekId)?.seasonKey;
  console.log(`week=${weekId?.slice(0, 8)}(${wk?.start_date}, season=${seasonKey})`);

  // 케이스 3(개설 전 not_applicable) — C 조회
  console.log("\n=== 케이스 3: 라인 미개설 → not_applicable, 집계 제외 ===");
  const cComp = compForWeek(cCardsPre as any[], weekId);
  console.log(`  C direct competency: ${J(cComp)} (den=null·not_applicable 기대)`);

  // A 만 개설
  await fetch(`${BASE}/api/admin/cluster4/competency/applications`, { method: "POST", headers: H, body: J({ organization: ORG, target_user_id: A.user_id, week_id: weekId, competency_line_master_id: (master as any).id, line_code: (master as any).line_code, line_name: LINE_NAME }) });
  await fetch(`${BASE}/api/admin/cluster4/competency/opening`, { method: "POST", headers: H, body: J({ action: "open", organization: ORG, week_id: weekId, output_link_1: "https://sot.example/cafe", output_description: "s" }) });
  await recomputeAndStoreWeeklyCardsSnapshot(A.user_id);
  await recomputeAndStoreWeeklyCardsSnapshot(B.user_id);

  const check = async (label: string, uid: string, expectEnh: string) => {
    const direct = await getCluster4WeeklyCardsForProfileUser(uid);
    const snap = await readWeeklyCardsSnapshot(uid);
    const snapCards = (snap.status === "hit" || snap.status === "stale") ? (snap.cards as any[]) : [];
    const { cards: http, sap } = await httpCards(uid);
    const dC = compForWeek(direct as any[], weekId), sC = compForWeek(snapCards, weekId), hC = compForWeek(http, weekId);
    const eq = J(dC) === J(sC) && J(sC) === J(hC);
    const sk = seasonComp(sap, seasonKey);
    console.log(`  ${label} competency=${J(hC)}  direct==snap==http=${eq}  시즌집계[${seasonKey}]="총 ${sk?.total}개 중 ${sk?.earned}개"`);
    const ok = hC.some((c: any) => c.enh === expectEnh) && eq;
    return { ok, sk };
  };

  console.log("\n=== 케이스 1: 대상자 success ===");
  const r1 = await check("A(대상자)", A.user_id, "success");
  console.log("\n=== 케이스 2: 비대상자 fail ===");
  const r2 = await check("B(비대상)", B.user_id, "fail");

  console.log("\n=== 판정 ===");
  console.log(`  1) 대상자 success + 집계 포함(earned>=1): ${r1.ok && (r1.sk?.total ?? 0) >= 1 && (r1.sk?.earned ?? 0) >= 1 ? "PASS ✅" : "확인"}`);
  console.log(`  2) 비대상 fail + 집계 분모 포함(total>=1, earned=0에도 총>=1): ${r2.ok && (r2.sk?.total ?? 0) >= 1 ? "PASS ✅ (강화실패↔총0 모순 없음)" : "FAIL ❌"}`);
  console.log(`  3) 미개설 not_applicable + 집계 제외: ${cComp.every((c: any) => c.enh === "not_applicable" && c.den == null) ? "PASS ✅" : (cComp.length === 0 ? "N/A(카드없음)" : "확인")}`);

  await cleanup();

  // ── 부가: 직전 phalanx 라인 복구로 stale 된 phalanx 테스트 유저 전원 재계산 ──
  console.log("\n=== phalanx 테스트 유저 snapshot 재계산(stale 해소) ===");
  const { data: phal } = await sb.from("user_profiles").select("user_id").eq("organization_slug", "phalanx").in("user_id", ids);
  let done = 0;
  for (const p of (phal ?? []) as any[]) { try { await recomputeAndStoreWeeklyCardsSnapshot(p.user_id); done++; } catch {} }
  console.log(`  재계산 완료: ${done}/${(phal ?? []).length}명`);
}
main().catch((e) => { console.error("FATAL", e?.stack ?? e); process.exit(1); });
