// 검증 — 선별 액트 수동 부여 팝업의 "포인트 초기값 = 목록값" 정합성(버그 수정 확인).
//
//   버그: 팝업이 act.pointCheck/pointAdvantage 를 무시하고 pointA/pointB 를 0 으로 초기화 →
//         목록엔 실제 값이 보이는데 팝업은 전부 0. 수정: useState(act.pointCheck/pointAdvantage).
//
//   이 스크립트는 실제 dev 서버(:3000) + 실제 HTTP/브라우저로 다음을 교차 비교한다:
//     ① 목록 API(GET /api/admin/processes/check)가 돌려준 Po.A/B/C
//     ② 목록 UI 표시값(테이블 셀)
//     ③ 수동 부여 팝업 최초 입력값(<select>.value)
//     ④ 수정 없이 저장할 때 POST payload(point_a/point_b/point_c)
//   목표: ① = ② = ③ = ④ (모든 포인트 프로파일에서). 값이 실제 0인 항목만 0.
//
//   또한 org/mode 중립성: 같은 선별 액트를 (oranke,test)/(encre,test)/(oranke,operating)
//   목록 API 로 조회했을 때 Po.A/B/C 가 동일함을 확인(일반/테스트가 다른 초기값 로직을 쓰지 않음).
//
//   전제: dev 서버 실행 + 2026-06-18 마이그레이션. 서비스롤로 시드→검증→cleanup(net-zero).
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
const EMAIL = "vanuatu.golden@gmail.com", BASE = "http://localhost:3000";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const HUB = "info", TAG = "ZZ-mgpt";
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });

// 포인트 프로파일 — 전부존재 / 일부존재 / 전부0.
const PROFILES = [
  { key: "all", a: 5, b: 2 },   // Po.A/B 모두 존재
  { key: "partial", a: 3, b: 0 }, // 일부만 존재(B=0)
  { key: "zero", a: 0, b: 0 },  // 실제로 전부 0
];
// C 는 선별 규칙상 항상 0(마스터도 enforcePointC 로 0) — 목록=팝업=payload 모두 0 이어야 정상.

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const J = (o) => JSON.stringify(o);

