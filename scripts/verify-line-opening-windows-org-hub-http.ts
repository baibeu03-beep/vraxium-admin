/**
 * verify-line-opening-windows-org-hub-http.ts
 * 라인 개설 예외 org+hub — 실제 HTTP API + weeks-options 드롭다운 반영 + 스코핑 + snapshot 무영향.
 *
 * 사전: dev 서버(:3000) 기동 + 마이그(org/hub 컬럼) 적용.
 * 실행: npx tsx --env-file=.env.local scripts/verify-line-opening-windows-org-hub-http.ts
 *
 * 검증(요청 스펙 1~6):
 *   1) 조직별 등록(Encre+experience) → weeks-options?org=encre&hub=experience 에만 반영.
 *   2) 라인 종류 스코핑 → 다른 hub(info) 미반영.
 *   3) 전체(all/all) → 모든 org·hub weeks-options 반영.
 *   4) 드롭다운 반영 = weeks-options 옵션 존재 + hasOpeningException/canOpen.
 *   5) 삭제 → 즉시 제외.
 *   6) 실제 HTTP API + direct==HTTP(list).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { listLineOpeningWindows } from "@/lib/lineOpeningWindowsData";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

async function adminCookieHeader(): Promise<string> {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  if (linkErr) throw linkErr;
  const otp = linkData.properties?.email_otp;
  if (!otp) throw new Error("email_otp 없음");
  const { data: verifyData, error: vErr } = await browser.auth.verifyOtp({ email: ADMIN_EMAIL, token: otp, type: "magiclink" });
  if (vErr) throw vErr;
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session!.access_token, refresh_token: verifyData.session!.refresh_token });
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

// weeks-options?org&hub 에서 weekId 옵션의 반영 여부.
async function weekOpt(cookie: string, org: string | null, hub: string | null, weekId: string) {
  const qs = new URLSearchParams({ limit: "8" });
  if (org) qs.set("org", org);
  if (hub) qs.set("hub", hub);
  const res = await fetch(`${BASE}/api/admin/cluster4/weeks-options?${qs}`, { headers: { cookie }, cache: "no-store" as RequestCache });
  const json = await res.json().catch(() => ({}));
  const opt = ((json?.data?.weeks ?? []) as Array<{ id: string; hasOpeningException: boolean; canOpen: boolean }>).find((w) => w.id === weekId);
  return { present: !!opt, hasException: !!opt?.hasOpeningException, canOpen: !!opt?.canOpen };
}

async function post(cookie: string, body: unknown) {
  const res = await fetch(`${BASE}/api/admin/line-opening-windows`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function main() {
  const cookie = await adminCookieHeader();

  // 최신 주차(recent window 밖일 가능성 큰 미래 주차) — 예외로만 옵션에 뜨는 케이스.
  const { data: latest } = await sb.from("weeks").select("id").order("start_date", { ascending: false }).limit(1).maybeSingle();
  const weekId = (latest as { id: string }).id;
  console.log(`테스트 주차=${weekId}\n`);
  await sb.from("line_opening_windows").delete().eq("week_id", weekId);

  const snap = async () => {
    const { count } = await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
    const { data: l } = await sb.from("cluster4_weekly_card_snapshots").select("computed_at").order("computed_at", { ascending: false }).limit(1).maybeSingle();
    return { count: count ?? 0, latest: (l as { computed_at?: string } | null)?.computed_at ?? null };
  };
  const before = await snap();

  const listRes = await fetch(`${BASE}/api/admin/line-opening-windows`, { headers: { cookie } });
  check("[auth] GET 200", listRes.status === 200, `status=${listRes.status}`);

  // ── [1·2·4] encre + experience 등록 ──
  const r1 = await post(cookie, { week_id: weekId, organization_slug: "encre", hub: "experience" });
  check("[1] POST encre+experience → 201", r1.status === 201 && r1.json.success);
  const winId1 = r1.json?.data?.windows?.[0]?.id as string | undefined;
  {
    const m = await weekOpt(cookie, "encre", "experience", weekId);
    check("[4] weeks-options(encre, experience) 반영(예외+canOpen)", m.present && m.hasException && m.canOpen);
    const o = await weekOpt(cookie, "oranke", "experience", weekId);
    check("[1] weeks-options(oranke, experience) 미반영", !o.hasException);
    const h = await weekOpt(cookie, "encre", "info", weekId);
    check("[2] weeks-options(encre, info) 미반영", !h.hasException);
    const n = await weekOpt(cookie, null, null, weekId);
    check("[1] weeks-options(전체 질의) 미반영(org 스코프 예외)", !n.hasException);
  }

  // ── [5] 삭제 → 즉시 제외 ──
  const del1 = await fetch(`${BASE}/api/admin/line-opening-windows/${winId1}`, { method: "DELETE", headers: { cookie } });
  check("[5] DELETE → 200", del1.status === 200);
  {
    const m = await weekOpt(cookie, "encre", "experience", weekId);
    check("[5] 삭제 후 encre+experience 미반영", !m.hasException);
  }

  // ── [3] 전체(all/all) → 모든 org·hub 반영 ──
  const r2 = await post(cookie, { week_id: weekId, organization_slug: "all", hub: "all" });
  check("[3] POST 전체(all/all) → 201", r2.status === 201 && r2.json.success);
  const winId2 = r2.json?.data?.windows?.[0]?.id as string | undefined;
  {
    const a = await weekOpt(cookie, "encre", "experience", weekId);
    const b = await weekOpt(cookie, "oranke", "info", weekId);
    const c = await weekOpt(cookie, "phalanx", "competency", weekId);
    check("[3] 전체 → encre/experience 반영", a.hasException && a.canOpen);
    check("[3] 전체 → oranke/info 반영", b.hasException && b.canOpen);
    check("[3] 전체 → phalanx/competency 반영", c.hasException && c.canOpen);
  }

  // ── [6] direct == HTTP (list) ──
  {
    const httpList = await (await fetch(`${BASE}/api/admin/line-opening-windows`, { headers: { cookie } })).json();
    const directList = await listLineOpeningWindows();
    const norm = (arr: Array<{ id: string }>) => JSON.stringify([...arr].sort((a, b) => a.id.localeCompare(b.id)));
    check("[6] direct == HTTP (list deep-equal)", norm(httpList.data.windows) === norm(directList), `http=${httpList.data.windows.length} direct=${directList.length}`);
  }

  // 정리.
  await fetch(`${BASE}/api/admin/line-opening-windows/${winId2}`, { method: "DELETE", headers: { cookie } });
  await sb.from("line_opening_windows").delete().eq("week_id", weekId);

  const after = await snap();
  check("[snapshot] count·최신 computed_at 불변", after.count === before.count && after.latest === before.latest, `count ${before.count}→${after.count}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
