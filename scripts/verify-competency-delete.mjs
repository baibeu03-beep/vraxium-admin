// 검증 — 실무 역량 수동 추가 항목 X 삭제 (source 게이트 + 삭제 영속 + direct==HTTP).
//   자체 테스트 행(customer 1 + manual 1, line_name 'ZZ-verify-del-*')을 service-role 로 삽입 후
//   HTTP DELETE 로 게이트/삭제를 검증하고, 끝에 자체 행만 정리(운영 데이터 무접촉).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const r = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = r("@supabase/supabase-js");
const { createServerClient } = r("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const [URL, ANON, SERVICE] = [get("NEXT_PUBLIC_SUPABASE_URL"), get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), get("SUPABASE_SERVICE_ROLE_KEY")];
const sb = createClient(URL, SERVICE);
const brow = createClient(URL, ANON);
const ORG = "oranke";
const TAG = "ZZ-verify-del";

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: "vanuatu.golden@gmail.com" });
const { data: v } = await brow.auth.verifyOtp({ email: "vanuatu.golden@gmail.com", token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");

let pass = 0, fail = 0;
const check = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const httpGet = async () => (await (await fetch(`${BASE}/api/admin/cluster4/competency/applications?organization=${ORG}`, { headers: { cookie } })).json());

async function cleanup() {
  await sb.from("cluster4_competency_applications").delete().like("line_name", `${TAG}%`);
}

try {
  await cleanup(); // 이전 잔여 제거

  // 대상 주차 + 실제 크루 2명.
  const g0 = await httpGet();
  const weekId = g0.data?.weekId;
  const crewsRes = await fetch(`${BASE}/api/admin/cluster4/crews?organization=${ORG}&status=active`, { headers: { cookie } });
  const crews = (await crewsRes.json()).data ?? [];
  check("[준비] 대상 주차 + 활동 크루 확보", !!weekId && crews.length >= 1, `weekId=${weekId} crews=${crews.length}`);
  if (!weekId || crews.length < 1) throw new Error("준비 실패");

  // service-role 직접 삽입: customer 1 + manual 1.
  const ins = await sb.from("cluster4_competency_applications").insert([
    { organization_slug: ORG, week_id: weekId, target_user_id: crews[0].userId, line_name: `${TAG}-customer`, source: "customer", submission_link: "https://example.com/c" },
    { organization_slug: ORG, week_id: weekId, target_user_id: crews[0].userId, line_name: `${TAG}-manual`, source: "manual", submission_link: "https://example.com/m" },
  ]).select("id,source,line_name");
  check("[준비] 테스트 행 2건 삽입(customer+manual)", !ins.error && ins.data?.length === 2, ins.error?.message ?? "");
  const customerId = ins.data.find((x) => x.source === "customer").id;
  const manualId = ins.data.find((x) => x.source === "manual").id;

  // HTTP GET 에 2건 노출 + source 정확.
  const g1 = await httpGet();
  const mine = (g1.data?.applications ?? []).filter((a) => a.lineName.startsWith(TAG));
  check("[1] HTTP GET 에 테스트 2건 노출", mine.length === 2, `n=${mine.length}`);
  const mManual = mine.find((a) => a.lineName.endsWith("manual"));
  const mCustomer = mine.find((a) => a.lineName.endsWith("customer"));
  check("[1] source 구분(manual/customer)", mManual?.source === "manual" && mCustomer?.source === "customer");

  // direct(서비스 직접) == HTTP : 동일 2건 + source 일치.
  const dRows = (await sb.from("cluster4_competency_applications").select("id,source,line_name").eq("organization_slug", ORG).eq("week_id", weekId).like("line_name", `${TAG}%`)).data ?? [];
  const sameSet = dRows.length === mine.length &&
    dRows.every((d) => mine.some((h) => h.id === d.id && h.source === d.source));
  check("[5] direct DB == HTTP 응답(행 집합·source 일치)", sameSet, `direct=${dRows.length} http=${mine.length}`);

  // [2] 고객 신청(customer) DELETE → 403, 잔존.
  const delC = await fetch(`${BASE}/api/admin/cluster4/competency/applications/${customerId}`, { method: "DELETE", headers: { cookie } });
  const stillC = (await sb.from("cluster4_competency_applications").select("id").eq("id", customerId)).data ?? [];
  check("[2] customer 항목 DELETE 거절(403)", delC.status === 403, `status=${delC.status}`);
  check("[2] customer 항목 삭제 안 됨(잔존)", stillC.length === 1);

  // [3] 수동(manual) DELETE → 200.
  const delM = await fetch(`${BASE}/api/admin/cluster4/competency/applications/${manualId}`, { method: "DELETE", headers: { cookie } });
  const delMJson = await delM.json();
  check("[3] manual 항목 DELETE 성공", delM.ok && delMJson.success, `status=${delM.status}`);

  // [4] 삭제 후 재조회(direct + HTTP) 에 manual 항목 없음.
  const goneDb = (await sb.from("cluster4_competency_applications").select("id").eq("id", manualId)).data ?? [];
  const g2 = await httpGet();
  const stillHttp = (g2.data?.applications ?? []).some((a) => a.id === manualId);
  check("[4] 삭제 후 manual 항목 DB 에서 제거", goneDb.length === 0);
  check("[4] 삭제 후 HTTP 응답에도 없음(새로고침 재현 없음)", !stillHttp);
} catch (e) {
  console.error("error:", e?.message ?? e);
  fail++;
} finally {
  await cleanup(); // 자체 테스트 행만 정리(운영 데이터 무접촉)
  console.log("  (cleanup: 테스트 행 제거 완료)");
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
