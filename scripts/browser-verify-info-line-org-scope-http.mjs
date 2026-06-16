// 브라우저(인증) HTTP 검증 — info-lines 개설의 org 스코프(line_code 토큰) 격리.
//   실제 POST/GET/DELETE 라우트를 통해: ①개설 시 line_code 에 org 토큰 기록 ②org GET 필터
//   ③두 조직이 같은 주차+활동유형에 각자 개설 공존(org 인지 중복검사) ④org 인지 DELETE.
//   운영(operating)·테스트(test) 두 모드 모두. dev=true 로 과거 주차(W13) 개설.
//   대상 = 실유저/테스트유저(스냅샷 재계산 발생하나 open→cancel 왕복으로 순변화 0). 끝에 cleanup.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(SUPABASE_URL, SERVICE);

const WEEK_ID = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc"; // 2026-spring W13(과거)
const ACT = "etc_a";
const ENCRE_REAL = "3c4fc830-a465-4a00-a26a-a0c37fa3052c";
const ORANKE_REAL = "2ac6d5e9-f650-4bfc-99bc-36895aa8c9a2";
const ENCRE_TEST = "28c60d60-aa17-4614-9127-fd65a8aebcaf"; // T송하린
const ORANKE_TEST = "13b8e55e-ff49-43f3-a01f-cb68bfb74581"; // T한지윤

