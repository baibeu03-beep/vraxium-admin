// 브라우저 검증 — 실무 경험 [라인 개설] 개설 진행 단계 플로우(단일 pill → 4단계 스텝 UI 교체).
//   SoT = currentProgress(서버 team-overall 상태). 비파괴(mutation 없음) — 표시·파생·반응성만 검증.
//   검증 항목(org × mode 전수):
//     · 4단계(신청필요→신청완료→검수완료→개설완료)가 항상 모두 노출
//     · 현재 단계 정확히 1개(aria-current="step") + data-state 순서와 위치 일치
//     · 지나온 단계=아이콘 있음 / 미도달 단계=아이콘 없음
//     · 연결선(3개)이 현재 진행도까지 활성(active=currentIndex)
//     · 상단 필터 영역에 스텝 컨테이너 정확히 1개(중복 렌더 없음)
//     · 파트 선택 시 현재 단계는 1·2단계까지만(3·4단계로 추론 금지)
//     · 기존 파트 드롭다운 완료 체크와 진행 단계 비모순
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
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"),
  ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE),
  brow = createClient(URL_, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
const ORGS = process.env.VERIFY_ORG ? [process.env.VERIFY_ORG] : ["encre", "oranke", "phalanx"];
const ALL_MODES = [
  { key: "operating", qs: "" },
  { key: "test", qs: "&mode=test" },
];
const MODES = process.env.VERIFY_MODE
  ? ALL_MODES.filter((mode) => mode.key === process.env.VERIFY_MODE)
  : ALL_MODES;

// 단계 순서(SoT resolveExperienceOpeningProgress 와 동일) + 표시 문구.
const ORDER = ["required", "application_completed", "review_completed", "opened"];
const TITLES = ["개설 신청 필요", "개설 신청 완료", "개설 검수 완료", "개설 완료"];
// 파트 선택 시 현재 단계로 허용되는 인덱스(신청까지만; 검수/개설 추론 금지).
const PART_MAX_INDEX = 1;

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = [];
const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookies = cap.map((i) => ({ name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax" }));

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
await context.addCookies(cookies);
const page = await context.newPage();

// 스텝 컨테이너 상태 읽기 — data-state(현재 progress) + 각 단계 li 의 문구/아이콘/aria-current + 연결선 활성.
const readSteps = () =>
  page.evaluate(() => {
    const ol = document.querySelector('[data-slot="experience-opening-progress-steps"]');
    if (!ol) return null;
    const stepEls = Array.from(ol.querySelectorAll("li")).filter(
      (li) => li.getAttribute("aria-hidden") !== "true",
    );
    const connectorEls = Array.from(ol.querySelectorAll('li[aria-hidden="true"]'));
    return {
      state: ol.getAttribute("data-state"),
      steps: stepEls.map((li) => {
        const svg = li.querySelector("svg");
        const cls = svg ? svg.getAttribute("class") || "" : "";
        return {
          title: (li.querySelector("span > span.font-semibold, span > span")?.textContent || "").trim(),
          text: (li.textContent || "").trim(),
          current: li.getAttribute("aria-current") === "step",
          hasIcon: !!svg,
          iconCheck: cls.includes("check"),
          iconDot: cls.includes("circle-dot"),
        };
      }),
      connectors: connectorEls.map((li) => {
        const span = li.querySelector("span");
        return (span?.getAttribute("class") || "").includes("emerald");
      }),
    };
  });

const gotoAndReady = async (url) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch {
      await page.waitForTimeout(900);
      continue;
    }
    const ready = await page
      .waitForSelector('[data-slot="select-trigger"].w-56', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (ready) {
      await page.waitForSelector('[data-slot="experience-opening-progress-steps"]', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(800);
      return;
    }
    await page.waitForTimeout(900);
  }
  throw new Error("part Select 트리거 미등장(부트 실패)");
};

const readTrigger = () =>
  page.evaluate(() => {
    const val = document.querySelector('[data-slot="select-trigger"].w-56 [data-slot="select-value"]');
    return {
      text: val ? (val.textContent || "").trim() : "",
      hasCheck: !!(val && val.querySelector("svg")),
    };
  });

const openSelect = async () => {
  await page.locator('[data-slot="select-trigger"].w-56').first().click({ timeout: 10000 });
  await page.waitForTimeout(400);
};
const pickOption = async (text) => {
  await page.locator('[data-slot="select-item"]', { hasText: text }).first().click({ timeout: 10000 });
  await page.waitForTimeout(1500);
};

// 단계 스냅샷 1건에 대한 불변식 전수 검증.
const assertStepsInvariant = (tag, label, snap) => {
  if (!snap) {
    ck(`[${tag}] ${label} 스텝 컨테이너 렌더`, false, "스텝 컨테이너 없음");
    return null;
  }
  const idx = ORDER.indexOf(snap.state);
  // ① 4단계 전체 노출 + 문구 순서 고정.
  const titlesOk =
    snap.steps.length === 4 && TITLES.every((t, i) => snap.steps[i].text.includes(t));
  ck(`[${tag}] ${label} 4단계 전체 노출+문구`, titlesOk, `titles=${snap.steps.map((s) => s.title).join("|")} state=${snap.state}`);
  // ② 현재 단계 정확히 1개 + data-state 위치 일치.
  const currents = snap.steps.map((s, i) => (s.current ? i : -1)).filter((i) => i >= 0);
  const currentOk = currents.length === 1 && currents[0] === idx && snap.steps[idx]?.iconDot;
  ck(`[${tag}] ${label} 현재 단계 1개+위치일치(idx=${idx})`, currentOk, `currents=${JSON.stringify(currents)} dot=${snap.steps[idx]?.iconDot}`);
  // ③ 지나온 단계=체크 아이콘 / 현재=dot / 미도달=아이콘 없음.
  const iconsOk = snap.steps.every((s, i) => {
    if (i < idx) return s.iconCheck && !s.current;
    if (i === idx) return s.iconDot && s.current;
    return !s.hasIcon && !s.current;
  });
  ck(`[${tag}] ${label} 완료=체크/현재=dot/미도달=무아이콘`, iconsOk, snap.steps.map((s) => `${s.iconCheck ? "✓" : s.iconDot ? "●" : "·"}`).join(""));
  // ④ 연결선 3개 + 현재 진행도까지 활성(active = idx).
  const activeCount = snap.connectors.filter(Boolean).length;
  const connOk = snap.connectors.length === 3 && activeCount === idx;
  ck(`[${tag}] ${label} 연결선 활성=진행도(${idx})`, connOk, `connectors=${JSON.stringify(snap.connectors)}`);
  return idx;
};

for (const org of ORGS) {
  for (const m of MODES) {
    const tag = `${org}/${m.key}`;
    try {
      const weekQs = process.env.VERIFY_WEEK
        ? `&week=${encodeURIComponent(process.env.VERIFY_WEEK)}`
        : "";
      await gotoAndReady(`${BASE}/admin/line-opening/practical-experience?org=${org}&tab=open${m.qs}${weekQs}`);

      // 초기 진입(기본 선택) 스텝 불변식.
      const snap0 = await readSteps();
      assertStepsInvariant(tag, "초기", snap0);

      // 상단 필터 영역 스텝 컨테이너 단일 렌더.
      const count0 = await page.locator('[data-slot="experience-opening-progress-steps"]').count();
      ck(`[${tag}] 스텝 컨테이너 단일 렌더`, count0 === 1, `count=${count0}`);

      // 팀 총괄 선택 → 4단계 팀 상태 기준. 파트 드롭다운 옵션 수집.
      await openSelect();
      const optTexts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-slot="select-item"]')).map((el) => (el.textContent || "").trim()),
      );
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);

      const hasOverall = optTexts.some((t) => t.includes("팀 총괄"));
      if (hasOverall) {
        await openSelect();
        await pickOption("팀 총괄");
        const snapO = await readSteps();
        assertStepsInvariant(tag, "팀총괄", snapO);
        // 팀 총괄 선택 후에도 스텝 컨테이너 단일.
        const countO = await page.locator('[data-slot="experience-opening-progress-steps"]').count();
        ck(`[${tag}] 팀총괄 후 스텝 단일 렌더`, countO === 1, `count=${countO}`);
        await page.screenshot({ path: resolve(adminRoot, "claudedocs", `exp-steps-${org}-${m.key}-overall.png`), fullPage: false }).catch(() => {});
      }

      // 실제 파트 선택 → 현재 단계는 1·2단계까지만 + 트리거 완료체크 비모순.
      const partText = optTexts.find((t) => !t.includes("팀 총괄"));
      if (partText) {
        await openSelect();
        await pickOption(partText);
        const snapP = await readSteps();
        const idxP = assertStepsInvariant(tag, "파트", snapP);
        if (idxP !== null) {
          ck(`[${tag}] 파트 현재단계 ≤ 신청완료(추론금지)`, idxP <= PART_MAX_INDEX, `idx=${idxP} state=${snapP.state}`);
          const trigP = await readTrigger();
          // 트리거 완료 체크 ⇔ 파트 신청완료(idx===1) 비모순.
          ck(`[${tag}] 트리거 체크 ⇔ 파트 신청완료 비모순`, trigP.hasCheck === (idxP === 1), `trigCheck=${trigP.hasCheck} idx=${idxP}`);
        }
        await page.screenshot({ path: resolve(adminRoot, "claudedocs", `exp-steps-${org}-${m.key}-part.png`), fullPage: false }).catch(() => {});
      }
    } catch (e) {
      ck(`[${tag}] 반복 실행 오류`, false, e?.message ?? String(e));
      try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", `exp-steps-${org}-${m.key}-error.png`), fullPage: true }); } catch {}
    }
  }
}

await browser.close();
console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
