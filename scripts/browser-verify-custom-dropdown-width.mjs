// 커스텀 주차 드롭다운(공통 base-ui Select 미사용) 폭/줄바꿈 SoT 브라우저 검증.
//
// 실제 앱 라우트는 admin 세션/org/데이터가 필요하므로, 여기서는 대상 컴포넌트가 렌더하는
// "동일 마크업 + 동일 계산 CSS"(new SoT class 의 computed 값)를 재현해 CSS 거동만 검증한다.
//   - trigger: min-width 220px (CompetencyLineManageBoard 기준)
//   - popup:  width:max-content; min-width:100%; max-width:calc(100vw-2rem); overflow-x:hidden
//   - option 행: 1행 주차명 / 2행 날짜범위 (whitespace:normal 기본)
// 대조군으로 기존 고정폭(width:280px)도 같이 렌더해 "데스크톱에서 날짜가 줄바꿈되던" 회귀를 확인.
import { chromium } from "playwright-core";
import { execSync } from "node:child_process";

function findChromeExe() {
  const base = `${process.env.LOCALAPPDATA}\\ms-playwright`;
  const dirs = execSync(`dir /b "${base}"`, { shell: "cmd.exe" })
    .toString()
    .split(/\r?\n/)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort();
  const latest = dirs[dirs.length - 1];
  return `${base}\\${latest}\\chrome-win64\\chrome.exe`;
}

// 가장 긴 옵션(개설 대상 접미 + 긴 날짜)을 포함한 대표 주차 목록.
const WEEKS = [
  { name: "2026년 겨울 시즌 13주차 · 개설 대상 · 현재", date: "2026년 12월 29일 (월) ~ 2027년 1월 4일 (일)" },
  { name: "2026년 가을 시즌 3주차", date: "2026년 9월 14일 (월) ~ 9월 20일 (일)" },
  { name: "2026년 봄 시즌 1주차", date: "2026년 3월 30일 (월) ~ 4월 5일 (일)" },
];

