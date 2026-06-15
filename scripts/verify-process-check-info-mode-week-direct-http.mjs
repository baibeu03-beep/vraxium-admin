// 프로세스 체크 · info — 테스트/운영 모드 주차 분리(13주차 예외) direct==HTTP 검증.
//   operating GET → 현재 주차(W16·휴식) · test GET → 마지막 운영 주차(W13).
//   test request 저장 주차 = W13(직접 DB 확인) · operating 보드엔 미노출(주차 분리) ·
//   org 분리 · 다른 허브(club)는 test 예외 미적용(현재 주차 유지) · cleanup net-zero.
// 전제: dev 서버 + 2026-06-12_process_check_v2.sql 적용.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const r = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"));
const { createClient } = r("@supabase/supabase-js");
const { createServerClient } = r("@supabase/ssr");
const env = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL, SERVICE), brow = createClient(URL, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
const HUB = "info", ORG = "oranke", TAG = "ZZ-pchk-mode";
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

async function cleanup() {
  const g = (await sb.from("process_line_groups").select("id").eq("hub", HUB).like("name", `${TAG}%`)).data ?? [];
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

try {
  const probe = await sb.from("process_check_statuses").select("week_id").limit(1);
  if (probe.error) { console.log(`⚠ v2 미적용(${probe.error.code}) — 적용 후 재실행`); process.exit(2); }

  // 기대 주차(weeks) — 현재 주차 W16(휴식) vs 마지막 운영 W13.
  const wk = (n) => (sb.from("weeks").select("id,week_number").eq("season_key", "2026-spring").eq("week_number", n).maybeSingle());
  const w16 = (await wk(16)).data, w13 = (await wk(13)).data;
  ck("[전제] weeks W16/W13 존재", !!w16?.id && !!w13?.id, J({ w16: w16?.week_number, w13: w13?.week_number }));

  await cleanup();
  const cg = await api("/api/admin/processes/line-groups", { method: "POST", body: J({ hub: HUB, name: `${TAG} 라인급` }) });
  const groupId = cg.json.data?.id;
  const a1 = (await api("/api/admin/processes/acts", { method: "POST", body: J({
    line_group_id: groupId, hub: HUB, act_name: `${TAG} 대상1`, duration_minutes: 10,
    occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00",
    point_check: 1, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "required",
    overview: null, remarks: null,
  }) })).json.data;
  ck("[시드] 라인급 + 체크대상 액트", !!groupId && !!a1?.id);

  // ── 1. operating GET → 현재 주차(W16) ──
  const bOp = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}`);
  ck("[운영] GET 200 · weekNumber=16(현재 주차) · weekId=W16", bOp.status === 200 && bOp.json.data?.week?.weekNumber === 16 && bOp.json.data?.week?.weekId === w16.id, `wn=${bOp.json.data?.week?.weekNumber}`);

  // ── 2. test GET → 마지막 운영 주차(W13) ──
  const bTe = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}&mode=test`);
  ck("[테스트] GET 200 · weekNumber=13(13주차 예외) · weekId=W13", bTe.status === 200 && bTe.json.data?.week?.weekNumber === 13 && bTe.json.data?.week?.weekId === w13.id, `wn=${bTe.json.data?.week?.weekNumber}`);

  // ── 3. 다른 허브(club)는 test 예외 미적용 → 현재 주차(W16) 유지 ──
  const bClub = await api(`/api/admin/processes/check?hub=club&org=${ORG}&mode=test`);
  ck("[격리] club test → weekNumber=16(예외 미적용)", bClub.status === 200 && bClub.json.data?.week?.weekNumber === 16, `wn=${bClub.json.data?.week?.weekNumber}`);

  // ── 4. test request → W13 에 저장(직접 DB 확인) ──
  const schedIso = new Date(Date.now() + DAY).toISOString();
  const req = await api("/api/admin/processes/check", { method: "POST", body: J({ hub: HUB, organization: ORG, act_id: a1.id, action: "request", mode: "test", review_link: "https://cafe.naver.com/test/13", scheduled_check_at: schedIso }) });
  ck("[테스트 신청] 201 → pending", req.status === 201 && req.json.data?.status === "pending", `status=${req.status}`);
  const rowT = (await sb.from("process_check_statuses").select("week_id,status").eq("organization_slug", ORG).eq("hub", HUB).eq("act_id", a1.id).eq("week_id", w13.id).maybeSingle()).data;
  ck("[direct DB] test 저장 주차 = W13", rowT?.week_id === w13.id && rowT?.status === "pending", J({ wk: rowT?.week_id === w13.id }));

  // ── 5. test 보드엔 pending, operating 보드엔 needed(주차 분리) ──
  const bTe2 = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}&mode=test`);
  const bOp2 = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}`);
  ck("[분리] test 보드 a1=pending", findAct(bTe2.json.data, a1.id)?.status === "pending");
  ck("[분리] operating 보드 a1=needed(W16·미노출)", findAct(bOp2.json.data, a1.id)?.status === "needed");
  // direct==HTTP (test 보드 a1 == DB)
  ck("[direct==HTTP] test 보드 a1.reviewLink == DB", findAct(bTe2.json.data, a1.id)?.reviewLink === "https://cafe.naver.com/test/13");

  // ── 6. org 분리 — test write(oranke)는 encre test 보드에 미노출 ──
  const bEnc = await api(`/api/admin/processes/check?hub=${HUB}&org=encre&mode=test`);
  ck("[org분리] encre test a1=needed", findAct(bEnc.json.data, a1.id)?.status === "needed");

  // ── 7. operating request → W16 에 저장(test 저장과 분리 공존) ──
  const reqOp = await api("/api/admin/processes/check", { method: "POST", body: J({ hub: HUB, organization: ORG, act_id: a1.id, action: "request", review_link: "https://cafe.naver.com/op/16", scheduled_check_at: schedIso }) });
  ck("[운영 신청] 201 → pending(W16)", reqOp.status === 201 && reqOp.json.data?.status === "pending");
  const rowO = (await sb.from("process_check_statuses").select("week_id").eq("organization_slug", ORG).eq("hub", HUB).eq("act_id", a1.id).eq("week_id", w16.id).maybeSingle()).data;
  ck("[direct DB] operating 저장 주차 = W16(W13 행과 공존)", rowO?.week_id === w16.id);
  const rowsBoth = (await sb.from("process_check_statuses").select("week_id").eq("organization_slug", ORG).eq("hub", HUB).eq("act_id", a1.id)).data ?? [];
  ck("[공존] 같은 act 에 W13·W16 2행", rowsBoth.length === 2 && rowsBoth.some((x) => x.week_id === w13.id) && rowsBoth.some((x) => x.week_id === w16.id), `rows=${rowsBoth.length}`);
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); console.log("(cleanup — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }
