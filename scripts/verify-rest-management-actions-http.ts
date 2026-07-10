import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// /admin/rest-management 액션 엔드포인트 실제 HTTP 검증(수정 무관 회귀 방지).
//   GET  /api/admin/rest-management/list  (전체 행 · DTO 형태)
//   GET  /api/admin/rest-management/summary
//   PATCH /api/admin/rest-management/[id] {action:"approve"}
//   DELETE /api/admin/rest-management/[id]
//   POST /api/admin/rest-management/approve-all {organization,season_key}
// phalanx/2026-summer(실데이터 0건)에 미래주차 pending 3행 시드 → 검증 → 정확히 삭제.

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const ORG = "phalanx";
const SEASON = "2026-summer";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function adminCookieHeader(): Promise<string> {
  const { data: admins } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  assert(link.properties?.email_otp, "generateLink failed");
  const { data: verified } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  assert(verified.session, "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function seedThree(): Promise<string[]> {
  const date = "2026-07-20"; // 미래 주차(미종료) → pending 유지
  const { data: wk } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date")
    .eq("start_date", date)
    .maybeSingle();
  assert(wk, `weeks 에 ${date} 없음`);
  const { data: users } = await supabaseAdmin.from("user_profiles").select("user_id").limit(3);
  const userIds = (users ?? []).map((u) => (u as { user_id: string }).user_id);
  assert(userIds.length === 3, "user_profiles 부족");
  const rows = userIds.map((uid) => ({
    id: randomUUID(),
    user_id: uid,
    org: ORG,
    season_key: SEASON,
    week_id: (wk as { id: string }).id,
    week_start_date: date,
    reason: "HTTP 검증용 시드",
    status: "pending",
    request_type: "normal",
    created_at: "2026-07-05T00:00:00.000Z",
  }));
  const { error } = await supabaseAdmin.from("vacation_requests").insert(rows);
  if (error) throw new Error(`seed failed: ${error.message}`);
  return rows.map((r) => r.id);
}

async function statusOf(id: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("vacation_requests")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  return (data as { status: string | null } | null)?.status ?? null;
}
async function exists(id: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("vacation_requests")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  return Boolean(data);
}

async function main() {
  const ids = await seedThree();
  console.log(`SEEDED 3 rows: ${ids.join(", ")}`);
  const cookie = await adminCookieHeader();
  const H = { Cookie: cookie, "Content-Type": "application/json" };

  try {
    // 1) GET list — DTO 형태 확인
    const listRes = await fetch(
      `${baseUrl}/api/admin/rest-management/list?organization=${ORG}&season_key=${SEASON}`,
      { headers: { Cookie: cookie } },
    );
    const listJson = await listRes.json();
    assert(listRes.ok && listJson.success, `list GET 실패 ${listRes.status}`);
    const sample = (listJson.rows as Array<Record<string, unknown>>).find((r) => ids.includes(r.id as string));
    assert(sample, "시드 행이 list 에 없음");
    const dtoKeys = Object.keys(sample!).sort().join(",");
    console.log(`PASS 1 list GET · rows=${listJson.rows.length} · DTO keys=[${dtoKeys}]`);

    // 2) GET summary
    const sumRes = await fetch(
      `${baseUrl}/api/admin/rest-management/summary?organization=${ORG}&season_key=${SEASON}`,
      { headers: { Cookie: cookie } },
    );
    const sumJson = await sumRes.json();
    assert(sumRes.ok && sumJson.success, `summary GET 실패 ${sumRes.status}`);
    assert(sumJson.summary.total >= 3, `summary.total 예상>=3, 실제 ${sumJson.summary.total}`);
    console.log(`PASS 2 summary GET · ${JSON.stringify(sumJson.summary)}`);

    // 3) PATCH approve (1건)
    const patchRes = await fetch(`${baseUrl}/api/admin/rest-management/${ids[0]}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ action: "approve" }),
    });
    const patchJson = await patchRes.json();
    assert(patchRes.ok && patchJson.success, `approve PATCH 실패 ${patchRes.status}`);
    assert((await statusOf(ids[0])) === "approved", "approve 후 status!=approved");
    console.log("PASS 3 PATCH approve → status=approved");

    // 4) DELETE (1건)
    const delRes = await fetch(`${baseUrl}/api/admin/rest-management/${ids[1]}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    const delJson = await delRes.json();
    assert(delRes.ok && delJson.success, `DELETE 실패 ${delRes.status}`);
    assert(!(await exists(ids[1])), "DELETE 후에도 행 존재");
    console.log("PASS 4 DELETE → 행 삭제됨");

    // 5) POST approve-all — 남은 pending(ids[2]) 승인
    const allRes = await fetch(`${baseUrl}/api/admin/rest-management/approve-all`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ organization: ORG, season_key: SEASON }),
    });
    const allJson = await allRes.json();
    assert(allRes.ok && allJson.success, `approve-all POST 실패 ${allRes.status}`);
    assert((await statusOf(ids[2])) === "approved", "approve-all 후 남은 pending 미승인");
    console.log(`PASS 5 POST approve-all → approved=${allJson.approved} · 남은 pending 승인 확인`);

    console.log("\nALL PASS (actions HTTP)");
  } finally {
    const { error } = await supabaseAdmin.from("vacation_requests").delete().in("id", ids);
    console.log(error ? `CLEANUP FAILED: ${error.message}` : `CLEANUP ${ids.length} rows deleted`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
