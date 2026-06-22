/**
 * PMS useractivities → user_position_histories 이관(주차단위 직책 이력).
 *   DRY_RUN(기본): 디코드/매핑 검증만(새 테이블 무접촉) — 윤서영·운영진 샘플 + 통계.
 *   APPLY=1     : user_position_histories upsert(테이블 선행 생성 필요).
 *
 *   npx tsx --env-file=.env.local scripts/ingest-position-histories.ts            # dry-run
 *   APPLY=1 npx tsx --env-file=.env.local scripts/ingest-position-histories.ts    # 적용
 */
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { createClient } from "@supabase/supabase-js";
import {
  decodePmsPosition,
  higherPosition,
  PMS_POSITION_SOURCE,
  type PositionCode,
} from "@/lib/positionHistory";

const env = readFileSync(".env.local", "utf8");
const G = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(G("NEXT_PUBLIC_SUPABASE_URL")!, G("SUPABASE_SERVICE_ROLE_KEY")!);
const APPLY = process.env.APPLY === "1";

const SOURCE_DB: Record<string, string> = { oranke: "oranke", hrdb: "hrdb", olympus: "olympus" };

type WeekMeta = { id: string; week_number: number | null; season_key: string | null };
type Acc = {
  user_id: string; organization: string | null;
  week_start_date: string; week: WeekMeta;
  code: PositionCode; raw: { level: string | null; team: string | null; part: string | null };
  source_ref: string | null; source_system: string; legacy_user_id: number;
};

