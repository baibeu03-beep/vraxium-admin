/**
 * verify-experience-overall-inactive-part-sot.ts
 * 실무 경험 [팀 총괄] — "미개설 파트 행 비활성" UI 판정 SoT 검증.
 *   행 비활성 스타일은 board.parts[].submitted (DTO) 로만 판정한다(문자열/파트명 무관).
 *   여기서는 그 SoT 필드가 실제 HTTP GET 응답에서 부분신청 상태를 정확히 구분하는지 확인한다.
 *   (렌더링은 이 boolean 의 순수 함수 — !submitted → 행 muted/opacity/cursor 비활성.)
 *
 *   실행: npx tsx --env-file=.env.local scripts/verify-experience-overall-inactive-part-sot.ts
 *   ⚠ seed 한 part_submissions + overall 헤더는 말미에 원복.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import type { ScopeMode } from "@/lib/userScope";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

const ORG = "oranke";
const LEGS: Array<{ label: string; mode: ScopeMode; teamName: string }> = [
  { label: "operating", mode: "operating", teamName: "음료(T)" },
  { label: "test", mode: "test", teamName: "과일(T)" },
];

let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function latestWeekId(): Promise<string> {
  const { data } = await sb.from("weeks").select("id").order("start_date", { ascending: false }).limit(1).maybeSingle();
  return (data as { id: string }).id;
}
async function teamId(name: string): Promise<string | null> {
  const { data } = await sb.from("cluster4_teams").select("id").eq("organization_slug", ORG).eq("team_name", name).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}
async function cleanAll(weekId: string, tid: string) {
  await sb.from("cluster4_experience_team_overall").delete().eq("organization_slug", ORG).eq("week_id", weekId).eq("team_id", tid);
  await sb.from("cluster4_experience_part_submissions").delete().eq("organization_slug", ORG).eq("week_id", weekId).eq("team_id", tid);
}
async function seedApply(weekId: string, tid: string, part: string) {
  await sb.from("cluster4_experience_part_submissions").upsert(
    { organization_slug: ORG, week_id: weekId, team_id: tid, part_name: part, submitted_by: null, submitted_at: new Date().toISOString() },
    { onConflict: "organization_slug,week_id,team_id,part_name" },
  );
}
async function adminCookie(): Promise<string | null> {
  try {
    const admin = createClient(SUPABASE_URL, SERVICE);
    const browser = createClient(SUPABASE_URL, ANON);
    const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
    const otp = link.properties?.email_otp; if (!otp) return null;
    const { data: v } = await browser.auth.verifyOtp({ email: ADMIN_EMAIL, token: otp, type: "magiclink" });
    const captured: Array<{ name: string; value: string }> = [];
    const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (i) => captured.push(...i) } });
    await server.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
    return captured.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch { return null; }
}
async function httpGet(cookie: string, weekId: string, tid: string, teamName: string, mode: ScopeMode) {
  const qs = new URLSearchParams({ organization: ORG, week_id: weekId, team_id: tid, team_name: teamName });
  if (mode === "test") qs.set("mode", "test");
  const res = await fetch(`${BASE}/api/admin/cluster4/experience/team-overall?${qs}`, { headers: { cookie } });
  return { status: res.status, json: await res.json() };
}

async function main() {
  const weekId = await latestWeekId();
  const cookie = await adminCookie();
  if (!cookie) { console.log("admin 쿠키 실패 — 중단"); process.exit(1); }

  for (const leg of LEGS) {
    console.log(`\n=== [${leg.label}] ${leg.teamName} ===`);
    const tid = await teamId(leg.teamName);
    if (!tid) { ck(`[${leg.label}] team_id`, false, "팀 없음"); continue; }
    await cleanAll(weekId, tid);

    // 전 파트 목록 파악.
    const g0 = await httpGet(cookie!, weekId, tid, leg.teamName, leg.mode);
    const parts0: Array<{ partName: string; submitted: boolean }> = (g0.json?.data?.parts ?? []).map((p: { partName: string; submitted: boolean }) => ({ partName: p.partName, submitted: p.submitted }));
    ck(`[${leg.label}] GET 200 + parts[].submitted 필드`, g0.status === 200 && parts0.length >= 2 && parts0.every((p) => typeof p.submitted === "boolean"), `parts=${JSON.stringify(parts0.map((p) => p.partName))}`);
    if (parts0.length < 2) { await cleanAll(weekId, tid); continue; }

    // 미신청(초기) → 전 파트 submitted=false (전 행 비활성 대상).
    ck(`[${leg.label}] 초기(미신청): 전 파트 submitted=false → 전 파트 행 비활성 대상`, parts0.every((p) => p.submitted === false));

    // 부분 신청: 첫 파트만 [개설 신청] seed.
    const applied = parts0[0].partName;
    await seedApply(weekId, tid, applied);
    const g1 = await httpGet(cookie!, weekId, tid, leg.teamName, leg.mode);
    const parts1: Array<{ partName: string; submitted: boolean }> = (g1.json?.data?.parts ?? []);
    const submittedSet = parts1.filter((p) => p.submitted).map((p) => p.partName);
    const unsubmittedSet = parts1.filter((p) => !p.submitted).map((p) => p.partName);
    ck(
      `[${leg.label}] 부분신청: '${applied}'만 submitted=true(활성 유지), 나머지 false(행 비활성)`,
      submittedSet.length === 1 && submittedSet[0] === applied && unsubmittedSet.length === parts1.length - 1,
      `개설=${JSON.stringify(submittedSet)} 미개설=${JSON.stringify(unsubmittedSet)}`,
    );

    // 전 파트 신청 → 전 파트 submitted=true (비활성 대상 0).
    for (const p of parts1) await seedApply(weekId, tid, p.partName);
    const g2 = await httpGet(cookie!, weekId, tid, leg.teamName, leg.mode);
    const parts2: Array<{ partName: string; submitted: boolean }> = (g2.json?.data?.parts ?? []);
    ck(`[${leg.label}] 전 신청: 전 파트 submitted=true → 비활성 행 0(기존과 동일)`, parts2.length >= 2 && parts2.every((p) => p.submitted === true));

    await cleanAll(weekId, tid);
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
