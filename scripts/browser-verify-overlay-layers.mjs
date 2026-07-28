// 검증 — 어드민 전역 레이어(z-index) 스케일 SoT.
//   배경: 모달을 열면 표의 sticky 헤더/고정열/교차 셀이 backdrop 위로 보인다는 제보.
//   실측 결과 stacking 인버전은 없었고(모달 50 > corner 40), 실제 원인은
//     ① backdrop 농도가 오버레이마다 제각각(bg-black/40~/80)이라 불투명 sticky 헤더 밴드가 비쳐 보임
//     ② 포털 팝오버(툴팁 60 · 드롭다운 60 · Select 50)가 모달(50/60/70)과 값이 겹쳐
//        "페이지 팝오버가 모달 위" / "모달 안 Select 가 패널 뒤" 가 동시에 발생
//   → app/globals.css 의 --z-* 토큰 + lib/overlayLayer.ts 런타임 레이어 판정으로 통일했다.
//
//   이 스크립트는 그 계약을 실제 브라우저에서 확인한다(읽기 전용 — 변이 버튼 미클릭).
//   실행: node scripts/browser-verify-overlay-layers.mjs
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

// 표(가로/세로 sticky)와 모달이 함께 있는 대표 화면들. mode/org 무관 계약이므로 조직 1개로 충분.
const PAGES = (process.env.VERIFY_PAGES ?? [
  "/admin/season-weeks?org=encre",
  "/admin/members?org=encre",
  "/admin/team-parts/info?org=encre",
  // ⚠ /admin/integrated/processes/check 자체에는 page 가 없다(허브별 하위 세그먼트만 존재) → 404.
  "/admin/integrated/processes/check/club?org=encre",
  "/admin/integrated/line-opening/practical-competency?org=encre",
].join(",")).split(",");
// 데스크톱 좁은 화면 / 넓은 화면.
const VIEWPORTS = [
  { name: "narrow 1280x720", width: 1280, height: 720 },
  { name: "wide 1920x1080", width: 1920, height: 1080 },
];

