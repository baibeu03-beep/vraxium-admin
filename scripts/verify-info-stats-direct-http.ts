/**
 * direct == HTTP 엄밀 검증 — snapshot 라이브 재계산(환경 잡음)과 실제 코드 발산을 분리.
 *   각 org: direct1 → HTTP → direct2. direct1==direct2(HTTP 창 동안 snapshot 불변)일 때만 비교 확정:
 *     · 안정 창에서 direct==HTTP  → PASS(코드 동치 확인)
 *     · 안정 창에서 direct!=HTTP  → REAL 발산(하드 실패)
 *     · direct1!=direct2(창 중 flip) → 재시도(최대 4회)
 *   route 가 loadMembersInfoStats 를 그대로 호출하므로 구조상 동일 — 본 검증은 그 동치를 실측.
 * Usage: npx tsx --env-file=.env.local scripts/verify-info-stats-direct-http.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { loadMembersInfoStats } from "@/lib/adminMembersInfoStats";

const BASE = "http://localhost:3000";
const EMAIL = "vanuatu.golden@gmail.com";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};
const strip = (d: any) => { const { generatedAt, ...r } = d ?? {}; return JSON.stringify(r); };

async function cookie(): Promise<string> {
  const sb = createClient(URL_, SERVICE);
  const brow = createClient(URL_, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: (link as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i: any[]) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v!.session!.access_token, refresh_token: v!.session!.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

function firstWeekDiff(a: any, b: any): string {
  if (strip(a.cumulative) !== strip(b.cumulative)) return `cumulative ${strip(a.cumulative)} vs ${strip(b.cumulative)}`;
  if (a.weeks.length !== b.weeks.length) return `weeks len ${a.weeks.length} vs ${b.weeks.length}`;
  for (let i = 0; i < a.weeks.length; i++) {
    if (JSON.stringify(a.weeks[i]) !== JSON.stringify(b.weeks[i]))
      return `week[${i}] ${a.weeks[i].seasonWeekName}: ${JSON.stringify(a.weeks[i])} vs ${JSON.stringify(b.weeks[i])}`;
  }
  return "(no week diff)";
}

async function main() {
  const ck_ = await cookie();
  for (const org of ["all", "encre", "oranke", "phalanx"] as const) {
    const qs = org === "all" ? "" : `?organization=${org}`;
    let settled = false;
    for (let attempt = 1; attempt <= 4 && !settled; attempt++) {
      const direct1 = await loadMembersInfoStats({ organization: org, mode: "operating" });
      const res = await fetch(`${BASE}/api/admin/members/info-stats${qs}`, { headers: { cookie: ck_ }, cache: "no-store" as RequestCache });
      const http = (await res.json()).data;
      const direct2 = await loadMembersInfoStats({ organization: org, mode: "operating" });

      const stable = strip(direct1) === strip(direct2); // HTTP 창 동안 snapshot 불변?
      if (!stable) {
        console.log(`  · [${org}] attempt ${attempt}: HTTP 창 동안 snapshot flip → 재시도 (${firstWeekDiff(direct1, direct2)})`);
        continue;
      }
      settled = true;
      const match = strip(direct1) === strip(http);
      ck(`[${org}] direct == HTTP (안정 창, attempt ${attempt})`, match, match ? "" : `REAL DIVERGENCE: ${firstWeekDiff(direct1, http)}`);
      console.log(`     weeks=${direct1.weeks.length} cumulative=${strip(direct1.cumulative)}`);
    }
    if (!settled) ck(`[${org}] 안정 창 확보(4회 내)`, false, "snapshot 계속 변동 — 환경 잡음(코드 발산 아님)");
  }
  console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
