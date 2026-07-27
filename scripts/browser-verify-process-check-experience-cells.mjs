// 브라우저 검증(보강) — 프로세스 체크 · [실무 경험 급] 표 셀 스타일.
//
//   experience 허브는 팀 탭 → 팀 보드 fetch 후에야 액트 표가 생긴다. 현재 주차에 팀 로스터가
//   없으면 표가 아예 없으므로, 주차 드롭다운을 훑어 팀이 잡히는 주차를 찾아 검증한다.
//   (읽기 전용 — 주차 선택/팀 탭 클릭만. 저장/검수/롤백 없음.)
//
//   검증 계약: 소속 라인 급·종류·카페 = 공용 배지 / 별·방패 = 초록 · 번개 = 빨강(셀값).
//   run: node scripts/browser-verify-process-check-experience-cells.mjs
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

const ORGS = (process.env.ORGS ?? "encre,oranke,phalanx").split(",");
const MODES = ["", "&mode=test"];
const BADGE_COLUMNS = ["소속 라인 급", "종류", "카페"];

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
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
  await server.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  console.log(`admin = ${email}`);
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

const readActTable = (page) =>
  page.evaluate((cols) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const t = Array.from(document.querySelectorAll("table")).find((tb) =>
      Array.from(tb.querySelectorAll("thead th")).some((th) => /소속 라인 급/.test(th.textContent || "")));
    if (!t) return null;
    const labels = Array.from(t.querySelectorAll("thead th")).map((th) => norm(th.textContent));
    const idxOf = (l) => labels.findIndex((x) => x === l || x.startsWith(l));
    const durIdx = idxOf("소요 시간(m)");
    const out = { headers: labels, badge: {}, points: { a: [], b: [], c: [] }, rows: 0 };
    for (const c of cols) out.badge[c] = [];
    for (const tr of Array.from(t.querySelectorAll("tbody tr"))) {
      const tds = Array.from(tr.querySelectorAll("td"));
      if (tds.length < labels.length - 1) continue;
      out.rows += 1;
      for (const c of cols) {
        const i = idxOf(c);
        if (i < 0 || !tds[i]) continue;
        const b = tds[i].querySelector('[data-slot="badge"],[data-slot="badge-button"]');
        out.badge[c].push({
          text: norm(tds[i].textContent),
          hasBadge: Boolean(b),
          sig: b ? `${getComputedStyle(b).color}|${getComputedStyle(b).backgroundColor}` : null,
          nowrap: b ? getComputedStyle(b).whiteSpace : null,
        });
      }
      if (durIdx >= 0) {
        const keys = ["a", "b", "c"];
        for (let k = 0; k < 3; k += 1) {
          const cell = tds[durIdx + 1 + k];
          if (cell) out.points[keys[k]].push({ text: norm(cell.textContent), color: getComputedStyle(cell).color });
        }
      }
    }
    return out;
  }, BADGE_COLUMNS);

async function tokens(page) {
  return page.evaluate(() => {
    const p = document.createElement("span");
    p.style.display = "none";
    document.body.appendChild(p);
    p.className = "text-point-good";
    const good = getComputedStyle(p).color;
    p.className = "text-point-danger";
    const danger = getComputedStyle(p).color;
    p.remove();
    return { good, danger };
  });
}