function pageHtml() {
  const options = WEEKS.map(
    (w) => `
    <button type="button" class="opt">
      <div class="row-name">${w.name}</div>
      <div class="row-date">${w.date}</div>
    </button>`,
  ).join("");
  // .popup-new = new SoT 계산값 / .popup-old = 기존 고정폭 대조군
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
    * { box-sizing: border-box; margin: 0; }
    body { font: 16px/1.4 -apple-system, system-ui, sans-serif; padding: 12px; }
    .field { display: flex; align-items: center; gap: 8px; }
    .rel { position: relative; }
    .trigger { display: inline-flex; min-width: 220px; align-items: center; justify-content: space-between;
               gap: 8px; border: 1px solid #ccc; border-radius: 8px; padding: 8px 12px; font-weight: 600; }
    .popup-new, .popup-old { position: absolute; z-index: 20; margin-top: 4px; max-height: 280px;
               overflow-y: auto; border: 1px solid #ccc; border-radius: 8px; background: #fff;
               padding: 4px 0; box-shadow: 0 4px 12px rgba(0,0,0,.15); }
    /* new SoT: components/ui/select.tsx 와 동일 원칙 (w-max min-w-full max-w-[calc(100vw-2rem)]) */
    .popup-new { width: max-content; min-width: 100%; max-width: calc(100vw - 2rem); overflow-x: hidden; }
    /* old: 기존 CompetencyLineManageBoard 고정폭 */
    .popup-old { width: 280px; }
    .opt { display: block; width: 100%; text-align: left; padding: 6px 12px; background: none; border: 0; }
    .row-name { font-size: 14px; font-weight: 500; }
    .row-date { font-size: 12px; color: #666; }
  </style></head><body>
    <div class="field">
      <div class="rel" id="rel-new">
        <button class="trigger">2026년 겨울 시즌 13주차</button>
        <div class="popup-new" id="popup-new">${options}</div>
      </div>
    </div>
    <div style="height:320px"></div>
    <div class="field">
      <div class="rel" id="rel-old">
        <button class="trigger">2026년 겨울 시즌 13주차</button>
        <div class="popup-old" id="popup-old">${options}</div>
      </div>
    </div>
  </body></html>`;
}

// 텍스트 노드의 시각적 줄 수 = Range.getClientRects().length
function measureScript() {
  return `(() => {
    const lineCount = (div) => {
      const r = document.createRange();
      r.selectNodeContents(div.firstChild);
      return r.getClientRects().length;
    };
    const measurePopup = (id) => {
      const popup = document.getElementById(id);
      const rows = [...popup.querySelectorAll('.opt')].map((opt) => ({
        nameLines: lineCount(opt.querySelector('.row-name')),
        dateLines: lineCount(opt.querySelector('.row-date')),
      }));
      const pr = popup.getBoundingClientRect();
      return { width: Math.round(pr.width), right: Math.round(pr.right), rows };
    };
    const trigger = document.querySelector('#rel-new .trigger').getBoundingClientRect();
    // popupOld(고정 280px)는 회귀 대조용일 뿐 실제 앱엔 없음 → 측정 후 숨겨 doc 가로폭에서 제외.
    const popupOld = measurePopup('popup-old');
    const popupNew = measurePopup('popup-new');
    document.getElementById('rel-old').style.display = 'none';
    const docScrollW = document.documentElement.scrollWidth; // new-only 기준
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      docScrollW,
      triggerW: Math.round(trigger.width),
      popupNew,
      popupOld,
    };
  })()`;
}

async function run() {
  const browser = await chromium.launch({ executablePath: findChromeExe(), headless: true });
  const html = pageHtml();
  const results = {};
  for (const [label, vp] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 375, height: 720 }],
    ["narrow", { width: 260, height: 640 }],
  ]) {
    const page = await browser.newPage({ viewport: vp });
    await page.setContent(html, { waitUntil: "load" });
    results[label] = await page.evaluate(measureScript());
    await page.close();
  }
  await browser.close();

  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, detail });

  const d = results.desktop;
  const m = results.mobile;
  const n = results.narrow;

  // 1) 데스크톱: new SoT — 모든 행이 1줄 (주차명/날짜 줄바꿈 0)
  const dNewSingle = d.popupNew.rows.every((r) => r.nameLines === 1 && r.dateLines === 1);
  add("desktop/new: 모든 옵션 행 1줄 (줄바꿈 없음)", dNewSingle, JSON.stringify(d.popupNew.rows));
  // 2) 데스크톱: 대조군(old 280px) — 긴 날짜/이름이 2줄로 깨짐(=기존 버그 재현)
  const dOldWrapped = d.popupOld.rows.some((r) => r.nameLines > 1 || r.dateLines > 1);
  add("desktop/old(280px): 최소 1개 행이 2줄로 깨짐(회귀 대조)", dOldWrapped, JSON.stringify(d.popupOld.rows));
  // 3) 데스크톱: new 팝업 폭 >= 트리거 폭(min-w-full) 이고 콘텐츠에 맞춰 확장(>280 고정보다 넓음)
  add("desktop/new: 팝업 폭 >= 트리거 폭 (min-w-full)", d.popupNew.width >= d.triggerW,
      `popup=${d.popupNew.width} trigger=${d.triggerW}`);
  add("desktop/new: 콘텐츠만큼 확장(>280 고정폭)", d.popupNew.width > 280, `popup=${d.popupNew.width}`);
  // 4) 데스크톱: 가로 스크롤 없음
  add("desktop: 가로 스크롤 없음", d.docScrollW <= d.viewport.w, `docScrollW=${d.docScrollW} vw=${d.viewport.w}`);

  // 5) 모바일(375, 콘텐츠<캡): 캡 이하이면서 여유가 있어 여전히 1줄 (불필요한 줄바꿈 없음)
  const mCap = m.viewport.w - 32;
  add("mobile/new: 팝업 폭 <= viewport-2rem 캡", m.popupNew.width <= mCap + 1,
      `popup=${m.popupNew.width} cap=${mCap}`);
  add("mobile/new: 콘텐츠가 캡보다 짧으면 1줄 유지", m.popupNew.rows.every((r) => r.nameLines === 1 && r.dateLines === 1),
      JSON.stringify(m.popupNew.rows));
  add("mobile: 가로 스크롤 없음", m.docScrollW <= m.viewport.w, `docScrollW=${m.docScrollW} vw=${m.viewport.w}`);

  // 6) 초협소(260, 콘텐츠>캡): max-w 캡이 실제로 작동 → 줄바꿈 허용(클리핑/생략 아님)
  const nCap = n.viewport.w - 32;
  add("narrow/new: 팝업 폭 <= viewport-2rem 캡(실제 작동)", n.popupNew.width <= nCap + 1,
      `popup=${n.popupNew.width} cap=${nCap}`);
  const nWrapped = n.popupNew.rows.some((r) => r.nameLines > 1 || r.dateLines > 1);
  add("narrow/new: 공간 부족 시 줄바꿈 허용(생략 아님)", nWrapped, JSON.stringify(n.popupNew.rows));
  add("narrow: 가로 스크롤 없음", n.docScrollW <= n.viewport.w, `docScrollW=${n.docScrollW} vw=${n.viewport.w}`);
  add("narrow/new: 팝업 우측 끝 뷰포트 내", n.popupNew.right <= n.viewport.w, `right=${n.popupNew.right} vw=${n.viewport.w}`);

  console.log(JSON.stringify(results, null, 2));
  console.log("\n=== CHECKS ===");
  let allPass = true;
  for (const c of checks) {
    if (!c.pass) allPass = false;
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}  — ${c.detail}`);
  }
  console.log(`\n${allPass ? "ALL PASS" : "SOME FAILED"}`);
  process.exit(allPass ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(2);
});
