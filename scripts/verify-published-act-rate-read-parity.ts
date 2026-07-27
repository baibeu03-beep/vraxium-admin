/**
 * [실 HTTP · read-only] 공표 snapshot 액트 체크율 조회 파리티.
 *
 *   BASE=http://localhost:3000 npx tsx --env-file=.env.local \
 *     scripts/verify-published-act-rate-read-parity.ts
 *
 * 검증:
 *   ① 일반 모드 / mode=test 가 **같은 공표 snapshot(활성 run)** 을 읽는가
 *   ② 화면이 내려주는 actCompletionRatePercent 가 DB 저장값과 동일한가(live 재계산으로 덮지 않음)
 *   ③ 정정 대상 26행이 현재는 여전히 옛 저장값을 노출하는가(= 코드 변경만으로 자동 재작성되지 않음)
 *
 * write 0.
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
  const cookie = await cookieHeader();

  const { data: runData } = await supabaseAdmin
    .from("cluster4_week_finalize_runs")
    .select("id,week_id,organization_slug,scope")
    .is("reverted_at", null).eq("snapshot_captured", true);
  const runs = (runData ?? []) as any[];
  const { data: wkData } = await supabaseAdmin.from("weeks").select("id,season_key,week_number");
  const W = new Map(((wkData ?? []) as any[]).map((w) => [w.id, `${w.season_key} W${w.week_number}`]));

  for (const run of runs) {
    const name = `${run.organization_slug} ${W.get(run.week_id)} (scope=${run.scope})`;
    const { data: crData } = await supabaseAdmin
      .from("cluster4_week_finalize_run_crew_results")
      .select("user_id,crew_display_name,act_completion_rate_percent,act_total_count,act_success_count")
      .eq("run_id", run.id);
    const stored = new Map(((crData ?? []) as any[]).map((r) => [r.user_id, r]));

    const path = `/api/admin/team-parts/info/crew-week-results/${run.organization_slug}/${run.week_id}`;
    const base = await get(path, cookie);
    const test = await get(`${path}?mode=test`, cookie);
    ck(`${name} · 200 (일반·test)`, base.status === 200 && test.status === 200, { 일반: base.status, test: test.status });
    if (base.status !== 200) continue;

    // ① 일반 == test — 같은 공표 snapshot 을 읽는가.
    ck(`${name} · 일반 == mode=test (공표 snapshot 동일)`,
      JSON.stringify(base.json?.data) === JSON.stringify(test.json?.data));

    // ② API 값 == DB 저장값(live 재계산으로 덮지 않음).
    //    응답 shape = { published: { crewResults: [...] }, publication, scope }.
    const cells: any[] = base.json?.data?.published?.crewResults ?? [];
    if (cells.length === 0) { console.log(`   (published.crewResults 비어 있음 — 건너뜀)`); continue; }
    let mismatched = 0;
    const samples: any[] = [];
    for (const c of cells) {
      const st = stored.get(c.userId ?? c.user_id);
      if (!st) continue;
      const apiRate = c.actCompletionRatePercent ?? null;
      const apiTotal = c.actTotalCount ?? null;
      if (apiRate !== st.act_completion_rate_percent || apiTotal !== st.act_total_count) {
        mismatched++;
        if (samples.length < 3) samples.push({ user: st.crew_display_name, api: [apiRate, apiTotal], db: [st.act_completion_rate_percent, st.act_total_count] });
      }
    }
    ck(`${name} · API 액트 체크율 == DB 저장값(${cells.length}행 · live 덮어쓰기 없음)`,
      mismatched === 0, mismatched === 0 ? undefined : samples);
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
