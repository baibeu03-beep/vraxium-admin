/**
 * verify-roster-restusers-fix — /admin/members/roster 500(.in URL 길이) 수정 검증.
 *   사전: admin dev :3000. Usage: npx tsx --env-file=.env.local scripts/verify-roster-restusers-fix.ts
 *
 * 1) direct listMembersRoster (전체·org별) 성공 + 인원
 * 2) HTTP GET /api/admin/members/roster (전체·org별) 200 + 인원
 * 3) direct == HTTP (인원·seasonal_rest 수 일치)
 * 4) seasonal_rest 사용자가 로스터에 표시되는지
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { listMembersRoster } from "@/lib/adminMembersData";

const env = readFileSync(".env.local", "utf8");
const get = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL")!, ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY")!, SERVICE = get("SUPABASE_SERVICE_ROLE_KEY")!;
const BASE = "http://localhost:3000";
const EMAIL = "vanuatu.golden@gmail.com";
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);

let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const restCount = (members: any[]) => members.filter((m) => m.displayGrowthStatus === "seasonal_rest").length;

async function main() {
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const otp = (link as any).properties.email_otp;
  const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: otp, type: "magiclink" });
  const cap: Array<{ name: string; value: string }> = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  const cookie = cap.map((c) => `${c.name}=${c.value}`).join("; ");

  for (const org of [null, "encre", "oranke", "phalanx"] as const) {
    const label = org ?? "전체";
    console.log(`\n=== org=${label} (mode=operating) ===`);

    // 1) direct
    let direct: any = null;
    try {
      direct = await listMembersRoster({ organization: org as any, mode: "operating" });
      ck("direct listMembersRoster 성공", true, `members=${direct.members.length} seasonal_rest=${restCount(direct.members)} partialFail=${direct.partialFailure ? "Y" : "N"}`);
    } catch (e) {
      ck("direct listMembersRoster 성공", false, e instanceof Error ? e.message : String(e));
    }

    // 2) HTTP
    const qs = org ? `?organization=${org}&mode=operating` : `?mode=operating`;
    const res = await fetch(`${BASE}/api/admin/members/roster${qs}`, { headers: { cookie } });
    ck("HTTP 200", res.status === 200, `status=${res.status}`);
    const body: any = await res.json().catch(() => null);
    const httpMembers = body?.data?.members ?? [];
    ck("HTTP members 반환", Array.isArray(httpMembers) && (httpMembers.length > 0 || label !== "전체"), `members=${httpMembers.length}`);

    // 3) direct == HTTP
    if (direct) {
      ck("direct==HTTP 인원", direct.members.length === httpMembers.length, `${direct.members.length} | ${httpMembers.length}`);
      ck("direct==HTTP seasonal_rest 수", restCount(direct.members) === restCount(httpMembers), `${restCount(direct.members)} | ${restCount(httpMembers)}`);
    }

    // 4) seasonal_rest 표시
    if (org) ck("seasonal_rest 사용자 표시됨", restCount(httpMembers) > 0, `${restCount(httpMembers)}명`);
  }

  console.log(`\n${fail === 0 ? "✅ roster 수정 검증 전체 통과" : "✗ " + fail + "건 실패"}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