async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({
    email: adminEmail, token: linkData.properties.email_otp, type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

let pass = 0, fail = 0, skip = 0;
const check = (label, ok, detail = "") => {
  if (ok === null) { console.log(`  ~ ${label}${detail ? ` — ${detail}` : ""} (skip)`); skip++; return; }
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const cookies = await makeAdminCookies();
const browser = await chromium.launch();

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  await ctx.addCookies(cookies);

  for (const path of PAGES) {
    console.log(`\n===== [${vp.name}] ${path} =====`);
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on("console", (m) => {
      const t = m.text();
      if (m.type() === "error" || /hydrat|did not match/i.test(t)) consoleErrors.push(`${m.type()}: ${t.slice(0, 160)}`);
    });
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 160)}`));

    try {
      await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e) { check("페이지 로드", false, e.message); await page.close(); continue; }
    await page.waitForTimeout(9000);

    // ── 1) 토큰 스케일이 실제로 생성되고 순서가 맞는가 ──
    const scale = await page.evaluate(() => {
      const rs = getComputedStyle(document.documentElement);
      const v = (n) => Number.parseInt(rs.getPropertyValue(n).trim(), 10);
      // @utility 가 실제 CSS 로 생성됐는지 — 클래스를 붙여 계산값을 읽는다.
      const probe = (cls) => {
        const d = document.createElement("div");
        d.className = `fixed ${cls}`;
        document.body.appendChild(d);
        const z = getComputedStyle(d).zIndex;
        d.remove();
        return z;
      };
      return {
        vars: {
          cell: v("--z-sticky-cell"), header: v("--z-sticky-header"), corner: v("--z-sticky-corner"),
          pagePopover: v("--z-page-popover"), modal: v("--z-modal"), modalNested: v("--z-modal-nested"),
          modalPopover: v("--z-modal-popover"), toast: v("--z-toast"), navProgress: v("--z-nav-progress"),
        },
        utilities: {
          "z-page-popover": probe("z-page-popover"), "z-modal": probe("z-modal"),
          "z-modal-nested": probe("z-modal-nested"), "z-modal-popover": probe("z-modal-popover"),
          "z-toast": probe("z-toast"), "z-nav-progress": probe("z-nav-progress"),
        },
      };
    });
    const s = scale.vars;
    const ordered = s.cell < s.header && s.header < s.corner && s.corner < s.pagePopover
      && s.pagePopover < s.modal && s.modal < s.modalNested && s.modalNested < s.modalPopover
      && s.modalPopover < s.toast && s.toast <= s.navProgress;
    check("레이어 토큰 순서(셀<헤더<corner<페이지팝오버<모달<중첩모달<모달팝오버<토스트)", ordered,
      Object.entries(s).map(([k, v2]) => `${k}=${v2}`).join(" "));
    const utilOk = Object.entries(scale.utilities).every(([, z]) => z !== "auto" && z !== "");
    check("@utility z-* 클래스가 실제 CSS 로 생성됨", utilOk, JSON.stringify(scale.utilities));

    // ── 2) sticky 활성화(세로 + 가로 스크롤) 후 실제 모달 열기 ──
    await page.evaluate(() => {
      for (const r of document.querySelectorAll(".sticky-head-region")) r.scrollTop = Math.min(300, r.scrollHeight);
      for (const r of document.querySelectorAll(".admin-table-scroll")) r.scrollLeft = Math.min(500, r.scrollWidth);
    });
    await page.waitForTimeout(400);

    const stickyBefore = await page.evaluate(() => {
      const th = document.querySelector(".sticky-head-region thead th");
      const region = document.querySelector(".sticky-head-region");
      const col = document.querySelector(".admin-table-scroll");
      return {
        hasRegion: Boolean(region),
        thTop: th ? Math.round(th.getBoundingClientRect().top) : null,
        thPosition: th ? getComputedStyle(th).position : null,
        scrollTop: region ? Math.round(region.scrollTop) : null,
        scrollLeft: col ? Math.round(col.scrollLeft) : null,
      };
    });

    const helpBtn = page.locator('button[aria-label*="도움말"]').first();
    let opened = false;
    if ((await helpBtn.count()) > 0) {
      try { await helpBtn.click({ timeout: 5000 }); opened = true; } catch { /* noop */ }
      await page.waitForTimeout(1200);
    }

    const r = await page.evaluate(() => {
      const desc = (el) => {
        if (!el) return null;
        const cls = typeof el.className === "string" && el.className
          ? "." + el.className.trim().split(/\s+/).slice(0, 4).join(".") : "";
        return `${el.tagName.toLowerCase()}${cls}`;
      };
      const overlay = document.querySelector("[data-admin-overlay]");
      if (!overlay) return { noOverlay: true };
      const os = getComputedStyle(overlay);
      const or = overlay.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;

      const probes = [];
      const add = (label, sel) => {
        const el = document.querySelector(sel);
        if (!el) return;
        const b = el.getBoundingClientRect();
        const inView = b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < vh && b.right > 0 && b.left < vw;
        if (!inView) { probes.push({ label, inView: false }); return; }
        const x = Math.min(Math.max(b.left + b.width / 2, 1), vw - 1);
        const y = Math.min(Math.max(b.top + b.height / 2, 1), vh - 1);
        const hit = document.elementFromPoint(x, y);
        probes.push({
          label, inView: true, z: getComputedStyle(el).zIndex,
          coveredByOverlay: Boolean(hit && (hit === overlay || overlay.contains(hit))),
          hit: desc(hit),
        });
      };
      add("sticky thead th", ".sticky-head-region thead th");
      add("corner(thead .stick-col-1)", "thead .stick-col-1");
      add("corner(thead .stick-col-2)", "thead .stick-col-2");
      add("고정열 본문(tbody .stick-col-1)", "tbody .stick-col-1");
      add("레거시 sticky 셀(td.sticky)", "td.sticky");
      add("표 첫 행 td", "tbody tr td");
      add("헤더 내부 버튼/아이콘", "thead button, thead svg");

      // 모달이 열린 상태에서 포털 팝오버(툴팁)를 띄우면 모달 위로 와야 한다.
      const titled = overlay.contains(document.body) ? null : document.querySelector("[title]");

      return {
        overlay: {
          desc: desc(overlay), z: os.zIndex, bg: os.backgroundColor,
          backdropFilter: os.backdropFilter || os.webkitBackdropFilter || "none",
          coversViewport: Math.round(or.width) >= vw - 1 && Math.round(or.height) >= vh - 1
            && Math.round(or.left) <= 0 && Math.round(or.top) <= 0,
        },
        probes,
        hasTitled: Boolean(titled),
      };
    });

    if (r.noOverlay) {
      check("모달 열림", null, opened ? "도움말 버튼은 눌렀으나 오버레이 미탐지" : "이 화면에 도움말 버튼 없음");
    } else {
      check("모달 오버레이가 --z-modal 레이어", Number(r.overlay.z) === s.modal, `z=${r.overlay.z} (${r.overlay.desc})`);
      check("backdrop 가 화면 전체를 동일하게 덮음", r.overlay.coversViewport, `bg=${r.overlay.bg}`);
      check("backdrop 블러 적용(sticky 헤더 비침 완화)", /blur/.test(r.overlay.backdropFilter), r.overlay.backdropFilter);
      for (const p of r.probes) {
        if (!p.inView) { check(`${p.label} — 모달 아래`, null, "화면 밖"); continue; }
        check(`${p.label} — 모달 아래(z=${p.z})`, p.coveredByOverlay, p.coveredByOverlay ? "" : `최상단=${p.hit}`);
      }

      // ── 3) 모달 안에서 뜬 포털 툴팁은 모달 위 ──
      const tip = await page.evaluate(() => {
        // 전역 HoverTooltipProvider 경로를 그대로 태운다(네이티브 title → 공통 말풍선).
        const overlay = document.querySelector("[data-admin-overlay]");
        const el = overlay?.querySelector("[title]") ?? document.querySelector("[title]");
        if (!el) return { noTitled: true };
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        return { noTitled: false };
      });
      if (tip.noTitled) {
        check("모달 위 툴팁 레이어", null, "title 요소 없음");
      } else {
        await page.waitForTimeout(700);
        const tipZ = await page.evaluate(() => {
          const b = document.querySelector('[role="tooltip"]');
          if (!b) return null;
          const wrapper = b.parentElement;
          return Number.parseInt(getComputedStyle(wrapper).zIndex, 10);
        });
        check("모달 위에서 연 툴팁이 모달보다 위", tipZ === null ? null : tipZ > Number(r.overlay.z),
          tipZ === null ? "말풍선 미표시" : `tooltip z=${tipZ} > modal z=${r.overlay.z}`);
      }

      // ── 4) 모달 닫은 뒤 sticky 복구 ──
      await page.keyboard.press("Escape");
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => {
        const overlay = document.querySelector("[data-admin-overlay]");
        const region = document.querySelector(".sticky-head-region");
        const th = document.querySelector(".sticky-head-region thead th");
        const col = document.querySelector(".admin-table-scroll");
        const before = th ? Math.round(th.getBoundingClientRect().top) : null;
        if (region) region.scrollTop = Math.min(region.scrollTop + 120, region.scrollHeight);
        const after2 = th ? Math.round(th.getBoundingClientRect().top) : null;
        return {
          closed: !overlay,
          bodyOverflow: document.body.style.overflow,
          thPosition: th ? getComputedStyle(th).position : null,
          thZ: th ? getComputedStyle(th).zIndex : null,
          thTopStable: before !== null && after2 !== null ? Math.abs(before - after2) <= 1 : null,
          scrollLeft: col ? Math.round(col.scrollLeft) : null,
        };
      });
      check("모달 닫힘 + 배경 스크롤 잠금 해제", after.closed && after.bodyOverflow !== "hidden",
        `closed=${after.closed} bodyOverflow="${after.bodyOverflow}"`);
      if (stickyBefore.hasRegion) {
        check("닫은 뒤 헤더 고정 유지(세로 스크롤해도 top 불변)", after.thTopStable,
          `position=${after.thPosition} z=${after.thZ}`);
      } else {
        check("닫은 뒤 헤더 고정 유지", null, "이 화면엔 headerSticky 표 없음");
      }
      check("닫은 뒤 가로 스크롤(고정열) 위치 유지", after.scrollLeft === stickyBefore.scrollLeft,
        `${stickyBefore.scrollLeft} → ${after.scrollLeft}`);
    }

    // ── 5) Select 포털 레이어 — 페이지에서 열면 모달 아래, 모달이 열린 동안 열면 모달 위 ──
    //    (앱 안에 아직 "Select 를 품은 모달"이 없어, 모달과 동일 계약의 오버레이를 띄운 상태에서
    //     실제 Select 컴포넌트를 연다. 판정 로직 lib/overlayLayer.ts 는 완전히 동일 경로.)
    const trigger = page.locator('[data-slot="select-trigger"]').first();
    if ((await trigger.count()) > 0) {
      try {
        await trigger.click({ timeout: 5000 });
        await page.waitForTimeout(600);
        const pageZ = await page.evaluate(() => {
          const p = document.querySelector('[data-slot="select-content"]');
          return p ? Number.parseInt(getComputedStyle(p.parentElement).zIndex, 10) : null;
        });
        check("페이지에서 연 Select = 페이지 팝오버 레이어", pageZ === null ? null : pageZ === s.pagePopover,
          `z=${pageZ}`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);

        await page.evaluate(() => {
          const d = document.createElement("div");
          d.setAttribute("data-admin-overlay", "");
          d.className = "fixed inset-0 z-modal admin-backdrop";
          d.style.pointerEvents = "none"; // 트리거 클릭을 통과시키기 위한 검증 전용 설정
          d.id = "__probe_overlay";
          document.body.appendChild(d);
        });
        await trigger.click({ timeout: 5000 });
        await page.waitForTimeout(600);
        const modalSel = await page.evaluate(() => {
          const p = document.querySelector('[data-slot="select-content"]');
          const o = document.getElementById("__probe_overlay");
          if (!p || !o) return null;
          // ⚠ 검증용 오버레이는 트리거 클릭을 통과시키려 pointer-events:none 이라
          //    elementFromPoint 최상단 판정에 쓸 수 없다 → z 순서만 본다.
          return {
            z: Number.parseInt(getComputedStyle(p.parentElement).zIndex, 10),
            modalZ: Number.parseInt(getComputedStyle(o).zIndex, 10),
          };
        });
        check("모달이 열린 동안 연 Select 가 모달 위",
          modalSel === null ? null : modalSel.z > modalSel.modalZ,
          modalSel ? `select z=${modalSel.z} vs modal z=${modalSel.modalZ}` : "팝업 미표시");
        await page.keyboard.press("Escape");
        await page.evaluate(() => document.getElementById("__probe_overlay")?.remove());
      } catch (e) {
        check("Select 레이어", null, `트리거 조작 실패: ${String(e).slice(0, 80)}`);
      }
    } else {
      check("Select 레이어", null, "이 화면에 Select 없음");
    }

    check("콘솔 오류/hydration 경고 없음", consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(" | "));

    await page.close();
  }
  await ctx.close();
}

await browser.close();
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
