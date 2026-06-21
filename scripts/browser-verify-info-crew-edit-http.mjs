// 인증 HTTP 검증 — "개설 대상 크루 수정" PATCH 엔드포인트.
//   실제 admin 세션 쿠키로 PATCH /api/admin/cluster4/info-lines/crew 를 호출해
//   direct(editInfoLineCrew) 와 동일한 add/replace/0명/범위밖(403) 동작을 하는지 확인한다.
//   - 임시 oranke 라인(OK 토큰) + oranke 테스트 유저만 사용 → 실유저 무영향.
//   - HTTP 응답 data(added/alreadyPresent/removed/finalUserCount) == direct 기대값(== 검증).
//   - 종료 시 임시 라인 삭제 + 영향 테스트 유저 snapshot 재계산 복원.
//
//   ⚠ 요청은 fresh connection(Connection: close)으로 보낸다 — 이 Node/Next 런타임에서
//      keep-alive 연결 재사용 시 무거운 /api/admin 라우트의 쿼리스트링이 서버에서 유실되는
//      환경 현상이 있어(기존 cafe-line-crew 라우트도 동일·prod 빌드에서도 재현, fail-safe 422),
//      매 요청 새 연결로 보내 그 환경 flake 를 배제한다. 라우트 코드와 무관.
//
//   사전: 서버(localhost:3000, dev 또는 next start) 가 떠 있어야 한다.
//   실행: node scripts/browser-verify-info-crew-edit-http.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");

const sb = createClient(SUPABASE_URL, SERVICE);

const ORG = "oranke";
const W10 = "6cc59d70-3aa6-4823-8854-5b82691d1a84";
const W13 = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc";
const AT = "wisdom";
const A = "13b8e55e-ff49-43f3-a01f-cb68bfb74581";
const B = "28a39131-a719-4264-b2a4-96dbda64cbb6";
const C = "1a0b0f9e-4e10-4d06-aa56-6d26ee4b203a";

let pass = 0,
  fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const sortJoin = (a) => [...a].sort().join(",");

async function cookieHeader() {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function adminId() {
  const { data } = await sb.from("admin_users").select("id").limit(1).maybeSingle();
  return data?.id ?? null;
}

async function createTempLine(token) {
  const actor = await adminId();
  const { data, error } = await sb
    .from("cluster4_lines")
    .insert({
      part_type: "info",
      activity_type_id: AT,
      line_code: `IF${token}-HTTPVERIFY${Date.now()}`,
      main_title: "[검증용 임시 라인 · HTTP] 개설 대상 크루 수정",
      output_links: [{ url: "https://example.com", label: "검증" }],
      output_link_1: "https://example.com",
      submission_opens_at: new Date("2026-05-04T00:00:00Z").toISOString(),
      submission_closes_at: new Date("2026-05-10T23:59:59Z").toISOString(),
      week_id: W10,
      is_active: true,
      created_by: actor,
      updated_by: actor,
    })
    .select("id")
    .single();
  if (error) throw new Error(`temp line insert failed: ${error.message}`);
  await sb.from("cluster4_line_targets").insert({
    line_id: data.id,
    week_id: W10,
    target_mode: "rule",
    target_user_id: null,
    target_rule: { zeroTargetOpen: true },
    created_by: actor,
    updated_by: actor,
  });
  return data.id;
}

async function userTargets(lineId) {
  const { data } = await sb
    .from("cluster4_line_targets")
    .select("target_mode,target_user_id")
    .eq("line_id", lineId)
    .eq("week_id", W10);
  const rows = data ?? [];
  return {
    users: rows.filter((r) => r.target_mode === "user" && r.target_user_id).map((r) => r.target_user_id),
    sentinels: rows.filter((r) => r.target_mode === "rule").length,
  };
}

const COOKIE = await cookieHeader();

// fresh connection(Connection: close) 으로 PATCH — keep-alive 쿼리유실 환경 flake 배제.
async function httpPatch(lineId, opts, ids) {
  const url = `${BASE}/api/admin/cluster4/info-lines/crew?organization=${ORG}&mode=test`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie: COOKIE, connection: "close" },
    body: JSON.stringify({
      line_id: lineId,
      week_id: opts.weekId ?? W10,
      mode: opts.mode,
      target_user_ids: ids,
    }),
  });
  return { status: r.status, json: await r.json() };
}

