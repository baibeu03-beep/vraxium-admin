/**
 * growth_status 자동/오버라이드 분리 — 로컬 HTTP 검증.
 *   1) 고객 /api/cluster3/stats-cards (internal key, demoUserId 동일 경로):
 *      growthStatusKey=display 그대로 + 관리자 전용 필드 미노출(lean DTO)
 *   2) 관리자 /api/admin/crews/[id]/cluster3/growth (세션 쿠키):
 *      autoGrowthStatusKey/manualOverrideStatus/overrideMismatch 정확성
 *   3) PATCH /api/admin/members/[id]: graduating/seasonal_rest 쓰기 400 거부 (쓰기 0건)
 *   4) direct↔HTTP 일치 + snapshot 불변
 * 사전조건: admin dev :3000.
 * Usage: npx tsx --env-file=.env.local scripts/verify-growth-override-http.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const BASE = process.env.DIAG_ADMIN_BASE ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const internalKey = process.env.INTERNAL_API_KEY!;
const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const sbService = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let pass = 0,
  fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

async function makeAdminCookieHeader(): Promise<string> {
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const admin = createClient(sbUrl, sbService);
  const browser = createClient(sbUrl, anonKey);
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp)
    throw new Error(linkError?.message ?? "generateLink failed");
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session)
    throw new Error(verifyError?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(sbUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        void captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  const { error } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (error) throw new Error(error.message);
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

const CHO = "cc05522b-7a71-48fb-a291-3aaaefdf4865"; // T조하은 paused override
const YOON = "bf3b4305-751a-49e3-88ad-95a20e5c4dad"; // T윤도현 graduated override
const SONG = "28c60d60-aa17-4614-9127-fd65a8aebcaf"; // T송하린 seasonal_rest legacy
const AHN = "ff6adaf8-8993-4b5b-b5ea-a4fa1036cdee"; // T안건우 graduating legacy
const REAL = "247021bc-374b-48f4-8d49-b181d149ee33"; // 이유나 실유저

const ids = [CHO, YOON, SONG, AHN, REAL];

async function snapState() {
  const res = await fetch(
    `${sbUrl}/rest/v1/cluster4_weekly_card_snapshots?select=user_id,is_stale,computed_at,dto_version&user_id=in.(${ids.join(",")})`,
    { headers: { apikey: sbService, Authorization: `Bearer ${sbService}` } },
  );
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  return new Map(rows.map((r) => [r.user_id, `${r.is_stale}|${r.computed_at}|${r.dto_version}`]));
}

async function main() {
  const before = await snapState();

  console.log("=== 1) 고객 /api/cluster3/stats-cards (internal key = demoUserId 경로) ===");
  const statsByUser = new Map<string, Record<string, unknown>>();
  for (const [name, uid, expectKey] of [
    ["T조하은(override=paused)", CHO, "paused"],
    ["T윤도현(override=graduated)", YOON, "graduated"],
    ["T송하린(legacy seasonal_rest)", SONG, "seasonal_rest"],
    ["T안건우(legacy graduating)", AHN, "active"],
    ["이유나(실유저)", REAL, "active"],
  ] as const) {
    const r = await fetch(`${BASE}/api/cluster3/stats-cards?userId=${uid}`, {
      headers: { "x-internal-api-key": internalKey },
    });
    const j = (await r.json().catch(() => null)) as {
      data?: { process?: Record<string, unknown> };
    } | null;
    const p = j?.data?.process ?? {};
    statsByUser.set(uid, p);
    check(`${name}: 고객 growthStatusKey=${expectKey}`, p.growthStatusKey === expectKey,
      `실제=${p.growthStatusKey} status=${r.status}`);
  }
  // 고객 DTO 는 lean — 관리자 전용 필드 미노출
  {
    const p = statsByUser.get(CHO)!;
    check("고객 DTO: manualOverrideStatus/autoGrowthStatusKey 미노출",
      !("manualOverrideStatus" in p) && !("autoGrowthStatusKey" in p) && !("overrideMismatch" in p),
      Object.keys(p).join(","));
  }

  console.log("\n=== 2) 관리자 /api/admin/crews/[id]/cluster3/growth (세션) ===");
  const cookie = await makeAdminCookieHeader();
  type AdminProc = {
    growthDisplayKey: string;
    autoGrowthStatusKey: string;
    manualOverrideStatus: string | null;
    overrideMismatch: boolean;
    manualOverrideReason: string | null;
  };
  const adminProc = new Map<string, AdminProc>();
  for (const uid of ids) {
    const r = await fetch(`${BASE}/api/admin/crews/${uid}/cluster3/growth`, {
      headers: { cookie },
    });
    const j = (await r.json().catch(() => null)) as {
      data?: { process?: AdminProc };
    } | null;
    if (j?.data?.process) adminProc.set(uid, j.data.process);
  }
  {
    const p = adminProc.get(CHO);
    check("T조하은: override=paused / auto=active / mismatch=true(경고 대상)",
      p?.manualOverrideStatus === "paused" && p?.autoGrowthStatusKey === "active" && p?.overrideMismatch === true,
      JSON.stringify(p));
  }
  {
    const p = adminProc.get(YOON);
    check("T윤도현: override=graduated / display=graduated",
      p?.manualOverrideStatus === "graduated" && p?.growthDisplayKey === "graduated",
      JSON.stringify(p));
  }
  {
    const p = adminProc.get(SONG);
    check("T송하린: override=null / auto=seasonal_rest (legacy 값 무시·자동 도출)",
      p?.manualOverrideStatus === null && p?.autoGrowthStatusKey === "seasonal_rest",
      JSON.stringify(p));
  }
  {
    const p = adminProc.get(AHN);
    check("T안건우: override=null / display=active (legacy graduating 무시)",
      p?.manualOverrideStatus === null && p?.growthDisplayKey === "active",
      JSON.stringify(p));
  }

  console.log("\n=== 3) direct↔HTTP 일치 (고객 display == 관리자 display) ===");
  for (const uid of ids) {
    const customer = statsByUser.get(uid)?.growthStatusKey;
    const admin = adminProc.get(uid)?.growthDisplayKey;
    check(`${uid.slice(0, 8)}…: 고객(${customer}) == 관리자(${admin})`, customer === admin, "");
  }

  console.log("\n=== 4) PATCH 쓰기 가드 (자동 전용 상태 저장 거부 — 쓰기 0건) ===");
  for (const [val, expect] of [
    ["graduating", 400],
    ["seasonal_rest", 400],
    ["weekly_rest", 400],
    ["active", 400],
  ] as const) {
    const r = await fetch(`${BASE}/api/admin/members/${AHN}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ growth_status: val, growth_status_reason: "verify-only" }),
    });
    const j = (await r.json().catch(() => null)) as { error?: string } | null;
    check(`growth_status='${val}' → ${expect}`, r.status === expect, `실제=${r.status} ${j?.error ?? ""}`);
  }

  const after = await snapState();
  let snapChanged = 0;
  for (const [uid, sig] of before) {
    if (after.get(uid) !== sig) snapChanged++;
  }
  check("snapshot 불변(쓰기 0건)", snapChanged === 0, `변경 ${snapChanged}건`);

  // growth_status 원본 불변 확인 (PATCH 400 들이 실제로 아무것도 안 바꿨는지)
  {
    const r = await fetch(
      `${sbUrl}/rest/v1/user_profiles?select=user_id,growth_status&user_id=eq.${AHN}`,
      { headers: { apikey: sbService, Authorization: `Bearer ${sbService}` } },
    );
    const rows = (await r.json()) as Array<{ growth_status: string | null }>;
    check("T안건우 growth_status 원본 불변(=graduating 유지)", rows[0]?.growth_status === "graduating",
      `실제=${rows[0]?.growth_status}`);
  }

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}
void main();
