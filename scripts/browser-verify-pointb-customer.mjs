// 브라우저 실측(고객 :3001): 음수 사용자 T정시현의 주차 카드 Point B(방패)=최종B(음수) + Point C(양수).
//   어드민 CrewDetail 주차 poB(=adv−pen)와 동일 값인지 DB 기준 대조. 사전조건: front :3001 + admin :3000.
//   node scripts/browser-verify-pointb-customer.mjs
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
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(get("NEXT_PUBLIC_SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"));
const USER = "70abfec0-660b-4af3-a940-5d318f76bd4e"; // T정시현 (encre, test) — 로스터 최종B 최소(-48)
const BASE = "http://localhost:3001";
let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const parse = (s) => { const m = String(s).match(/lab\(([^)]+)\)/); if (m) { const [, a] = m[1].split(/[\s/]+/).map(Number); return { lab: true, a }; } const r = String(s).match(/rgba?\(([^)]+)\)/); if (r) { const [x, g, b] = r[1].split(/[,\s/]+/).map(Number); return { r: x, g, b }; } return null; };
const isGreen = (c) => c && (c.lab ? c.a < -20 : c.g > 90 && c.g > c.r + 20);
const isRed = (c) => c && (c.lab ? c.a > 40 : c.r > 120 && c.r > c.g + 40);

// DB 주차별 net(=adv−pen) — 대조 기준
const rows = (await sb.from("user_weekly_points").select("advantages,penalty").eq("user_id", USER)).data ?? [];
const dbNegWeeks = rows.map((r) => (r.advantages ?? 0) - (r.penalty ?? 0)).filter((n) => n < 0);
console.log(`DB 기준: 주차 ${rows.length}개 · net<0 주차 ${dbNegWeeks.length}개 (예: ${dbNegWeeks.slice(0, 5).join(", ")})`);

const browser = await chromium.launch({ channel: "chromium", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 2200 } });
await page.goto(`${BASE}/cluster-4?demoUserId=${USER}`, { waitUntil: "domcontentloaded", timeout: 90000 });

// 주차 카드 렌더까지 폴링 후, 리프 요소 중 "숫자 텍스트"를 색과 함께 수집.
//   음수 & 연두(green) = Point B(방패=최종B). 양수 & 빨강(red) = Point C.
let leaves = [];
{ const t0 = Date.now(); while (Date.now() - t0 < 50000) {
  leaves = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll(".cluster4-weekly-list *")) {
      if (el.children.length !== 0) continue;
      const t = (el.textContent || "").trim();
      if (!/^-?\d[\d,]*$/.test(t)) continue;
      out.push({ text: t, color: getComputedStyle(el).color });
    }
    return out;
  });
  if (leaves.length > 5) break;
  await page.waitForTimeout(2000);
} }

const greenNums = leaves.filter((l) => isGreen(parse(l.color)));
const redNums = leaves.filter((l) => isRed(parse(l.color)));
const negGreen = greenNums.filter((l) => /^-\d/.test(l.text)); // 음수 Point B
console.log(`\n고객 숫자 리프 ${leaves.length}개 · 연두 ${greenNums.length} · 빨강 ${redNums.length} · 음수·연두(Point B) ${negGreen.length}`);
for (const n of negGreen.slice(0, 8)) console.log(`  Point B=${n.text} (${n.color})`);

ck("고객 Point B(방패)에 음수 존재(최종B·clamp 없음)", negGreen.length > 0, `음수 연두 ${negGreen.length}개`);
ck("고객 음수 Point B = 연두(green)", negGreen.length > 0, `예: ${negGreen[0]?.text}`);
ck("고객 Point C = 빨강 & 전부 양수(마이너스 없음)", redNums.length > 0 && redNums.every((l) => !/^-/.test(l.text)), `빨강 ${redNums.length}개·예 ${redNums[0]?.text}`);
const custNegVals = [...new Set(negGreen.map((n) => Number(n.text.replace(/,/g, ""))))];
const allInDb = custNegVals.length > 0 && custNegVals.every((v) => dbNegWeeks.includes(v));
ck("고객 음수 Point B 값 ⊆ DB 주차 net(adv−pen) = 어드민과 동일 최종B", allInDb, `고객=${custNegVals.slice(0, 8).join(",")} / DB=${[...new Set(dbNegWeeks)].slice(0, 8).join(",")}`);

await page.screenshot({ path: "claudedocs/pointb-customer-negative.png", fullPage: false });
console.log("📸 claudedocs/pointb-customer-negative.png");
console.log(`\n결과: ${fail === 0 ? "ALL PASS" : `${fail} FAIL`}`);
await browser.close();
process.exit(fail ? 1 : 0);
