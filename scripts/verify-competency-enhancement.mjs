// 실무 역량 강화 결과 정책 검증 — 승인자=성공, 반려자=실패, 미신청자=실패(분모=활동 크루).
// 실제 oranke 활동 크루 3명(A승인·B반려·C승인) 신청 → 개설 → 집계 확인 → 취소 원복, 정리(net-zero).
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
const ORG = "oranke", TAG = "ZZ-enh";
const J = (o) => JSON.stringify(o);
const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: "vanuatu.golden@gmail.com" });
const { data: v } = await brow.auth.verifyOtp({ email: "vanuatu.golden@gmail.com", token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");
const httpData = async () => (await (await fetch(`${BASE}/api/admin/cluster4/competency/applications?organization=${ORG}`, { headers: { cookie } })).json()).data;
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
async function cleanup() {
  const rows = (await sb.from("cluster4_competency_applications").select("opened_line_id").eq("organization_slug", ORG).like("line_name", `${TAG}%`)).data ?? [];
  const lids = rows.map((x) => x.opened_line_id).filter(Boolean);
  if (lids.length) { await sb.from("cluster4_line_targets").delete().in("line_id", lids); await sb.from("cluster4_lines").delete().in("id", lids); }
  await sb.from("cluster4_competency_applications").delete().eq("organization_slug", ORG).like("line_name", `${TAG}%`);
}
try {
  await cleanup();
  const weekId = (await httpData()).weekId;
  const tm = new Set((await sb.from("test_user_markers").select("user_id")).data.map((x) => x.user_id));
  const crews = ((await (await fetch(`${BASE}/api/admin/cluster4/crews?organization=${ORG}&status=active`, { headers: { cookie } })).json()).data ?? []).filter((c) => !tm.has(c.userId));
  const master = (await sb.from("cluster4_competency_line_masters").select("id,line_code").eq("line_code", "CPBS-NN0001").maybeSingle()).data;
  const [A, B, C] = crews;
  const base = (await httpData()).summary;
  console.log(`활동 크루(active)=${base.activeCrews} | 시나리오: A=${A.displayName}(승인) B=${B.displayName}(반려) C=${C.displayName}(승인) + 나머지 미신청`);

  // 신청 삽입: A,C 승인(approval=true), B 반려(approval=false)
  await sb.from("cluster4_competency_applications").insert([
    { organization_slug: ORG, week_id: weekId, target_user_id: A.userId, line_name: `${TAG}-A`, source: "customer", competency_line_master_id: master.id, submission_link: "https://e.x/a", approval_checked: true },
    { organization_slug: ORG, week_id: weekId, target_user_id: B.userId, line_name: `${TAG}-B`, source: "customer", competency_line_master_id: master.id, submission_link: "https://e.x/b", approval_checked: false },
    { organization_slug: ORG, week_id: weekId, target_user_id: C.userId, line_name: `${TAG}-C`, source: "customer", competency_line_master_id: master.id, submission_link: "https://e.x/c", approval_checked: true },
  ]);
  const sPre = (await httpData()).summary;
  ck("[개설 전] 신청 3 · 강화성공 0(개설 전) · 강화실패=활동크루(전원 미개설)",
    sPre.appliedCrews === 3 && sPre.enhanceSuccess === 0 && sPre.enhanceFail === base.activeCrews,
    J({ 신청: sPre.appliedCrews, 성공: sPre.enhanceSuccess, 실패: sPre.enhanceFail }));

  // 개설 완료 (UI 버튼과 동일 API)
  await (await fetch(`${BASE}/api/admin/cluster4/competency/opening`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ action: "open", organization: ORG, output_link_1: "https://e.x/cafe", output_description: "공통" }) })).json();
  const s = (await httpData()).summary;

  // direct(DB) 재계산
  const dRows = (await sb.from("cluster4_competency_applications").select("target_user_id,resolution").eq("organization_slug", ORG).like("line_name", `${TAG}%`)).data ?? [];
  const activeIds = new Set(crews.map((c) => c.userId));
  const dOpenedActive = new Set(dRows.filter((x) => x.resolution === "opened" && activeIds.has(x.target_user_id)).map((x) => x.target_user_id));
  const dSuccess = dOpenedActive.size, dFail = base.activeCrews - dSuccess;

  console.log(`[개설 후] HTTP summary=${J({ 활동: s.activeCrews, 개설크루: s.openedCrews, 반려크루: s.rejectedCrews, 강화성공: s.enhanceSuccess, 강화실패: s.enhanceFail })}`);
  ck("[검증3] 승인자(A,C) 강화 성공 처리 — enhanceSuccess=2", s.enhanceSuccess === 2);
  ck("[검증4] 반려자(B) 강화 실패 — 성공에 미포함 + rejectedCrews=1", s.enhanceSuccess === 2 && s.rejectedCrews === 1);
  ck("[검증5] 미신청자 강화 실패 — enhanceFail=활동−성공 이고 반려수보다 큼(미신청 포함)",
    s.enhanceFail === base.activeCrews - 2 && s.enhanceFail > s.rejectedCrews, J({ 강화실패: s.enhanceFail, 반려: s.rejectedCrews, 활동: base.activeCrews }));
  ck("[검증1·2] direct(DB 재계산) == HTTP 응답", dSuccess === s.enhanceSuccess && dFail === s.enhanceFail, `direct=${dSuccess}/${dFail} http=${s.enhanceSuccess}/${s.enhanceFail}`);
  ck("[정책] 성공 + 실패 == 활동 크루(분모)", s.enhanceSuccess + s.enhanceFail === s.activeCrews, `${s.enhanceSuccess}+${s.enhanceFail}=${s.activeCrews}`);

  // [검증7] 고객 반영: A,C 라인 타깃 생성 / B 미생성
  const opened = (await sb.from("cluster4_competency_applications").select("target_user_id,opened_line_id,resolution").eq("organization_slug", ORG).like("line_name", `${TAG}%`)).data ?? [];
  const aLine = opened.find((x) => x.target_user_id === A.userId);
  const bRow = opened.find((x) => x.target_user_id === B.userId);
  const aTgt = aLine?.opened_line_id ? ((await sb.from("cluster4_line_targets").select("id").eq("line_id", aLine.opened_line_id)).data ?? []).length : 0;
  ck("[검증7] 고객 반영 — 승인자 A 라인/타깃 생성 / 반려자 B 라인 미생성",
    aLine?.resolution === "opened" && aTgt === 1 && bRow?.resolution === "rejected" && !bRow?.opened_line_id);

  // [검증6] 라인 관리 탭(Cluster4LineTable) — lines detailed 에 A,C 라인 노출(per-target 강화 상태)
  const linesJson = await (await fetch(`${BASE}/api/admin/cluster4/lines?partType=competency&detailed=1&organization=${ORG}&limit=500`, { headers: { cookie } })).json();
  const myLines = (linesJson.data?.rows ?? []).filter((x) => [aLine?.opened_line_id, opened.find((o) => o.target_user_id === C.userId)?.opened_line_id].includes(x.id));
  ck("[검증6] 라인 관리 탭 lines 에 개설 라인(A,C) 노출 — per-target 강화 상태(미신청은 라인 타깃 아님)", myLines.length === 2, `노출 라인=${myLines.length}`);

  // 개설 취소 → 원복
  await (await fetch(`${BASE}/api/admin/cluster4/competency/opening`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ action: "cancel", organization: ORG }) })).json();
  const sc = (await httpData()).summary;
  ck("[취소] 원복 — 강화성공 0 · 강화실패=활동크루 · 개설크루 0", sc.enhanceSuccess === 0 && sc.enhanceFail === base.activeCrews && sc.openedCrews === 0);
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); console.log("(cleanup 완료 — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }
