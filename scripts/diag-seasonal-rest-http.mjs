// READ-ONLY HTTP 검증: seasonal_rest 유저의 weekly-cards 가
//   (1) admin 직접 HTTP(x-internal-api-key)  (2) front 고객 프록시(demo) 에서
//   direct/snapshot 과 동일한 주차 정보를 내려주는지.
// 사전조건: admin :3000, front :3001 dev 실행 중.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const env = readFileSync(resolve(root, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const KEY = get("INTERNAL_API_KEY");
const ADMIN = "http://localhost:3000";
const FRONT = "http://localhost:3001";

// 운영 4 + 테스트 4 (diag-seasonal-rest-weekcards 결과에서)
const OPERATING = [
  ["강민주", "db6a6135-1508-450b-885b-48a8e49737a1"],
  ["강민진", "87e3ff5f-7e5d-492f-b2ab-2b5d1f095f30"],
  ["강소윤", "210c58d6-1e00-42db-bd42-d9073ef5652a"],
];
const TEST = [
  ["T송하린", "28c60d60-aa17-4614-9127-fd65a8aebcaf"],
  ["T강서현", "3330f4c3-5331-4632-bbe6-01a19017a089"],
  ["T윤민지", "ea286f9d-fb5b-492e-a081-cd5c200a4455"],
];

function summarize(cards) {
  const byStatus = {};
  let rest = 0;
  const spring = [];
  for (const c of cards) {
    const st = String(c.userWeekStatus ?? "(null)");
    byStatus[st] = (byStatus[st] ?? 0) + 1;
    if (c.isRestWeek) rest++;
    if (c.seasonKey === "2026-spring") spring.push(`W${c.weekNumber}:${st}`);
  }
  return { count: cards.length, byStatus, rest, spring: spring.sort() };
}

async function adminHttp(userId, mode) {
  const u = `${ADMIN}/api/cluster4/weekly-cards?userId=${userId}${mode ? `&mode=${mode}` : ""}`;
  const r = await fetch(u, { headers: { "x-internal-api-key": KEY } });
  const j = await r.json();
  return { status: r.status, ...summarize(j.data ?? []), growthInfo: j.growthInfo ?? null };
}

async function frontDemo(userId, mode) {
  // 고객 프록시: 데모 모드 — demoUserId 로 인증 우회, userId 로 대상 지정.
  const u = `${FRONT}/api/cluster4/weekly-cards?userId=${userId}&demoUserId=${userId}${mode ? `&mode=${mode}` : ""}`;
  const r = await fetch(u, {});
  let j;
  try { j = await r.json(); } catch { return { status: r.status, err: "non-json" }; }
  if (!Array.isArray(j.data)) return { status: r.status, err: j?.error?.code ?? "no-data" };
  return { status: r.status, ...summarize(j.data) };
}

async function run(label, list) {
  for (const [name, id] of list) {
    console.log(`\n▶ [${label}] ${name} ${id.slice(0, 8)}`);
    const aOp = await adminHttp(id, null);
    const aTest = await adminHttp(id, "test");
    console.log(`  ADMIN(op)   status=${aOp.status} cards=${aOp.count} byStatus=${JSON.stringify(aOp.byStatus)} rest=${aOp.rest}`);
    console.log(`  ADMIN(test) status=${aTest.status} cards=${aTest.count} byStatus=${JSON.stringify(aTest.byStatus)} rest=${aTest.rest}`);
    const sameMode = aOp.count === aTest.count && JSON.stringify(aOp.byStatus) === JSON.stringify(aTest.byStatus);
    console.log(`  → op==test DTO? ${sameMode}`);
    console.log(`  growthInfo(op)=${JSON.stringify(aOp.growthInfo)}`);
    const f = await frontDemo(id, "test");
    if (f.err) console.log(`  FRONT(demo) status=${f.status} err=${f.err}`);
    else console.log(`  FRONT(demo) status=${f.status} cards=${f.count} byStatus=${JSON.stringify(f.byStatus)} rest=${f.rest}`);
    console.log(`  2026-spring(admin op): ${aOp.spring.join(" ")}`);
    if (!f.err) console.log(`  2026-spring(front)   : ${f.spring.join(" ")}`);
  }
}

await run("운영", OPERATING);
await run("테스트", TEST);
process.exit(0);
