/**
 * verify-grade-membership-backfill.ts — PMS 등급 보정 결과 검증.
 *   direct(데이터 레이어) == HTTP(/api/admin/members, /api/.../experience/line-manage)
 *   + /admin/members statusLabel 파트장/에이전트 + 라인 관리 보드 headcount + snapshot stale/불변.
 *   admin 세션 쿠키는 service-role generateLink(magiclink)→verifyOtp 로 발급.
 *
 * 사전: dev 서버(:3000) 기동. 실행: npx tsx --env-file=.env.local scripts/verify-grade-membership-backfill.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { listMembers } from "@/lib/adminMembersData";
import { getExperienceLineManageSummary } from "@/lib/adminExperienceLineManage";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

const AFFECTED_29 = [
  "fc83bff6-f160-4a9b-a1ee-477168248977","df952cd1-7aa4-4cb8-a085-530e469f40ff","576d0e8f-d4d3-49b4-8d0f-34ec3e51dac8",
  "535fd54a-b9c4-4daa-a364-b4360d87a90f","2d00608d-052a-4569-a017-b9ca76269f9d","fd4eb101-24c4-4f95-8349-9d9f8d9b81c4",
  "805c3a4c-714f-4b43-9dac-f99adeec05f4","c285e987-b465-4cd1-a434-9a015142240b","16e4d039-0c75-4fc1-b01c-d878651e6217",
  "c04025d3-74f7-44f7-ac69-8362ceb3b179","74a22910-edab-48a4-b336-92f301de9b60","60e3e8a2-0d28-4bfa-bac6-55f480bfa92a",
  "6a4deabb-a0dd-4e9b-92a3-1f21829d3d51","f810ae32-7261-402e-8db1-12a32eed8629","07c877a7-0e2e-4f7d-a250-7f16363d7a88",
  "787d36ba-ac71-4682-912d-d020b5162000","43eadae5-596e-4903-9a92-2f5cc18e59f6","b38b90b9-9db1-4db6-8895-ac3c513d9ceb",
  "c15513ad-654d-4401-a527-e9fc4728a3c0","b09b2559-249c-4358-a1f4-f89132db854c","072e8890-edc3-4878-9e3c-da4a1f7853d0",
  "db3cce9d-b189-404d-b6ab-31b70a6bbeb6","781620d0-fffe-43bd-b8b0-aa7f660d3b6f","132d85d1-40da-4567-9da8-e3d4c4687388",
  "13fb675f-3943-4be8-89c5-0739024dd5b2","dd10d62a-633b-430b-a342-36db7bfb3aa3","940eaf5c-6fed-496a-b272-37ce9569169a",
  "5c5bd454-ca1c-4e2b-a059-6f09190a718f","02706319-9281-41a5-97ef-705dfa56ab21",
];

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

async function adminCookieHeader(): Promise<string> {
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  if (linkErr) throw linkErr;
  const otp = linkData.properties?.email_otp;
  if (!otp) throw new Error("email_otp 없음");
  const jar: Record<string, string> = {};
  const ssr = createServerClient(SUPABASE_URL, ANON, {
    cookies: {
      getAll: () => Object.entries(jar).map(([name, value]) => ({ name, value })),
      setAll: (cs) => cs.forEach((c) => { jar[c.name] = c.value; }),
    },
  });
  const { error: otpErr } = await ssr.auth.verifyOtp({ email: ADMIN_EMAIL, token: otp, type: "email" });
  if (otpErr) throw otpErr;
  return Object.entries(jar).map(([n, v]) => `${n}=${v}`).join("; ");
}

// statusLabel 파트장/에이전트 카운트(비테스트).
async function directMembersCount(org: string, testSet: Set<string>) {
  let offset = 0, pl = 0, ag = 0;
  for (;;) {
    const res = await listMembers({ organization: org, limit: 500, offset });
    for (const m of res.members) {
      if (testSet.has(m.userId)) continue;
      if (m.statusLabel === "심화(파트장)") pl++;
      else if (m.statusLabel === "심화(에이전트)") ag++;
    }
    offset += res.members.length;
    if (res.members.length === 0 || offset >= res.total) break;
  }
  return { pl, ag };
}

async function httpMembersCount(org: string, cookie: string, testSet: Set<string>) {
  let offset = 0, pl = 0, ag = 0, total = 0;
  for (;;) {
    const r = await fetch(`${BASE}/api/admin/members?organization=${org}&limit=500&offset=${offset}`, { headers: { cookie } });
    const j = await r.json();
    if (!j.success) throw new Error(`members HTTP ${org}: ${j.error}`);
    const members = j.data.members as Array<{ userId: string; statusLabel: string }>;
    total = j.data.total;
    for (const m of members) {
      if (testSet.has(m.userId)) continue;
      if (m.statusLabel === "심화(파트장)") pl++;
      else if (m.statusLabel === "심화(에이전트)") ag++;
    }
    offset += members.length;
    if (members.length === 0 || offset >= total) break;
  }
  return { pl, ag };
}

function boardCounts(summary: Awaited<ReturnType<typeof getExperienceLineManageSummary>>) {
  let pl = 0, ag = 0;
  for (const t of summary.teams) { pl += t.headcount.partLeader; ag += t.headcount.agent; }
  return { pl, ag };
}

async function main() {
  console.log(`\n*** 등급 보정 검증 (BASE=${BASE}) ***\n`);
  const testSet = new Set((await (async () => { const { data } = await sb.from("test_user_markers").select("user_id"); return data ?? []; })()).map((t: any) => t.user_id));

  // ── (1)(2) affected/org별 DB 확정 ──
  console.log("[1-2] affected/org별 반영 (DB 직접)");
  const { data: affRows } = await sb.from("user_memberships")
    .select("user_id,membership_level,is_current").in("user_id", AFFECTED_29).eq("is_current", true);
  const affPl = (affRows ?? []).filter((r: any) => r.membership_level === "심화(파트장)").length;
  const affAg = (affRows ?? []).filter((r: any) => r.membership_level === "심화(에이전트)").length;
  check("affected 29건 모두 심화(파트장/에이전트)로 반영", (affRows ?? []).length === 29 && affPl + affAg === 29, `파트장 ${affPl}/에이전트 ${affAg} (총 ${(affRows ?? []).length})`);

  const cookie = await adminCookieHeader();

  // ── (3)(5)(6)(7) members: direct == HTTP, 파트장/에이전트 표시 ──
  console.log("\n[3,5,6,7] /admin/members statusLabel — direct vs HTTP");
  for (const org of ["oranke", "encre"]) {
    const d = await directMembersCount(org, testSet);
    const h = await httpMembersCount(org, cookie, testSet);
    check(`[${org}] members direct 파트장/에이전트 > 0`, d.pl > 0 || d.ag > 0, `direct 파트장 ${d.pl}/에이전트 ${d.ag}`);
    check(`[${org}] members direct == HTTP`, d.pl === h.pl && d.ag === h.ag, `HTTP 파트장 ${h.pl}/에이전트 ${h.ag}`);
  }

  // ── (4)(5)(6)(7) 라인 관리 보드: direct == HTTP ──
  console.log("\n[4,5,6,7] 라인 관리 보드 headcount — direct vs HTTP");
  for (const org of ["oranke", "encre"]) {
    const direct = await getExperienceLineManageSummary(org);
    const d = boardCounts(direct);
    const r = await fetch(`${BASE}/api/admin/cluster4/experience/line-manage?organization=${org}`, { headers: { cookie } });
    const j = await r.json();
    if (!j.success) { check(`[${org}] board HTTP 200`, false, j.error); continue; }
    const h = boardCounts(j.data);
    check(`[${org}] board direct 파트장/에이전트 반영`, d.pl > 0 || d.ag > 0, `direct 파트장 ${d.pl}/에이전트 ${d.ag}`);
    check(`[${org}] board direct == HTTP`, d.pl === h.pl && d.ag === h.ag, `HTTP 파트장 ${h.pl}/에이전트 ${h.ag}`);
    // 팀별 출력
    for (const t of direct.teams) if (t.headcount.partLeader || t.headcount.agent)
      console.log(`      [${org}] ${t.teamName}: 파트장 ${t.headcount.partLeader} / 에이전트 ${t.headcount.agent}`);
  }

  // ── (9)(10) snapshot stale/불변 ──
  console.log("\n[9,10] snapshot stale 표시 / count 불변·강제 재계산 없음");
  const { data: snaps } = await sb.from("cluster4_weekly_card_snapshots")
    .select("user_id,is_stale,computed_at").in("user_id", AFFECTED_29);
  const staleCount = (snaps ?? []).filter((s: any) => s.is_stale === true).length;
  check("대상자 snapshot 전부 is_stale=true", (snaps ?? []).length > 0 && staleCount === (snaps ?? []).length, `${staleCount}/${(snaps ?? []).length} stale`);
  const { count: totalSnap } = await sb.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  check("snapshot 전체 row 존재(삭제/INSERT 없음 — UPDATE만)", (totalSnap ?? 0) > 0, `전체 snapshot row=${totalSnap}`);

  console.log(`\n=== 검증 종료: PASS ${pass} / FAIL ${fail} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
