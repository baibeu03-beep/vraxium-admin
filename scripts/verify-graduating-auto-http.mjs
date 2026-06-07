// graduating 자동 계산 — 로컬 HTTP 검증 + direct 일치 + snapshot 불변 확인 (read-only).
//   1) GET /api/cluster3/stats-cards?userId= (x-internal-api-key) — growthStatusKey 확인
//   2) direct 결과(verify-graduating-auto.ts 실측)와 일치 여부
//   3) HTTP 호출 전후 cluster4_weekly_card_snapshots.computed_at/is_stale 불변(쓰기 없음) 확인
// Usage: node scripts/verify-graduating-auto-http.mjs   (사전조건: admin dev :3000)
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const internalKey = get("INTERNAL_API_KEY");
const sbUrl = get("NEXT_PUBLIC_SUPABASE_URL");
const sbKey = get("SUPABASE_SERVICE_ROLE_KEY");
const BASE = process.env.DIAG_ADMIN_BASE ?? "http://localhost:3000";

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// [name, userId, expectedKey(=direct 실측)]
const CASES = [
  ["T안건우(DB=graduating, a=17)", "ff6adaf8-8993-4b5b-b5ea-a4fa1036cdee", "active"],
  ["T윤서진(DB=graduating, a=22)", "76a42307-f3b2-4c08-92ab-f339a20b7d38", "active"],
  ["T황하린(DB=graduating, a=18)", "8e38d52f-727e-429b-9db3-423cd031d2a5", "active"],
  ["T강지아(DB=graduating, a=20)", "369d11e5-8c9e-423c-95e8-4e52a62460d7", "active"],
  ["T강지환(DB=graduating, a=19)", "6678e364-68ad-4aa1-a531-79f62c2c166a", "active"],
  ["T조서현(DB=graduating, a=18)", "b303c17e-26ec-429c-804e-f0d25c3f9463", "active"],
  ["T조민재(DB=graduating, a=18)", "ec11fe34-0cba-4bbc-afae-6d7514fdf57e", "active"],
  ["T윤도현(graduated)", "bf3b4305-751a-49e3-88ad-95a20e5c4dad", "graduated"],
  ["T홍지환(graduated)", "e6574586-6279-41cc-ae36-1c9dc3078bc3", "graduated"],
  ["T조하은(paused)", "cc05522b-7a71-48fb-a291-3aaaefdf4865", "paused"],
  ["T송하린(seasonal_rest)", "28c60d60-aa17-4614-9127-fd65a8aebcaf", "seasonal_rest"],
  ["이유나(실유저 active)", "247021bc-374b-48f4-8d49-b181d149ee33", "active"],
];

const ids = CASES.map(([, id]) => id);
async function snapState() {
  const res = await fetch(
    `${sbUrl}/rest/v1/cluster4_weekly_card_snapshots?select=user_id,is_stale,computed_at,dto_version&user_id=in.(${ids.join(",")})`,
    { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } },
  );
  const rows = await res.json();
  return new Map(rows.map((r) => [r.user_id, `${r.is_stale}|${r.computed_at}|${r.dto_version}`]));
}

const before = await snapState();
console.log(`=== HTTP /api/cluster3/stats-cards (${BASE}) ===`);
for (const [name, uid, expected] of CASES) {
  const r = await fetch(`${BASE}/api/cluster3/stats-cards?userId=${uid}`, {
    headers: { "x-internal-api-key": internalKey },
  });
  const j = await r.json().catch(() => null);
  const key = j?.data?.process?.growthStatusKey ?? null;
  const label = j?.data?.process?.growthStatus ?? null;
  check(`${name}: HTTP growthStatusKey=${expected}`, key === expected, `실제=${key} ("${label}") status=${r.status}`);
  if (expected !== "graduating") {
    check(`${name}: HTTP ≠ graduating`, key !== "graduating", "");
  }
}

const after = await snapState();
let snapChanged = 0;
for (const [uid, sig] of before) {
  if (after.get(uid) !== sig) {
    snapChanged++;
    console.log(`  ! snapshot 변경: ${uid} ${sig} → ${after.get(uid)}`);
  }
}
check("snapshot 불변(쓰기 0건) — is_stale/computed_at/dto_version 변화 없음", snapChanged === 0, `변경 ${snapChanged}건`);

console.log(`\n결과: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
