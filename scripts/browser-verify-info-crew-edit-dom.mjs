// 브라우저 DOM 검증 — "개설 대상 크루 수정" 버튼/모달이 실제 화면에 반영되는지.
//   1) 임시 in-range(2026-spring W10) oranke info 라인(테스트 유저 1명 대상) 생성.
//   2) /admin/line-opening/practical-info?org=oranke 진입 → 주차별 개설 결과에서 W10 선택.
//   3) 개설 완료 카드에 [개설 대상 크루 수정] 버튼 노출 확인.
//   4) 클릭 → 모달 오픈: "현재 대상자 (1명)" + 반영 방식(추가/교체) + 공용 카페 검수 UI(검수/수동추가) 확인.
//   5) 정리: 임시 라인 삭제 + 스냅샷 복원.
//   ⚠ 데이터 변경(저장)은 HTTP 스크립트(16/0)로 검증 — 여기선 UI 반영(렌더)만 본다.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const U = get("NEXT_PUBLIC_SUPABASE_URL"), AN = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SV = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(U, SV);

const W10 = "6cc59d70-3aa6-4823-8854-5b82691d1a84";
const A = "13b8e55e-ff49-43f3-a01f-cb68bfb74581"; // T한지윤

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };

async function cookies() {
  const a = createClient(U, SV), b = createClient(U, AN);
  const { data: l } = await a.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: v } = await b.auth.verifyOtp({ email: adminEmail, token: l.properties.email_otp, type: "magiclink" });
  const cap = [];
  const s = createServerClient(U, AN, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it) } });
  await s.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));
}

let lineId = null;
const br = await chromium.launch({ channel: "chromium", headless: true });
try {
  const { data: adm } = await sb.from("admin_users").select("id").limit(1).maybeSingle();
  const { data: line } = await sb.from("cluster4_lines").insert({
    part_type: "info", activity_type_id: "wisdom", line_code: `IFOK-DOMVERIFY${Date.now()}`,
    main_title: "[검증용 임시 라인 · DOM] 개설 대상 크루 수정",
    output_links: [{ url: "https://example.com", label: "검증" }], output_link_1: "https://example.com",
    submission_opens_at: new Date("2026-05-04T00:00:00Z").toISOString(),
    submission_closes_at: new Date("2026-05-10T23:59:59Z").toISOString(),
    week_id: W10, is_active: true, created_by: adm.id, updated_by: adm.id,
  }).select("id").single();
  lineId = line.id;
  await sb.from("cluster4_line_targets").insert({ line_id: lineId, week_id: W10, target_mode: "user", target_user_id: A, target_rule: {}, created_by: adm.id, updated_by: adm.id });

  const ctx = await br.newContext();
  await ctx.addCookies(await cookies());
  const pg = await ctx.newPage();
  await pg.goto(`${BASE}/admin/line-opening/practical-info?org=oranke`, { waitUntil: "domcontentloaded" });

  // 주차별 개설 결과 — W10 선택. (select 라벨: "개설 결과 주차 선택")
  const sel = pg.getByLabel("개설 결과 주차 선택");
  await sel.waitFor({ timeout: 15000 });
  // W10 옵션 value = week_id
  await sel.selectOption(W10).catch(() => {});
  await pg.waitForTimeout(2500); // 결과 로드

  // 개설 완료 카드(wisdom = 위즈덤)에 [개설 대상 크루 수정] 버튼 노출?
  const editBtn = pg.getByRole("button", { name: "개설 대상 크루 수정" }).first();
  const btnVisible = await editBtn.isVisible().catch(() => false);
  check("개설 완료 카드에 [개설 대상 크루 수정] 버튼 노출", btnVisible);

  if (btnVisible) {
    await editBtn.click();
    await pg.waitForTimeout(1500);
    const heading = await pg.getByText("개설 대상 크루 수정", { exact: false }).first().isVisible().catch(() => false);
    check("모달 헤더 노출", heading);
    const cur = await pg.getByText("현재 대상자", { exact: false }).first().isVisible().catch(() => false);
    check("모달에 '현재 대상자' 섹션 노출", cur);
    const addToggle = await pg.getByRole("button", { name: /기존 유지 \+ 추가/ }).isVisible().catch(() => false);
    const replaceToggle = await pg.getByRole("button", { name: "전체 교체" }).isVisible().catch(() => false);
    check("반영 방식 토글(추가/교체) 노출", addToggle && replaceToggle);
    // 공용 CafeCrewPicker 재사용 — 카페 링크 검수 + 수동 추가 검색.
    const cafeInput = await pg.getByLabel("카페 게시물 링크").isVisible().catch(() => false);
    const verifyBtn = await pg.getByRole("button", { name: "검수" }).first().isVisible().catch(() => false);
    const manualSearch = await pg.getByLabel("크루 수동 추가 검색").isVisible().catch(() => false);
    check("기존 카페 검수 UI(링크 입력/검수 버튼) 재사용 노출", cafeInput && verifyBtn);
    check("수동 추가 검색 입력 노출", manualSearch);
  }
} catch (e) {
  check("실행", false, e instanceof Error ? e.message : String(e));
} finally {
  if (lineId) {
    await sb.from("cluster4_line_targets").delete().eq("line_id", lineId);
    await sb.from("cluster4_lines").delete().eq("id", lineId);
    const { data } = await sb.from("cluster4_lines").select("id").eq("id", lineId).maybeSingle();
    check("cleanup) 임시 라인 삭제됨", !data);
  }
  await sb.from("cluster4_weekly_card_snapshots").update({ is_stale: false }).in("user_id", [A]);
  await br.close();
}
console.log(`\n=== DOM 결과: ${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
