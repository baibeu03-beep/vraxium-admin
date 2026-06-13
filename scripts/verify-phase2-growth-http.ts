// 검증(HTTP, READ-ONLY) — Phase 2: 성장 동기화 operating dry-run direct==HTTP.
//   사전: dev 서버(:3000). 실행: npx tsx --env-file=.env.local scripts/verify-phase2-growth-http.ts
//
// ⚠ scope=test HTTP 경로는 즉시 write(success→fail + markStaleMany) 라 호출하지 않는다
//    (DB write/snapshot 재계산 금지). 안전한 operating dry-run(scope=all,confirm=false)만 검증.

import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { syncAllExperienceGrowthWeekStatuses } from "@/lib/cluster4WeeklyGrowthData";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

let pass = 0;
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

async function adminCookie(): Promise<string> {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: link, error } = await sb.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  if (error) throw error;
  const otp = link.properties?.email_otp;
  if (!otp) throw new Error("email_otp 없음");
  const { data: v, error: vErr } = await browser.auth.verifyOtp({ email: ADMIN_EMAIL, token: otp, type: "magiclink" });
  if (vErr) throw vErr;
  const cap: Array<{ name: string; value: string }> = [];
  const srv = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function main() {
  const cookie = await adminCookie();
  // 서버 대기.
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/admin/cluster4/admin-org`, { headers: { cookie } });
      if (r.status === 200) break;
    } catch {/* not ready */}
    await new Promise((r) => setTimeout(r, 2000));
  }

  // snapshot 불변 가드.
  const snapCount = async () =>
    (await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true })).count ?? 0;
  const before = await snapCount();

  // direct(operating dry-run).
  const direct = await syncAllExperienceGrowthWeekStatuses({ dryRun: true });

  // HTTP(operating dry-run) — scope=all, confirm=false → dryRun=true(서버 강제).
  const res = await fetch(`${BASE}/api/admin/sync/experience-growth`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ devMode: false, scope: "all", confirm: false }),
  });
  const json = await res.json();
  ck("[HTTP] 200 success", res.status === 200 && json?.success, `status=${res.status}`);
  ck("[HTTP] dryRun=true (DB 미반영)", json?.dryRun === true && json?.data?.dryRun === true);
  ck("[HTTP] scope=all", json?.scope === "all");
  ck(
    "[direct==HTTP] usersScanned 일치",
    json?.data?.usersScanned === direct.usersScanned,
    `direct=${direct.usersScanned} http=${json?.data?.usersScanned}`,
  );
  ck(
    "[direct==HTTP] totalFlippedToFail 일치",
    json?.data?.totalFlippedToFail === direct.totalFlippedToFail,
    `direct=${direct.totalFlippedToFail} http=${json?.data?.totalFlippedToFail}`,
  );

  const after = await snapCount();
  ck("[격리] snapshot count 불변(HTTP dry-run)", after === before, `${before}→${after}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
