/**
 * [실무 역량] 비대상자 집계 진단 — 대상자 개설 후 비대상자의 competency 카드/집계 확인.
 *   npx tsx --env-file=.env.local scripts/diag-competency-nontarget-aggregate.ts
 *
 * 대상자 A 개설 → 비대상자 B(같은 org, 미배정)의:
 *   - direct 함수 competency 카드(해당 주차): enhancementStatus / lineTargetId / numerator / denominator
 *   - seasonAreaProgress(competency): earned/total (= "총 N개 중 M개")
 * 기대: B 는 synthetic fail(enh=fail, tgt=null, den=1, num=0) → 집계 총≥1 중 0. not_applicable(den=null)이면 버그.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getCluster4WeeklyCardsForProfileUser } from "../lib/cluster4WeeklyCardsData";
import { recomputeAndStoreWeeklyCardsSnapshot } from "../lib/cluster4WeeklyCardsSnapshot";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const IKEY = process.env.INTERNAL_API_KEY!;
const BASE = "http://localhost:3000";
const ORG = "oranke";
const MASTER_CODE = "CPBS-NN0001";
const LINE_NAME = "ZZ-비대상집계-역량라인";
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
  const comp = (c?.lines ?? []).filter((l: any) => l.partType === "competency");
  return comp.map((l: any) => ({ code: l.lineCode, tgt: l.lineTargetId ? "Y" : null, enh: l.enhancementStatus, reason: l.enhancementReason, num: l.numerator, den: l.denominator }));
}

async function main() {
  const cookie = await adminCookie();
  const H = { cookie, "Content-Type": "application/json" };
  await cleanup();

  const { data: tm } = await sb.from("test_user_markers").select("user_id");
  const ids = (tm ?? []).map((x: any) => x.user_id);
  const { data: profs } = await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", ORG).eq("growth_status", "active").in("user_id", ids).limit(5);
  const A = (profs ?? [])[0] as any; // 대상자
  const B = (profs ?? [])[1] as any; // 비대상자
  const { data: master } = await sb.from("cluster4_competency_line_masters").select("id,line_code").eq("line_code", MASTER_CODE).maybeSingle();
  const weekId = (await (await fetch(`${BASE}/api/admin/cluster4/competency/applications?organization=${ORG}`, { headers: { cookie } })).json())?.data?.weekId;
  console.log(`week=${weekId?.slice(0, 8)} 대상자A=${A.display_name}(${A.user_id.slice(0, 8)}) 비대상자B=${B.display_name}(${B.user_id.slice(0, 8)})`);

  // A 만 수동 추가 + 개설
  await fetch(`${BASE}/api/admin/cluster4/competency/applications`, { method: "POST", headers: H, body: J({ organization: ORG, target_user_id: A.user_id, week_id: weekId, competency_line_master_id: (master as any).id, line_code: (master as any).line_code, line_name: LINE_NAME }) });
  await fetch(`${BASE}/api/admin/cluster4/competency/opening`, { method: "POST", headers: H, body: J({ action: "open", organization: ORG, week_id: weekId, output_link_1: "https://diag.example/cafe", output_description: "d" }) });

  // B 스냅샷 강제 재계산(org audience stale 반영 보장)
  await recomputeAndStoreWeeklyCardsSnapshot(B.user_id);

  // direct
  const directB = await getCluster4WeeklyCardsForProfileUser(B.user_id);
  console.log(`\n[비대상자 B — direct] 해당주차 competency: ${J(compForWeek(directB as any[], weekId))}`);

  // HTTP + seasonAreaProgress
  const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${B.user_id}`, { headers: { "x-internal-api-key": IKEY } });
  const j = await res.json();
  const httpB = Array.isArray(j?.data) ? j.data : [];
  console.log(`[비대상자 B — HTTP] 해당주차 competency: ${J(compForWeek(httpB, weekId))}`);
  const sap = (j?.seasonAreaProgress ?? []).find((p: any) => p.key === "competency" || p.label?.includes("역량"));
  console.log(`[비대상자 B — seasonAreaProgress competency] ${J(sap)}  ← "총 ${sap?.total ?? "?"}개 중 ${sap?.earned ?? "?"}개"`);

  // 대상자 A 도 확인(대조)
  const res2 = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${A.user_id}`, { headers: { "x-internal-api-key": IKEY } });
  const j2 = await res2.json();
  const sapA = (j2?.seasonAreaProgress ?? []).find((p: any) => p.key === "competency" || p.label?.includes("역량"));
  console.log(`\n[대상자 A — HTTP] 해당주차 competency: ${J(compForWeek(Array.isArray(j2?.data) ? j2.data : [], weekId))}`);
  console.log(`[대상자 A — seasonAreaProgress competency] ${J(sapA)}`);

  console.log("\n=== 판정 ===");
  const bComp = compForWeek(httpB, weekId);
  const bFail = bComp.find((c: any) => c.enh === "fail");
  console.log(`  비대상 B: fail카드=${!!bFail} den=${bFail?.den ?? "-"} → 집계 총 ${sap?.total}개 중 ${sap?.earned}개`);
  console.log(`  기대: fail이면 den>=1 이고 집계 총>=1. 현재 ${bFail && (sap?.total ?? 0) >= 1 ? "정합 ✅" : "모순 ❌ (강화실패인데 총 0)"}`);

  await cleanup();
  console.log("\n정리 완료");
}
main().catch((e) => { console.error("FATAL", e?.stack ?? e); process.exit(1); });
