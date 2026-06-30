/**
 * "현재 개설 대상 크루"(모달) info-lines/crew GET 의 mode 스코프 검증 — direct==HTTP.
 *   실제 운영 info 라인(운영 user 대상자 보유)을 DB 에서 찾아:
 *     · HTTP operating  → 대상자 = 운영 실유저(기존과 동일, marker 0)
 *     · HTTP test       → 대상자 = 0 (운영 실유저 필터됨)  ← 사용자 신고 핵심
 *     · direct(resolveUserScope filter) == HTTP
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveUserScope } from "@/lib/userScope";

const BASE = "http://localhost:3000";
const U = process.env.NEXT_PUBLIC_SUPABASE_URL!,
  A = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  S = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function makeAdminCookies(): Promise<string> {
  const { data: adm } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (adm?.[0] as any)?.email;
  const admin = createClient(U, S),
    anon = createClient(U, A);
  const { data: l } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await anon.auth.verifyOtp({
    email,
    token: (l as any).properties.email_otp,
    type: "magiclink",
  });
  const cap: Array<{ name: string; value: string }> = [];
  const sv = createServerClient(U, A, {
    cookies: {
      getAll: () => [],
      setAll: (it) => cap.push(...it.map(({ name, value }: any) => ({ name, value }))),
    },
  });
  await sv.auth.setSession({
    access_token: (v as any).session.access_token,
    refresh_token: (v as any).session.refresh_token,
  });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}
let fail = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) fail++;
};

async function main() {
  const markers = new Set(
    ((await supabaseAdmin.from("test_user_markers").select("user_id")).data ?? []).map(
      (x: any) => x.user_id,
    ),
  );

  // 운영 user 대상자(비-marker)를 가진 활성 info 라인 1건 찾기.
  const { data: tRows } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("line_id,week_id,target_user_id,target_mode,cluster4_lines!inner(part_type,is_active)")
    .eq("target_mode", "user")
    .eq("cluster4_lines.part_type", "info")
    .eq("cluster4_lines.is_active", true)
    .not("target_user_id", "is", null)
    .limit(2000);
  const opRow = ((tRows ?? []) as any[]).find(
    (r) => r.target_user_id && !markers.has(r.target_user_id) && r.line_id && r.week_id,
  );
  if (!opRow) {
    console.log("운영 user 대상자 보유 info 라인을 찾지 못함 — 검증 스킵");
    process.exit(0);
  }
  const lineId = opRow.line_id as string;
  const weekId = opRow.week_id as string;
  // 이 (line,week) 의 전체 user 대상자.
  const { data: allT } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("line_id", lineId)
    .eq("week_id", weekId)
    .eq("target_mode", "user")
    .not("target_user_id", "is", null);
  const dbUserIds = ((allT ?? []) as any[]).map((r) => r.target_user_id);
  const dbOperating = dbUserIds.filter((id) => !markers.has(id));
  console.log(`대상 라인 line_id=${lineId} week_id=${weekId} · DB user 대상자 ${dbUserIds.length}(운영 ${dbOperating.length})`);

  const cookie = await makeAdminCookies();
  const get = async (mode: "operating" | "test") => {
    const qs = new URLSearchParams({ line_id: lineId, week_id: weekId });
    if (mode === "test") qs.set("mode", "test");
    const res = await fetch(`${BASE}/api/admin/cluster4/info-lines/crew?${qs.toString()}`, {
      headers: { Cookie: cookie },
      cache: "no-store",
    });
    const json = await res.json();
    const ids = (json?.data?.targets ?? []).map((t: any) => t.userId);
    return { status: res.status, ids };
  };

  // direct: resolveUserScope filter.
  const opScope = await resolveUserScope("operating", null);
  const testScope = await resolveUserScope("test", null);
  const directOp = dbUserIds.filter((id) => opScope.includes(id));
  const directTest = dbUserIds.filter((id) => testScope.includes(id));

  // HTTP.
  const httpOp = await get("operating");
  const httpTest = await get("test");

  // 1) operating: 기존과 동일(운영 실유저 그대로, marker 0).
  ck(
    "HTTP operating = DB 운영 대상자(기존 동일)",
    httpOp.status === 200 &&
      httpOp.ids.length === dbOperating.length &&
      httpOp.ids.every((id: string) => !markers.has(id)),
    { http: httpOp.ids.length, dbOperating: dbOperating.length },
  );
  // 2) test: 운영 실유저 필터됨 → "현재 개설 대상 크루" 0.
  ck(
    "HTTP test '현재 개설 대상 크루' 운영유저 0",
    httpTest.status === 200 && httpTest.ids.filter((id: string) => !markers.has(id)).length === 0,
    { httpTestTotal: httpTest.ids.length, opLeak: httpTest.ids.filter((id: string) => !markers.has(id)).length },
  );
  // 3) direct == HTTP.
  ck("direct==HTTP (operating)", directOp.length === httpOp.ids.length, {
    direct: directOp.length,
    http: httpOp.ids.length,
  });
  ck("direct==HTTP (test)", directTest.length === httpTest.ids.length, {
    direct: directTest.length,
    http: httpTest.ids.length,
  });

  console.log(fail === 0 ? "\n✅ ALL PASS" : `\n❌ ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