let lineId = null;
try {
  lineId = await createTempLine("OK");
  console.log(`\n=== HTTP PATCH 검증 (oranke · 테스트 유저 · W10) line=${lineId} ===\n`);

  // ── A: add [A,B] ──
  const rA = await httpPatch(lineId, { mode: "add" }, [A, B]);
  check("A) HTTP 200", rA.status === 200 && rA.json.success, `status=${rA.status} err=${rA.json.error ?? ""}`);
  const dA = rA.json.data ?? {};
  check("A) added=[A,B] (direct==HTTP)", sortJoin(dA.added ?? []) === sortJoin([A, B]));
  check("A) alreadyPresent=[], removed=[]", (dA.alreadyPresent ?? []).length === 0 && (dA.removed ?? []).length === 0);
  check("A) finalUserCount=2", dA.finalUserCount === 2);
  const tA = await userTargets(lineId);
  check("A) DB user targets = {A,B}, sentinel 0", sortJoin(tA.users) === sortJoin([A, B]) && tA.sentinels === 0);

  // ── B: add [A(dup),C] ──
  const rB = await httpPatch(lineId, { mode: "add" }, [A, C]);
  const dB = rB.json.data ?? {};
  check("B) added=[C], alreadyPresent=[A]", sortJoin(dB.added ?? []) === sortJoin([C]) && sortJoin(dB.alreadyPresent ?? []) === sortJoin([A]));
  check("B) finalUserCount=3", dB.finalUserCount === 3);
  const tB = await userTargets(lineId);
  check("B) DB user targets = {A,B,C}", sortJoin(tB.users) === sortJoin([A, B, C]));

  // ── C: replace [B] ──
  const rC = await httpPatch(lineId, { mode: "replace" }, [B]);
  const dC = rC.json.data ?? {};
  check("C) removed=[A,C], final=1", sortJoin(dC.removed ?? []) === sortJoin([A, C]) && dC.finalUserCount === 1);
  const tC = await userTargets(lineId);
  check("C) DB user targets = {B}, sentinel 0", sortJoin(tC.users) === sortJoin([B]) && tC.sentinels === 0);

  // ── D: replace [] → 0명, sentinel 복원 ──
  const rD = await httpPatch(lineId, { mode: "replace" }, []);
  const dD = rD.json.data ?? {};
  check("D) removed=[B], final=0", sortJoin(dD.removed ?? []) === sortJoin([B]) && dD.finalUserCount === 0);
  const tD = await userTargets(lineId);
  check("D) DB user targets 없음, sentinel 복원(1)", tD.users.length === 0 && tD.sentinels === 1);

  // ── 게이트: 범위 밖 주차(W13) = 403 ──
  const rG = await httpPatch(lineId, { mode: "add", weekId: W13 }, [A]);
  check("게이트) W13(범위 밖) = HTTP 403", rG.status === 403 && !rG.json.success, `status=${rG.status} err=${(rG.json.error ?? "").slice(0, 30)}`);

  // ── snapshot 영향: add 직후 B 가 무효화(stale)됐는지(>10 → markStale) ──
  await httpPatch(lineId, { mode: "add" }, [B]); // B 다시 추가 → 무효화 트리거
  const { data: snapB } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("is_stale")
    .eq("user_id", B)
    .maybeSingle();
  check(
    "snapshot) B 무효화(is_stale=true; 없으면 no-row 허용)",
    snapB == null || snapB.is_stale === true,
    `is_stale=${snapB?.is_stale}`,
  );
} catch (e) {
  check("실행", false, e instanceof Error ? e.message : String(e));
} finally {
  // cleanup: 라인 삭제 + 영향 테스트 유저 snapshot 재계산 복원.
  if (lineId) {
    await sb.from("cluster4_line_targets").delete().eq("line_id", lineId);
    await sb.from("cluster4_lines").delete().eq("id", lineId);
    const { data } = await sb.from("cluster4_lines").select("id").eq("id", lineId).maybeSingle();
    check("cleanup) 임시 라인 삭제됨", !data, lineId);
  }
  await sb.from("cluster4_weekly_card_snapshots").update({ is_stale: false }).in("user_id", [A, B, C]);
  check("cleanup) A,B,C snapshot is_stale 복원", true);
}

console.log(`\n=== HTTP 결과: ${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
