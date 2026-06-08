// 크래시 복구 재동기화 (2026-06-07, read-only — SELECT/GET 만, write 0):
//   ① legacy_point_ledger / legacy_event_logs DDL 적용 확인 (인덱스·UNIQUE(source_table, source_pk))
//   ② PMS 이관 write 흔적 0 확인 (users/profiles/uwp/uws/cluster4/ledger/sentinel)
//   ③ 1092 dry-run 산출물(weekRows 46) ↔ 라이브 weeks 유효성 재검 (threshold·publish·rest)
//   node scripts/resync-crash-recovery-20260607.mjs
import { readFileSync } from "node:fs";

const env = readFileSync(".env.local", "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const url = get("NEXT_PUBLIC_SUPABASE_URL");
const key = get("SUPABASE_SERVICE_ROLE_KEY");
const H = { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" };

const q = async (p) => {
  const res = await fetch(`${url}/rest/v1/${p}`, { headers: H });
  if (!res.ok) throw new Error(`${p} → ${res.status} ${await res.text()}`);
  return { rows: await res.json(), total: Number(res.headers.get("content-range")?.split("/")[1] ?? -1) };
};
// UNIQUE(source_table, source_pk) 검증 — exec_sql RPC 부재 + 직접 PG 연결 없음이라 카탈로그 직독 불가.
// 대신 PostgREST upsert arbiter 추론 probe (0-write 보장):
//   페이로드 id='...-g' invalid uuid → 캐스트 실패는 "실행" 단계 (22P02)
//   ON CONFLICT arbiter 제약 검증은 그보다 앞선 "플랜" 단계 (42P10)
//   → 42P10 = 제약 부재 / 22P02(또는 23502) = 제약 존재·실행 진입 전 차단. 어느 쪽이든 insert 0행.
//   실제 이관 코드가 사용할 on_conflict 멱등 upsert 경로와 동일 — 기능적 동치 검증.
const probeUnique = async (tbl) => {
  const res = await fetch(`${url}/rest/v1/${tbl}?on_conflict=source_table,source_pk`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ id: "00000000-0000-0000-0000-00000000000g", source_table: "__probe__", source_pk: 0 }]),
  });
  const body = await res.text();
  if (res.status >= 200 && res.status < 300) throw new Error(`${tbl} probe 가 성공해버림(예상 밖 insert!) — 즉시 확인 필요: ${body}`);
  const j = JSON.parse(body);
  return { exists: j.code !== "42P10", code: j.code, message: j.message };
};

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// ════════ ① legacy 테이블 DDL — 인덱스/제약 ════════
console.log("\n[1] legacy 테이블 UNIQUE(source_table, source_pk) — arbiter probe (0-write)");
for (const tbl of ["legacy_point_ledger", "legacy_event_logs"]) {
  const r = await probeUnique(tbl);
  check(`${tbl} UNIQUE(source_table, source_pk)`, r.exists, `probe → ${r.code}: ${r.message}`);
}

const lpl = await q("legacy_point_ledger?select=id&limit=1");
const lel = await q("legacy_event_logs?select=id&limit=1");
check("legacy_point_ledger 0행 (이관 전)", lpl.total === 0, `실제 ${lpl.total}`);
check("legacy_event_logs 0행 (이관 전)", lel.total === 0, `실제 ${lel.total}`);

// ════════ ② PMS 이관 write 흔적 0 ════════
console.log("\n[2] PMS 이관 write 흔적 (전부 0 기대)");
const u1092 = await q("users?select=id&legacy_user_id=eq.1092&limit=1");
check("users legacy_user_id=1092 부재 (1092 미이관)", u1092.total === 0, `실제 ${u1092.total}`);
// legacy_user_id<1억 보유 사용자 — 기존 운영 데이터인지(크래시 전 생성) PMS 이관 산출인지 created_at 으로 판별
const uLegacy = await q("users?select=id,legacy_user_id,created_at&legacy_user_id=lt.100000000&order=created_at.desc&limit=1000");
const recentLegacy = uLegacy.rows.filter((r) => r.created_at >= "2026-06-06");
console.log(`    legacy_user_id<1억 사용자: ${uLegacy.total}명 — created_at 범위 ${uLegacy.rows.at(-1)?.created_at} ~ ${uLegacy.rows[0]?.created_at}`);
check("06-06 이후 신규 생성된 legacy id 사용자 0명 (PMS 이관 write 부재)", recentLegacy.length === 0,
  recentLegacy.length ? JSON.stringify(recentLegacy.slice(0, 5)) : `전원 06-06 이전 생성 (기존 데이터)`);
const prof = await q(`user_profiles?select=user_id&display_name=eq.${encodeURIComponent("장승완")}&limit=1`);
check("user_profiles 장승완 부재", prof.total === 0, `실제 ${prof.total}`);
const sentinel = await q("user_weekly_points?select=user_id&year=eq.1900&limit=1");
check("uwp sentinel(1900-W0) 0행", sentinel.total === 0, `실제 ${sentinel.total}`);

