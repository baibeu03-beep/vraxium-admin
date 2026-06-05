// One-off diagnostic: 성장상태/주차범위/시즌이력 정합성 점검 (2026-06-05)
// Usage: node scripts/diag-status-week-consistency.mjs
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const url = get("NEXT_PUBLIC_SUPABASE_URL");
const key = get("SUPABASE_SERVICE_ROLE_KEY");

async function q(path) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    console.log(`  !! ${path} -> ${res.status}`, JSON.stringify(body).slice(0, 300));
    return [];
  }
  return body;
}

// paginate helper (PostgREST 1000행 cap)
async function qAll(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${url}/rest/v1/${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${from}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) { console.log(`  !! ${path} -> ${res.status}`); break; }
    out.push(...body);
    if (body.length < 1000) break;
  }
  return out;
}

console.log("=== [1] weeks 테이블: 시즌별 week_number 범위 점검 ===");
const weeks = await qAll("weeks?select=id,week_number,iso_year,iso_week,start_date,end_date,season_key&order=start_date.asc");
console.log(`weeks rows: ${weeks.length}`);
const bySeason = new Map();
for (const w of weeks) {
  const k = w.season_key ?? "(null)";
  if (!bySeason.has(k)) bySeason.set(k, []);
  bySeason.get(k).push(w);
}
for (const [k, rows] of [...bySeason.entries()].sort()) {
  const nums = rows.map((r) => r.week_number).filter((n) => n != null);
  const nulls = rows.filter((r) => r.week_number == null).length;
  const max = /-(summer|winter)$/.test(k) ? 8 : 16;
  const over = rows.filter((r) => r.week_number != null && r.week_number > max);
  console.log(
    `  ${k}: ${rows.length} rows, week_number ${Math.min(...nums)}..${Math.max(...nums)}, null=${nulls}` +
      (over.length ? `  ⚠ OVER-MAX(${max}): ${over.map((o) => `#${o.week_number}@${o.start_date}`).join(", ")}` : ""),
  );
}
const nullWeekNum = weeks.filter((w) => w.week_number == null);
if (nullWeekNum.length) {
  console.log(`  ⚠ week_number NULL rows: ${nullWeekNum.length}`);
  for (const w of nullWeekNum.slice(0, 20))
    console.log(`    ${w.season_key} start=${w.start_date} iso=${w.iso_year}-W${w.iso_week}`);
}

console.log("\n=== [2] user_week_statuses 고아(주차행 없는 uws) — 합성주차 후보 ===");
const weekStarts = new Set(weeks.map((w) => w.start_date));
const uwsAll = await qAll("user_week_statuses?select=user_id,year,week_number,week_start_date,status,season_key");
console.log(`uws rows: ${uwsAll.length}`);
const orphans = uwsAll.filter((r) => r.week_start_date && !weekStarts.has(r.week_start_date));
const orphanByStart = new Map();
for (const o of orphans) {
  const k = `${o.week_start_date} (uws.week_number=${o.week_number}, season=${o.season_key})`;
  orphanByStart.set(k, (orphanByStart.get(k) ?? 0) + 1);
}
console.log(`orphan uws rows: ${orphans.length}, distinct starts: ${orphanByStart.size}`);
for (const [k, c] of [...orphanByStart.entries()].sort().slice(0, 30)) console.log(`  ${k} x${c}`);

console.log("\n=== [3] graduated 사용자 vs 누적 성장 주차 (org 임계 25/30) ===");
const profiles = await qAll(
  "user_profiles?select=user_id,display_name,growth_status,organization&growth_status=in.(graduated,graduating)",
);
console.log(`graduated/graduating profiles: ${profiles.length}`);
const gstats = await qAll("user_growth_stats?select=user_id,approved_weeks,cumulative_weeks");
const gmap = new Map(gstats.map((g) => [g.user_id, g]));
const THRESH = { oranke: 25, encre: 30, phalanx: 30 };
let shortfall = 0;
for (const p of profiles) {
  const g = gmap.get(p.user_id);
  const th = THRESH[p.organization] ?? 30;
  const cum = g?.cumulative_weeks ?? null;
  const ok = cum != null && cum >= th;
  if (!ok) {
    shortfall++;
    console.log(
      `  ⚠ ${p.display_name} (${p.organization ?? "?"}, ${p.growth_status}) cumulative=${cum} approved=${g?.approved_weeks ?? "-"} < threshold ${th}`,
    );
  }
}
console.log(`threshold-미충족 graduated: ${shortfall}/${profiles.length}`);

console.log("\n=== [3b] 반대 방향: 임계 충족인데 graduated 아닌 사용자 ===");
const allProfiles = await qAll("user_profiles?select=user_id,display_name,growth_status,organization");
let overdue = 0;
for (const p of allProfiles) {
  if (["graduated", "graduating", "suspended", "paused"].includes(p.growth_status)) continue;
  const g = gmap.get(p.user_id);
  const th = THRESH[p.organization] ?? 30;
  if (g && g.cumulative_weeks >= th) {
    overdue++;
    if (overdue <= 15)
      console.log(`  ⚠ ${p.display_name} (${p.organization ?? "?"}) status=${p.growth_status} cumulative=${g.cumulative_weeks} >= ${th}`);
  }
}
console.log(`임계 충족·미졸업 상태: ${overdue}`);

console.log("\n=== [4] weekly-cards snapshot 내 시즌 초과 주차 카드 ===");
const snaps = await qAll("cluster4_weekly_card_snapshots?select=user_id,is_stale,dto_version,cards");
console.log(`snapshots: ${snaps.length}`);
let badSnapUsers = 0;
for (const s of snaps) {
  const cards = Array.isArray(s.cards) ? s.cards : [];
  const bad = cards.filter((c) => {
    const k = c.seasonKey ?? "";
    const max = /-(summer|winter)$/.test(k) ? 8 : 16;
    // 전환주차(17주차 등 transition)는 별도 — isTransition true 면 허용으로 표시만
    return typeof c.weekNumber === "number" && c.weekNumber > max + 1;
  });
  if (bad.length) {
    badSnapUsers++;
    if (badSnapUsers <= 10) {
      console.log(
        `  user=${s.user_id} stale=${s.is_stale} v=${s.dto_version}: ${bad
          .map((c) => `[${c.seasonKey} W${c.weekNumber} "${c.displayTitle ?? c.weekTitle}" start=${c.startDate}]`)
          .join(" ")}`,
      );
    }
  }
}
console.log(`초과 주차 카드 보유 snapshot 사용자 수: ${badSnapUsers}`);

console.log("\n=== [5] season_definitions 정렬·현재시즌 ===");
const sdefs = await q("season_definitions?select=season_key,season_label,season_type,start_date,end_date&order=start_date.desc");
for (const s of sdefs) console.log(`  ${s.season_key} (${s.season_type}) ${s.start_date} ~ ${s.end_date} label=${s.season_label}`);
