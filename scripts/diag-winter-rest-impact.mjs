// 운영 DB: 2026-winter W5(01-26)/W8(02-16) 휴식주 SoT 정정 영향 조사.
//   1) user_week_statuses 상태 분포 (주차별, 테스터/실유저 구분)
//   2) cluster4_weekly_card_snapshots 에 박힌 W5/W8 resultStatus 분포
//   3) user_weekly_points 존재 여부 (W5/W8)
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const url = get("NEXT_PUBLIC_SUPABASE_URL");
const key = get("SUPABASE_SERVICE_ROLE_KEY");
const H = { apikey: key, Authorization: `Bearer ${key}` };

const W5_ID = "8bd20da1-dca3-4618-879e-5008c6020bf5";
const W8_ID = "97a6523b-0e0e-4de7-93c5-bb8404ac9ac2";
const W5_START = "2026-01-26";
const W8_START = "2026-02-16";

// PostgREST 1000행 cap — order+range 전수 페이지네이션
async function fetchAll(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      headers: { ...H, Range: `${from}-${from + 999}` },
    });
    if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// 테스터 식별 = test_user_markers
const markers = await fetchAll("test_user_markers?select=user_id&order=user_id");
const testers = new Set(markers.map((m) => m.user_id));
console.log(`[0] test_user_markers: ${testers.size}명`);

for (const [label, start] of [["W5", W5_START], ["W8", W8_START]]) {
  const uws = await fetchAll(
    `user_week_statuses?week_start_date=eq.${start}&select=id,user_id,status,is_official_rest_override&order=id`,
  );
  const dist = {};
  for (const r of uws) {
    const who = testers.has(r.user_id) ? "tester" : "real";
    const k = `${who}:${r.status}${r.is_official_rest_override ? "+override" : ""}`;
    dist[k] = (dist[k] ?? 0) + 1;
  }
  console.log(`\n[1] uws ${label}(${start}): total=${uws.length}`, JSON.stringify(dist));
}

for (const [label, start] of [["W5", W5_START], ["W8", W8_START]]) {
  const pts = await fetchAll(
    `user_weekly_points?week_start_date=eq.${start}&select=user_id,points,advantages,penalty,checks_migrated&order=user_id`,
  );
  const dist = {};
  for (const r of pts) {
    const who = testers.has(r.user_id) ? "tester" : "real";
    dist[who] = (dist[who] ?? 0) + 1;
  }
  console.log(`[2] user_weekly_points ${label}(${start}): total=${pts.length}`, JSON.stringify(dist));
}

// snapshot 에 박힌 W5/W8 카드 resultStatus 분포
const snaps = await fetchAll(
  "cluster4_weekly_card_snapshots?select=user_id,is_stale,dto_version,cards&order=user_id",
);
console.log(`\n[3] snapshots: ${snaps.length}건`);
const byWeek = { [W5_ID]: {}, [W8_ID]: {} };
let staleCount = 0;
const dtoVers = {};
for (const s of snaps) {
  if (s.is_stale) staleCount++;
  dtoVers[s.dto_version] = (dtoVers[s.dto_version] ?? 0) + 1;
  const cards = Array.isArray(s.cards) ? s.cards : [];
  for (const c of cards) {
    if (c.weekId === W5_ID || c.weekId === W8_ID) {
      const who = testers.has(s.user_id) ? "tester" : "real";
      const k = `${who}:${c.userWeekStatus}|rest=${c.isRestWeek}|${c.statusLabel}|msg=${c.cardMessage}`;
      byWeek[c.weekId][k] = (byWeek[c.weekId][k] ?? 0) + 1;
    }
  }
}
console.log(`    is_stale=true: ${staleCount}, dto_version 분포:`, JSON.stringify(dtoVers));
console.log(`    W5 카드 상태 분포:`, JSON.stringify(byWeek[W5_ID]));
console.log(`    W8 카드 상태 분포:`, JSON.stringify(byWeek[W8_ID]));