async function main() {
  const cookies = await makeAdminCookies();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1800, height: 1200 } });
  await ctx.addCookies(cookies);
  const page = await ctx.newPage();
  let tk = null;
  const valueColor = {};
  for (const c of BADGE_COLUMNS) valueColor[c] = new Map();
  let covered = 0;

  for (const org of ORGS) {
    for (const mode of MODES) {
      const label = `experience | ${org} | ${mode ? "mode=test" : "일반"}`;
      const url = `${BASE}/admin/integrated/processes/check/experience?org=${org}${mode}`;
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForFunction(() => /상태창 1|클럽이 지정/.test(document.body.innerText || ""), { timeout: 90000, polling: 500 })
        .catch(() => {});
      if (!tk) tk = await tokens(page);

      // 주차 드롭다운 후보 — "주차 선택" select 의 option value 들.
      const weekOptions = await page.evaluate(() => {
        const sel = Array.from(document.querySelectorAll("select"))
          .find((s) => (s.getAttribute("aria-label") || "").includes("주차") ||
            Array.from(s.options).some((o) => /W\d+|주차/.test(o.textContent || "")));
        if (!sel) return [];
        return Array.from(sel.options).map((o) => ({ value: o.value, text: (o.textContent || "").trim() }));
      });

      let table = null;
      let usedWeek = "(기본)";
      for (const opt of [{ value: null, text: "(기본)" }, ...weekOptions]) {
        if (opt.value !== null) {
          await page.evaluate((v) => {
            const sel = Array.from(document.querySelectorAll("select"))
              .find((s) => Array.from(s.options).some((o) => o.value === v));
            if (!sel) return;
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
            setter.call(sel, v);
            sel.dispatchEvent(new Event("change", { bubbles: true }));
          }, opt.value);
        }
        // 팀 탭 + 팀 보드 로딩 대기(최대 25s) 후 표 확인.
        try {
          await page.waitForFunction(
            () => Array.from(document.querySelectorAll("table")).some((t) =>
              Array.from(t.querySelectorAll("thead th")).some((th) => /소속 라인 급/.test(th.textContent || ""))),
            { timeout: 25000, polling: 500 },
          );
        } catch { /* 이 주차엔 표 없음 */ }
        table = await readActTable(page);
        if (table && table.rows > 0) { usedWeek = opt.text; break; }
      }

      console.log(`\n▸ ${label}  (HTTP ${resp?.status()}, 주차 ${usedWeek})`);
      check("HTTP 정상", (resp?.status() ?? 0) < 400, `status=${resp?.status()}`);
      if (!table || table.rows === 0) {
        console.log(`  · 액트 표 없음(모든 주차에서 팀 로스터 0) — 셀 검증 skip`);
        continue;
      }
      covered += 1;
      check("파트 구분 컬럼 존재(experience 전용)", table.headers.some((h) => h.startsWith("파트 구분")),
        table.headers.join(" / "));
      for (const c of BADGE_COLUMNS) {
        const cells = (table.badge[c] ?? []).filter((x) => x.text && x.text !== "-" && x.text !== "—");
        if (cells.length === 0) { console.log(`    · ${c}: 표본 0 (skip)`); continue; }
        check(`${c} 배지 적용(${cells.length}셀)`, cells.every((x) => x.hasBadge));
        check(`${c} nowrap`, cells.every((x) => x.nowrap === "nowrap"));
        let conflict = null;
        for (const x of cells) {
          const prev = valueColor[c].get(x.text);
          if (prev === undefined) valueColor[c].set(x.text, x.sig);
          else if (prev !== x.sig) conflict = x.text;
        }
        check(`${c} 값→색 일관`, !conflict, conflict ?? `${valueColor[c].size}값 누적`);
      }
      for (const [k, want] of [["a", "good"], ["b", "good"], ["c", "danger"]]) {
        const cells = table.points[k] ?? [];
        if (cells.length === 0) continue;
        const expect = want === "good" ? tk.good : tk.danger;
        const bad = cells.filter((x) => x.color !== expect);
        check(`po.${k.toUpperCase()} 셀값 ${want === "good" ? "초록" : "빨강"}(${cells.length}셀)`,
          bad.length === 0, bad.slice(0, 3).map((x) => `${x.text}=${x.color}`).join(",") || expect);
      }
    }
  }

  await browser.close();
  console.log(`\n검증된 (조직×모드) 조합: ${covered} / ${ORGS.length * MODES.length}`);
  console.log(`결과: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
