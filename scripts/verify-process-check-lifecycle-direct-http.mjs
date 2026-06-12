// 프로세스 체크 동작 Phase — direct==HTTP 라이프사이클 검증.
//   board(현재주·acts·상태·로그) · request/cancel 전이 · 검수시점 검증(now·+7d) · 완료 표시(직접 시드) ·
//   org 분기 · direct==HTTP. 전제: dev 서버 + 2026-06-12_process_check_v2.sql 적용. net-zero(TAG 정리).
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
const HUB = "info", ORG = "oranke", TAG = "ZZ-pchk-life";
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
  // ── 스키마 게이트 — v2 적용 여부 확인 ──
  const probe = await sb.from("process_check_statuses").select("review_link,scheduled_check_at,checked_crew_count").limit(1);
  if (probe.error) {
    console.log(`⚠ v2 스키마 미적용(${probe.error.code}): ${probe.error.message}`);
    console.log("→ db/migrations/2026-06-12_process_check_v2.sql 적용(+NOTIFY) 후 재실행하세요.");
    process.exit(2);
  }

  await cleanup();

  const cg = await api("/api/admin/processes/line-groups", { method: "POST", body: J({ hub: HUB, name: `${TAG} 라인급` }) });
  const groupId = cg.json.data?.id;
  const mk = (name, target) => ({
    line_group_id: groupId, hub: HUB, act_name: `${TAG} ${name}`, duration_minutes: 10,
    occur_week: "N", occur_dow: 2, occur_time: "06:30", check_week: "N", check_dow: 3, check_time: "21:00",
    point_check: 1, point_advantage: 0, point_penalty: 0, cafe: "occur", check_target: target, act_type: "required",
    overview: null, remarks: null,
  });
  const a1 = (await api("/api/admin/processes/acts", { method: "POST", body: J(mk("대상1", "check")) })).json.data;
  const a2 = (await api("/api/admin/processes/acts", { method: "POST", body: J(mk("대상2", "check")) })).json.data;
  ck("시드 — 라인급1 + 체크대상2", !!groupId && a1?.id && a2?.id);

  // 보드 baseline.
  const b0 = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}`);
  ck("[HTTP] GET 보드 200 + week + acts", b0.status === 200 && b0.json.success && !!b0.json.data?.week && Array.isArray(b0.json.data?.acts), `status=${b0.status}`);
  const weekId = b0.json.data?.week?.weekId;
  ck("[주차] weekId 존재", !!weekId, weekId ?? "null");
  ck("[상태] 시드 직후 a1=needed · 실제시점 null", findAct(b0.json.data, a1.id)?.status === "needed" && findAct(b0.json.data, a1.id)?.requestedAt === null && findAct(b0.json.data, a1.id)?.scheduledCheckAt === null);

  const act = (id, action, extra = {}) => api("/api/admin/processes/check", { method: "POST", body: J({ hub: HUB, organization: ORG, act_id: id, action, ...extra }) });
  const iso = (ms) => new Date(ms).toISOString();

  // 검수 시점/링크 검증.
  const past = await act(a1.id, "request", { review_link: "https://cafe.naver.com/x/1", scheduled_check_at: iso(Date.now() - 3600_000) });
  ck("[검증] 검수 시점 과거 → 400", past.status === 400, past.json.error);
  const far = await act(a1.id, "request", { review_link: "https://cafe.naver.com/x/1", scheduled_check_at: iso(Date.now() + 8 * DAY) });
  ck("[검증] 검수 시점 +8일(>7) → 400", far.status === 400, far.json.error);
  const badlink = await act(a1.id, "request", { review_link: "not-a-url", scheduled_check_at: iso(Date.now() + DAY) });
  ck("[검증] 잘못된 검수 링크 → 400", badlink.status === 400, badlink.json.error);

  // 정상 신청 — a1.
  const schedIso = iso(Date.now() + DAY);
  const req = await act(a1.id, "request", { review_link: "https://cafe.naver.com/test/123", scheduled_check_at: schedIso });
  ck("[신청] a1 request 201 → pending", req.status === 201 && req.json.data?.status === "pending", `status=${req.status}`);
  // 중복 신청 409.
  const reqdup = await act(a1.id, "request", { review_link: "https://cafe.naver.com/test/123", scheduled_check_at: schedIso });
  ck("[가드] pending 재신청 409", reqdup.status === 409);

  // 보드 반영 + direct==HTTP.
  const b1 = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}`);
  const a1h = findAct(b1.json.data, a1.id);
  ck("[보드] a1 pending · reviewLink · 실제 시점(발생=신청, 체크=검수예정) 채움", a1h?.status === "pending" && a1h?.reviewLink === "https://cafe.naver.com/test/123" && !!a1h?.requestedAt && !!a1h?.scheduledCheckAt);
  const a1d = (await sb.from("process_check_statuses").select("status,review_link,scheduled_check_at,requested_at,requested_by").eq("organization_slug", ORG).eq("hub", HUB).eq("week_id", weekId).eq("act_id", a1.id).maybeSingle()).data;
  ck("[검증] direct(DB) == HTTP (status·link·scheduled)", a1d?.status === "pending" && a1d?.review_link === a1h?.reviewLink && new Date(a1d?.scheduled_check_at).toISOString() === new Date(a1h?.scheduledCheckAt).toISOString() && !!a1d?.requested_by, J({ d: a1d?.status, h: a1h?.status }));
  ck("[요약] actApplied 반영(≥1)", (b1.json.data?.summary?.actApplied ?? 0) >= 1);

  // 취소 — a1(now < scheduled).
  const cancel = await act(a1.id, "cancel");
  ck("[취소] a1 cancel 201 → needed", cancel.status === 201 && cancel.json.data?.status === "needed");
  const b2 = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}`);
  const a1c = findAct(b2.json.data, a1.id);
  ck("[취소] needed · 실제 시점/링크 제거(빈칸)", a1c?.status === "needed" && a1c?.reviewLink === null && a1c?.requestedAt === null && a1c?.scheduledCheckAt === null);

  // 취소 불가(검수 시점 지남) — a2 에 pending(scheduled 과거) 직접 시드 후 cancel.
  await sb.from("process_check_statuses").insert({ organization_slug: ORG, hub: HUB, week_id: weekId, line_group_id: groupId, act_id: a2.id, status: "pending", review_link: "https://cafe.naver.com/x/9", scheduled_check_at: iso(Date.now() - 3600_000), requested_at: iso(Date.now() - 2 * 3600_000) });
  const lateCancel = await act(a2.id, "cancel");
  ck("[가드] 검수 시점 지난 pending 취소 → 409", lateCancel.status === 409, lateCancel.json.error);

  // 완료 표시 — a2 를 completed 로 직접 전환(미래 크롤링 시뮬). 보드/팝업 데이터 노출 확인.
  await sb.from("process_check_statuses").update({ status: "completed", completed_at: iso(Date.now()), checked_crew_count: 5 }).eq("organization_slug", ORG).eq("hub", HUB).eq("week_id", weekId).eq("act_id", a2.id);
  const b3 = await api(`/api/admin/processes/check?hub=${HUB}&org=${ORG}`);
  const a2h = findAct(b3.json.data, a2.id);
  ck("[완료] a2 completed · checkedCrewCount=5 · completedAt", a2h?.status === "completed" && a2h?.checkedCrewCount === 5 && !!a2h?.completedAt);
  // 완료 후 취소 409.
  const compCancel = await act(a2.id, "cancel");
  ck("[가드] completed 취소 → 409", compCancel.status === 409);

  // 로그 — a1 request→cancel 2건(위=과거/아래=최신), 표시 필드.
  const myLogs = (b3.json.data?.logs ?? []).filter((l) => l.actName?.startsWith(TAG));
  const a1logs = myLogs.filter((l) => l.actName.endsWith("대상1")).map((l) => l.action);
  ck("[로그] a1 순서 = check_requested → check_cancelled", J(a1logs) === J(["check_requested", "check_cancelled"]), J(a1logs));
  ck("[로그] period_label '26년 …시즌 N주차'(콤마 없음) · 필드 채움", myLogs.length > 0 && myLogs.every((l) => /^\d{2}년 .+시즌 \d+주차$/.test(l.periodLabel) && l.lineGroupName && l.actName && l.actorName));

  // org 분기 — encre 보드 a1 needed(org별 상태).
  const bEnc = await api(`/api/admin/processes/check?hub=${HUB}&org=encre`);
  ck("[org분기] encre a1 = needed(상태 org별)", findAct(bEnc.json.data, a1.id)?.status === "needed");

  // 잘못된 입력.
  const badOrg = await api(`/api/admin/processes/check?hub=${HUB}&org=nope`);
  ck("[검증] 잘못된 org GET 400", badOrg.status === 400);
  const badAct = await act("not-a-uuid", "request", { review_link: "https://cafe.naver.com/x/1", scheduled_check_at: iso(Date.now() + DAY) });
  ck("[검증] 없는 act_id → 404/400", badAct.status === 404 || badAct.status === 400, `status=${badAct.status}`);
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); console.log("(cleanup 완료 — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }
