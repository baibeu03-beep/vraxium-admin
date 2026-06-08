// 운영 배포 감지 폴링 (read-only): T안건우 stats-cards growthStatusKey 가
// graduating(구 코드) → active(신 코드 54c6c0f)로 바뀌면 배포 완료.
// Usage: node scripts/poll-prod-deploy.mjs
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const key = get("INTERNAL_API_KEY");

const AHN = "ff6adaf8-8993-4b5b-b5ea-a4fa1036cdee";
const target = `https://vraxium-admin.vercel.app/api/cluster3/stats-cards?userId=${AHN}`;

for (let i = 0; i < 27; i++) {
  try {
    const r = await fetch(target, { headers: { "x-internal-api-key": key } });
    const j = await r.json().catch(() => null);
    const k = j?.data?.process?.growthStatusKey;
    console.log(`${new Date().toISOString().slice(11, 19)} status=${r.status} growthStatusKey=${k}`);
    if (k === "active") {
      console.log(">>> 신규 배포 감지 — 검증 진행 가능");
      process.exit(0);
    }
  } catch (e) {
    console.log("fetch err:", e?.cause?.message ?? e.message);
  }
  await new Promise((s) => setTimeout(s, 20000));
}
console.log(">>> 타임아웃 — 배포 미완료");
process.exit(1);
