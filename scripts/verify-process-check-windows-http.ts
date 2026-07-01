/**
 * verify-process-check-windows-http.ts
 * 프로세스 체크 예외 주차 — 실제 HTTP API + 드롭다운 반영 + org/hub 스코핑 + snapshot 무영향.
 *   admin 세션 쿠키를 service-role generateLink→verifyOtp 로 발급해 실제 라우트를 호출한다.
 *
 * 사전: dev 서버(:3000) 기동 + 마이그레이션(2026-07-01_process_check_windows.sql) 적용.
 * 실행: npx tsx --env-file=.env.local scripts/verify-process-check-windows-http.ts
 *
 * 검증(요청 스펙 1~7):
 *   1) 조직별 등록(Encre+experience) → Encre experience 보드에만 반영.
 *   2) 종류별 등록(hub) 스코핑 → 다른 hub 보드 미반영.
 *   3) 전체 등록(org=all·hub=all) → 모든 org·hub 보드 반영.
 *   4) 드롭다운 반영 = 보드 GET weeks[] 에 예외 주차 등장 + selectedWeekId + editable.
 *   5) 삭제 시 즉시 드롭다운 제외.
 *   6) 실제 HTTP API 기준(라우트 호출) + direct==HTTP(list).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { listProcessCheckWindows } from "@/lib/processCheckWindowsData";

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

// 보드 GET → 특정 주차가 드롭다운(weeks[])에 있고, 선택 시 editable 인지.
async function board(
  cookie: string,
  hub: string,
  org: string,
  weekId: string,
): Promise<{ present: boolean; editable: boolean; selected: boolean }> {
  const res = await fetch(
    `${BASE}/api/admin/processes/check?hub=${hub}&org=${org}&week=${weekId}`,
    { headers: { cookie }, cache: "no-store" as RequestCache },
  );
  const json = await res.json().catch(() => ({}));
  const weeks = (json?.data?.weeks ?? []) as Array<{ weekId: string | null }>;
  return {
    present: weeks.some((w) => w.weekId === weekId),
    editable: Boolean(json?.data?.editable),
    selected: json?.data?.selectedWeekId === weekId,
  };
}

async function post(cookie: string, body: unknown) {
  const res = await fetch(`${BASE}/api/admin/process-check-windows`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function main() {
  const cookie = await adminCookieHeader();

  // 미래 주차 1개(기본 드롭다운 미노출) 확보.
  const { data: latest } = await sb
    .from("weeks")
    .select("id")
    .order("start_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const weekId = (latest as { id: string }).id;
  console.log(`테스트(미래) 주차=${weekId}\n`);

  // 정리.
  await sb.from("process_check_windows").delete().eq("week_id", weekId);

  // snapshot 베이스라인.
  const snap = async () => {
    const { count } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("*", { count: "exact", head: true });
    const { data: l } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("computed_at")
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return { count: count ?? 0, latest: (l as { computed_at?: string } | null)?.computed_at ?? null };
  };
  const before = await snap();

  // ── [auth] ──
  const listRes = await fetch(`${BASE}/api/admin/process-check-windows`, { headers: { cookie } });
  check("[auth] GET 200 (admin 세션)", listRes.status === 200, `status=${listRes.status}`);

  // ── [기본] 예외 전 — 미래 주차 미노출 ──
  {
    const b = await board(cookie, "experience", "encre", weekId);
    check("[기본] Encre experience 보드 미노출", !b.present);
  }

  // ── [1·2] 조직별+종류별 등록(Encre + experience) ──
  const r1 = await post(cookie, { week_id: weekId, organization_slug: "encre", hub: "experience" });
  check("[1] POST Encre+experience → 201", r1.status === 201 && r1.json.success);
  const winId1 = r1.json?.data?.window?.id as string | undefined;
  {
    const bMatch = await board(cookie, "experience", "encre", weekId);
    check("[4] Encre experience 보드에 등장 + editable + 선택됨", bMatch.present && bMatch.editable && bMatch.selected);
    const bOrg = await board(cookie, "experience", "oranke", weekId);
    check("[1] 다른 org(oranke) experience 미노출", !bOrg.present);
    const bHub = await board(cookie, "info", "encre", weekId);
    check("[2] 같은 org 다른 hub(info) 미노출", !bHub.present);
  }

  // ── [5] 삭제 → 즉시 제외 ──
  const del1 = await fetch(`${BASE}/api/admin/process-check-windows/${winId1}`, {
    method: "DELETE",
    headers: { cookie },
  });
  check("[5] DELETE → 200", del1.status === 200);
  {
    const b = await board(cookie, "experience", "encre", weekId);
    check("[5] 삭제 후 Encre experience 미노출", !b.present);
  }

  // ── [3] 전체 등록(org=all·hub=all) → 모든 org·hub 반영 ──
  const r2 = await post(cookie, { week_id: weekId, organization_slug: "all", hub: "all" });
  check("[3] POST 전체(all/all) → 201", r2.status === 201 && r2.json.success);
  const winId2 = r2.json?.data?.window?.id as string | undefined;
  {
    const b1 = await board(cookie, "experience", "encre", weekId);
    const b2 = await board(cookie, "info", "oranke", weekId);
    const b3 = await board(cookie, "competency", "phalanx", weekId);
    check("[3] 전체 등록 → encre/experience 노출+editable", b1.present && b1.editable);
    check("[3] 전체 등록 → oranke/info 노출+editable", b2.present && b2.editable);
    check("[3] 전체 등록 → phalanx/competency 노출+editable", b3.present && b3.editable);
  }

  // ── [6] direct == HTTP (list) ──
  {
    const httpList = await (await fetch(`${BASE}/api/admin/process-check-windows`, { headers: { cookie } })).json();
    const directList = await listProcessCheckWindows();
    const norm = (arr: Array<{ id: string }>) =>
      JSON.stringify([...arr].sort((a, b) => a.id.localeCompare(b.id)));
    check(
      "[6] direct == HTTP (list deep-equal)",
      norm(httpList.data.windows) === norm(directList),
      `http=${httpList.data.windows.length} direct=${directList.length}`,
    );
  }

  // ── [비활성] PATCH is_active=false → 제외 ──
  const patch = await fetch(`${BASE}/api/admin/process-check-windows/${winId2}`, {
    method: "PATCH",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ is_active: false }),
  });
  check("[5] PATCH is_active=false → 200", patch.status === 200);
  {
    const b = await board(cookie, "experience", "encre", weekId);
    check("[5] 비활성 후 미노출", !b.present);
  }

  // 정리.
  await fetch(`${BASE}/api/admin/process-check-windows/${winId2}`, { method: "DELETE", headers: { cookie } });
  await sb.from("process_check_windows").delete().eq("week_id", weekId);

  // ── snapshot 무영향 ──
  const after = await snap();
  check(
    "[8] snapshot count·최신 computed_at 불변(예외 CRUD 가 snapshot 미접촉)",
    after.count === before.count && after.latest === before.latest,
    `count ${before.count}→${after.count}, latest ${before.latest}→${after.latest}`,
  );

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
