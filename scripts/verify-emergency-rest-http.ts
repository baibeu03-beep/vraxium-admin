/**
 * 긴급 휴식 — 실제 HTTP 검증(엔드포인트 경유). dev 서버(localhost:3000) 필요.
 *   npx tsx --env-file=.env.local scripts/verify-emergency-rest-http.ts
 *
 * 안전: mode=test + (T) 테스트 팀·테스트 크루로만 생성(실 크루/실 주차 포인트 무영향). 종료 시 정리.
 * 케이스(스펙 §상태):
 *   현재 주차 → 생성 응답 이행 & 목록 이행
 *   다음 주차 → 생성 응답 승인 & 목록 승인
 *   Po.C +2 원장 반영 · 변동 액트 보드 숨김 · 어떤 경우도 신청(pending) 아님
 *   생성 응답 status == 목록 재조회 displayStatus (동일 판정)
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error("ASSERT FAIL: " + m);
}
let pass = 0;
function ok(label: string) {
  pass++;
  console.log(`  PASS · ${label}`);
}

async function writeAdminCookie(): Promise<string> {
  const { data } = await supabaseAdmin
    .from("admin_users")
    .select("email,role")
    .in("role", ["owner", "admin"])
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (data?.[0] as { email: string } | undefined)?.email;
  assert(email, "no owner/admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  assert(link.properties?.email_otp, "generateLink failed");
  const { data: verified } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  assert(verified.session, "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function main() {
  const cookie = await writeAdminCookie();
  const H = { Cookie: cookie, "Content-Type": "application/json" };
  const ORGS = ["encre", "oranke", "phalanx"] as const;

  // 1) test 스코프에서 (팀+크루+주차2) 조합 발견.
  let found: { org: string; teamId: string; crewUserId: string; crewName: string;
    cur: { weekId: string; seasonKey: string; ws: string }; nxt: { weekId: string; ws: string } } | null = null;
  for (const org of ORGS) {
    const ctxRes = await fetch(`${baseUrl}/api/admin/rest-management/emergency/context?organization=${org}&mode=test`, { headers: { Cookie: cookie } });
    const ctxJson = await ctxRes.json();
    assert(ctxRes.ok && ctxJson.success, `context ${org} ${ctxRes.status} ${JSON.stringify(ctxJson).slice(0,120)}`);
    const ctx = ctxJson.context;
    if (ctx.weeks.length < 2) continue;
    for (const t of ctx.teams) {
      const cRes = await fetch(`${baseUrl}/api/admin/rest-management/emergency/crews?organization=${org}&teamId=${t.teamId}&mode=test`, { headers: { Cookie: cookie } });
      const cJson = await cRes.json();
      assert(cRes.ok && cJson.success, `crews ${org} ${cRes.status}`);
      if (cJson.crews.length > 0) {
        found = {
          org, teamId: t.teamId, crewUserId: cJson.crews[0].userId, crewName: cJson.crews[0].crewName,
          cur: { weekId: ctx.weeks[0].weekId, seasonKey: ctx.weeks[0].seasonKey, ws: ctx.weeks[0].weekStartDate },
          nxt: { weekId: ctx.weeks[1].weekId, ws: ctx.weeks[1].weekStartDate },
        };
        break;
      }
    }
    if (found) break;
  }
  assert(found, "test 스코프 (팀+크루+주차2) 조합 없음");
  console.log(`\nscope: org=${found.org} crew=${found.crewName} cur=${found.cur.ws} nxt=${found.nxt.ws}`);
  ok("context/crews DTO (동일 응답 형태)");

  const post = (weekId: string, reason: string) =>
    fetch(`${baseUrl}/api/admin/rest-management/emergency?mode=test`, {
      method: "POST", headers: H,
      body: JSON.stringify({ organization: found!.org, teamId: found!.teamId, crewUserId: found!.crewUserId, weekId, reason }),
    });
  const listStatusById = async (id: string): Promise<string | null> => {
    const r = await fetch(`${baseUrl}/api/admin/rest-management/list?organization=${found!.org}&season_key=${found!.cur.seasonKey}`, { headers: { Cookie: cookie } });
    const j = await r.json();
    assert(r.ok && j.success, `list ${r.status}`);
    return (j.rows as Array<{ id: string; displayStatus: string }>).find((x) => x.id === id)?.displayStatus ?? null;
  };

  let curId = "", nxtId = "";
  try {
    // 2) 현재 주차 → 이행
    const curRes = await post(found.cur.weekId, "http-현재");
    const curJson = await curRes.json();
    assert(curRes.ok && curJson.success, `POST current ${curRes.status} ${JSON.stringify(curJson).slice(0,160)}`);
    curId = curJson.request.id;
    assert(curJson.request.status === "fulfilled", `현재 생성응답 status=${curJson.request.status} (fulfilled 기대)`);
    ok("현재 주차 생성 응답 = 휴식 이행(fulfilled)");
    assert(curJson.awardedPoint?.amount === 2, "awardedPoint.amount!=2");
    const curList = await listStatusById(curId);
    assert(curList === "fulfilled", `현재 목록 displayStatus=${curList} (fulfilled 기대)`);
    ok("현재 주차 목록 displayStatus = 휴식 이행(생성응답==목록)");

    // 3) 다음 주차 → 승인
    const nxtRes = await post(found.nxt.weekId, "http-다음");
    const nxtJson = await nxtRes.json();
    assert(nxtRes.ok && nxtJson.success, `POST next ${nxtRes.status} ${JSON.stringify(nxtJson).slice(0,160)}`);
    nxtId = nxtJson.request.id;
    assert(nxtJson.request.status === "approved", `다음 생성응답 status=${nxtJson.request.status} (approved 기대)`);
    ok("다음 주차 생성 응답 = 휴식 승인(approved)");
    const nxtList = await listStatusById(nxtId);
    assert(nxtList === "approved", `다음 목록 displayStatus=${nxtList} (approved 기대)`);
    ok("다음 주차 목록 displayStatus = 휴식 승인(생성응답==목록)");

    // 어떤 경우도 신청(pending) 아님
    assert(![curJson.request.status, nxtJson.request.status].includes("pending"), "pending 발생");
    ok("어떤 긴급 신청도 휴식 신청(pending) 아님");

    // 4) Po.C +2 원장(현재 행 기준)
    const { data: vr } = await supabaseAdmin.from("vacation_requests").select("po_c_act_id").eq("id", curId).maybeSingle();
    const actId = (vr as { po_c_act_id: string | null } | null)?.po_c_act_id ?? null;
    assert(actId, "po_c_act_id 미기록");
    const { data: awards } = await supabaseAdmin.from("process_point_awards").select("point_check,point_advantage,point_penalty").eq("source","irregular").eq("ref_id", actId);
    const rows = (awards ?? []) as Array<{ point_check: number; point_advantage: number; point_penalty: number }>;
    const pen = rows.reduce((s, r) => s + r.point_penalty, 0);
    const chk = rows.reduce((s, r) => s + r.point_check, 0);
    const adv = rows.reduce((s, r) => s + r.point_advantage, 0);
    assert(rows.length === 1 && pen === 2 && chk === 0 && adv === 0, `원장 rows=${rows.length} pen=${pen} chk=${chk} adv=${adv} (1/2/0/0 기대)`);
    ok("Po.C ×2 순수 패널티 원장 반영");

    // 5) 변동 액트 보드 숨김(현재 주차)
    const boardRes = await fetch(`${baseUrl}/api/admin/processes/check/irregular?org=${found.org}&mode=test&week=${found.cur.weekId}`, { headers: { Cookie: cookie } });
    const boardJson = await boardRes.json();
    assert(boardRes.ok && boardJson.success, `board ${boardRes.status}`);
    const onBoard = (boardJson.data.acts as Array<{ id: string }>).some((a) => a.id === actId);
    assert(!onBoard, "emergency 액트가 변동 액트 보드에 노출됨");
    ok("변동 액트 보드에서 긴급 휴식 액트 숨김");
  } finally {
    // 정리 — HTTP DELETE(Po.C 회수 포함)
    for (const id of [curId, nxtId].filter(Boolean)) {
      const d = await fetch(`${baseUrl}/api/admin/rest-management/${id}`, { method: "DELETE", headers: { Cookie: cookie } });
      const dj = await d.json().catch(() => ({}));
      console.log(`  cleanup DELETE ${id}: ${d.status} ${dj.success ? "ok" : dj.error ?? ""}`);
    }
  }

  console.log(`\n✅ ALL PASS (${pass}) — 긴급 휴식 HTTP 검증`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
