// 운영 front(고객 프록시) vs admin(internal key) weekly-cards W5/W8 비교.
//   node scripts/diag-winter-rest-front-vs-admin.mjs <userId>
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const internalKey = get("INTERNAL_API_KEY");

const userId = process.argv[2];
if (!userId) throw new Error("usage: node ... <userId>");

const FRONT = "https://vraxium.vercel.app";
const ADMIN = "https://vraxium-admin.vercel.app";
const W5 = "8bd20da1-dca3-4618-879e-5008c6020bf5";
const W8 = "97a6523b-0e0e-4de7-93c5-bb8404ac9ac2";

function pick(cards, weekId) {
  const c = (cards ?? []).find((c) => c.weekId === weekId);
  if (!c) return null;
  return {
    weekLabel: c.weekLabel,
    userWeekStatus: c.userWeekStatus,
    isRestWeek: c.isRestWeek,
    statusLabel: c.statusLabel,
    cardMessage: c.cardMessage,
    statusIconKey: c.statusIconKey,
  };
}

const [frontRes, adminRes] = await Promise.all([
  fetch(`${FRONT}/api/cluster4/weekly-cards?userId=${userId}`),
  fetch(`${ADMIN}/api/cluster4/weekly-cards?userId=${userId}`, {
    headers: { "x-internal-api-key": internalKey },
  }),
]);
const frontJson = await frontRes.json();
const adminJson = await adminRes.json();
console.log(`[front] ${frontRes.status} success=${frontJson.success} cards=${frontJson.data?.length}`);
console.log(`[admin] ${adminRes.status} success=${adminJson.success} cards=${adminJson.data?.length}`);

let mismatch = 0;
for (const [label, weekId] of [["W5", W5], ["W8", W8]]) {
  const f = pick(frontJson.data, weekId);
  const a = pick(adminJson.data, weekId);
  console.log(`\n${label} front:`, JSON.stringify(f));
  console.log(`${label} admin:`, JSON.stringify(a));
  if (JSON.stringify(f) !== JSON.stringify(a)) {
    mismatch++;
    console.log(`${label} ❌ front/admin 불일치`);
  } else {
    console.log(`${label} ✅ front == admin`);
  }
}
process.exit(mismatch ? 1 : 0);
