// 브라우저 검증 — 실무 경험 [팀 총괄] '아웃풋 이미지 1' 미리보기 카드(버튼→정사각 박스) 전환.
//   구조 검증(org×mode 전수): 이미지 없음 = 점선 정사각 "미리보기" 박스, disabled 동일 레이아웃, 4열 유지, 5카테고리.
//   업로드 라운드트립(encre/operating 1셀만): 박스 클릭 경로의 hidden input 에 파일 주입 → 같은 박스에 이미지 렌더.
//     ⚠ 업로드는 blob 만 생성(팀총괄 DB 무변경 — 검수/완료 클릭 안 함). 저장/DTO/DB 무변경 원칙 준수.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
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
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
const ORGS = process.env.VERIFY_ORG ? [process.env.VERIFY_ORG] : ["encre"];
const ALL_MODES = [{ key: "operating", qs: "" }, { key: "test", qs: "&mode=test" }];
const MODES = process.env.VERIFY_MODE ? ALL_MODES.filter((m) => m.key === process.env.VERIFY_MODE) : ALL_MODES;

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// 1x1 투명 PNG(업로드 라운드트립용).
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const pngPath = resolve(adminRoot, "claudedocs", "_verify-1px.png");
writeFileSync(pngPath, Buffer.from(PNG_B64, "base64"));

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1600 } });
await context.addCookies(cookies);
const page = await context.newPage();

const gotoAndReady = async (url) => {
  for (let a = 0; a < 4; a++) {
    try { await page.goto(url, { waitUntil: "domcontentloaded" }); } catch { await page.waitForTimeout(900); continue; }
    const ok = await page.waitForSelector('[data-slot="select-trigger"].w-56', { timeout: 15000 }).then(() => true).catch(() => false);
    if (ok) { await page.waitForTimeout(800); return; }
    await page.waitForTimeout(900);
  }
  throw new Error("part Select 트리거 미등장");
};
const openSelect = async () => { await page.locator('[data-slot="select-trigger"].w-56').first().click({ timeout: 10000 }); await page.waitForTimeout(400); };
const pickOption = async (t) => { await page.locator('[data-slot="select-item"]', { hasText: t }).first().click({ timeout: 10000 }); await page.waitForTimeout(1500); };
const scrollToOutput = async () => {
  await page.evaluate(() => {
    const h = Array.from(document.querySelectorAll("p")).find((p) => (p.textContent || "").includes("아웃풋 링크"));
    if (h) h.scrollIntoView({ block: "start" });
  });
  await page.waitForTimeout(400);
};

