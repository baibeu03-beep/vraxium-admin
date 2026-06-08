// 2026-06-05 정합성 수정 운영 HTTP 검증.
//   A) admin /api/cluster1/resume — 정상 졸업 게이팅 (T홍지환 spring=정상 졸업/winter=정상 완료)
//   B) front /api/cluster4/weekly-growth — 시즌 상태 분리 (graduated 진행 시즌=시즌 진행 중)
//   C) admin /api/cluster3/club-rank — direct 일치 재확인 (회귀)
// Usage: node scripts/verify-status-fixes-http.mjs
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const internalKey = get("INTERNAL_API_KEY");
const ADMIN_BASE = process.env.DIAG_ADMIN_BASE ?? "https://vraxium-admin.vercel.app";
const FRONT_BASE = process.env.DIAG_FRONT_BASE ?? "https://vraxium.vercel.app";

const HONG = "e6574586-6279-41cc-ae36-1c9dc3078bc3"; // T홍지환 graduated
const AHN = "ff6adaf8-8993-4b5b-b5ea-a4fa1036cdee"; // T안건우 graduating
const REAL = "247021bc-374b-48f4-8d49-b181d149ee33"; // 이유나 active 실유저

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

console.log("=== A) admin /api/cluster1/resume (정상 졸업 게이팅) ===");
for (const [name, uid, expectSpring, expectWinter] of [
  ["T홍지환(graduated)", HONG, "정상 졸업", "정상 완료"],
  ["T안건우(graduating)", AHN, "진행 중", "정상 완료"],
]) {
  const r = await fetch(`${ADMIN_BASE}/api/cluster1/resume?userId=${uid}`, {
    headers: { "x-internal-api-key": internalKey },
  });
  const j = await r.json().catch(() => null);
  const recs = j?.data?.seasonRecords ?? [];
  const tok = (s) => String(s ?? "").replace(/\s*시즌\s*$/, "").trim();
  const spring = recs.find((x) => x.year === "26" && tok(x.seasonName) === "봄");
  const winter = recs.find((x) => x.year === "26" && tok(x.seasonName) === "겨울");
  check(`${name} 26봄=${expectSpring}`, spring?.progressStatus === expectSpring, `실제=${spring?.progressStatus}`);
  check(`${name} 26겨울=${expectWinter}`, winter?.progressStatus === expectWinter, `실제=${winter?.progressStatus}`);
  const gradCount = recs.filter((x) => x.progressStatus === "정상 졸업").length;
  check(`${name} 정상 졸업 행 수(${name.includes("graduated") ? 1 : 0} 기대)`, gradCount === (uid === HONG ? 1 : 0), `실제=${gradCount}`);
}

console.log("\n=== B) front /api/cluster4/weekly-growth (시즌 상태 분리) ===");
// (2026-06-05 후속 개정) "시즌 중 졸업" 5종째 추가 — graduated 의 마지막 활동 시즌은
// "시즌 진행 중"이 아니라 "시즌 중 졸업"이 정답으로 변경됨.
// 전용 검증은 scripts/verify-season-mid-graduation-http.mjs 참고.
for (const [name, uid, springExpect] of [
  ["T홍지환(graduated)", HONG, "시즌 중 졸업"],
  ["T안건우(graduating)", AHN, "시즌 진행 중"],
  ["이유나(active)", REAL, "시즌 진행 중"],
]) {
  const r = await fetch(`${FRONT_BASE}/api/cluster4/weekly-growth?userId=${uid}`);
  const j = await r.json().catch(() => null);
  const sums = j?.data?.seasonSummaries ?? [];
  const cur = j?.data?.seasonSummary;
  const spring = sums.find((s) => s.seasonKey === "2026-spring");
  check(`${name} 2026-spring(진행 중 시즌)=${springExpect}`, spring?.statusLabel === springExpect, `실제=${spring?.statusLabel}`);
  if (cur) check(`${name} 현재 시즌 단일 요약=${springExpect}`, cur?.statusLabel === springExpect, `실제=${cur?.statusLabel}`);
  for (const s of sums.filter((s) => s.seasonKey !== "2026-spring")) {
    console.log(`    (참고) ${name} ${s.seasonKey}: ${s.statusLabel} (seasonResult=${s.seasonResult})`);
  }
}

console.log("\n=== B-2) 종료 시즌 = 이력서 판정 일치 ===");
{
  // T안건우 25가을 = 활동 중단(이력서) → 시즌 중단(weekly-growth) 기대
  const r = await fetch(`${FRONT_BASE}/api/cluster4/weekly-growth?userId=${AHN}`);
  const j = await r.json().catch(() => null);
  const autumn = (j?.data?.seasonSummaries ?? []).find((s) => s.seasonKey === "2025-autumn");
  check("T안건우 2025-autumn(이력서 활동 중단)=시즌 중단", autumn?.statusLabel === "시즌 중단", `실제=${autumn?.statusLabel}`);
  const winter = (j?.data?.seasonSummaries ?? []).find((s) => s.seasonKey === "2026-winter");
  check("T안건우 2026-winter(이력서 정상 완료)=시즌 성공", winter?.statusLabel === "시즌 성공", `실제=${winter?.statusLabel}`);
}

console.log("\n=== C) club-rank 회귀 (frozen 경로) ===");
{
  const r = await fetch(`${ADMIN_BASE}/api/cluster3/club-rank?userId=${HONG}`, {
    headers: { "x-internal-api-key": internalKey },
  });
  const j = await r.json().catch(() => null);
  const d = j?.data ?? j;
  check("T홍지환 frozen 27.84/정2품 유지", d?.avgPercentile === 27.84 && d?.rankGrade === "정2품", JSON.stringify({ a: d?.avgPercentile, g: d?.rankGrade, f: d?.isFrozen }));
}

console.log(`\n결과: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
