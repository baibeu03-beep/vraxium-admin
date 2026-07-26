// 실사용자 — 스코프 게이트가 없는 HTTP 표면으로 누적 A/B/C 확인(internal key 경로).
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = process.env.VERIFY_BASE || "http://localhost:3012";
const INTERNAL = get("INTERNAL_API_KEY");

const USERS = [
  { id: "ef4938c2-5dfe-4500-a0bc-0d953c6f7314", name: "서유솔", before: 8486 },
  { id: "8cc1ae06-3110-4e34-918c-2a92674725a1", name: "최서윤", before: 2748 },
  { id: "13fb675f-3943-4be8-89c5-0739024dd5b2", name: "김도연", before: 2371 },
  { id: "8eeb75ba-47c9-49fd-971b-ba3188b90ce4", name: "윤채영", before: 709 },
];

const j = async (p, o = {}) => {
  const r = await fetch(`${BASE}${p}`, o);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: { _raw: t.slice(0, 200) } }; }
};

for (const u of USERS) {
  const r = await j(`/api/cluster3/stats-cards?userId=${u.id}`, { headers: { "x-internal-api-key": INTERNAL } });
  const p = r.body?.data?.points ?? r.body?.points ?? null;
  console.log(
    `${u.name.padEnd(8)} HTTP ${r.status}  현재 A=${p?.totalStars ?? "-"} B=${p?.totalShields ?? "-"} C=${p?.totalLightning ?? "-"}` +
      `   (마이그 이전 roster A=${u.before})${p ? "" : `  err=${r.body?.error ?? ""}`}`,
  );
}