for (const org of ORGS) {
  for (const m of MODES) {
    const tag = `${org}/${m.key}`;
    try {
      const weekQs = process.env.VERIFY_WEEK ? `&week=${encodeURIComponent(process.env.VERIFY_WEEK)}` : "";
      await gotoAndReady(`${BASE}/admin/line-opening/practical-experience?org=${org}&tab=open${m.qs}${weekQs}`);
      await openSelect();
      if (!(await page.locator('[data-slot="select-item"]', { hasText: "팀 총괄" }).count())) { await page.keyboard.press("Escape"); ck(`[${tag}] 팀 총괄 없음(스킵)`, true); continue; }
      await pickOption("팀 총괄");
      await scrollToOutput();

      // 미리보기 박스 = "아웃풋 이미지 …" aria-label 버튼(우측 아이콘 버튼 "이미지 …" 과 구분). 5카테고리 = 5개.
      const boxes = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button[aria-label^="아웃풋 이미지"]'));
        return btns.map((b) => {
          const r = b.getBoundingClientRect();
          const cs = getComputedStyle(b);
          const hasImg = !!b.querySelector("img");
          return {
            w: Math.round(r.width), h: Math.round(r.height),
            square: Math.abs(r.width - r.height) <= 2,
            dashed: cs.borderStyle.includes("dashed"),
            text: (b.textContent || "").trim(),
            hasImg,
            disabled: b.disabled,
          };
        });
      });
      ck(`[${tag}] 미리보기 박스 5개(카테고리별)`, boxes.length === 5, `n=${boxes.length}`);
      const emptyOk = boxes.filter((b) => !b.hasImg).every((b) => b.square && b.dashed && b.text.includes("미리보기") && b.w >= 150 && b.w <= 175);
      ck(`[${tag}] 빈 박스=정사각 점선 "미리보기"(w40≈160)`, emptyOk, JSON.stringify(boxes.map((b) => ({ w: b.w, sq: b.square, dash: b.dashed, t: b.text.slice(0, 6), img: b.hasImg }))));
      // 확장 류(비확장 주간)=disabled 여도 동일 정사각 레이아웃 유지.
      const disabledBoxes = boxes.filter((b) => b.disabled);
      const disabledLayoutOk = disabledBoxes.every((b) => b.square && b.w >= 150 && b.w <= 175);
      ck(`[${tag}] disabled 박스도 동일 정사각 레이아웃`, disabledLayoutOk, `disabled=${disabledBoxes.length}`);

      // 4열 레이아웃이 여전히 유지되는지(박스 도입 후 회귀 없음).
      const gridOk = await page.evaluate(() => {
        const grids = Array.from(document.querySelectorAll('div[class*="grid-cols-[minmax(240px,1.1fr)"]'));
        return grids.length === 5 && grids.every((g) => getComputedStyle(g).gridTemplateColumns.split(" ").length === 4);
      });
      ck(`[${tag}] 1행 4열 레이아웃 유지`, gridOk);

      // 업로드 라운드트립 — encre/operating 첫 셀만(비활성 아닌 도출 류).
      if (tag === "encre/operating") {
        const firstInput = page.locator('input[type="file"]').first();
        await firstInput.setInputFiles(pngPath);
        // 업로드 완료 → 첫 박스(아웃풋 이미지 교체)에 img 렌더 대기.
        const got = await page.waitForFunction(() => {
          const b = document.querySelector('button[aria-label="아웃풋 이미지 교체"]');
          return !!(b && b.querySelector("img"));
        }, { timeout: 20000 }).then(() => true).catch(() => false);
        ck(`[${tag}] 업로드 후 같은 박스에 이미지 렌더`, got);
        if (got) {
          const info = await page.evaluate(() => {
            const b = document.querySelector('button[aria-label="아웃풋 이미지 교체"]');
            const img = b?.querySelector("img");
            const cs = img ? getComputedStyle(img) : null;
            const r = b?.getBoundingClientRect();
            // 제거 = 아이콘 전용 버튼(aria-label "이미지 제거"). 텍스트 없음 + 휴지통 아이콘 빨간색(text-red-600).
            const rm = document.querySelector('button[aria-label="이미지 제거"]');
            const rmSvg = rm?.querySelector("svg");
            const rmColor = rmSvg ? getComputedStyle(rmSvg).color : "";
            // 브라우저가 lab()/rgb() 어느 색공간으로 반환하든 red-600 이면 R(빨강)축이 우세.
            //   신뢰 가능한 판정 = 클래스에 text-red-600 존재 + 회색조(무채색)가 아님.
            const isRed = !!rmSvg && rmSvg.classList.contains("text-red-600");
            return {
              objectFit: cs?.objectFit,
              square: r ? Math.abs(r.width - r.height) <= 2 : false,
              hasRemove: !!rm,
              rmTextEmpty: (rm?.textContent || "").trim() === "",
              rmColor, isRed,
            };
          });
          ck(`[${tag}] 이미지=object-cover·박스 정사각·제거=아이콘전용`, info.objectFit === "cover" && info.square && info.hasRemove && info.rmTextEmpty, JSON.stringify({ objectFit: info.objectFit, square: info.square, rmTextEmpty: info.rmTextEmpty }));
          ck(`[${tag}] 제거 휴지통 아이콘 빨간색`, info.isRed, `color=${info.rmColor}`);
          // 제거(아이콘 버튼) → 다시 "미리보기" 빈 박스.
          await page.locator('button[aria-label="이미지 제거"]').first().click();
          await page.waitForTimeout(500);
          const back = await page.evaluate(() => {
            const b = document.querySelector('button[aria-label="아웃풋 이미지 업로드"]');
            return !!(b && (b.textContent || "").includes("미리보기") && !b.querySelector("img"));
          });
          ck(`[${tag}] 제거 후 빈 "미리보기" 박스 복귀`, back);
        }
        await scrollToOutput();
      }

      await page.screenshot({ path: resolve(adminRoot, "claudedocs", `exp-image-preview-${org}-${m.key}.png`), fullPage: true }).catch(() => {});
    } catch (e) {
      ck(`[${tag}] 실행 오류`, false, e?.message ?? String(e));
    }
  }
}
await browser.close();
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
