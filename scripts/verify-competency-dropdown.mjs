// 실무 역량 수동 추가 라인명 드롭다운 검증 — 드롭다운 선택 → 저장(master_id/line_code/line_name) → 개설 → 취소.
// 브라우저 UI 구동 + direct DB + HTTP. 격리: oranke + 테스트 크루 + common 마스터, 끝에 정리(net-zero).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const r = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = r("@supabase/supabase-js");
const { createServerClient } = r("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL, SERVICE), brow = createClient(URL, ANON);
const ORG = "oranke", SUB = "https://verify.example/dropdown-sub";
const J = (o) => JSON.stringify(o);
const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: "vanuatu.golden@gmail.com" });
const { data: v } = await brow.auth.verifyOtp({ email: "vanuatu.golden@gmail.com", token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");
const httpApps = async () => (await (await fetch(`${BASE}/api/admin/cluster4/competency/applications?organization=${ORG}`, { headers: { cookie } })).json()).data;
const dbAppByUser = async (uid) => (await sb.from("cluster4_competency_applications").select("*").eq("organization_slug", ORG).eq("target_user_id", uid).eq("submission_link", SUB).maybeSingle()).data;
async function cleanup(uid) { const a = await dbAppByUser(uid); if (a?.opened_line_id) { await sb.from("cluster4_line_targets").delete().eq("line_id", a.opened_line_id); await sb.from("cluster4_lines").delete().eq("id", a.opened_line_id); } await sb.from("cluster4_competency_applications").delete().eq("organization_slug", ORG).eq("submission_link", SUB); }

const b = await chromium.launch({ channel: "chromium", headless: true });
const ctx = await b.newContext({ viewport: { width: 1500, height: 1600 } }); await ctx.addCookies(cookies);
const p = await ctx.newPage();
p.on("dialog", async (d) => { await d.accept(); });
let crew;
try {
  // 마스터 목록(드롭다운 데이터) — org 미전달(공통 포함).
  const mastersJson = await (await fetch(`${BASE}/api/admin/cluster4/competency-line-masters`, { headers: { cookie } })).json();
  const masters = (mastersJson.data ?? []).filter((m) => m.isActive && (!m.organizationSlug || m.organizationSlug === "common" || m.organizationSlug === ORG));
  console.log(`\n[검증1] 드롭다운 데이터: 활성 competency master = ${masters.length}건, 예=${masters[0] ? J({ lineCode: masters[0].lineCode, lineName: masters[0].lineName.slice(0, 24) }) : "-"}`);

  const tm = (await sb.from("test_user_markers").select("user_id")).data.map((x) => x.user_id);
  crew = (await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", ORG).in("user_id", tm)).data[0];
  await cleanup(crew.user_id);
  console.log(`[setup] crew=${crew.display_name}(${crew.user_id.slice(0, 8)})`);

  await p.goto(`${BASE}/admin/line-opening/practical-competency?org=${ORG}&tab=open`, { waitUntil: "domcontentloaded" });
  await p.waitForFunction("document.body.innerText.includes('오늘은')", undefined, { timeout: 30000 }).catch(() => {});
  await p.waitForFunction("document.body.innerText.includes('신청 데이터가 없습니다') || !!document.querySelector('table')", undefined, { timeout: 20000 }).catch(() => {});

  // 수동 추가: 크루 선택 → 추가 → 팝업
  await p.fill('input[aria-label="수동 추가 크루 검색"]', crew.display_name);
  await p.waitForTimeout(2500);
  await p.evaluate(() => document.querySelector('input[aria-label="수동 추가 크루 검색"]')?.closest(".relative")?.querySelector("div.absolute button")?.click());
  await p.waitForTimeout(300);
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim().startsWith("추가"))?.click());
  await p.waitForTimeout(400);

  // [검증1-UI] 드롭다운 옵션 확인
  const ddOpts = await p.evaluate(() => { const s = document.querySelector('select[aria-label="수동 추가 라인명"]'); return s ? [...s.options].map((o) => o.textContent.trim()).filter((t) => t && !t.includes("선택")) : null; });
  console.log(`[검증1-UI] 팝업 라인명 드롭다운 옵션 ${ddOpts?.length ?? 0}건, 예='${ddOpts?.[0] ?? "-"}' (line_code 보조표시=${/\(.+\)/.test(ddOpts?.[0] ?? "") ? "O" : "X"})`);
  console.log(`[검증-오타방지] 라인명 자유 입력칸(input) 존재? = ${await p.evaluate(() => !!document.querySelector('input[aria-label="수동 추가 라인명"]'))} (false 여야 함)`);

  // 첫 마스터 선택 + 제출링크 + 확인
  const chosen = masters[0];
  await p.selectOption('select[aria-label="수동 추가 라인명"]', chosen.id);
  await p.fill('input[aria-label="수동 추가 제출 링크"]', SUB);
  await p.evaluate(() => { const btns = [...document.querySelectorAll("button")].filter((x) => (x.textContent || "").trim() === "확인"); btns[btns.length - 1]?.click(); });
  await p.waitForTimeout(2500);

  // [검증2] 저장값
  const a1 = await dbAppByUser(crew.user_id);
  const h1 = (await httpApps()).applications.find((x) => x.targetUserId === crew.user_id && x.submissionLink === SUB);
  console.log("\n[검증2] 저장값:");
  console.log("  [direct DB] ", a1 ? J({ master_id: a1.competency_line_master_id?.slice(0, 8), line_code: a1.line_code, line_name: a1.line_name, source: a1.source }) : "NULL");
  console.log("  [HTTP] ", h1 ? J({ masterId: h1.competencyLineMasterId?.slice(0, 8), lineCode: h1.lineCode, lineName: h1.lineName, source: h1.source }) : "NULL");
  console.log("  선택 마스터=" + J({ id: chosen.id.slice(0, 8), lineCode: chosen.lineCode, lineName: chosen.lineName }));
  console.log(`  => master_id 저장=${a1?.competency_line_master_id === chosen.id} line_name 저장=${a1?.line_name === chosen.lineName} line_code 저장=${a1?.line_code === chosen.lineCode ? "O" : a1?.line_code === null ? "null(컬럼 미적용)" : "X"} | direct==HTTP=${a1?.competency_line_master_id === h1?.competencyLineMasterId && a1?.line_name === h1?.lineName}`);

  // [검증3] 개설 → 마스터 기준 라인 생성
  await p.fill('input[aria-label="아웃풋 링크 1"]', "https://verify.example/cafe");
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "개설")?.click());
  await p.waitForTimeout(4500);
  const a2 = await dbAppByUser(crew.user_id);
  const lineRow = a2?.opened_line_id ? (await sb.from("cluster4_lines").select("line_code,competency_line_master_id,is_active,output_link_2").eq("id", a2.opened_line_id).maybeSingle()).data : null;
  console.log("\n[검증3] 개설 — 마스터 기준 라인 생성:");
  console.log("  [direct DB cluster4_lines] ", lineRow ? J({ line_code: lineRow.line_code, master_id: lineRow.competency_line_master_id?.slice(0, 8), is_active: lineRow.is_active, output_link_2: lineRow.output_link_2 }) : "NULL");
  console.log(`  => resolution=${a2?.resolution} 라인 line_code=${lineRow?.line_code}(선택마스터 ${chosen.lineCode} 일치=${lineRow?.line_code === chosen.lineCode}) master 일치=${lineRow?.competency_line_master_id === chosen.id}`);

  // [검증4] 개설 취소 → 원복
  const wasLine = a2?.opened_line_id;
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "개설 취소" && !x.disabled)?.click());
  await p.waitForTimeout(4500);
  const a3 = await dbAppByUser(crew.user_id);
  const goneL = (await sb.from("cluster4_lines").select("id").eq("id", wasLine)).data ?? [];
  const goneT = (await sb.from("cluster4_line_targets").select("id").eq("line_id", wasLine)).data ?? [];
  console.log("\n[검증4] 개설 취소 — 원복:");
  console.log(`  => resolution=${a3?.resolution} 라인삭제=${goneL.length === 0} 타깃삭제=${goneT.length === 0}`);

  // [검증5] 자유 입력(존재하지 않는 라인) 차단 — master 없이 POST → 400
  const bad = await fetch(`${BASE}/api/admin/cluster4/competency/applications`, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify({ organization: ORG, target_user_id: crew.user_id, line_name: "존재하지않는라인명", submission_link: SUB }) });
  console.log(`\n[검증-오타방지] master 없이(자유 라인명) POST → status=${bad.status} (400 이어야 함, 미존재 라인 차단)`);
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); }
finally { if (crew) await cleanup(crew.user_id); const left = crew ? await dbAppByUser(crew.user_id) : null; console.log("\n=== CLEANUP === 잔존:", left ? "남음(주의)" : "없음(net-zero)"); await b.close(); }
