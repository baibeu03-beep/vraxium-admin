// 프로세스 체크 · competency/career — 테스트 모드 W13 예외 HTTP 검증(2026-06-17).
//   operating GET → 현재 주차(W16·휴식) · test GET → 마지막 활동 주차(W13).
//   test request 저장 주차 = W13(직접 DB 확인) · operating 보드엔 미노출(주차 분리) ·
//   club 도 test W13 예외 적용(2026-06-17 신규 허용) · direct(스냅샷)==HTTP 주차 일치 · cleanup net-zero.
// 전제: dev 서버(:3000) + 2026-06-12_process_check_v2.sql 적용 +
//        먼저 verify-process-check-club-competency-direct.ts 실행(direct 스냅샷 생성).
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const r = createRequire(resolve(here, "..", "package.json"));
const { createClient } = r("@supabase/supabase-js");
const { createServerClient } = r("@supabase/ssr");
const env = readFileSync(resolve(here, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL, SERVICE), brow = createClient(URL, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
const ORG = "oranke", TAG = "ZZ-pchk-w13";
const J = (o) => JSON.stringify(o);
const DAY = 86_400_000;

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) } });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const findAct = (board, id) => (board.acts ?? []).find((a) => a.actId === id) ?? null;

async function cleanupHub(hub) {
  const g = (await sb.from("process_line_groups").select("id").eq("hub", hub).like("name", `${TAG}%`)).data ?? [];
  const ids = g.map((x) => x.id);
  if (ids.length) {
    const acts = (await sb.from("process_acts").select("id").in("line_group_id", ids)).data ?? [];
    const actIds = acts.map((x) => x.id);
    if (actIds.length) {
      await sb.from("process_check_logs").delete().in("act_id", actIds);
      await sb.from("process_check_statuses").delete().in("act_id", actIds);
      await sb.from("process_acts").delete().in("id", actIds);
    }
    await sb.from("process_line_groups").delete().in("id", ids);
  }
}
async function cleanup() { for (const h of ["competency", "career"]) await cleanupHub(h); }

async function seedAct(hub) {
  const cg = await api("/api/admin/processes/line-groups", { method: "POST", body: J({ hub, name: `${TAG} 라인급` }) });
  const groupId = cg.json.data?.id;
  const a1 = (await api("/api/admin/processes/acts", { method: "POST", body: J({
    line_group_id: groupId, hub, act_name: `${TAG} 대상1`, duration_minutes: 10,
    occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00",
    point_check: 1, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "required",
    overview: null, remarks: null,
  }) })).json.data;
  return { groupId, a1 };
}

