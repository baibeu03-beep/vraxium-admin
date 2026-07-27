// 브라우저 검증 — /admin/team-parts/info/weeks/*  [실무 경험] 라인(오픈) 체크 ↔ 주차 기준 반영.
//
//   검증 계약(2026-07-27 평점 기준 정책):
//     (1) 체크박스를 바꾸면 preview(data-week-recognition-pending)가 즉시 갱신된다.
//     (2) 도출·분석·견문 셀 1칸을 끄면 pending 이 감소한다(주차 기준에 반영됨).
//     (3) 관리·확장 셀을 전부 껐다 켜도 pending 이 변하지 않는다(주차 기준에서 제외됨).
//     (4) 확정 표시값(data-week-recognition-count)은 체크 변경으로 덮이지 않는다(latch 보존).
//     (5) 일반 모드와 mode=test 가 같은 값을 보여준다.
//
//   비파괴 — 체크박스 토글은 로컬 state 이고, [클럽 활동 진행](오픈 확인) 을 누르지 않으므로
//   POST 가 나가지 않는다. recognition-preview 만 호출되며 이는 read-only 다.
//   종료 전 원래 체크 상태로 되돌린다(어차피 저장 안 하지만 방어적).
//
//   run: node scripts/browser-verify-experience-rating-criterion.mjs
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
const g = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = process.env.BASE ?? "http://localhost:3000";
const SUPABASE_URL = g("NEXT_PUBLIC_SUPABASE_URL");
const ANON = g("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = g("SUPABASE_SERVICE_ROLE_KEY");
const admin = createClient(SUPABASE_URL, SERVICE);

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};

async function makeAdminCookies() {
  const { data: adm } = await admin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = process.env.SMOKE_ADMIN_EMAIL ?? adm?.[0]?.email;
  const b = createClient(SUPABASE_URL, ANON);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await b.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: v.session.access_token, refresh_token: v.session.refresh_token,
  });
  console.log(`admin = ${email}`);
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

// pending 값(= 지금 설정으로 오픈 확인하면 확정될 N). 없으면 확정값과 같다는 뜻이라 null.
const readState = (page) =>
  page.evaluate(() => {
    const pend = document.querySelector("[data-week-recognition-pending]");
    const cnt = document.querySelector("[data-week-recognition-count]");
    return {
      pending: pend ? Number(pend.getAttribute("data-week-recognition-pending")) : null,
      count: cnt ? cnt.textContent.trim() : null,
    };
  });

// preview 는 300ms 디바운스 + 서버 왕복 → 값이 바뀔 때까지(또는 타임아웃) 기다린다.
async function waitPending(page, prev, timeoutMs = 12000) {
  const t0 = Date.now();
  let last = await readState(page);
  while (Date.now() - t0 < timeoutMs) {
    if (last.pending !== prev) return last;
    await page.waitForTimeout(250);
    last = await readState(page);
  }
  return last;
}

