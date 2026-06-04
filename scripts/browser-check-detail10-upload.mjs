// details 10 브라우저 E2E — 테스트 유저(demoUserId) 모드에서 detail 카드 1 메인이미지
// 업로드 → 저장 → 새로고침 후에도 supabase public URL 이 유지되는지 확인.
//   node scripts/browser-check-detail10-upload.mjs [base]
import { chromium } from "playwright";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] || "https://vraxium.vercel.app";
const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad"; // T윤도현 (test_user_markers 등재)
const BUCKET_MARK = "portfolio-top-images";

// 업로드용 1x1 PNG 임시 파일
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const tmpPng = join(mkdtempSync(join(tmpdir(), "d10-")), "detail10-main.png");
writeFileSync(tmpPng, PNG_BYTES);

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("dialog", async (d) => {
  console.log("[native dialog]", d.type(), d.message().slice(0, 80));
  await d.accept();
});

const url = `${BASE}/cluster-3/?demoUserId=${UID}&admin=true`;
console.log("goto:", url);
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForSelector(".detail-grid .detail-item", { timeout: 60000 });
await page.waitForTimeout(5000); // 카드/권한 fetch 안정화

// 1) detail 카드 1 모달 열기
await page.click(".detail-grid .detail-item >> nth=0");
await page.waitForSelector(".modal-edit-btn", { timeout: 20000 });

// 2) 편집 모드 진입
await page.click(".modal-edit-btn");
await page.waitForSelector(".modal-save-btn", { timeout: 10000 });

// 3) 메인 이미지 업로드 (업로드 버튼 → filechooser)
const [chooser] = await Promise.all([
  page.waitForEvent("filechooser", { timeout: 10000 }),
  page.click(".image-actions-overlay .image-action-btn >> nth=0"),
]);
await chooser.setFiles(tmpPng);
await page.waitForTimeout(1000);

// 4) 저장 → custom popup confirm
await page.click(".modal-save-btn");
await page.waitForSelector(".custom-popup__btn--confirm", { timeout: 10000 });
await page.click(".custom-popup__btn--confirm");

// 저장 완료 대기 — 편집 모드 종료(수정 버튼 복귀)까지
await page.waitForSelector(".modal-edit-btn", { timeout: 30000 });
await page.waitForTimeout(2000);

const srcAfterSave = await page.evaluate(`(() => {
  const imgs = [...document.querySelectorAll("img")];
  const hit = imgs.find((i) => (i.getAttribute("src") || "").includes("${BUCKET_MARK}"));
  return hit ? hit.getAttribute("src") : null;
})()`);
console.log("저장 직후 메인이미지 src:", srcAfterSave ? `...${srcAfterSave.slice(-60)}` : null);
if (!srcAfterSave) {
  console.log("FAIL — 저장 직후 supabase URL 미반영");
  await page.screenshot({ path: "detail10-upload-fail.png", fullPage: false });
  await browser.close();
  process.exit(1);
}

// 5) 새로고침 → 모달 재진입 → 이미지 유지 확인
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForSelector(".detail-grid .detail-item", { timeout: 60000 });
await page.waitForTimeout(5000);
await page.click(".detail-grid .detail-item >> nth=0");
await page.waitForSelector(".modal-edit-btn", { timeout: 20000 });
await page.waitForTimeout(2000);

const srcAfterReload = await page.evaluate(`(() => {
  const imgs = [...document.querySelectorAll("img")];
  const hit = imgs.find((i) => (i.getAttribute("src") || "").includes("${BUCKET_MARK}"));
  return hit ? { src: hit.getAttribute("src"), loaded: hit.complete && hit.naturalWidth > 0 } : null;
})()`);
console.log("새로고침 후 메인이미지:", srcAfterReload ? `...${srcAfterReload.src.slice(-60)} loaded=${srcAfterReload.loaded}` : null);

await page.screenshot({ path: "detail10-upload-check.png", fullPage: false });

if (srcAfterReload?.src && srcAfterReload.loaded) {
  console.log("PASS — 브라우저 저장 후 새로고침에도 이미지 유지");
  await browser.close();
  process.exit(0);
}
console.log("FAIL — 새로고침 후 이미지 미유지");
await browser.close();
process.exit(1);