async function sbAll(table: string, sel: string): Promise<any[]> {
  const out: any[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from(table).select(sel).range(f, f + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  // Vraxium weeks: start_date → meta
  const weeks = await sbAll("weeks", "id,start_date,week_number,season_key");
  const weekByStart = new Map<string, WeekMeta>();
  for (const w of weeks) {
    const k = String(w.start_date).slice(0, 10);
    if (!weekByStart.has(k)) weekByStart.set(k, { id: w.id, week_number: w.week_number, season_key: w.season_key });
  }

  // Vraxium users + profiles
  const users = await sbAll("users", "id,source_system,legacy_user_id");
  const profiles = await sbAll("user_profiles", "user_id,display_name,organization_slug");
  const orgByUid = new Map(profiles.map((p) => [p.user_id, p.organization_slug]));
  const nameByUid = new Map(profiles.map((p) => [p.user_id, p.display_name]));
  const vidByKey = new Map<string, string>(); // "src::legacy" → user_id
  for (const u of users) {
    if (u.source_system && u.legacy_user_id != null) vidByKey.set(`${u.source_system}::${Number(u.legacy_user_id)}`, u.id);
  }

  const conn = await mysql.createConnection({
    host: G("MYSQL_HOST"), port: Number(G("MYSQL_PORT") ?? 3306),
    user: G("MYSQL_USER"), password: G("MYSQL_PASSWORD"), dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const q = async (s: string) => (await conn.query(s))[0] as any[];

  // (user_id, week_start_date) → Acc (그 주차 최고 직책 유지)
  const byUserWeek = new Map<string, Acc>();
  let pmsRows = 0, unmatchedUser = 0, unmatchedWeek = 0;

  for (const [source, db] of Object.entries(SOURCE_DB)) {
    const rows = await q(
      `SELECT ActivityId,UserId,StartDate,UserLevel,UserTeam,UserPart FROM \`${db}\`.useractivities`,
    );
    for (const r of rows as any[]) {
      pmsRows++;
      const vid = vidByKey.get(`${source}::${Number(r.UserId)}`);
      if (!vid) { unmatchedUser++; continue; }
      if (!r.StartDate) { unmatchedWeek++; continue; }
      const start = String(r.StartDate).slice(0, 10);
      const week = weekByStart.get(start);
      if (!week) { unmatchedWeek++; continue; }
      const code = decodePmsPosition(r.UserLevel, r.UserTeam, r.UserPart);
      const key = `${vid}::${start}`;
      const existing = byUserWeek.get(key);
      if (existing) {
        existing.code = higherPosition(existing.code, code); // 같은 주차 최고 직책
      } else {
        byUserWeek.set(key, {
          user_id: vid, organization: orgByUid.get(vid) ?? null,
          week_start_date: start, week,
          code, raw: { level: r.UserLevel, team: r.UserTeam, part: r.UserPart },
          source_ref: r.ActivityId != null ? String(r.ActivityId) : null,
          source_system: source, legacy_user_id: Number(r.UserId),
        });
      }
    }
  }
  await conn.end();

  const accs = [...byUserWeek.values()];
  console.log(`PMS useractivities 행=${pmsRows} · 매핑성공=${accs.length} · 유저미매칭=${unmatchedUser} · 주차미매칭=${unmatchedWeek}`);
  const codeDist = new Map<string, number>();
  for (const a of accs) codeDist.set(a.code, (codeDist.get(a.code) ?? 0) + 1);
  console.log(`position_code 분포(주차행): ${JSON.stringify([...codeDist.entries()])}`);
  const userSet = new Set(accs.map((a) => a.user_id));
  console.log(`대상 사용자=${userSet.size}`);

  // 샘플: 윤서영 + 운영진 신호 있는 유저
  const ysVid = [...nameByUid.entries()].find(([, n]) => n === "윤서영")?.[0];
  if (ysVid) {
    const rows = accs.filter((a) => a.user_id === ysVid).sort((a, b) => a.week_start_date.localeCompare(b.week_start_date));
    console.log(`\n[샘플 윤서영] ${rows.length}주`);
    const bySeason = new Map<string, Map<PositionCode, number>>();
    for (const r of rows) {
      const m = bySeason.get(r.week.season_key ?? "-") ?? new Map();
      m.set(r.code, (m.get(r.code) ?? 0) + 1); bySeason.set(r.week.season_key ?? "-", m);
    }
    for (const [s, m] of bySeason) console.log(`  ${s}: ${JSON.stringify([...m.entries()])}`);
  }
  // 운영진 주차 보유 유저 3명 샘플
  const opUsers = [...new Set(accs.filter((a) => a.code.startsWith("operating")).map((a) => a.user_id))].slice(0, 3);
  for (const uid of opUsers) {
    const rows = accs.filter((a) => a.user_id === uid);
    const m = new Map<PositionCode, number>();
    for (const r of rows) m.set(r.code, (m.get(r.code) ?? 0) + 1);
    console.log(`\n[샘플 운영진주차] ${nameByUid.get(uid)} (${orgByUid.get(uid)}): ${JSON.stringify([...m.entries()])}`);
  }

  if (!APPLY) { console.log(`\n[DRY RUN] APPLY=1 로 upsert (${accs.length}행).`); return; }

  // ── upsert ──
  const payload = accs.map((a) => ({
    user_id: a.user_id, organization: a.organization,
    season_key: a.week.season_key, week_id: a.week.id,
    week_number: a.week.week_number, week_start_date: a.week_start_date,
    position_code: a.code, source: PMS_POSITION_SOURCE, source_ref: a.source_ref,
    source_system: a.source_system, legacy_user_id: a.legacy_user_id,
    raw_level: a.raw.level, raw_team: a.raw.team, raw_part: a.raw.part,
    updated_at: new Date(0).toISOString(), // placeholder; DB default now() on insert
  }));
  // updated_at 은 DB default(now())에 맡기려 제거.
  for (const p of payload) delete (p as any).updated_at;

  let done = 0;
  const CHUNK = 500;
  for (let i = 0; i < payload.length; i += CHUNK) {
    const chunk = payload.slice(i, i + CHUNK);
    const { error } = await sb.from("user_position_histories").upsert(chunk, { onConflict: "user_id,week_start_date" });
    if (error) throw new Error(`upsert: ${error.message}`);
    done += chunk.length;
    if (done % 5000 === 0 || done === payload.length) console.log(`  upsert ${done}/${payload.length}`);
  }
  console.log(`[APPLY] 완료: ${done}행 upsert.`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