// 현재 행수 vs 06-05 fingerprint (B7 무접촉 테이블 — 단, 06-06 테스터 top-up W1~4 합법 delta 주석)
const fp = JSON.parse(readFileSync("claudedocs/b7-fingerprint-after.json", "utf8"));
const counts = {};
for (const t of ["user_weekly_points", "user_week_statuses", "cluster4_lines", "cluster4_line_targets",
  "cluster4_line_submissions", "cluster4_experience_line_evaluations", "cluster4_weekly_card_snapshots"]) {
  const pk = t === "cluster4_weekly_card_snapshots" ? "user_id" : "id";
  counts[t] = (await q(`${t}?select=${pk}&limit=1`)).total;
  const base = fp[t]?.count;
  console.log(`    ${t}: ${counts[t]}${base != null ? ` (06-05 fingerprint ${base}, Δ${counts[t] - base})` : ""}`);
}

// top-up 합성 주차: 2025-summer = W1~4 만 (2단계에서 W5~8 삭제, 2026-06-06) — uws 키는 week_start_date
const summerWeeks = await q("weeks?select=id,week_number,start_date,check_threshold,result_published_at&season_key=eq.2025-summer&order=week_number");
console.log(`    2025-summer weeks: ${summerWeeks.total}행 — ${summerWeeks.rows.map((w) => `W${w.week_number}(thr${w.check_threshold}${w.result_published_at ? "·pub" : ""})`).join(" ")}`);
check("2025-summer weeks = W1~4 만 (W5~8 삭제 유지) · threshold 0",
  summerWeeks.total === 4 && summerWeeks.rows.every((w) => w.week_number <= 4 && w.check_threshold === 0));
const summerStarts = summerWeeks.rows.map((w) => w.start_date);
const summerUws = await q(`user_week_statuses?select=user_id,week_start_date,status&week_start_date=in.(${summerStarts.join(",")})&limit=1000`);
const byWeek = new Map();
for (const r of summerUws.rows) byWeek.set(r.week_start_date, (byWeek.get(r.week_start_date) ?? 0) + 1);
console.log(`    2025-summer uws: ${summerUws.total}행 — ${[...byWeek.entries()].sort().map(([w, n]) => `${w}:${n}`).join(" ")}`);
check("top-up uws = 24행 (6명×W1~4, Δuws 와 일치)", summerUws.total === 24, `실제 ${summerUws.total}`);

// ════════ ③ 1092 dry-run weekRows ↔ 라이브 weeks 유효성 ════════
console.log("\n[3] dry-run 1092 weekRows(46) ↔ 라이브 weeks");
const dry = JSON.parse(readFileSync("claudedocs/dryrun-pms-1092-20260606.json", "utf8"));
const weeks = await q("weeks?select=id,season_key,week_number,start_date,check_threshold,result_published_at,is_official_rest&order=start_date&limit=1000");
check("weeks 총 149행 (B7 153 − top-up 2단계 summer W5~8 삭제 4)", weeks.total === 149, `실제 ${weeks.total}`);
const seasons = await q("seasons?select=id&limit=1");
check("seasons 13행 (B7 apply 후 불변)", seasons.total === 13, `실제 ${seasons.total}`);

const mismatches = [];
for (const wr of dry.weekRows) {
  const live = weeks.rows.find((w) => w.start_date === wr.start);
  if (!live) { mismatches.push(`${wr.week}: 라이브 주차 부재`); continue; }
  const thr = live.check_threshold ?? 30; // dry-run 은 DEFAULT 30 적용값으로 기록
  if (thr !== wr.threshold) mismatches.push(`${wr.week}: threshold ${wr.threshold}→${thr}`);
  if ((live.result_published_at != null) !== wr.published) mismatches.push(`${wr.week}: published ${wr.published}→${live.result_published_at != null}`);
  if (live.is_official_rest !== wr.isOfficialRest) mismatches.push(`${wr.week}: rest ${wr.isOfficialRest}→${live.is_official_rest}`);
}
check(`dry-run 참조 ${dry.weekRows.length}주 전부 라이브 일치 (threshold·publish·rest)`, mismatches.length === 0,
  mismatches.length ? mismatches.join(" / ") : undefined);

// FLIP 2행 기준 주차 재확인 (2025-autumn W13 thr30 · 2026-winter W5 thr37)
const flipChecks = [
  { start: "2025-11-24", thr: 30, label: "2025-autumn W13" },
  { start: "2026-01-26", thr: 37, label: "2026-winter W5" },
];
for (const f of flipChecks) {
  const live = weeks.rows.find((w) => w.start_date === f.start);
  check(`FLIP 기준 주차 ${f.label} threshold=${f.thr} 유지`, live != null && (live.check_threshold ?? 30) === f.thr,
    live ? `실제 ${live.check_threshold}` : "부재");
}

// W8 공식 휴식 + winter 휴식 단 1건
const winterRest = weeks.rows.filter((w) => w.season_key === "2026-winter" && w.is_official_rest);
check("2026-winter 휴식 플래그 = W8 단 1건", winterRest.length === 1 && winterRest[0].week_number === 8,
  JSON.stringify(winterRest.map((w) => w.week_number)));
const pubCount = weeks.rows.filter((w) => w.result_published_at != null).length;
check("result_published_at 보유 = 42 (B7 46 − 삭제된 summer W5~8 publish 4)", pubCount === 42, `실제 ${pubCount}`);

console.log(`\n결과: ✅ ${pass} / ❌ ${fail}`);
process.exit(fail > 0 ? 1 : 0);
