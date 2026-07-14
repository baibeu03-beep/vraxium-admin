/**
 * 프로세스 체크 보드 — 액트 "미가동(isOpenThisWeek=false)" 게이트 HTTP 검증 (dev server 필요).
 *
 *   1) 공용 판정 함수(weekOpenGate.isActOpenForWeek) 단위 검증 — open_confirmed·라인급 체크 규칙.
 *   2) HTTP GET /api/admin/processes/check?hub=club — 운영/테스트 모드 응답 구조 파리티 +
 *      모든 액트에 isOpenThisWeek(boolean) 존재 + 오픈 설정(DB) 기준 값 일치(HTTP가 SoT 소비 증명).
 *   3) HTTP POST(action=request) — 미가동 액트는 409 차단(운영/테스트 동일 status·message). 미가동
 *      액트는 write 전 거부되므로 DB 무변경(안전).
 *
 *   oranke = 오픈 설정 행 자체가 없어 전 club 액트가 미가동 → 엄격 SoT(open_confirmed=false) 결정적 검증.
 *
 *   npx tsx --env-file=.env.local scripts/verify-process-check-act-open-gate.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadWeekOpeningConfig } from "@/lib/adminTeamPartsInfoWeekDetailData";
import { isActOpenForWeek } from "@/lib/weekOpenGate";

const BASE = "http://localhost:3000";
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
  const email = (adm?.[0] as any)?.email;
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: Array<{ name: string; value: string }> = [];
  const sv = createServerClient(u, a, {
    cookies: { getAll: () => [], setAll: (it: any[]) => cap.push(...it.map(({ name, value }: any) => ({ name, value }))) },
  });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

const ACT_KEYS = [
  "actId","lineGroupId","lineGroupName","partLabel","actName","durationMinutes","occurWhen","checkWhen",
  "pointCheck","pointAdvantage","pointPenalty","actType","crewReactionLabel","cafeLabel","isCheckTarget",
  "isOpenThisWeek","checkStatusId","status","completionType","reviewLink","scheduledCheckAt","requestedAt",
  "completedAt","checkedCrewCount","completedCrewList","reviewerDebug",
].sort();

async function getBoard(cookie: string, org: string, mode: string) {
  const res = await fetch(`${BASE}/api/admin/processes/check?hub=club&org=${org}&mode=${mode}`, {
    headers: { cookie }, cache: "no-store",
  });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function postRequest(cookie: string, org: string, mode: string, weekId: string, actId: string) {
  const res = await fetch(`${BASE}/api/admin/processes/check`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      hub: "club", organization: org, act_id: actId, action: "request", mode, week: weekId,
      review_link: "https://cafe.naver.com/test/1",
      scheduled_check_at: new Date(Date.now() + 13 * 3600 * 1000).toISOString(),
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function main() {
  // ── 1) 공용 판정 함수 단위 검증 ──────────────────────────────────────────────
  const cfgChecked = { actCheck: { club: { LG: true } } } as any;
  const cfgUnchecked = { actCheck: { club: { LG: false } } } as any;
  ck("gate: open_confirmed=false → 미가동", isActOpenForWeek({ hub: "club", openConfirmed: false, config: cfgChecked, lineGroupId: "LG" }) === false);
  ck("gate: club 체크됨 → 가동", isActOpenForWeek({ hub: "club", openConfirmed: true, config: cfgChecked, lineGroupId: "LG" }) === true);
  ck("gate: club 미체크 → 미가동", isActOpenForWeek({ hub: "club", openConfirmed: true, config: cfgUnchecked, lineGroupId: "LG" }) === false);
  ck("gate: config 없음+확인됨 → 기본 가동", isActOpenForWeek({ hub: "club", openConfirmed: true, config: null, lineGroupId: "LG" }) === true);
  ck("gate: lineGroupId null → 미가동", isActOpenForWeek({ hub: "club", openConfirmed: true, config: null, lineGroupId: null }) === false);
  ck("gate: career(비게이트 허브) → 항상 가동", isActOpenForWeek({ hub: "career", openConfirmed: false, config: null, lineGroupId: null }) === true);

  const cookie = await cookieHeader();

  // ── 2) HTTP GET 파리티 — oranke(오픈 설정 없음 → 전 액트 미가동) ─────────────
  const org = "oranke";
  const [op, te] = await Promise.all([getBoard(cookie, org, "operating"), getBoard(cookie, org, "test")]);
  ck(`GET operating 200 (${org})`, op.status === 200, op.json?.error);
  ck(`GET test 200 (${org})`, te.status === 200, te.json?.error);

  const opActs = (op.json?.data?.acts ?? []) as any[];
  const teActs = (te.json?.data?.acts ?? []) as any[];
  ck("operating: 액트 목록 존재(목록 표시 유지)", opActs.length > 0, { count: opActs.length });
  ck("test: 액트 목록 존재(목록 표시 유지)", teActs.length > 0, { count: teActs.length });

  // 모든 액트에 isOpenThisWeek(boolean) — 운영/테스트 동일 DTO 구조.
  const allBool = (arr: any[]) => arr.every((x) => typeof x.isOpenThisWeek === "boolean");
  ck("operating: 전 액트 isOpenThisWeek boolean", allBool(opActs));
  ck("test: 전 액트 isOpenThisWeek boolean", allBool(teActs));

  // DTO 키 파리티(운영==테스트, 스펙 키 집합).
  const keysOf = (arr: any[]) => (arr[0] ? Object.keys(arr[0]).sort() : []);
  const opKeys = keysOf(opActs), teKeys = keysOf(teActs);
  ck("operating: 액트 DTO 키 == 스펙", JSON.stringify(opKeys) === JSON.stringify(ACT_KEYS), { missing: ACT_KEYS.filter((k) => !opKeys.includes(k)) });
  ck("운영/테스트 액트 DTO 키 동일", JSON.stringify(opKeys) === JSON.stringify(teKeys));

  // oranke = 오픈 설정 없음 → 전 액트 미가동 + 요약 집계 제외(actTotal=0).
  ck("operating: 전 액트 미가동(오픈 설정 없음)", opActs.every((x) => x.isOpenThisWeek === false));
  ck("test: 전 액트 미가동(오픈 설정 없음)", teActs.every((x) => x.isOpenThisWeek === false));
  ck("operating: 요약 actTotal=0(미가동 제외)", op.json?.data?.summary?.actTotal === 0, op.json?.data?.summary);
  ck("test: 요약 actTotal=0(미가동 제외)", te.json?.data?.summary?.actTotal === 0, te.json?.data?.summary);

  // HTTP DTO 값이 오픈 설정 SoT(DB)와 일치하는지 — 각 액트 재계산 비교(HTTP가 SoT 소비 증명).
  for (const [label, board] of [["operating", op], ["test", te]] as const) {
    const weekId = board.json?.data?.week?.weekId ?? board.json?.data?.selectedWeekId ?? null;
    if (!weekId) { ck(`${label}: 주차 식별`, false); continue; }
    const { config, openConfirmed } = await loadWeekOpeningConfig(weekId, org as any);
    const acts = (board.json?.data?.acts ?? []) as any[];
    const mismatch = acts.filter((x) => x.isOpenThisWeek !== isActOpenForWeek({ hub: "club", openConfirmed, config, lineGroupId: x.lineGroupId }));
    ck(`${label}: HTTP isOpenThisWeek == 오픈설정 SoT 재계산`, mismatch.length === 0, { weekId: String(weekId).slice(0, 8), openConfirmed, mismatch: mismatch.length });
  }

  // ── 3) HTTP POST(request) 차단 파리티 — 미가동 액트는 409 ────────────────────
  const results: Record<string, { status: number; error: string }> = {};
  for (const [label, board] of [["operating", op], ["test", te]] as const) {
    const data = board.json?.data;
    const weekId = data?.selectedWeekId ?? data?.week?.weekId ?? null;
    const cand = (data?.acts ?? []).find((x: any) => x.isCheckTarget && x.isOpenThisWeek === false);
    if (!data?.editable) { ck(`${label}: 차단 POST 스킵(주차 편집 불가)`, true, { editable: data?.editable }); continue; }
    if (!cand || !weekId) { ck(`${label}: 미가동 체크대상 액트 없음(스킵)`, true); continue; }
    const r = await postRequest(cookie, org, label, weekId, cand.actId);
    results[label] = { status: r.status, error: r.json?.error ?? "" };
    ck(`${label}: 미가동 액트 request → 409 차단`, r.status === 409, r.json);
    ck(`${label}: 차단 메시지에 '미가동' 포함`, String(r.json?.error ?? "").includes("미가동"));
  }
  if (results.operating && results.test) {
    ck("운영/테스트 차단 status 동일", results.operating.status === results.test.status, results);
    ck("운영/테스트 차단 message 동일", results.operating.error === results.test.error);
  }

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
