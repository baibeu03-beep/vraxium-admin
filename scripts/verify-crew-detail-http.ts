// ===================================================================
// 크루 상세 HTTP 검증 — GET /api/admin/members/[user_id] 응답이 direct(getCrewDetailDto)와 동일한지.
//   실행: dev server(:3000) 가동 후
//         npx tsx --env-file=.env.local scripts/verify-crew-detail-http.ts
//   read-only. 인증 = magiclink 세션 쿠키(브라우저 검증과 동일). DB write 없음.
// ===================================================================
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCrewDetailDto } from "@/lib/adminCrewDetailData";

const BASE = "http://localhost:3000";
const EMAIL = "vanuatu.golden@gmail.com";

const env = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
const get = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim() ?? "";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");

let fail = 0;
const ck = (label: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${d ? ` — ${d}` : ""}`);
  if (!ok) fail += 1;
};

async function buildCookie(): Promise<string> {
  const brow = createClient(URL_, ANON);
  const { data: link, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email: EMAIL,
  });
  if (error) throw new Error(error.message);
  const otp = (link as { properties?: { email_otp?: string } }).properties?.email_otp;
  const { data: v, error: vErr } = await brow.auth.verifyOtp({
    email: EMAIL,
    token: otp!,
    type: "magiclink",
  });
  if (vErr || !v.session) throw new Error(vErr?.message ?? "세션 생성 실패");
  const cap: { name: string; value: string }[] = [];
  const srv = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (items) => cap.push(...items) },
  });
  await srv.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  const cookie = await buildCookie();

  // 샘플: org별 + 졸업/중단.
  const ids = new Set<string>();
  for (const org of ["encre", "oranke", "phalanx"]) {
    const { data } = await supabaseAdmin
      .from("user_profiles").select("user_id")
      .eq("organization_slug", org).not("activity_started_at", "is", null).limit(1);
    for (const r of (data ?? []) as { user_id: string }[]) ids.add(r.user_id);
  }
  for (const gs of ["graduated", "suspended"]) {
    const { data } = await supabaseAdmin
      .from("user_profiles").select("user_id").eq("growth_status", gs).limit(1);
    for (const r of (data ?? []) as { user_id: string }[]) ids.add(r.user_id);
  }

  const FIELDS = [
    "userId", "displayName", "organizationSlug", "profilePhotoUrl", "gender",
    "birthDate", "age", "address", "contactPhone", "contactEmail", "schoolName",
    "departmentName", "admissionPeriod", "crewCode", "statusLabel",
    "activityStartDate", "activityStartWeek", "activityEndDate", "activityEndWeek",
    "classLabel", "teamName", "partName",
  ] as const;

  for (const userId of ids) {
    const direct = await getCrewDetailDto(userId);
    const res = await fetch(`${BASE}/api/admin/members/${userId}`, {
      headers: { cookie },
      cache: "no-store",
    });
    const json = await res.json();
    console.log(`▶ ${direct?.displayName} (${userId})`);
    ck("HTTP 200 + success", res.ok && json.success === true, `status=${res.status}`);
    if (!json.success) continue;
    const http = json.data;
    let same = true;
    const diffs: string[] = [];
    for (const f of FIELDS) {
      if ((direct as any)?.[f] !== http[f]) {
        same = false;
        diffs.push(`${f}: direct=${JSON.stringify((direct as any)?.[f])} http=${JSON.stringify(http[f])}`);
      }
    }
    ck("direct == HTTP (전 필드)", same, diffs.join(" | "));
    ck("note 포함", typeof http.note === "object" && http.note !== null);
  }

  console.log("─".repeat(50));
  console.log(fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
