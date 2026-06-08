/**
 * growth_status 수동 오버라이드 변경 E2E (운영 write 포함 — 검증 후 원복).
 *
 *   대상: T조하은(테스터, 기존 override=paused)
 *   시나리오:
 *     1) PATCH paused → suspended (사유 동봉)
 *     2) user_growth_status_audit 기록 생성 확인 (old/new/reason/changed_by)
 *     3) admin growth API 에서 manualOverrideStatus/Reason/ByName/At 반영 확인
 *     4) PATCH suspended → paused (원복, 사유 동봉) — 원본 raw 정확 복원
 *     5) audit 2번째 행 + 최종 상태 원복 확인
 *     6) snapshot 전후 불변 확인
 *   Usage: $env:DIAG_ADMIN_BASE='https://vraxium-admin.vercel.app'; npx tsx --env-file=.env.local scripts/verify-override-write-e2e.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const BASE = process.env.DIAG_ADMIN_BASE ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const sbService = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const CHO = "cc05522b-7a71-48fb-a291-3aaaefdf4865"; // T조하은 (테스터)
const REASON_SET = "운영 검증 — auto/override 분리 E2E (paused→suspended)";
const REASON_REVERT = "운영 검증 원복 (suspended→paused)";

let pass = 0,
  fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

const sbHeaders = { apikey: sbService, Authorization: `Bearer ${sbService}` };

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

async function rawStatus(): Promise<string | null> {
  const r = await fetch(
    `${sbUrl}/rest/v1/user_profiles?select=growth_status&user_id=eq.${CHO}`,
    { headers: sbHeaders },
  );
  const rows = (await r.json()) as Array<{ growth_status: string | null }>;
  return rows[0]?.growth_status ?? null;
}

async function auditRows() {
  const r = await fetch(
    `${sbUrl}/rest/v1/user_growth_status_audit?select=old_status,new_status,reason,changed_by,created_at&user_id=eq.${CHO}&order=created_at.desc&limit=5`,
    { headers: sbHeaders },
  );
  return (await r.json()) as Array<{
    old_status: string | null;
    new_status: string | null;
    reason: string | null;
    changed_by: string;
    created_at: string;
  }>;
}

async function snapState() {
  const r = await fetch(
    `${sbUrl}/rest/v1/cluster4_weekly_card_snapshots?select=is_stale,computed_at,dto_version&user_id=eq.${CHO}`,
    { headers: sbHeaders },
  );
  const rows = (await r.json()) as Array<Record<string, unknown>>;
  return JSON.stringify(rows[0] ?? null);
}

async function patchGrowth(cookie: string, status: string, reason: string) {
  const r = await fetch(`${BASE}/api/admin/members/${CHO}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ growth_status: status, growth_status_reason: reason }),
  });
  const j = (await r.json().catch(() => null)) as {
    success?: boolean;
    data?: { growthStatus?: string | null };
    error?: string;
  } | null;
  return { status: r.status, body: j };
}

async function adminGrowthProcess(cookie: string) {
  const r = await fetch(`${BASE}/api/admin/crews/${CHO}/cluster3/growth`, {
    headers: { cookie },
  });
  const j = (await r.json().catch(() => null)) as {
    data?: {
      process?: {
        growthDisplayKey: string;
        manualOverrideStatus: string | null;
        manualOverrideReason: string | null;
        manualOverrideByName: string | null;
        manualOverrideAt: string | null;
        overrideMismatch: boolean;
      };
    };
  } | null;
  return j?.data?.process ?? null;
}

async function main() {
  console.log(`BASE=${BASE}`);
  const before = await rawStatus();
  check("사전 상태 = paused", before === "paused", `실제=${before}`);
  if (before !== "paused") {
    console.log("!! 사전 상태가 예상과 다름 — 중단 (write 0건)");
    process.exit(1);
  }
  const snapBefore = await snapState();
  const auditCountBefore = (await auditRows()).length;

  const cookie = await makeAdminCookieHeader();

  // ── 1) paused → suspended ──────────────────────────────────────────
  console.log("\n=== 1) PATCH paused → suspended (사유 동봉) ===");
  const p1 = await patchGrowth(cookie, "suspended", REASON_SET);
  check("PATCH 200 + growthStatus=suspended", p1.status === 200 && p1.body?.data?.growthStatus === "suspended",
    `status=${p1.status} ${p1.body?.error ?? ""}`);

  // ── 2) audit 기록 ──────────────────────────────────────────────────
  const a1 = await auditRows();
  const top1 = a1[0];
  check("audit 신규 행 생성", a1.length === auditCountBefore + 1, `before=${auditCountBefore} after=${a1.length}`);
  check("audit old=paused / new=suspended / 사유 일치",
    top1?.old_status === "paused" && top1?.new_status === "suspended" && top1?.reason === REASON_SET,
    JSON.stringify(top1));
  check("audit changed_by 기록됨", Boolean(top1?.changed_by), top1?.changed_by ?? "");

  // ── 3) admin growth API 메타 반영 ──────────────────────────────────
  const proc1 = await adminGrowthProcess(cookie);
  check("admin API: override=suspended / display=suspended",
    proc1?.manualOverrideStatus === "suspended" && proc1?.growthDisplayKey === "suspended",
    JSON.stringify(proc1));
  check("admin API: 사유/변경자/변경일 표시",
    proc1?.manualOverrideReason === REASON_SET && Boolean(proc1?.manualOverrideByName) && Boolean(proc1?.manualOverrideAt),
    `reason=${proc1?.manualOverrideReason} by=${proc1?.manualOverrideByName} at=${proc1?.manualOverrideAt}`);

  // ── 4) 원복 suspended → paused ─────────────────────────────────────
  console.log("\n=== 4) PATCH suspended → paused (원복) ===");
  const p2 = await patchGrowth(cookie, "paused", REASON_REVERT);
  check("원복 PATCH 200 + growthStatus=paused", p2.status === 200 && p2.body?.data?.growthStatus === "paused",
    `status=${p2.status} ${p2.body?.error ?? ""}`);

  // ── 5) 최종 상태 + audit 2행 ───────────────────────────────────────
  const after = await rawStatus();
  check("최종 raw = paused (원본 정확 복원)", after === "paused", `실제=${after}`);
  const a2 = await auditRows();
  check("audit 총 2행 추가 (변경+원복)", a2.length === auditCountBefore + 2, `총=${a2.length}`);
  check("audit 최신 행 = 원복 기록",
    a2[0]?.old_status === "suspended" && a2[0]?.new_status === "paused" && a2[0]?.reason === REASON_REVERT,
    JSON.stringify(a2[0]));
  const proc2 = await adminGrowthProcess(cookie);
  check("원복 후 admin API: override=paused + 최신 사유=원복 사유",
    proc2?.manualOverrideStatus === "paused" && proc2?.manualOverrideReason === REASON_REVERT,
    `reason=${proc2?.manualOverrideReason}`);

  // ── 6) snapshot 불변 ───────────────────────────────────────────────
  const snapAfter = await snapState();
  check("snapshot 불변 (override 변경은 snapshot 무관)", snapBefore === snapAfter, "");

  console.log(`\n결과: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}
void main();
