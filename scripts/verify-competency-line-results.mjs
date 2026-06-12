// 실무 역량 [라인 관리] 크루별 라인 개설 결과 표 — direct==HTTP 검증.
//   results: 활동 대상 크루 전원(미신청 포함). 성공=opened/pending(강화대기), 실패=rejected/미신청.
//   seed(service-role, TAG): A=opened B=rejected C=pending + 미신청 활동크루. net-zero 정리.
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
const EMAIL = "vanuatu.golden@gmail.com", ORG = "oranke", TAG = "ZZ-cres";
const J = (o) => JSON.stringify(o);

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");
const httpGet = async (weekId) =>
  (await (await fetch(`${BASE}/api/admin/cluster4/competency/applications?organization=${ORG}${weekId ? `&week_id=${weekId}` : ""}`, { headers: { cookie } })).json()).data;
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cleanup(weekId) {
  await sb.from("cluster4_competency_applications").delete().eq("organization_slug", ORG).eq("week_id", weekId).like("line_name", `${TAG}%`);
}

// 서버 getCompetencyLineResults 미러 (logic 필드: result/progressLine/applied/appliedAt).
async function directResults(weekId) {
  const apps = (await sb.from("cluster4_competency_applications").select("target_user_id,line_name,resolution,created_at").eq("organization_slug", ORG).eq("week_id", weekId).order("created_at", { ascending: true })).data ?? [];
  const testSet = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const crews = ((await (await fetch(`${BASE}/api/admin/cluster4/crews?organization=${ORG}&status=active`, { headers: { cookie } })).json()).data ?? []).filter((c) => !testSet.has(c.userId));
  const byUser = new Map();
  for (const a of apps) { const arr = byUser.get(a.target_user_id) ?? []; arr.push(a); byUser.set(a.target_user_id, arr); }
  return crews.map((c) => {
    const list = byUser.get(c.userId) ?? [];
    let progressLine = null, result = "fail", appliedAt = null;
    if (list.length) {
      const succ = list.find((a) => a.resolution === "opened") ?? list.find((a) => a.resolution === "pending");
      const rep = succ ?? list[0];
      progressLine = rep.line_name; appliedAt = rep.created_at; result = succ ? "success" : "fail";
    }
    return { userId: c.userId, progressLine, result, appliedAt, applied: list.length > 0 };
  });
}

