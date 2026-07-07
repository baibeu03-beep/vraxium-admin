/**
 * [실무 역량] 성장 중단(paused/suspended) 유저 개설 대상 제외 검증.
 *   npx tsx --env-file=.env.local scripts/verify-competency-growth-stop-exclusion.ts
 *
 * 검증(사용자 요청):
 *   1. active 유저는 수동 추가 검색에 노출 + POST 201
 *   2. paused/suspended 유저는 검색 피커에 미노출(excludeGrowthStopped)
 *   3. paused 유저를 직접 POST payload 로 보내면 422 차단
 *   4. open 단계에서 (게이트 우회로 삽입된) paused 승인 신청은 라인 미생성(skip)
 * 격리: oranke, line_name 고정, 끝에 정리.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE = "http://localhost:3000";
const ADMIN_EMAIL = "vanuatu.golden@gmail.com";
const ORG = "oranke";
const MASTER_CODE = "CPBS-NN0001";
const LINE_NAME = "ZZ-성장중단-역량라인";
const sb = createClient(URL, SERVICE);
const J = (o: unknown) => JSON.stringify(o);

async function adminCookie(): Promise<string> {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  const { data: v } = await brow.auth.verifyOtp({ email: ADMIN_EMAIL, token: (link as any).properties.email_otp, type: "magiclink" });
  const cap: Array<{ name: string; value: string }> = [];
  const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function cleanup() {
  const { data: apps } = await sb.from("cluster4_competency_applications").select("id,opened_line_id").eq("organization_slug", ORG).eq("line_name", LINE_NAME);
  for (const a of (apps ?? []) as any[]) {
    if (a.opened_line_id) {
      await sb.from("cluster4_line_targets").delete().eq("line_id", a.opened_line_id);
      await sb.from("cluster4_lines").delete().eq("id", a.opened_line_id);
    }
  }
  await sb.from("cluster4_competency_applications").delete().eq("organization_slug", ORG).eq("line_name", LINE_NAME);
}

async function search(cookie: string, name: string, withGrowthFlag: boolean) {
  const sp = new URLSearchParams({ q: name, organization: ORG, excludeSeasonRest: "1" });
  if (withGrowthFlag) sp.set("excludeGrowthStopped", "1");
  const res = await fetch(`${BASE}/api/admin/cluster4/cafe-line-crew?${sp.toString()}`, { headers: { cookie } });
  const json = await res.json();
  return (json?.data?.crews ?? []) as any[];
}

async function main() {
  const cookie = await adminCookie();
  const H = { cookie, "Content-Type": "application/json" };
  await cleanup();

  const { data: tm } = await sb.from("test_user_markers").select("user_id");
  const ids = (tm ?? []).map((x: any) => x.user_id);
  const { data: profs } = await sb.from("user_profiles").select("user_id,display_name,growth_status").eq("organization_slug", ORG).in("user_id", ids);
  const active = (profs ?? []).find((p: any) => p.growth_status === "active") as any;
  const paused = (profs ?? []).find((p: any) => p.growth_status === "paused" || p.growth_status === "suspended") as any;
  const { data: master } = await sb.from("cluster4_competency_line_masters").select("id,line_code").eq("line_code", MASTER_CODE).maybeSingle();
  console.log(`active=${active?.display_name}(${active?.user_id?.slice(0, 8)})  paused=${paused?.display_name}(${paused?.user_id?.slice(0, 8)}, growth=${paused?.growth_status})`);

  // ── 1&2: 검색 피커 노출/제외 ──
  console.log("\n=== 1&2. 수동 추가 검색 피커 ===");
  const pausedNoFlag = await search(cookie, paused.display_name, false);
  const pausedWithFlag = await search(cookie, paused.display_name, true);
  const activeWithFlag = await search(cookie, active.display_name, true);
  const pInNoFlag = pausedNoFlag.some((c) => c.userId === paused.user_id);
  const pInFlag = pausedWithFlag.some((c) => c.userId === paused.user_id);
  const aInFlag = activeWithFlag.some((c) => c.userId === active.user_id);
  console.log(`  paused 검색(플래그 없음)=포함:${pInNoFlag} (대조군, 포함되어야)`);
  console.log(`  paused 검색(excludeGrowthStopped)=포함:${pInFlag} (제외되어야 → false 기대)`);
  console.log(`  active 검색(excludeGrowthStopped)=포함:${aInFlag} (포함되어야 → true 기대)`);
  console.log(`  => 검증: paused제외=${pInFlag === false}  active노출=${aInFlag === true}`);

  // ── 3: 직접 POST payload 차단 ──
  console.log("\n=== 3. paused 직접 POST 차단 ===");
  const weekId = (await (await fetch(`${BASE}/api/admin/cluster4/competency/applications?organization=${ORG}`, { headers: { cookie } })).json())?.data?.weekId;
  const postPaused = await fetch(`${BASE}/api/admin/cluster4/competency/applications`, {
    method: "POST", headers: H,
    body: J({ organization: ORG, target_user_id: paused.user_id, week_id: weekId, competency_line_master_id: (master as any).id, line_code: (master as any).line_code, line_name: LINE_NAME }),
  });
  const postPausedJson = await postPaused.json();
  console.log(`  POST(paused): http=${postPaused.status} success=${postPausedJson.success} error="${postPausedJson.error ?? ""}"`);
  const postActive = await fetch(`${BASE}/api/admin/cluster4/competency/applications`, {
    method: "POST", headers: H,
    body: J({ organization: ORG, target_user_id: active.user_id, week_id: weekId, competency_line_master_id: (master as any).id, line_code: (master as any).line_code, line_name: LINE_NAME }),
  });
  console.log(`  POST(active): http=${postActive.status} success=${(await postActive.json()).success}`);
  console.log(`  => 검증: paused차단(422)=${postPaused.status === 422}  active허용(201)=${postActive.status === 201}`);

  // ── 4: open 단계 방어 — 게이트 우회로 paused 승인 신청 삽입 후 개설 → 라인 미생성 ──
  console.log("\n=== 4. open 단계 방어(우회 삽입 후 개설) ===");
  await sb.from("cluster4_competency_applications").insert({
    organization_slug: ORG, week_id: weekId, target_user_id: paused.user_id,
    competency_line_master_id: (master as any).id, line_code: (master as any).line_code,
    line_name: LINE_NAME, source: "manual", approval_checked: true, created_by: null,
  });
  const openJson = await (await fetch(`${BASE}/api/admin/cluster4/competency/opening`, { method: "POST", headers: H, body: J({ action: "open", organization: ORG, week_id: weekId, output_link_1: "https://gs.example/cafe", output_description: "gs" }) })).json();
  const d = openJson?.data ?? {};
  const { data: pausedApp } = await sb.from("cluster4_competency_applications").select("resolution,opened_line_id").eq("organization_slug", ORG).eq("line_name", LINE_NAME).eq("target_user_id", paused.user_id).maybeSingle();
  const { data: activeApp } = await sb.from("cluster4_competency_applications").select("resolution,opened_line_id").eq("organization_slug", ORG).eq("line_name", LINE_NAME).eq("target_user_id", active.user_id).maybeSingle();
  console.log(`  [개설응답] reflectedCrews=${d.reflectedCrews} reflectedLines=${d.reflectedLines}`);
  console.log(`  paused app: resolution=${(pausedApp as any)?.resolution} opened_line=${(pausedApp as any)?.opened_line_id ? "생성됨(❌)" : "없음(✅)"}`);
  console.log(`  active app: resolution=${(activeApp as any)?.resolution} opened_line=${(activeApp as any)?.opened_line_id ? "생성됨(✅)" : "없음"}`);
  console.log(`  => 검증: paused라인미생성=${!(pausedApp as any)?.opened_line_id}  active라인생성=${!!(activeApp as any)?.opened_line_id}`);

  await cleanup();
  const { data: left } = await sb.from("cluster4_competency_applications").select("id").eq("organization_slug", ORG).eq("line_name", LINE_NAME);
  console.log(`\n=== 정리 === 잔존=${(left ?? []).length}건`);
}
main().catch((e) => { console.error("FATAL", e?.stack ?? e); process.exit(1); });