async function main() {
  const cookies = await makeAdminCookies();

  // 편집 가능한(검수 완료 아님) 오픈확인 주차를 고른다.
  const { data: cfg } = await admin
    .from("cluster4_week_opening_configs")
    .select("week_id, organization_slug, config, recognition_count_n")
    .eq("open_confirmed", true)
    .not("recognition_count_n", "is", null);
  const cands = (cfg ?? []).filter((r) => ["encre", "oranke", "phalanx"].includes(r.organization_slug));
  const { data: wk } = await admin
    .from("weeks").select("id, season_key, week_number, start_date")
    .in("id", [...new Set(cands.map((t) => t.week_id))]);
  const wkById = new Map((wk ?? []).map((w) => [w.id, w]));
  cands.sort((a, b) =>
    String(wkById.get(b.week_id)?.start_date ?? "").localeCompare(String(wkById.get(a.week_id)?.start_date ?? "")));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });

  let ran = 0;
  for (const c of cands) {
    if (ran >= 2) break;
    const w = wkById.get(c.week_id);
    const org = c.organization_slug;
    const name = `${org} ${w?.season_key} W${w?.week_number}`;
    const exp = c.config?.practicalExperience ?? {};
    const teamIds = Object.keys(exp);
    if (teamIds.length === 0) continue;

    for (const mode of ["", "&mode=test"]) {
      const modeLabel = mode ? "mode=test" : "일반";
      const url = `${BASE}/admin/team-parts/info/weeks/${c.week_id}?club=${org}${mode}`;
      await page.goto(url, { waitUntil: "networkidle" });

      // 편집 가능 여부 — 체크박스가 disabled 면 readOnly 주차라 이 검증 대상이 아니다.
      const derTeam = teamIds.find((t) => exp[t]?.derive === true);
      if (!derTeam) continue;
      const derSel = `[data-line-exp-cell="${derTeam}:derive"]`;
      const has = await page.$(derSel);
      if (!has) { console.log(`\n▸ ${name} (${modeLabel}) — 셀 미발견, 건너뜀`); continue; }
      const disabled = await page.$eval(derSel, (el) => el.disabled === true || el.getAttribute("disabled") != null);
      if (disabled) { console.log(`\n▸ ${name} (${modeLabel}) — 읽기전용(검수 완료) 주차, 건너뜀`); continue; }

      console.log(`\n▸ ${name} (${modeLabel})`);
      ran += mode ? 0 : 1;

      const base = await readState(page);
      const latch = base.count;

      // (2) 도출 1칸 해제 → pending 감소
      await page.click(derSel);
      const off = await waitPending(page, base.pending);
      check("도출 1칸 해제 → 주차 기준 pending 감소",
        off.pending != null && (base.pending == null || off.pending < base.pending),
        `${base.pending ?? "(확정값과 동일)"} → ${off.pending}`);
      check("확정 표시값(latch)은 체크 변경으로 덮이지 않음", off.count === latch, `${latch} → ${off.count}`);

      // 되돌리기
      await page.click(derSel);
      const back = await waitPending(page, off.pending);
      check("다시 체크 → 원래 값 복귀", back.pending === base.pending, `${off.pending} → ${back.pending}`);

      // (3) 관리 전체 해제 → pending 불변
      let mgmtToggled = 0;
      for (const t of teamIds) {
        const sel = `[data-line-exp-cell="${t}:management"]`;
        if (await page.$(sel)) {
          const on = await page.$eval(sel, (el) => el.checked === true || el.getAttribute("aria-checked") === "true");
          if (on) { await page.click(sel); mgmtToggled++; }
        }
      }
      if (mgmtToggled > 0) {
        await page.waitForTimeout(1800); // 디바운스 + 왕복
        const afterMgmt = await readState(page);
        check(`관리 ${mgmtToggled}칸 해제 → 주차 기준 불변(제외 확인)`,
          afterMgmt.pending === back.pending, `${back.pending} → ${afterMgmt.pending}`);
        for (const t of teamIds) {
          const sel = `[data-line-exp-cell="${t}:management"]`;
          if (await page.$(sel)) {
            const on = await page.$eval(sel, (el) => el.checked === true || el.getAttribute("aria-checked") === "true");
            if (!on) await page.click(sel);
          }
        }
        await page.waitForTimeout(1200);
      } else {
        console.log("  · 관리 체크 셀 없음 — 해당 검증 스킵");
      }

      // (3b) 확장 전체 체크 → pending 불변
      let expToggled = 0;
      for (const t of teamIds) {
        const sel = `[data-line-exp-cell="${t}:expansion"]`;
        if (await page.$(sel)) {
          const on = await page.$eval(sel, (el) => el.checked === true || el.getAttribute("aria-checked") === "true");
          if (!on) { await page.click(sel); expToggled++; }
        }
      }
      if (expToggled > 0) {
        await page.waitForTimeout(1800);
        const afterExp = await readState(page);
        check(`확장 ${expToggled}칸 체크 → 주차 기준 불변(제외 확인)`,
          afterExp.pending === back.pending, `${back.pending} → ${afterExp.pending}`);
      } else {
        console.log("  · 확장 미체크 셀 없음 — 해당 검증 스킵");
      }

      // 모드별 값 기록(파리티는 아래에서 대조).
      globalThis.__modeVals ??= {};
      globalThis.__modeVals[`${name}|${modeLabel}`] = { pending: back.pending, count: latch };
    }

    // (5) 일반 vs mode=test 파리티
    const a = globalThis.__modeVals?.[`${name}|일반`];
    const b = globalThis.__modeVals?.[`${name}|mode=test`];
    if (a && b) {
      check(`${name} · 일반 == mode=test (확정값·pending)`,
        a.count === b.count && a.pending === b.pending, `일반 ${JSON.stringify(a)} / test ${JSON.stringify(b)}`);
    }
  }

  const realErrors = consoleErrors.filter((e) => !/favicon|Download the React DevTools/i.test(e));
  check("콘솔 오류 없음", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  await browser.close();
  console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAIL`} (pass ${pass} / fail ${fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