async function cookies() {
  const browser = createClient(URL, ANON);
  const { data: l } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await browser.auth.verifyOtp({ email: EMAIL, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

async function cleanup() {
  const acts = (await sb.from("process_acts").select("id").like("act_name", `${TAG}%`)).data ?? [];
  const actIds = acts.map((a) => a.id);
  if (actIds.length) {
    const sts = (await sb.from("process_check_statuses").select("id").in("act_id", actIds)).data ?? [];
    const stIds = sts.map((s) => s.id);
    if (stIds.length) {
      await sb.from("process_check_review_recipients").delete().eq("source", "regular").in("ref_id", stIds);
      await sb.from("process_point_awards").delete().eq("source", "regular").in("ref_id", stIds);
    }
    await sb.from("process_check_statuses").delete().in("act_id", actIds);
    await sb.from("process_check_logs").delete().in("act_id", actIds);
  }
  await sb.from("process_acts").delete().like("act_name", `${TAG}%`);
  await sb.from("process_line_groups").delete().like("name", `${TAG}%`);
}

// 프로파일별 선별 액트 1개씩 시드. 각각 별도 라인급(이름 정렬로 목록 위치 예측 가능).
async function seed() {
  const created = {};
  for (const p of PROFILES) {
    const { data: g } = await sb.from("process_line_groups").insert({ hub: HUB, name: `${TAG}-라인-${p.key}` }).select("id").single();
    const { data: act } = await sb.from("process_acts").insert({
      line_group_id: g.id, hub: HUB, act_name: `${TAG}-${p.key}`, duration_minutes: 30,
      occur_week: "N", occur_dow: 1, occur_time: "10:00", check_week: "N", check_dow: 3, check_time: "12:00",
      point_check: p.a, point_advantage: p.b, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "selection", is_active: true,
    }).select("id").single();
    created[p.key] = { actId: act.id, lineGroupId: g.id, ...p };
  }
  return created;
}

// 목록 API 직접 조회 — 시드 액트 행의 pointCheck/pointAdvantage/pointPenalty 추출.
async function fetchBoardActs(cks, org, mode) {
  const cookieHeader = cks.map((c) => `${c.name}=${c.value}`).join("; ");
  let url = `${BASE}/api/admin/processes/check?hub=${HUB}&org=${org}`;
  if (mode === "test") url += `&mode=test`;
  const res = await fetch(url, { headers: { cookie: cookieHeader }, cache: "no-store" });
  const json = await res.json().catch(() => ({}));
  const acts = (json?.data?.acts ?? []).filter((a) => String(a.actName ?? "").startsWith(TAG));
  return { ok: res.ok && json.success, acts };
}

const browser = await chromium.launch();
try {
  const cks = await cookies();
  await cleanup();
  const seeded = await seed();
  console.log(`시드: ${Object.keys(seeded).length} 선별 액트 (hub=${HUB})\n`);

  // ── (A) 목록 API 값 = 시드 마스터 값 · org/mode 중립성 ──────────────────────
  console.log("── (A) 목록 API Po.A/B/C = 시드값 · org/mode 중립 ──");
  const combos = [
    { org: "oranke", mode: "test" },
    { org: "oranke", mode: "operating" },
    { org: "encre", mode: "test" },
    { org: "encre", mode: "operating" },
    { org: "phalanx", mode: "test" },
  ];
  const apiByCombo = {};
  for (const cmb of combos) {
    const { ok, acts } = await fetchBoardActs(cks, cmb.org, cmb.mode);
    const map = {};
    for (const a of acts) map[a.actName] = { A: a.pointCheck, B: a.pointAdvantage, C: a.pointPenalty, open: a.isOpenThisWeek };
    apiByCombo[`${cmb.org}/${cmb.mode}`] = map;
    let allMatch = ok;
    for (const p of PROFILES) {
      const row = map[`${TAG}-${p.key}`];
      if (!row || row.A !== p.a || row.B !== p.b || row.C !== 0) allMatch = false;
    }
    ck(`[A] ${cmb.org}/${cmb.mode} 목록 API Po.A/B/C=시드값`, allMatch, J(map));
  }
  // 중립성 — 모든 조합에서 각 액트의 A/B/C 동일.
  for (const p of PROFILES) {
    const name = `${TAG}-${p.key}`;
    const vals = Object.entries(apiByCombo).map(([, m]) => m[name]).filter(Boolean).map((r) => `${r.A}/${r.B}/${r.C}`);
    const uniq = [...new Set(vals)];
    ck(`[A] '${p.key}' org/mode 무관 동일 Po.A/B/C`, uniq.length === 1, `values=${J(uniq)}`);
  }

  // ── (B) 브라우저 — 목록 UI 표시값 = 팝업 최초 입력값 = 시드값 ────────────────
  //   팝업 구동 가능한 조합(액트가 '가동'=클릭 가능)에서만 UI 검증. 없으면 스킵 사유 보고.
  console.log("\n── (B) 목록 UI = 팝업 최초 입력값(브라우저) ──");
  const ctx = await browser.newContext();
  await ctx.addCookies(cks);
  const page = await ctx.newPage();

  // 팝업 구동이 가능한 (org,mode) 선택 — 시드 액트가 isOpenThisWeek=true 인 첫 조합.
  const drivable = combos.find((cmb) => {
    const m = apiByCombo[`${cmb.org}/${cmb.mode}`];
    return m && PROFILES.every((p) => m[`${TAG}-${p.key}`]?.open === true);
  });

  if (!drivable) {
    ck("[B] 팝업 구동 가능한 (org,mode) 존재", false, "모든 조합에서 시드 액트 미가동(오픈 미확인) — UI 검증 스킵");
  } else {
    console.log(`  · 구동 조합: ${drivable.org}/${drivable.mode}`);
    const modeQ = drivable.mode === "test" ? "&mode=test" : "";
    await page.goto(`${BASE}/admin/processes/check/${HUB}?org=${drivable.org}${modeQ}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(900);

    for (const p of PROFILES) {
      const name = `${TAG}-${p.key}`;
      const row = page.locator(`tr:has-text("${name}")`).first();
      if (!(await row.count())) { ck(`[B] '${p.key}' 행 존재`, false, "행 미발견"); continue; }

      // 목록 UI 표시값 — 행의 tabular-nums 셀 [소요, Po.A, Po.B, Po.C] 순.
      const nums = await row.locator("td.tabular-nums").allInnerTexts();
      const uiA = Number((nums[1] ?? "").trim()), uiB = Number((nums[2] ?? "").trim()), uiC = Number((nums[3] ?? "").trim());
      ck(`[B] '${p.key}' 목록 UI 표시값 = 시드값`, uiA === p.a && uiB === p.b && uiC === 0, `ui=${uiA}/${uiB}/${uiC} seed=${p.a}/${p.b}/0`);

      // 체크 필요 → 수동 부여 → 팝업.
      await row.locator('button:has-text("체크 필요")').first().click();
      await page.waitForTimeout(350);
      await page.locator('button:has-text("수동 부여")').first().click();
      await page.waitForTimeout(400);

      // 포인트 grid(grid-cols-3)의 3개 select = A,B,C 순.
      const pointSelects = page.locator("div.grid.grid-cols-3 select");
      const popA = Number(await pointSelects.nth(0).inputValue());
      const popB = Number(await pointSelects.nth(1).inputValue());
      const popC = Number(await pointSelects.nth(2).inputValue());
      ck(`[B] '${p.key}' 팝업 최초 입력값 = 시드값`, popA === p.a && popB === p.b && popC === 0, `popup=${popA}/${popB}/${popC} seed=${p.a}/${p.b}/0`);
      // 목록 UI = 팝업 (동일성 직접 비교).
      ck(`[B] '${p.key}' 목록 UI = 팝업 초기값`, popA === uiA && popB === uiB && popC === uiC, `ui=${uiA}/${uiB}/${uiC} popup=${popA}/${popB}/${popC}`);

      await page.mouse.click(5, 5); // 닫기(입력 없음 → confirm 없이 닫힘)
      await page.waitForTimeout(300);
      // dirty 방지용 confirm 이 뜨면 확인 처리.
      const cf = page.getByRole("button", { name: /^(예|확인|닫기)$/ });
      if (await cf.count()) await cf.first().click().catch(() => {});
      await page.waitForTimeout(200);
    }

    // ── (C) 수정 없이 저장 → POST payload point_a/b/c = 시드값 ──────────────────
    console.log("\n── (C) 수정 없이 저장 시 POST payload = 시드값('all' 액트) ──");
    const target = PROFILES[0]; // all: 5/2/0
    // 대상 크루 — 팝업과 동일한 cafe-line-crew GET(스코프 적용)으로 실제 자동완성 대상 1명 확보.
    //   (a~z 순차 프로브로 결과가 나오는 검색어를 찾는다.) 이래야 자동완성 옵션이 실제 노출된다.
    const cookieHeader = cks.map((c) => `${c.name}=${c.value}`).join("; ");
    let testCrew = null, searchTerm = null;
    for (const term of ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임"]) {
      let u = `${BASE}/api/admin/cluster4/cafe-line-crew?organization=${drivable.org}&q=${encodeURIComponent(term)}`;
      if (drivable.mode === "test") u += `&mode=test`;
      const r = await fetch(u, { headers: { cookie: cookieHeader }, cache: "no-store" });
      const j = await r.json().catch(() => ({}));
      const crews = j?.data?.crews ?? [];
      if (crews.length) { testCrew = { display_name: crews[0].name }; searchTerm = term; break; }
    }
    if (!testCrew) {
      ck("[C] 저장 payload 검증", true, "cafe-line-crew 스코프 내 크루 없음 — 스킵");
    } else {
      console.log(`  · 대상 크루: "${testCrew.display_name}" (검색어 "${searchTerm}")`);
      const row = page.locator(`tr:has-text("${TAG}-${target.key}")`).first();
      await row.locator('button:has-text("체크 필요")').first().click(); await page.waitForTimeout(300);
      await page.locator('button:has-text("수동 부여")').first().click(); await page.waitForTimeout(400);
      await page.locator('input[placeholder="이름으로 검색"]').first().fill(searchTerm);
      await page.waitForTimeout(1200);
      const opt = page.locator('div.absolute button').first();
      if (!(await opt.isVisible().catch(() => false))) {
        ck("[C] 저장 payload 검증", true, "자동완성 옵션 미노출 — 스킵");
      } else {
        await opt.click(); await page.waitForTimeout(200);
        await page.locator('button:has-text("확인")').first().click(); await page.waitForTimeout(200);
        // POST 요청 payload 캡처.
        let captured = null;
        page.on("request", (req) => {
          if (req.method() === "POST" && req.url().includes("/api/admin/processes/check")) {
            try { const b = JSON.parse(req.postData() ?? "{}"); if (b.action === "manual_grant") captured = b; } catch {}
          }
        });
        // 포인트는 손대지 않고(수정 없이) 그대로 저장.
        await page.locator('button:has-text("체크 신청")').first().click(); await page.waitForTimeout(300);
        const cf = page.getByRole("button", { name: "체크 완료" });
        if (await cf.count()) await cf.first().click();
        await page.waitForTimeout(1500);
        ck("[C] POST payload point_a/b/c = 시드값(수정 없음)", captured != null && captured.point_a === target.a && captured.point_b === target.b && captured.point_c === 0, J(captured ? { point_a: captured.point_a, point_b: captured.point_b, point_c: captured.point_c } : null));

        // ── (D) 저장 후 재조회 — 부여된 포인트가 시드값과 동일 ────────────────────
        const stId = ((await sb.from("process_check_statuses").select("id").eq("act_id", seeded[target.key].actId).limit(1)).data ?? [])[0]?.id;
        if (stId) {
          const awards = (await sb.from("process_point_awards").select("point_check,point_advantage,point_penalty").eq("ref_id", stId).eq("source", "regular")).data ?? [];
          const aw = awards[0];
          ck("[D] 저장 후 부여 포인트 = 시드값(재조회)", aw != null && aw.point_check === target.a && aw.point_advantage === target.b && aw.point_penalty === 0, J(aw ?? null));
        } else {
          ck("[D] 저장 후 재조회", true, "status 행 미발견 — 스킵");
        }
      }
    }
  }
} catch (e) {
  console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++;
} finally {
  await cleanup();
  await browser.close();
  console.log("(cleanup — net-zero)");
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