let WEEK = null;
try {
  WEEK = (await httpGet(null)).weekId;
  ck("개설 대상 주차 weekId 확인", !!WEEK, WEEK);
  await cleanup(WEEK);

  const testSet = new Set(((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x) => x.user_id));
  const crews = ((await (await fetch(`${BASE}/api/admin/cluster4/crews?organization=${ORG}&status=active`, { headers: { cookie } })).json()).data ?? []).filter((c) => !testSet.has(c.userId));
  ck("활동 크루(테스트 제외) ≥ 4명 확보", crews.length >= 4, `n=${crews.length}`);
  const [A, B, C] = crews;

  // seed: A=opened(성공) B=rejected(실패) C=pending(강화대기→성공) · 나머지 미신청(실패)
  await sb.from("cluster4_competency_applications").insert([
    { organization_slug: ORG, week_id: WEEK, target_user_id: A.userId, line_name: `${TAG}-A`, source: "manual", resolution: "opened", approval_checked: true },
    { organization_slug: ORG, week_id: WEEK, target_user_id: B.userId, line_name: `${TAG}-B`, source: "manual", resolution: "rejected", approval_checked: false },
    { organization_slug: ORG, week_id: WEEK, target_user_id: C.userId, line_name: `${TAG}-C`, source: "manual", resolution: "pending", approval_checked: false },
  ]);

  const data = await httpGet(WEEK);
  const results = data.results ?? [];
  const map = new Map(results.map((x) => [x.userId, x]));

  // 카운트 = 활동 크루
  ck("[갯수] results 수 == 활동 크루(summary.activeCrews)", results.length === data.summary.activeCrews, `results=${results.length} active=${data.summary.activeCrews}`);

  // 매핑 검증
  const ra = map.get(A.userId), rb = map.get(B.userId), rc = map.get(C.userId);
  ck("[검증5] 승인(opened) 크루 A = 강화 성공 + 진행 라인/신청시간 표시", ra && ra.result === "success" && ra.progressLine === `${TAG}-A` && !!ra.appliedAt, J(ra));
  ck("[검증6] 반려(rejected) 크루 B = 강화 실패 (진행 라인은 신청 라인 표시)", rb && rb.result === "fail" && rb.progressLine === `${TAG}-B` && rb.applied === true, J(rb));
  ck("[정책] 강화 대기(pending) 크루 C = 강화 성공(표 정책)", rc && rc.result === "success" && rc.progressLine === `${TAG}-C`, J(rc));

  // 미신청 활동 크루 = 강화 실패 + 진행 라인 미신청(null) + 신청 시간 null
  const unapplied = results.find((x) => !x.applied);
  ck("[검증7] 미신청 활동 크루 = 강화 실패 · 진행 라인 미신청(null) · 신청 시간 null",
    !!unapplied && unapplied.result === "fail" && unapplied.progressLine === null && unapplied.appliedAt === null, J(unapplied));

  // [검증8] 신청 시간 — applied 크루는 ISO 존재
  ck("[검증8] 신청 시간 — 신청 크루 appliedAt 존재(ISO)", !!ra.appliedAt && !Number.isNaN(Date.parse(ra.appliedAt)));

  // 정렬: 신청 크루 먼저 → 미신청 뒤 (partition)
  const firstUnappliedIdx = results.findIndex((x) => !x.applied);
  const lastAppliedIdx = results.map((x) => x.applied).lastIndexOf(true);
  ck("[검증·정렬] 신청 크루 먼저 · 미신청 뒤(partition)", firstUnappliedIdx === -1 || lastAppliedIdx < firstUnappliedIdx, `lastApplied=${lastAppliedIdx} firstUnapplied=${firstUnappliedIdx}`);

  // direct == HTTP (logic 필드)
  const direct = await directResults(WEEK);
  const dmap = new Map(direct.map((x) => [x.userId, x]));
  const sameSet = direct.length === results.length && direct.every((d) => map.has(d.userId));
  const sameFields = direct.every((d) => {
    const h = map.get(d.userId);
    return h && h.result === d.result && (h.progressLine ?? null) === (d.progressLine ?? null) && h.applied === d.applied && (h.appliedAt ?? null) === (d.appliedAt ?? null);
  });
  ck("[검증3] direct(DB 재계산) == HTTP results (userId 집합)", sameSet, `direct=${direct.length} http=${results.length}`);
  ck("[검증3] direct == HTTP — result/progressLine/applied/appliedAt 전건 일치", sameFields);
  void dmap;

  // 주차 변경 시 갱신: 다른 주차 조회 → results 다름(시드 없음 → 모두 미신청/실패)
  const weeksOpts = (await (await fetch(`${BASE}/api/admin/cluster4/weeks-options?limit=8`, { headers: { cookie } })).json()).data?.weeks ?? [];
  const other = weeksOpts.find((w) => w.id !== WEEK);
  if (other) {
    const d2 = await httpGet(other.id);
    const seededInOther = (d2.results ?? []).some((x) => [`${TAG}-A`, `${TAG}-B`, `${TAG}-C`].includes(x.progressLine));
    ck("[검증4] 주차 변경 시 결과 갱신 — 다른 주차엔 이번 시드 미노출", !seededInOther);
  } else { ck("[검증4] 주차 변경(다른 주차 없음 — skip)", true); }
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { if (WEEK) await cleanup(WEEK); console.log("(cleanup 완료 — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }
