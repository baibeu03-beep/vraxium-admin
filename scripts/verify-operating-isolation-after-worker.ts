/**
 * 검증(DB + HTTP 동시): test worker 완료가 operating 데이터/보드에 누수 없음.
 *   실행: npx tsx --env-file=.env.local scripts/verify-operating-isolation-after-worker.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { resolveProcessWeek } from "@/lib/adminProcessCheckData";

const BASE = "http://localhost:3000";
const EMAIL = "vanuatu.golden@gmail.com";
const ORG = "encre", HUB = "experience";
const ROW_ID = "c1702443-eff8-42be-b599-2315c311e2fe";
const ACT_ID = "86d67cb2-d46d-408b-ae9a-2970706d7531";
const TEAM_ID = "ad6304ba-c566-445a-afd6-1b1bb8939925";
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!, ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cookie() {
  const sb = createClient(URL, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const brow = createClient(URL, ANON);
  const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const s = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) } });
  await s.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  const wTest = await resolveProcessWeek("test", "process-experience");
  const wOp = await resolveProcessWeek("operating", "process-experience");
  const cookieHdr = await cookie();
  const api = async (path: string) => {
    const res = await fetch(`${BASE}${path}`, { headers: { cookie: cookieHdr } });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  // ── 5. week_id 분리 ──
  console.log("── 5. test/operating 주차 분리 ──");
  ck("test=W13 · operating=W16 · 서로 다른 weekId", !!wTest?.weekId && !!wOp?.weekId && wTest!.weekId !== wOp!.weekId,
    `test=${wTest?.weekId} op=${wOp?.weekId}`);

  // ── 1. 처리한 행 = encre/experience/test/W13 ──
  console.log("── 1. DB: 처리한 행 정체 ──");
  const { data: row } = await supabaseAdmin.from("process_check_statuses")
    .select("organization_slug,hub,scope_mode,week_id,act_id,status,checked_crew_count").eq("id", ROW_ID).single();
  const r = row as any;
  ck("[DB] org=encre·hub=experience·scope_mode=test·week_id=W13",
    r?.organization_slug === ORG && r?.hub === HUB && r?.scope_mode === "test" && r?.week_id === wTest?.weekId,
    `org=${r?.organization_slug} hub=${r?.hub} sm=${r?.scope_mode} w=${r?.week_id === wTest?.weekId ? "W13" : r?.week_id}`);
  ck("[DB] 그 행 status=completed · cc=0", r?.status === "completed" && r?.checked_crew_count === 0);

  // ── 2/3. 동일 act_id 의 operating(W16) 행 존재/영향 ──
  console.log("── 2·3. DB: 동일 act_id operating 행 ──");
  const { data: sameAct } = await supabaseAdmin.from("process_check_statuses")
    .select("id,scope_mode,week_id,status,checked_crew_count,scheduled_check_at,completed_at,last_attempt_at")
    .eq("organization_slug", ORG).eq("hub", HUB).eq("act_id", ACT_ID);
  const rows = (sameAct ?? []) as any[];
  const opRows = rows.filter((x) => x.scope_mode === "operating" || x.week_id === wOp?.weekId);
  ck("[DB] act_id 행 전체 = test 1건만(별도 operating 행 없음)",
    rows.length === 1 && rows[0].id === ROW_ID && opRows.length === 0,
    `total=${rows.length} opRows=${opRows.length}`);
  console.log("    → operating(W16) 행이 애초에 없음 ⇒ worker 가 변경할 operating 데이터 자체가 없음(변경 0).");
  // (만약 존재했다면 그 값을 출력)
  for (const o of opRows) console.log(`    operating row: ${JSON.stringify(o)}`);

  // worker 가 onlyIds=[test row] 로만 처리했음을 재확인 — encre/experience 완료행은 test 1건뿐.
  const { data: completedRows } = await supabaseAdmin.from("process_check_statuses")
    .select("id,scope_mode,week_id").eq("organization_slug", ORG).eq("hub", HUB).eq("status", "completed");
  const comp = (completedRows ?? []) as any[];
  ck("[DB] encre/experience completed 행 = test/W13 1건뿐(operating 완료 0)",
    comp.length === 1 && comp[0].id === ROW_ID && comp.every((c) => c.scope_mode === "test" && c.week_id === wTest?.weekId),
    `completed=${comp.length}`);

  // ── 4. operating 보드(HTTP)에서 해당 액트가 완료로 안 보임 ──
  console.log("── 4. HTTP: operating 보드 누수 없음 ──");
  const opBoard = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}&team=${TEAM_ID}&scope=team_all&mode=operating`);
  const opAct = (opBoard.json.data?.acts ?? []).find((a: any) => a.actId === ACT_ID);
  ck("[HTTP] operating 보드 200 + weekId=W16", opBoard.status === 200 && opBoard.json.data?.week?.weekId === wOp?.weekId,
    `week=${opBoard.json.data?.week?.weekId === wOp?.weekId ? "W16" : opBoard.json.data?.week?.weekId}`);
  ck("[HTTP] operating 보드의 해당 액트 status≠completed(기존 needed)",
    !!opAct && opAct.status !== "completed",
    `status=${opAct?.status} cc=${opAct?.checkedCrewCount} resolution=${opAct?.reviewerDebug?.resolutionStatus}`);

  // test 보드(HTTP)에서는 완료로 보임 — 대조.
  const testBoard = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}&team=${TEAM_ID}&scope=team_all&mode=test`);
  const testAct = (testBoard.json.data?.acts ?? []).find((a: any) => a.actId === ACT_ID);
  ck("[HTTP] test 보드의 해당 액트 status=completed·cc=0 (대조)",
    testBoard.json.data?.week?.weekId === wTest?.weekId && testAct?.status === "completed" && testAct?.checkedCrewCount === 0,
    `status=${testAct?.status}`);
  ck("[HTTP] 동일 act_id 가 보드별로 분리(operating≠test 상태)",
    opAct?.status !== testAct?.status, `op=${opAct?.status} vs test=${testAct?.status}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
