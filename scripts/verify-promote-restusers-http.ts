/**
 * verify-promote-restusers-http — 승격자 direct 함수 결과 vs 실제 HTTP API 응답 동일성 검증.
 *   사전: admin dev :3000. Usage: npx tsx --env-file=.env.local scripts/verify-promote-restusers-http.ts
 *
 * 검증:
 *   1) direct: getGrowthIndicators(uuid).displayGrowthStatus === 'seasonal_rest' (2-write 파생 정합)
 *   2) direct: getCrewDetailDto(uuid).seasonSummary.currentSeason 에 '휴식 중'
 *   3) HTTP  : GET /api/admin/members/[uuid] → data.seasonSummary.currentSeason 동일
 *   4) direct == HTTP: crew detail 핵심 필드(status·currentSeason·successSeasons·restSeasons) 일치
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getGrowthIndicators } from "@/lib/cluster3GrowthData";
import { getCrewDetailDto } from "@/lib/adminCrewDetailData";

const env = readFileSync(".env.local", "utf8");
const get = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL")!, ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY")!, SERVICE = get("SUPABASE_SERVICE_ROLE_KEY")!;
const BASE = "http://localhost:3000";
const EMAIL = "vanuatu.golden@gmail.com";
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);

let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function main() {
  // 세션 쿠키 (magiclink → cookie 헤더 문자열)
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const otp = (link as any).properties.email_otp;
  const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: otp, type: "magiclink" });
  const cap: Array<{ name: string; value: string }> = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  const cookieHeader = cap.map((c) => `${c.name}=${c.value}`).join("; ");

  const orgIdx = process.argv.indexOf("--org");
  const ORG = orgIdx >= 0 ? process.argv[orgIdx + 1].trim() : null;
  const sampleIdx = process.argv.indexOf("--sample");
  const SAMPLE = sampleIdx >= 0 ? Number(process.argv[sampleIdx + 1]) : 5;
  let q: any = sb.from("legacy_pms_restuser_archive")
    .select("source_system,legacy_user_id,name,promoted_user_id,organization_slug").eq("promotion_status", "promoted").order("legacy_user_id");
  if (ORG) q = q.eq("organization_slug", ORG);
  const { data: all } = await q;
  // 샘플: 앞·중간·뒤를 고루 (HTTP 는 1인 ~10초라 전수 비현실적).
  const arr = (all ?? []) as any[];
  const promoted = arr.length <= SAMPLE ? arr
    : Array.from({ length: SAMPLE }, (_, i) => arr[Math.floor((i * (arr.length - 1)) / (SAMPLE - 1))]);
  console.log(`HTTP 검증 표본 ${promoted.length}/${arr.length}${ORG ? ` org=${ORG}` : ""}`);

  for (const p of promoted) {
    const uid = (p as any).promoted_user_id as string;
    console.log(`\n=== ${(p as any).source_system}/${(p as any).legacy_user_id} ${(p as any).name} uuid=${uid.slice(0, 8)} ===`);

    // 1) direct 파생 성장상태 (process.growthDisplayKey = resolution.display)
    const gi = await getGrowthIndicators(uid);
    const display = (gi as any).process?.growthDisplayKey;
    const rawStored = (gi as any).process?.growthStatus;
    ck("direct 파생 displayKey = seasonal_rest", display === "seasonal_rest", `display=${display} raw=${rawStored}`);

    // 2) direct crew detail
    const detail = await getCrewDetailDto(uid, { generatedBy: uid });
    const dSeason = (detail as any)?.seasonSummary?.currentSeason ?? "";
    ck("direct crew detail currentSeason '휴식 중'", String(dSeason).includes("휴식 중"), dSeason);

    // 3) HTTP crew detail
    const res = await fetch(`${BASE}/api/admin/members/${uid}`, { headers: { cookie: cookieHeader } });
    ck("HTTP 200", res.status === 200, `status=${res.status}`);
    const body: any = await res.json().catch(() => null);
    const hSeason = body?.data?.seasonSummary?.currentSeason ?? "";
    ck("HTTP currentSeason '휴식 중'", String(hSeason).includes("휴식 중"), hSeason);

    // 4) direct == HTTP (핵심 필드)
    const dss = (detail as any)?.seasonSummary ?? {};
    const hss = body?.data?.seasonSummary ?? {};
    ck("direct==HTTP currentSeason", dss.currentSeason === hss.currentSeason, `${dss.currentSeason} | ${hss.currentSeason}`);
    ck("direct==HTTP successSeasons", dss.successSeasons === hss.successSeasons, `${dss.successSeasons} | ${hss.successSeasons}`);
    ck("direct==HTTP restSeasons", dss.restSeasons === hss.restSeasons, `${dss.restSeasons} | ${hss.restSeasons}`);
    ck("direct==HTTP status(raw)", (detail as any)?.status === body?.data?.status, `${(detail as any)?.status} | ${body?.data?.status}`);
  }
  console.log(`\n${fail === 0 ? "✅ direct == HTTP 검증 통과" : "✗ " + fail + "건 실패 — 원인 처리 필요"}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
