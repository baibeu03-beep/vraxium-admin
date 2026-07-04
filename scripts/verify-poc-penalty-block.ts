/**
 * 검증 — 이행자 패널티(Po.C) 차단 정책 (direct + HTTP, 실경로).
 *   npx tsx --env-file=.env.local scripts/verify-poc-penalty-block.ts
 *
 * [순수] resolveEffectivePenalty — 3 분기(자동매칭→0 / 보상+C→0 / 순수 수동 C→유지).
 * [실경로] 격리 seed(encre·test·W28·클린 test user)로 변동 액트 3종을 만들어 실제 적립 함수를 태운다:
 *   act1 review_request A=3 B=2 C=5  → 자동매칭 이행자 → 원장 C=0
 *   act2 manual_grant   A=3 B=0 C=5  → 보상+패널티 동시 금지 → 원장 C=0
 *   act3 manual_grant   A=0 B=0 C=5  → 순수 수동 패널티 → 원장 C=5 유지
 * [HTTP] /api/admin/processes/accrue 재실행(act1) → 원장 C=0 유지. direct==HTTP.
 * 정리: revokeForAct(원장 삭제+uwp 재계산+snapshot 무효화) + 액트/recipients 삭제 → 원상복구.
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  resolveEffectivePenalty,
  accrueForCompletedIrregular,
  revokeForAct,
} from "@/lib/processPointAccrual";

const REAL_BASE = process.env.REAL_BASE ?? "http://localhost:3000";
const ORG = "encre";
const WEEK_ID = "39aae7a0-216f-4262-8a67-6beef1bccf22"; // 2026-summer W2 (iso 2026 W28), accrual-allowed
const USER = "247021bc-374b-48f4-8d49-b181d149ee33"; // encre test user(T강민서) — 오펜더 아님
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

async function adminCookie(): Promise<string> {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const otp = (link as { properties?: { email_otp?: string } })?.properties?.email_otp;
  const { data: v } = await browser.auth.verifyOtp({ email: adminEmail, token: otp!, type: "magiclink" });
  const cap: Array<{ name: string; value: string }> = [];
  const s = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it) } });
  await s.auth.setSession({ access_token: v.session!.access_token, refresh_token: v.session!.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function seedAct(kind: string, a: number, b: number, c: number): Promise<string> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabaseAdmin.from("process_irregular_acts").insert({
    organization_slug: ORG, week_id: WEEK_ID, kind,
    act_name: `[정책검증] ${kind} A${a}B${b}C${c}`,
    applicant_admin_id: null, applicant_admin_name: "verify-poc",
    target_user_id: null, target_user_name: null, scope_mode: "test",
    duration_minutes: null, reason: "policy-verify",
    point_a: a, point_b: b, point_c: c,
    crew_reaction: "partial", review_link: null,
    scheduled_check_at: nowIso, status: "completed", completed_at: nowIso,
  }).select("id").single();
  if (error) throw new Error(`seed act(${kind}) 실패: ${error.message}`);
  const actId = (data as { id: string }).id;
  const { error: recErr } = await supabaseAdmin.from("process_check_review_recipients").insert({
    source: "irregular", ref_id: actId, organization_slug: ORG, scope_mode: "test",
    user_id: USER, nickname: "T강민서", match_type: "matched", match_reason: "verify",
  });
  if (recErr) throw new Error(`seed recipient 실패: ${recErr.message}`);
  return actId;
}

async function ledgerPenalty(refId: string): Promise<{ a: number; b: number; c: number; rows: number }> {
  const { data } = await supabaseAdmin.from("process_point_awards")
    .select("point_check,point_advantage,point_penalty").eq("source", "irregular").eq("ref_id", refId);
  const rows = (data ?? []) as { point_check: number; point_advantage: number; point_penalty: number }[];
  return {
    a: rows.reduce((s, r) => s + (r.point_check || 0), 0),
    b: rows.reduce((s, r) => s + (r.point_advantage || 0), 0),
    c: rows.reduce((s, r) => s + (r.point_penalty || 0), 0),
    rows: rows.length,
  };
}

async function cleanup(actIds: string[]) {
  for (const id of actIds) {
    try { await revokeForAct("irregular", id); } catch { /* ignore */ }
    await supabaseAdmin.from("process_check_review_recipients").delete().eq("source", "irregular").eq("ref_id", id);
    await supabaseAdmin.from("process_irregular_acts").delete().eq("id", id);
  }
}

