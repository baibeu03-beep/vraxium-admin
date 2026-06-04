/**
 * READ-ONLY: Details 카드 "성장 가능 시즌 < 성장 성공 시즌" 역전 진단.
 *
 * 성장 성공 시즌(approvedSeasons/g) SoT = user_season_statuses status≠'rest' COUNT
 * 성장 가능 시즌(화면 표기)            = seasonHistories.length
 *   → responseSeasonHistories = adminResume.seasonRecords(주차 있는 season_key 수) 우선,
 *     없으면 로컬 user_season_histories 행 수.
 *
 * 전 유저에 대해 4개 카운트를 비교해 역전(g > 가능 표기값) 유저를 찾는다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
// dotenv 적용 후 로드되도록 함수 내 동적 import (정적 require 호이스팅 회피).
type SupabaseAdmin = typeof import("@/lib/supabaseAdmin").supabaseAdmin;
let supabaseAdmin: SupabaseAdmin;

type Row = Record<string, unknown>;

async function fetchAll(table: string, select: string): Promise<Row[]> {
  const page = 1000;
  let from = 0;
  const out: Row[] = [];
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(select)
      .order("user_id", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = (data ?? []) as Row[];
    out.push(...batch);
    if (batch.length < page) break;
    from += page;
  }
  return out;
}

async function main() {
  ({ supabaseAdmin } = await import("@/lib/supabaseAdmin"));
  const [ssRows, ushRows, uwsRows, profiles] = await Promise.all([
    fetchAll("user_season_statuses", "user_id,season_key,status"),
    fetchAll("user_season_histories", "user_id,season_id"),
    fetchAll("user_week_statuses", "user_id,season_key,week_start_date"),
    fetchAll("user_profiles", "user_id,display_name"),
  ]);

  const nameOf = new Map(profiles.map((p) => [p.user_id as string, p.display_name as string]));

  // g/f per user (user_season_statuses)
  const g = new Map<string, number>();
  const f = new Map<string, number>();
  const ssKeys = new Map<string, string[]>();
  for (const r of ssRows) {
    const uid = r.user_id as string;
    if (r.status === "rest") f.set(uid, (f.get(uid) ?? 0) + 1);
    else g.set(uid, (g.get(uid) ?? 0) + 1);
    const ks = ssKeys.get(uid) ?? [];
    ks.push(`${r.season_key}:${r.status}`);
    ssKeys.set(uid, ks);
  }

  // user_season_histories 행 수 (로컬 seasonHistories 경로)
  const ush = new Map<string, number>();
  for (const r of ushRows) {
    const uid = r.user_id as string;
    ush.set(uid, (ush.get(uid) ?? 0) + 1);
  }

  // admin seasonRecords 경로 = user_week_statuses 의 distinct season_key (주차 보유 시즌 수)
  const uwsSeasons = new Map<string, Set<string>>();
  for (const r of uwsRows) {
    const uid = r.user_id as string;
    const key = r.season_key as string | null;
    if (!key) continue;
    const s = uwsSeasons.get(uid) ?? new Set<string>();
    s.add(key);
    uwsSeasons.set(uid, s);
  }

  const allUids = new Set<string>([...g.keys(), ...f.keys(), ...ush.keys(), ...uwsSeasons.keys()]);
  const bad: Array<Record<string, unknown>> = [];
  for (const uid of allUids) {
    const gg = g.get(uid) ?? 0;
    const ff = f.get(uid) ?? 0;
    const histories = ush.get(uid) ?? 0;
    const adminSeasons = uwsSeasons.get(uid)?.size ?? 0;
    // 화면 가능 시즌 = adminSeasons(>0이면 우선) else histories
    const displayed = adminSeasons > 0 ? adminSeasons : histories;
    if (gg > displayed || gg > histories) {
      bad.push({
        user_id: uid,
        name: nameOf.get(uid) ?? "?",
        successSeasons_g: gg,
        restSeasons_f: ff,
        ush_rows: histories,
        uws_distinct_seasons: adminSeasons,
        displayed_possible: displayed,
        season_statuses: ssKeys.get(uid) ?? [],
        uws_season_keys: [...(uwsSeasons.get(uid) ?? [])],
      });
    }
  }

  console.log(`total users scanned: ${allUids.size}`);
  console.log(`violations (g > displayed possible OR g > ush rows): ${bad.length}`);
  console.log(JSON.stringify(bad.slice(0, 50), null, 2));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
