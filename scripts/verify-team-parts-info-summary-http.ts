/**
 * 팀 내역(활동 관리 §1) 상단 요약 — 실제 HTTP 검증(가동 중 dev :3000).
 *   · 일반 모드 × 각 org / mode=test × 각 org 로 GET /api/admin/team-parts/info 를 호출.
 *   · summary(currentDate/currentWeek/counts) DTO 파리티·타입·집계값·반기 불변성을 원천 데이터와 대조.
 *   READ-ONLY. Usage: npx tsx --env-file=.env.local scripts/verify-team-parts-info-summary-http.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS } from "@/lib/organizations";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import {
  resolveCurrentHalfKey,
  loadTeamPartsCurrentSummary,
} from "@/lib/adminTeamHalvesData";
import { resolveEffectiveScopeMode } from "@/lib/cluster4ExperienceTestScope";
import type { ScopeMode } from "@/lib/userScopeShared";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const PAST_HALF = "2024-H1"; // 확실한 과거 반기(요약 불변성 · 목록 변동 확인용)

let fail = 0;
const ck = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(m);
}

async function cookieHeader(): Promise<string> {
  const { data: admins } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "활성 admin_users 이메일 없음");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  assert(link.properties?.email_otp, "generateLink 실패");
  const { data: verified } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  assert(verified.session, "verifyOtp 실패");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        captured.push(...items.map(({ name, value }) => ({ name, value }))),
    },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  console.log(`admin 세션: ${email}`);
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

// 원천 데이터 직접 집계(loadHalfRows 미사용 — 완전 독립 대조).
async function rawCounts(mode: ScopeMode) {
  const currentHalf = await resolveCurrentHalfKey();
  const wantQaTest = resolveEffectiveScopeMode(mode) === "test";
  let totalClubs = 0;
  let totalTeams = 0;
  const teamHalfIds: string[] = [];
  for (const org of ORGANIZATIONS) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_team_halves")
      .select("id,is_qa_test")
      .eq("organization_slug", org)
      .eq("half_key", currentHalf ?? "")
      .eq("is_active", true);
    if (error) throw new Error(error.message);
    const scoped = (data ?? []).filter(
      (r: { is_qa_test: boolean | null }) => Boolean(r.is_qa_test) === wantQaTest,
    );
    if (scoped.length > 0) totalClubs += 1;
    totalTeams += scoped.length;
    for (const r of scoped as Array<{ id: string }>) teamHalfIds.push(r.id);
  }
  let totalParts = 0;
  if (teamHalfIds.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("cluster4_team_parts")
      .select("id")
      .in("team_half_id", teamHalfIds);
    if (error) throw new Error(error.message);
    totalParts = (data ?? []).length;
  }
  return { totalClubs, totalTeams, totalParts, currentHalf };
}

async function getInfo(
  cookie: string,
  org: string,
  mode: ScopeMode,
  half?: string,
) {
  const params = new URLSearchParams({ organization: org });
  if (half) params.set("half", half);
  if (mode === "test") params.set("mode", "test");
  const res = await fetch(
    `${baseUrl}/api/admin/team-parts/info?${params.toString()}`,
    { headers: { cookie }, cache: "no-store" },
  );
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const SUMMARY_KEYS = ["currentDate", "currentWeek", "counts"].sort();
const COUNT_KEYS = ["totalClubs", "totalTeams", "totalParts"].sort();

function summaryShapeOk(s: unknown): string {
  if (!s || typeof s !== "object") return "summary 부재/비객체";
  const o = s as Record<string, unknown>;
  if (JSON.stringify(Object.keys(o).sort()) !== JSON.stringify(SUMMARY_KEYS))
    return `summary 키 불일치: ${Object.keys(o).sort().join(",")}`;
  if (typeof o.currentDate !== "string") return "currentDate 타입";
  const c = o.counts as Record<string, unknown>;
  if (!c || JSON.stringify(Object.keys(c).sort()) !== JSON.stringify(COUNT_KEYS))
    return "counts 키 불일치";
  for (const k of COUNT_KEYS)
    if (typeof c[k] !== "number") return `counts.${k} 타입`;
  // currentWeek 는 object | null(둘 다 허용) — 현재는 object 기대.
  if (o.currentWeek !== null && typeof o.currentWeek !== "object")
    return "currentWeek 타입";
  return "";
}

async function main() {
  const cookie = await cookieHeader();
  const todayIso = getCurrentActivityDateIso();
  console.log(`\n서버 활동기준일(Asia/Seoul 00:01 경계) = ${todayIso}\n`);

  // 0) 직접 계산 vs 원천 raw 대조(모드별).
  for (const mode of ["operating", "test"] as ScopeMode[]) {
    const direct = await loadTeamPartsCurrentSummary(mode);
    const raw = await rawCounts(mode);
    console.log(`[direct vs raw · ${mode}] current-half=${raw.currentHalf}`);
    ck(
      `direct.counts == raw.counts`,
      JSON.stringify(direct.counts) ===
        JSON.stringify({
          totalClubs: raw.totalClubs,
          totalTeams: raw.totalTeams,
          totalParts: raw.totalParts,
        }),
      `direct=${JSON.stringify(direct.counts)} raw={clubs:${raw.totalClubs},teams:${raw.totalTeams},parts:${raw.totalParts}}`,
    );
    ck(
      `currentDate 가 활동기준일과 정합(YYYY년…)`,
      direct.currentDate.startsWith(`${Number(todayIso.slice(0, 4))}년`),
      direct.currentDate,
    );
    ck(`currentWeek 존재(현재 주차)`, direct.currentWeek != null, direct.currentWeek?.label ?? "null");
  }

  // 1) HTTP — org × mode. 요약 파리티·타입·집계·전 org 동일성.
  const summaryByMode: Record<string, string[]> = { operating: [], test: [] };
  for (const mode of ["operating", "test"] as ScopeMode[]) {
    const raw = await rawCounts(mode);
    console.log(`\n[HTTP · mode=${mode}]`);
    for (const org of ORGANIZATIONS) {
      const { status, json } = await getInfo(cookie, org, mode);
      ck(`${org} HTTP 200`, status === 200, `status=${status}`);
      const shapeErr = summaryShapeOk(json?.data?.summary);
      ck(`${org} summary DTO 구조/타입`, shapeErr === "", shapeErr);
      const counts = json?.data?.summary?.counts;
      ck(
        `${org} counts == raw`,
        JSON.stringify(counts) ===
          JSON.stringify({
            totalClubs: raw.totalClubs,
            totalTeams: raw.totalTeams,
            totalParts: raw.totalParts,
          }),
        `http=${JSON.stringify(counts)}`,
      );
      summaryByMode[mode].push(JSON.stringify(json?.data?.summary));
    }
    // 전 org 요약 동일(현재 접속 시점·전 조직 기준 → org 무관).
    ck(
      `요약 전 org 동일(mode=${mode})`,
      new Set(summaryByMode[mode]).size === 1,
      `distinct=${new Set(summaryByMode[mode]).size}`,
    );
  }

  // 2) DTO 키 파리티 — operating vs test 동일 구조.
  {
    const opKeys = Object.keys(
      JSON.parse(summaryByMode.operating[0]) as object,
    ).sort();
    const tKeys = Object.keys(JSON.parse(summaryByMode.test[0]) as object).sort();
    ck(
      `operating/test summary 키 동일`,
      JSON.stringify(opKeys) === JSON.stringify(tKeys),
      `${opKeys} / ${tKeys}`,
    );
  }

  // 3) 반기 불변성 — 과거 반기(?half=2024-H1) 선택해도 요약 동일, 목록(selectedHalfKey/teams)은 변동.
  console.log(`\n[반기 불변성 · org=encre · mode=operating]`);
  const cur = await getInfo(cookie, "encre", "operating");
  const past = await getInfo(cookie, "encre", "operating", PAST_HALF);
  ck(`과거 반기 HTTP 200`, past.status === 200, `status=${past.status}`);
  ck(
    `요약 불변(현재 반기 == 과거 반기 선택)`,
    JSON.stringify(cur.json?.data?.summary) ===
      JSON.stringify(past.json?.data?.summary),
    `cur.counts=${JSON.stringify(cur.json?.data?.summary?.counts)} past.counts=${JSON.stringify(past.json?.data?.summary?.counts)}`,
  );
  ck(
    `목록은 선택 반기 반영(selectedHalfKey 변동)`,
    cur.json?.data?.selectedHalfKey !== past.json?.data?.selectedHalfKey,
    `cur=${cur.json?.data?.selectedHalfKey} past=${past.json?.data?.selectedHalfKey}`,
  );

  console.log(`\n${fail === 0 ? "PASS ✅" : `FAIL ❌ (${fail})`}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
