// 재계산 후 snapshot 24/25→15/16 교정 검증 (2026-06-05)
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const url = get("NEXT_PUBLIC_SUPABASE_URL");
const key = get("SUPABASE_SERVICE_ROLE_KEY");

const ids = [
  "42864260-e4ea-4150-a87f-cff545b02af1",
  "63813dc4-9dec-4511-83be-1f54196d09cf",
  "1a0b0f9e-4e10-4d06-aa56-6d26ee4b203a",
  "4a81b6d1-e488-4f14-8530-0cad60fe4f0d",
  "cc1b58e6-b14d-45a0-b389-2df3c27a0b25",
  "e6574586-6279-41cc-ae36-1c9dc3078bc3",
  "bf3b4305-751a-49e3-88ad-95a20e5c4dad",
  "e4dcb97e-a515-4ec5-a91e-32ca4e629dae",
  "05ff6b96-b3e7-4050-97f1-080633f183d3",
];
const r = await fetch(
  `${url}/rest/v1/cluster4_weekly_card_snapshots?select=user_id,is_stale,dto_version,cards&user_id=in.(${ids.join(",")})`,
  { headers: { apikey: key, Authorization: `Bearer ${key}` } },
);
const snaps = await r.json();
let allOk = true;
for (const s of snaps) {
  const cards = Array.isArray(s.cards) ? s.cards : [];
  const spring = cards.filter((c) => c.seasonKey === "2026-spring");
  const over = spring.filter((c) => c.weekNumber > 16);
  const w15 = spring.find((c) => c.startDate === "2026-06-08");
  const w16 = spring.find((c) => c.startDate === "2026-06-15");
  const ok = over.length === 0 && w15?.weekNumber === 15 && w16?.weekNumber === 16;
  if (!ok) allOk = false;
  console.log(
    `${ok ? "✓" : "✗"} ${s.user_id.slice(0, 8)} stale=${s.is_stale} v${s.dto_version} 06-08→W${w15?.weekNumber ?? "-"} 06-15→W${w16?.weekNumber ?? "-"} over16=${over.length} title15="${w15?.displayTitle ?? ""}"`,
  );
}
console.log(allOk ? "\n전원 교정 완료 ✓" : "\n잔존 오염 있음 ✗");
process.exit(allOk ? 0 : 1);
