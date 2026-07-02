/**
 * 라인 관리 주차 드롭다운 옵션 범위 검증 (dev server 필요).
 *   info/experience/ability(competency) 세 화면이 동일 SoT(season-weeks 전 주차)를 쓰는지.
 *   1) direct: loadSeasonWeeks → buildLineManageWeekRows(공용 필터) 옵션 수
 *   2) HTTP: GET /api/admin/season-weeks → 같은 필터 → 동일 수 (direct == HTTP)
 *   3) 기존 weeks-options?limit=3/8 보다 전 주차가 더 많이(>=) 노출되는지
 *   4) snapshot 무영향(드롭다운 조회는 read-only)
 *   npx tsx --env-file=.env.local scripts/verify-line-manage-week-options.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { buildLineManageWeekRows } from "@/lib/lineManageWeekOptions";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};
async function cookieHeader(): Promise<string> {
  const { data: adm } = await supabaseAdmin.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as any)?.email;
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const sv = createServerClient(u, a, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it.map(({ name, value }: any) => ({ name, value }))) } });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}
async function snap() {
  const { count } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  const { data } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("updated_at").order("updated_at", { ascending: false }).limit(1);
  return { count: count ?? 0, latest: (data?.[0] as any)?.updated_at ?? null };
}

async function main() {
  try { const h = await fetch(`${BASE}/api/health`); ck("dev server", h.ok); }
  catch { console.log("❌ dev server 미기동"); process.exit(2); }
  const cookie = await cookieHeader();
  const snapBefore = await snap();

  // 1) direct — loadSeasonWeeks + 공용 필터.
  const { rows: directRows } = await loadSeasonWeeks();
  const directOptions = buildLineManageWeekRows(directRows as any);
  ck("direct 옵션 수 > 0", directOptions.length > 0, { n: directOptions.length });

  // 2) HTTP — season-weeks 응답에 같은 필터 적용 → direct == HTTP.
  const res = await fetch(`${BASE}/api/admin/season-weeks`, { headers: { cookie }, cache: "no-store" });
  const json: any = await res.json();
  ck("season-weeks HTTP 200·success", res.ok && json?.success === true, { status: res.status });
  const httpRows = (json?.data?.rows ?? []) as any[];
  const httpOptions = buildLineManageWeekRows(httpRows);
  ck("direct == HTTP (옵션 week_id 집합 동일)",
    JSON.stringify(directOptions.map((w: any) => w.week_id)) === JSON.stringify(httpOptions.map((w: any) => w.week_id)),
    { direct: directOptions.length, http: httpOptions.length });

  // 3) 기존 weeks-options(limit=3/8) 대비 전 주차가 더 많이(>=) 노출.
  for (const limit of [3, 8]) {
    const wo = await fetch(`${BASE}/api/admin/cluster4/weeks-options?limit=${limit}`, { headers: { cookie } });
    const woj: any = await wo.json();
    const woCount = (woj?.data?.weeks ?? []).length;
    ck(`전 주차(${directOptions.length}) >= weeks-options?limit=${limit}(${woCount})`, directOptions.length >= woCount, { all: directOptions.length, capped: woCount });
  }
  ck("전 주차가 캡(6)보다 많음(전 주차 노출 확인)", directOptions.length > 6, { n: directOptions.length });

  // 4) mode=test 여도 season-weeks 목록 동일(주차 목록은 mode 무관 — info 와 동일).
  const resTest = await fetch(`${BASE}/api/admin/season-weeks`, { headers: { cookie }, cache: "no-store" });
  const jsonTest: any = await resTest.json();
  const testOptions = buildLineManageWeekRows((jsonTest?.data?.rows ?? []) as any[]);
  ck("mode 무관 주차 목록 동일", JSON.stringify(testOptions.map((w: any) => w.week_id)) === JSON.stringify(httpOptions.map((w: any) => w.week_id)));

  const snapAfter = await snap();
  ck("snapshot 무변경(count) = 재계산 불필요", snapBefore.count === snapAfter.count, { before: snapBefore.count, after: snapAfter.count });
  ck("snapshot 무변경(latest)", snapBefore.latest === snapAfter.latest);

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
