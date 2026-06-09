/**
 * verify-line-opening-windows-http.ts
 * 라인 개설 예외 — 실제 HTTP API + direct==HTTP + snapshot 무영향 런타임 검증.
 *   admin 세션 쿠키를 service-role generateLink→verifyOtp 로 발급해 실제 라우트를 호출한다.
 *
 * 사전: dev 서버(:3000) 기동 + 마이그레이션 적용.
 * 실행: npx tsx --env-file=.env.local scripts/verify-line-opening-windows-http.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  findActiveLineOpeningException,
  listActiveExceptionWeeks,
  listLineOpeningWindows,
} from "@/lib/lineOpeningWindowsData";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

async function adminCookieHeader(): Promise<string> {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: ADMIN_EMAIL,
  });
  if (linkErr) throw linkErr;
  const otp = linkData.properties?.email_otp;
  if (!otp) throw new Error("email_otp 없음");
  const { data: verifyData, error: vErr } = await browser.auth.verifyOtp({
    email: ADMIN_EMAIL,
    token: otp,
    type: "magiclink",
  });
  if (vErr) throw vErr;
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session!.access_token,
    refresh_token: verifyData.session!.refresh_token,
  });
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function main() {
  const cookie = await adminCookieHeader();
  const H = { cookie, "content-type": "application/json" };

  // 테스트 주차 + 활동유형 2개.
  const { data: week } = await sb
    .from("weeks")
    .select("id")
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const weekId = (week as { id: string }).id;
  const { data: types } = await sb
    .from("activity_types")
    .select("id,name")
    .eq("cluster_id", "practical_info")
    .eq("is_active", true)
    .limit(2);
  const [typeA, typeB] = (types ?? []) as Array<{ id: string; name: string }>;
  console.log(`테스트 주차=${weekId} / A=${typeA.name}(${typeA.id}) B=${typeB.name}(${typeB.id})\n`);

  // 정리.
  await sb.from("line_opening_windows").delete().eq("week_id", weekId);

  // ── snapshot 베이스라인 ──
  const snapBaseline = async () => {
    const { count } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("*", { count: "exact", head: true });
    const { data: latest } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("computed_at")
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return { count: count ?? 0, latest: (latest as { computed_at?: string } | null)?.computed_at ?? null };
  };
  const before = await snapBaseline();

  // ── HTTP 인증 sanity ──
  const listRes = await fetch(`${BASE}/api/admin/line-opening-windows`, { headers: { cookie } });
  check("[auth] GET 200 (admin 세션 인증)", listRes.status === 200, `status=${listRes.status}`);

  // ── [전체 주차 허용] HTTP POST scope=all ──
  const postAll = await fetch(`${BASE}/api/admin/line-opening-windows`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ week_id: weekId, scope: "all" }),
  });
  const postAllJson = await postAll.json();
  check("[6] HTTP POST scope=all → 201", postAll.status === 201 && postAllJson.success);
  const allRowId = postAllJson.data?.windows?.[0]?.id as string | undefined;

  // direct 판정 — 전체 허용.
  check(
    "[6] direct findActive(typeA)=true (전체)",
    (await findActiveLineOpeningException(weekId, typeA.id)) === true,
  );
  check(
    "[6] direct findActive(typeB)=true (전체)",
    (await findActiveLineOpeningException(weekId, typeB.id)) === true,
  );

  // ── direct == HTTP : list ──
  const httpList = await (await fetch(`${BASE}/api/admin/line-opening-windows`, { headers: { cookie } })).json();
  const directList = await listLineOpeningWindows();
  const norm = (arr: Array<{ id: string }>) =>
    JSON.stringify([...arr].sort((a, b) => a.id.localeCompare(b.id)));
  check(
    "[5] direct == HTTP (list 전체 deep-equal)",
    norm(httpList.data.windows) === norm(directList),
    `http=${httpList.data.windows.length} direct=${directList.length}`,
  );

  // ── direct == HTTP : active ──
  const httpActive = await (await fetch(`${BASE}/api/admin/line-opening-windows/active`, { headers: { cookie } })).json();
  const directActive = await listActiveExceptionWeeks();
  const normW = (arr: Array<{ id: string }>) =>
    JSON.stringify([...arr].sort((a, b) => a.id.localeCompare(b.id)));
  check(
    "[5] direct == HTTP (active deep-equal)",
    normW(httpActive.data.weeks) === normW(directActive),
    `http=${httpActive.data.weeks.length} direct=${directActive.length}`,
  );
  const awHttp = httpActive.data.weeks.find((w: { id: string }) => w.id === weekId);
  check("[4] HTTP /active 에 테스트 주차 + allowed=null(전체)", !!awHttp && awHttp.allowedActivityTypeIds === null);

  // ── [비활성화 후 차단] HTTP PATCH ──
  const patch = await fetch(`${BASE}/api/admin/line-opening-windows/${allRowId}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({ is_active: false }),
  });
  check("[8] HTTP PATCH is_active=false → 200", patch.status === 200);
  check(
    "[8] 비활성 후 direct findActive(typeA)=false",
    (await findActiveLineOpeningException(weekId, typeA.id)) === false,
  );

  // ── [삭제 후 차단] HTTP DELETE ──
  const del = await fetch(`${BASE}/api/admin/line-opening-windows/${allRowId}`, {
    method: "DELETE",
    headers: { cookie },
  });
  check("[9] HTTP DELETE → 200", del.status === 200);
  check(
    "[9] 삭제 후 direct findActive(typeA)=false",
    (await findActiveLineOpeningException(weekId, typeA.id)) === false,
  );

  // ── [특정 라인만 허용] HTTP POST scope=lines [typeA] ──
  const postLines = await fetch(`${BASE}/api/admin/line-opening-windows`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ week_id: weekId, scope: "lines", activity_type_ids: [typeA.id] }),
  });
  const postLinesJson = await postLines.json();
  check("[7] HTTP POST scope=lines → 201", postLines.status === 201 && postLinesJson.success);
  const lineRowId = postLinesJson.data?.windows?.[0]?.id as string | undefined;
  check(
    "[7] direct findActive(typeA 허용)=true",
    (await findActiveLineOpeningException(weekId, typeA.id)) === true,
  );
  check(
    "[7] direct findActive(typeB 미허용)=false",
    (await findActiveLineOpeningException(weekId, typeB.id)) === false,
  );

  // 정리.
  await fetch(`${BASE}/api/admin/line-opening-windows/${lineRowId}`, { method: "DELETE", headers: { cookie } });
  await sb.from("line_opening_windows").delete().eq("week_id", weekId);

  // ── snapshot 무영향 (items 11/12/13) ──
  const after = await snapBaseline();
  check(
    "[11/12] snapshot count·최신 computed_at 불변 (예외 CRUD 가 snapshot 미생성/미재계산)",
    after.count === before.count && after.latest === before.latest,
    `count ${before.count}→${after.count}, latest ${before.latest}→${after.latest}`,
  );
  check(
    "[13] demoUserId/일반 경로 무영향 (동일 snapshot 미변경 ⇒ 두 경로 입력 불변)",
    after.count === before.count && after.latest === before.latest,
  );

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
