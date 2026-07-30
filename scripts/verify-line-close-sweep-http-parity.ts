/**
 * [실 HTTP] 라인 마감 자동 지급 스윕 결과 — 일반/mode=test/actAsTestUserId/demoUserId 파리티.
 *
 *   dev server 필요(:3000). run:
 *     npx tsx --env-file=.env.local scripts/verify-line-close-sweep-http-parity.ts
 *
 * scripts/verify-line-close-sweep-hub-unified.ts 로 이미 지급된 QA experience 라인(rating>=4)을
 * 그대로 대상으로, 관리자 API(/api/admin/members/:user_id/weeks/:week_id/lines)를 여러 스코프
 * 조회 방식으로 호출해 같은 데이터가 나오는지 확인한다(sweep 은 mode 개념이 없으므로, 어떤 스코프로
 * 봐도 원장에 쓰인 값과 동일해야 한다).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 검증 스크립트 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BASE = process.env.BASE ?? "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

async function cookieHeader(): Promise<string> {
  const { data: adm } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("활성 관리자 계정을 찾지 못했습니다.");
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: Array<{ name: string; value: string }> = [];
  const sv = createServerClient(u, a, {
    cookies: { getAll: () => [], setAll: (it: any[]) => cap.push(...it.map(({ name, value }) => ({ name, value }))) },
  });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  console.log(`admin = ${email}\n`);
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function get(path: string, cookie: string) {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie }, cache: "no-store" });
  let json: any = null;
  try { json = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json };
}

async function main() {
  // scripts/verify-line-close-sweep-hub-unified.ts 가 방금 지급한 experience(rating=7) 픽스처를 재탐색.
  const { data: lines } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id")
    .eq("part_type", "experience")
    .eq("is_qa_test", true)
    .eq("is_active", true);
  const lineIds = ((lines ?? []) as any[]).map((l) => l.id);
  const { data: awards } = await supabaseAdmin
    .from("process_point_awards")
    .select("ref_id,user_id,point_check")
    .eq("source", "line_rating")
    .in("ref_id", lineIds)
    .is("cancelled_at", null)
    .gte("point_check", 4)
    .limit(1);
  const award = ((awards ?? []) as any[])[0];
  if (!award) {
    console.log("⚠ 지급된 line_rating 픽스처를 찾지 못해 종료합니다(먼저 verify-line-close-sweep-hub-unified.ts 를 실행하세요).");
    process.exit(0);
  }
  const { data: tgt } = await supabaseAdmin
    .from("cluster4_line_targets")
    .select("week_id")
    .eq("line_id", award.ref_id)
    .eq("target_user_id", award.user_id)
    .eq("target_mode", "user")
    .limit(1)
    .maybeSingle();
  const weekId = (tgt as any)?.week_id as string;
  const userId = award.user_id as string;
  const lineId = award.ref_id as string;
  console.log(`대상: user=${userId.slice(0, 8)} week=${weekId.slice(0, 8)} line=${lineId.slice(0, 8)} 원장 ratingA=${award.point_check}\n`);

  const cookie = await cookieHeader();
  const path = (q: string) => `/api/admin/members/${userId}/weeks/${weekId}/lines${q}`;

  // QA 대상(is_qa_test 라인)이므로 "일반 모드"는 스코프에서 제외되는 게 정상 동작이다 —
  //   여기서는 test 스코프로 진입하는 3가지 방식(mode=test / actAsTestUserId / demoUserId)이
  //   전부 "같은 값"을 돌려주는지만 비교한다(스윕 결과가 스코프에 따라 갈리지 않아야 함).
  const variants: Array<{ label: string; q: string }> = [
    { label: "mode=test", q: "?mode=test" },
    { label: "actAsTestUserId", q: `?mode=test&actAsTestUserId=${userId}` },
    { label: "demoUserId", q: `?demoUserId=${userId}` },
  ];

  const results: Record<string, any> = {};
  for (const v of variants) {
    const res = await get(path(v.q), cookie);
    results[v.label] = res;
    ck(`${v.label} — HTTP 200`, res.status === 200, { status: res.status, error: res.json?.error });
  }

  const rows = variants.map((v) => {
    const data = results[v.label]?.json?.data;
    // 이 admin 내부 라우트(getCrewWeekLineSummary)는 크루앱 공유 계약(rows)이 아니라 lineDetails 배열을 쓴다.
    const row = (data?.lineDetails ?? []).find((r: any) => r.lineId === lineId);
    return {
      label: v.label,
      enhancementStatus: row?.enhancementStatus ?? null,
      ratingPointA: row?.ratingPointA ?? null,
      ratingPointStatus: row?.ratingPointStatus ?? null,
      enhancementPointA: row?.enhancementPointA ?? null,
      enhancementPointB: row?.enhancementPointB ?? null,
    };
  });
  console.log(JSON.stringify(rows, null, 2));

  const allSame = rows.every(
    (r) => r.ratingPointA === rows[0].ratingPointA && r.ratingPointStatus === rows[0].ratingPointStatus,
  );
  ck("3가지 스코프 진입 방식 — 평점 Point A 표시값 동일(파리티)", allSame, rows);
  ck("HTTP DTO 의 평점 Point A == 원장 실측값", rows[0]?.ratingPointA === award.point_check, {
    dto: rows[0]?.ratingPointA,
    ledger: award.point_check,
  });
  ck("HTTP DTO — 상태 'paid'(미지급 아님)", rows[0]?.ratingPointStatus === "paid", {
    status: rows[0]?.ratingPointStatus,
  });

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