try {
  const probe = await sb.from("process_check_statuses").select("week_id").limit(1);
  if (probe.error) { console.log(`⚠ v2 미적용(${probe.error.code}) — 적용 후 재실행`); process.exit(2); }

  // direct 스냅샷(앞서 생성) — direct==HTTP 비교용.
  const snapPath = resolve(here, "..", "claudedocs", "verify-process-check-hub-direct.json");
  const direct = existsSync(snapPath) ? JSON.parse(readFileSync(snapPath, "utf8")) : null;
  ck("[전제] direct 스냅샷 존재(competency direct 함수 결과)", !!direct?.competency, snapPath);

  const wk = (n) => (sb.from("weeks").select("id,week_number").eq("season_key", "2026-spring").eq("week_number", n).maybeSingle());
  const w16 = (await wk(16)).data, w13 = (await wk(13)).data;
  ck("[전제] weeks W16/W13 존재", !!w16?.id && !!w13?.id, J({ w16: w16?.week_number, w13: w13?.week_number }));

  await cleanup();

  for (const HUB of ["competency", "career"]) {
    console.log(`\n── 허브: ${HUB} ───────────────────────────────`);
    const { groupId, a1 } = await seedAct(HUB);
    ck(`[시드/${HUB}] 라인급 + 체크대상 액트`, !!groupId && !!a1?.id);

    // 1. operating GET → 현재 주차(W16) — 운영 모드 W13 변경 불가(현재 주차 유지).
    const bOp = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}`);
    ck(`[운영/${HUB}] GET 200 · weekNumber=16 · weekId=W16`, bOp.status === 200 && bOp.json.data?.week?.weekNumber === 16 && bOp.json.data?.week?.weekId === w16.id, `wn=${bOp.json.data?.week?.weekNumber}`);

    // 2. test GET → W13(13주차 예외) — 변경 가능 주차.
    const bTe = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}&mode=test`);
    ck(`[테스트/${HUB}] GET 200 · weekNumber=13 · weekId=W13`, bTe.status === 200 && bTe.json.data?.week?.weekNumber === 13 && bTe.json.data?.week?.weekId === w13.id, `wn=${bTe.json.data?.week?.weekNumber}`);
    ck(`[테스트/${HUB}] week.editable=true(W13 변경 가능)`, bTe.json.data?.week?.editable === true);

    // 3. direct==HTTP — direct 함수 주차(competency 만 스냅샷 보유)와 HTTP 주차 일치.
    if (HUB === "competency" && direct?.competency) {
      ck(`[direct==HTTP/${HUB}] operating 주차 일치`, direct.competency.operating.weekNumber === bOp.json.data?.week?.weekNumber, `direct=${direct.competency.operating.weekNumber} http=${bOp.json.data?.week?.weekNumber}`);
      ck(`[direct==HTTP/${HUB}] test 주차 일치`, direct.competency.test.weekNumber === bTe.json.data?.week?.weekNumber, `direct=${direct.competency.test.weekNumber} http=${bTe.json.data?.week?.weekNumber}`);
    }

    // 4. test request → W13 저장(직접 DB 확인) — 일반 test user 경로(GET)와 동일 주차 SoT.
    const schedIso = new Date(Date.now() + DAY).toISOString();
    const req = await api("/api/admin/processes/check", { method: "POST", body: J({ hub: HUB, organization: ORG, act_id: a1.id, action: "request", mode: "test", review_link: `https://cafe.naver.com/test/${HUB}13`, scheduled_check_at: schedIso }) });
    ck(`[테스트 신청/${HUB}] 201 → pending`, req.status === 201 && req.json.data?.status === "pending", `status=${req.status}`);
    const rowT = (await sb.from("process_check_statuses").select("week_id,status").eq("organization_slug", ORG).eq("hub", HUB).eq("act_id", a1.id).eq("week_id", w13.id).maybeSingle()).data;
    ck(`[direct DB/${HUB}] test 저장 주차 = W13`, rowT?.week_id === w13.id && rowT?.status === "pending");

    // 5. 주차 분리 — test 보드 pending, operating 보드 needed(W16·미노출).
    const bTe2 = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}&mode=test`);
    const bOp2 = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}`);
    ck(`[분리/${HUB}] test 보드 a1=pending`, findAct(bTe2.json.data, a1.id)?.status === "pending");
    ck(`[분리/${HUB}] operating 보드 a1=needed`, findAct(bOp2.json.data, a1.id)?.status === "needed");
    ck(`[direct==HTTP/${HUB}] test 보드 a1.reviewLink == 신청값`, findAct(bTe2.json.data, a1.id)?.reviewLink === `https://cafe.naver.com/test/${HUB}13`);
  }

  // 6. 모드 — club 도 test W13 예외 적용(2026-06-17 process-club 신규 허용) → 마지막 활동주차(W13).
  const bClub = await api(`/api/admin/processes/check?hub=club&org=${ORG}&mode=test`);
  ck("[모드] club test → weekNumber=13(2026-06-17 club W13 예외 허용)", bClub.status === 200 && bClub.json.data?.week?.weekNumber === 13, `wn=${bClub.json.data?.week?.weekNumber}`);
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); console.log("(cleanup — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }
