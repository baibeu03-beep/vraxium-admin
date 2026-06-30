/**
 * "주차별 개설 결과 목록" info-line-results 의 mode 스코프 검증 — direct==HTTP.
 *   2026-spring 운영 라인 주차(W13/W12/W11, encre)에서:
 *     · operating → 운영 라인이 "개설 완료"로 보임(기존 동일, openedLineCount>0)
 *     · test      → 운영 라인 0건(openedLineCount=0, 테스트 라인 없으므로)
 *     · direct(getInfoLineResultsForWeek) == HTTP
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getInfoLineResultsForWeek } from "@/lib/adminCluster4InfoLineResults";

const BASE = "http://localhost:3000";
const U = process.env.NEXT_PUBLIC_SUPABASE_URL!,
  A = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  S = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const WEEKS = [
  { label: "W13", id: "a2112b50-64d2-42d6-a243-faf9fcdc6ffc" },
  { label: "W12", id: "00000000-0000-0000-0000-202605210002" },
  { label: "W11", id: "67e07106-564e-4dab-b180-8f11c909973a" },
];
let fail = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) fail++;
};

async function makeAdminCookies(): Promise<string> {
  const { data: adm } = await supabaseAdmin.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as any)?.email;
  const admin = createClient(U, S), anon = createClient(U, A);
  const { data: l } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await anon.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const sv = createServerClient(U, A, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it.map(({ name, value }: any) => ({ name, value }))) } });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function main() {
  const cookie = await makeAdminCookies();
  const httpOpened = async (weekId: string, mode: "operating" | "test") => {
    const qs = new URLSearchParams({ week_id: weekId, organization: "encre" });
    if (mode === "test") qs.set("mode", "test");
    const res = await fetch(`${BASE}/api/admin/cluster4/info-line-results?${qs.toString()}`, { headers: { Cookie: cookie }, cache: "no-store" });
    const j = await res.json();
    return { status: res.status, opened: j?.data?.openedLineCount ?? null, lines: (j?.data?.lines ?? []).filter((l: any) => l.status === "opened").length };
  };

  for (const w of WEEKS) {
    const dOp = await getInfoLineResultsForWeek({ weekId: w.id, organization: "encre", mode: "operating" });
    const dTest = await getInfoLineResultsForWeek({ weekId: w.id, organization: "encre", mode: "test" });
    const hOp = await httpOpened(w.id, "operating");
    const hTest = await httpOpened(w.id, "test");

    ck(`[${w.label}] operating 운영 라인 보임(기존 동일, openedLineCount>0)`, dOp.openedLineCount > 0 && hOp.opened === dOp.openedLineCount, { direct: dOp.openedLineCount, http: hOp.opened });
    ck(`[${w.label}] test 주차별 개설 결과 운영 라인 0건`, dTest.openedLineCount === 0 && hTest.opened === 0, { direct: dTest.openedLineCount, http: hTest.opened });
    ck(`[${w.label}] direct==HTTP (operating/test)`, hOp.opened === dOp.openedLineCount && hTest.opened === dTest.openedLineCount, { httpOp: hOp.opened, httpTest: hTest.opened });
  }

  console.log(fail === 0 ? "\n✅ ALL PASS" : `\n❌ ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