async function main() {
  // ── [순수] resolveEffectivePenalty ──
  console.log("[순수] resolveEffectivePenalty");
  check("자동매칭 이행자 → 0", resolveEffectivePenalty({ autoMatched: true, pointCheck: 3, pointAdvantage: 2, pointPenalty: 5 }) === 0);
  check("자동매칭 + 순수 C → 0(카페=이행자)", resolveEffectivePenalty({ autoMatched: true, pointCheck: 0, pointAdvantage: 0, pointPenalty: 5 }) === 0);
  check("수동 + 보상A + C → 0(A+C 금지)", resolveEffectivePenalty({ autoMatched: false, pointCheck: 3, pointAdvantage: 0, pointPenalty: 5 }) === 0);
  check("수동 + 보상B + C → 0(B+C 금지)", resolveEffectivePenalty({ autoMatched: false, pointCheck: 0, pointAdvantage: 2, pointPenalty: 5 }) === 0);
  check("수동 + 순수 C → 5 유지(미발생 패널티)", resolveEffectivePenalty({ autoMatched: false, pointCheck: 0, pointAdvantage: 0, pointPenalty: 5 }) === 5);
  check("C=0 요청 → 0", resolveEffectivePenalty({ autoMatched: false, pointCheck: 3, pointAdvantage: 0, pointPenalty: 0 }) === 0);

  const seeded: string[] = [];
  try {
    // ── [실경로 direct] ──
    console.log("\n[실경로 direct] 변동 액트 3종 실제 적립");
    const act1 = await seedAct("review_request", 3, 2, 5); seeded.push(act1);
    const r1 = await accrueForCompletedIrregular(act1);
    const l1 = await ledgerPenalty(act1);
    check(`review_request(자동): 원장 C=0`, l1.c === 0 && l1.a === 3 && l1.b === 2, `A=${l1.a} B=${l1.b} C=${l1.c} rows=${l1.rows} accr=${(r1 as any).accruedUserIds?.length}`);

    const act2 = await seedAct("manual_grant", 3, 0, 5); seeded.push(act2);
    await accrueForCompletedIrregular(act2);
    const l2 = await ledgerPenalty(act2);
    check(`manual_grant 보상A+C: 원장 C=0`, l2.c === 0 && l2.a === 3, `A=${l2.a} B=${l2.b} C=${l2.c}`);

    const act3 = await seedAct("manual_grant", 0, 0, 5); seeded.push(act3);
    await accrueForCompletedIrregular(act3);
    const l3 = await ledgerPenalty(act3);
    check(`manual_grant 순수C: 원장 C=5 유지`, l3.c === 5 && l3.a === 0 && l3.b === 0, `A=${l3.a} B=${l3.b} C=${l3.c}`);

    // ── [HTTP] act1 재실행(재실행 경로) → C=0 유지 + direct==HTTP ──
    console.log("\n[HTTP] /api/admin/processes/accrue 재실행(act1)");
    const cookie = await adminCookie();
    const res = await fetch(`${REAL_BASE}/api/admin/processes/accrue`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie, connection: "close" },
      body: JSON.stringify({ source: "irregular", ref_id: act1 }),
    });
    const j = await res.json();
    check("HTTP 200 + success", res.status === 200 && j?.success === true, `status=${res.status}`);
    const lh = await ledgerPenalty(act1);
    check("HTTP 재실행 후 원장 C=0 유지", lh.c === 0 && lh.a === 3 && lh.b === 2, `A=${lh.a} B=${lh.b} C=${lh.c}`);
    check("direct == HTTP (act1 원장 동일)", JSON.stringify(l1) === JSON.stringify(lh), `direct=${JSON.stringify(l1)} http=${JSON.stringify(lh)}`);
  } finally {
    await cleanup(seeded);
    console.log(`\n[cleanup] seed ${seeded.length}건 원장/recipients/act 삭제 + uwp 재계산 완료`);
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
