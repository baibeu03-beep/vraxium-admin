/**
 * 주차 SoT 통일 실제 HTTP 검증 — T윤서진 기준 4표면.
 *   1) GET /api/admin/crews?organization=encre                 → cumulativeWeeks/approvedWeeks (구 29주 표면)
 *   2) GET /api/admin/users/{uid}/weekly-status                → summary.total/success/approved/cumulative
 *   3) GET /api/admin/crews/{uid}/resume-card/resume           → seasonRecords (구 봄 2주 표면)
 *   4) GET /api/admin/crews/{uid}/cluster4/weekly-growth       → growthSummary.approvedWeeks (구 8주 표면)
 *   사전조건: dev 서버 http://localhost:3000.
 *   npx tsx scripts/verify-week-sot-http.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const TARGET_NAME = "T윤서진";

function ensureEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function makeAdminCookieHeader() {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const serviceRoleKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  if (linkError || !linkData?.properties?.email_otp) {
    throw new Error(linkError?.message ?? "Failed to generate admin magic link");
  }
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session) {
    throw new Error(verifyError?.message ?? "Failed to verify admin OTP");
  }
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return [];
      },
      setAll(items) {
        captured.push(...items.map((i) => ({ name: i.name, value: i.value })));
      },
    },
  });
  const { error: setError } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (setError) throw new Error(setError.message);
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function getJson(cookie: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const cookie = await makeAdminCookieHeader();

  // 1) /crews 목록 (구 29주 표면)
  const crews = await getJson(cookie, "/api/admin/crews?organization=encre");
  const crewRows = (crews?.data ?? crews?.crews ?? []) as any[];
  const me = crewRows.find((c) => (c.displayName ?? "").includes("윤서진"));
  if (!me) throw new Error("crews 목록에서 T윤서진 미발견");
  console.log(
    `[1] /api/admin/crews          → cumulativeWeeks=${me.cumulativeWeeks}, approvedWeeks=${me.approvedWeeks}`,
  );
  const uid = me.userId ?? me.user_id ?? me.legacyUserId;

  // 2) weekly-status 요약
  const ws = await getJson(cookie, `/api/admin/users/${uid}/weekly-status`);
  const s = ws?.data?.summary ?? ws?.summary;
  console.log(
    `[2] /weekly-status summary    → total=${s?.total_weeks}, success=${s?.success_weeks}, approved(cache)=${s?.approved_weeks}, cumulative(cache)=${s?.cumulative_weeks}`,
  );

  // 3) 이력서 seasonRecords (구 봄 2주 표면)
  const resume = await getJson(
    cookie,
    `/api/admin/crews/${uid}/resume-card/resume`,
  );
  const recs = resume?.data?.seasonRecords ?? resume?.seasonRecords ?? [];
  for (const r of recs) {
    console.log(
      `[3] resume seasonRecord       → ${r.year} ${r.seasonName} ${r.approvedWeeks}/${r.totalWeeks} (${r.progressStatus}/${r.reviewStatus})`,
    );
  }

  // 4) cluster4 weekly-growth (구 8주 표면)
  const wg = await getJson(
    cookie,
    `/api/admin/crews/${uid}/cluster4/weekly-growth`,
  );
  const g = wg?.data?.growthSummary ?? wg?.growthSummary;
  console.log(
    `[4] weekly-growth summary     → approved=${g?.approvedWeeks}, failed=${g?.failedWeeks}, rest=${g?.restWeeks}, available=${g?.availableWeeks}`,
  );

  // 판정: 같은 의미(누적 승인 주차)는 같은 값이어야 한다.
  const okApproved =
    me.approvedWeeks === s?.approved_weeks &&
    s?.approved_weeks === s?.success_weeks &&
    s?.success_weeks === g?.approvedWeeks;
  const okCumulative = me.cumulativeWeeks === s?.cumulative_weeks &&
    s?.cumulative_weeks === s?.total_weeks;
  const spring = recs.find((r: any) => r.seasonName?.includes("봄"));
  console.log(
    `\n판정: 누적 승인 주차 일치(${me.approvedWeeks}) ${okApproved ? "✅" : "❌"} | 누적 주차 일치(${me.cumulativeWeeks}) ${okCumulative ? "✅" : "❌"} | 봄 시즌(시즌 범위) ${spring?.approvedWeeks}/${spring?.totalWeeks}`,
  );
  if (!okApproved || !okCumulative) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