async function makeAdminCookies() {
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await sb.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({ email: adminEmail, token: linkData.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session.access_token, refresh_token: verifyData.session.refresh_token });
  return captured.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext();
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();
await page.goto(`${BASE}/admin/line-opening/practical-info?org=encre&tab=open`, { waitUntil: "domcontentloaded" });

function body(title, targetId) {
  return { activity_type_id: ACT, main_title: title, output_links: [{ url: "https://example.com", label: "t" }], output_images: [], target_user_ids: [targetId], week_id: WEEK_ID, submission_opens_at: "2026-05-25T00:00:00.000Z", submission_closes_at: "2026-05-31T00:00:00.000Z" };
}
async function api(method, org, mode, payload) {
  const sp = new URLSearchParams();
  if (org) sp.set("organization", org);
  if (mode === "test") sp.set("mode", "test");
  sp.set("dev", "true"); // 과거 주차(W13) 개설 honor
  if (method === "DELETE") { sp.set("week_id", WEEK_ID); sp.set("activity_type_id", ACT); }
  const url = `/api/admin/cluster4/info-lines?${sp.toString()}`;
  return page.evaluate(async ({ url, method, payload }) => {
    const opt = { method, headers: { "Content-Type": "application/json" } };
    if (payload) opt.body = JSON.stringify(payload);
    const r = await fetch(url, opt);
    const j = await r.json().catch(() => ({}));
    return { status: r.status, json: j };
  }, { url, method, payload: payload ?? null });
}
async function getLines(org) {
  const sp = new URLSearchParams({ week_id: WEEK_ID, activity_type_id: ACT });
  if (org) sp.set("organization", org);
  return page.evaluate(async (url) => { const x = await fetch(url); const j = await x.json(); return j.data?.rows ?? j.data ?? []; }, `/api/admin/cluster4/info-lines?${sp.toString()}`);
}
const titleIn = (rows, title) => (rows ?? []).some((r) => r.mainTitle === title);

const TS = Date.now();
const created = []; // {org, title} for cleanup safety
try {
  // ── 사전 정리: 혹시 남은 동일 활동/주차 테스트 라인 제거(이전 실패 잔재) ──
  // (sentinel 타이틀만 — 운영 라인 무접촉)

  // ====================== 운영 모드 ======================
  console.log("\n[operating] org=encre 개설 → line_code EC 토큰");
  const encTitle = `__HTTP_ENC_${TS}`;
  const r1 = await api("POST", "encre", "operating", body(encTitle, ENCRE_REAL));
  check("encre POST 201", r1.status === 201, `status=${r1.status} ${r1.json?.error ?? ""}`);
  const encLineCode = r1.json?.data?.line?.line_code ?? null;
  check("응답 line_code 에 EC 토큰", typeof encLineCode === "string" && encLineCode.includes("EC"), `line_code=${encLineCode}`);
  created.push(encTitle);

  // DB 확인
  const { data: encRow } = await sb.from("cluster4_lines").select("id,line_code").eq("week_id", WEEK_ID).eq("activity_type_id", ACT).eq("main_title", encTitle).maybeSingle();
  check("DB cluster4_lines.line_code EC 토큰 저장", !!encRow && (encRow.line_code ?? "").includes("EC"), `db line_code=${encRow?.line_code}`);
  const { data: encTargets } = await sb.from("cluster4_line_targets").select("target_user_id").eq("line_id", encRow?.id ?? "").eq("target_mode", "user");
  const encTids = (encTargets ?? []).map((t) => t.target_user_id);
  check("DB targets = encre 유저만", encTids.length === 1 && encTids[0] === ENCRE_REAL, JSON.stringify(encTids));

  console.log("\n[operating] org GET 필터");
  check("GET org=encre 에 encre 라인 노출", titleIn(await getLines("encre"), encTitle));
  check("GET org=oranke 에 encre 라인 미노출", !titleIn(await getLines("oranke"), encTitle));
  check("GET org=phalanx 에 encre 라인 미노출", !titleIn(await getLines("phalanx"), encTitle));

  console.log("\n[operating] org=oranke 가 같은 주차+활동유형에 공존 개설(org 인지 중복검사)");
  const orkTitle = `__HTTP_ORK_${TS}`;
  const r2 = await api("POST", "oranke", "operating", body(orkTitle, ORANKE_REAL));
  check("oranke POST 201(409 아님 — 타org 라인과 충돌 안 함)", r2.status === 201, `status=${r2.status} ${r2.json?.error ?? ""}`);
  const orkLineCode = r2.json?.data?.line?.line_code ?? null;
  check("oranke 응답 line_code 에 OK 토큰", typeof orkLineCode === "string" && orkLineCode.includes("OK"), `line_code=${orkLineCode}`);
  created.push(orkTitle);
  check("GET org=oranke 에 oranke 라인 노출·encre 라인 미노출", titleIn(await getLines("oranke"), orkTitle) && !titleIn(await getLines("oranke"), encTitle));
  check("GET org=encre 에 encre 라인만(oranke 라인 미노출)", titleIn(await getLines("encre"), encTitle) && !titleIn(await getLines("encre"), orkTitle));

  console.log("\n[operating] org 인지 DELETE — encre 취소 시 oranke 라인 보존");
  const d1 = await api("DELETE", "encre", "operating", null);
  check("DELETE org=encre 200", d1.status === 200, `status=${d1.status} ${d1.json?.error ?? ""}`);
  check("GET org=encre 에 encre 라인 제거됨", !titleIn(await getLines("encre"), encTitle));
  check("oranke 라인은 DB 보존(타org 오삭제 0)", titleIn(await getLines("oranke"), orkTitle));
  const d2 = await api("DELETE", "oranke", "operating", null);
  check("DELETE org=oranke 200(cleanup)", d2.status === 200, `status=${d2.status}`);
  created.length = 0; // 정상 삭제됨

  // ====================== 테스트 모드 ======================
  console.log("\n[test] org=encre 테스트 개설 → line_code EC 토큰(모드 무관 동일)");
  const encTestTitle = `__HTTP_ENC_TEST_${TS}`;
  const t1 = await api("POST", "encre", "test", body(encTestTitle, ENCRE_TEST));
  check("encre 테스트 POST 201", t1.status === 201, `status=${t1.status} ${t1.json?.error ?? ""}`);
  check("테스트 응답 line_code EC 토큰", (t1.json?.data?.line?.line_code ?? "").includes("EC"), `line_code=${t1.json?.data?.line?.line_code}`);
  check("GET org=oranke 에 미노출(테스트모드도 격리)", !titleIn(await getLines("oranke"), encTestTitle));
  if (t1.status === 201) { const dt = await api("DELETE", "encre", "test", null); check("테스트 라인 DELETE 200(cleanup)", dt.status === 200, `status=${dt.status}`); }
} catch (err) {
  console.error("browser error:", err?.stack ?? err?.message ?? err); fail++;
} finally {
  // 안전 cleanup — 남은 sentinel 라인 제거.
  for (const title of [`__HTTP_ENC_${TS}`, `__HTTP_ORK_${TS}`, `__HTTP_ENC_TEST_${TS}`]) {
    const { data } = await sb.from("cluster4_lines").select("id").eq("main_title", title);
    for (const r of data ?? []) { await sb.from("cluster4_line_targets").delete().eq("line_id", r.id); await sb.from("cluster4_lines").delete().eq("id", r.id); }
  }
  await browser.close();
}
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
