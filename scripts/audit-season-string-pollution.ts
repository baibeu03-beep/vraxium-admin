/**
 * PMS 3개 소스 — Season 문자열 오염 전수 조사 (read-only · write 0).
 *   npx tsx scripts/audit-season-string-pollution.ts
 *
 * 기준: 현행 이관 정규화(normSeason — 공백류 제거·'시즌' 접미 제거 후 사전 매칭)로
 *   매칭 실패하는 문자열 = 오염. 매칭되더라도 raw 변형(공백·접미)은 변형 통계로 병기.
 */
import { readFileSync, writeFileSync } from "fs";
import mysql from "mysql2/promise";

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const OUT = "claudedocs/audit-season-pollution-20260607.json";
const SOURCES = ["oranke", "hrdb", "olympus"] as const;

const SEASON_DICT = new Map([["봄", "spring"], ["여름", "summer"], ["가을", "autumn"], ["겨울", "winter"], ["거울", "winter"]]);
const normSeason = (s: unknown) => {
  let x = String(s ?? "").replace(/[\s\r\n ]+/g, "");
  if (x.endsWith("시즌")) x = x.slice(0, -2);
  return SEASON_DICT.get(x) ?? null;
};
const show = (s: string) =>
  JSON.stringify(s); // 특수문자 가시화

async function main() {
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"), port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"), password: envGet("MYSQL_PASSWORD"),
    dateStrings: true, ssl: { rejectUnauthorized: false },
  });

  // 276 대상 목록 (최종 정책: State 일반/운영진 · oranke 916/873 제외 · 운영진=활동행 보유자만)
  const targetIds = new Map<string, Set<number>>();
  for (const src of SOURCES) {
    const excl = src === "oranke" ? " AND u.UserId NOT IN (916,873)" : "";
    const [rows] = (await conn.query(`
      SELECT u.UserId FROM ${src}.users u JOIN ${src}.usersinfo i ON i.UserID=u.UserId
      WHERE i.State IN ('일반','운영진')${excl}
        AND (i.State='일반'
             OR EXISTS (SELECT 1 FROM ${src}.useractivities a WHERE a.UserId=u.UserId)
             OR EXISTS (SELECT 1 FROM ${src}.manageractivities m WHERE m.UserId=u.UserId))`)) as [any[], unknown];
    targetIds.set(src, new Set(rows.map((r) => Number(r.UserId))));
  }

  // pilot uuid → pms id
  const PILOT = new Map([["oranke|1092", "P1 장승완"], ["hrdb|1463", "P2 안은비"], ["olympus|249", "P3 성채윤"], ["olympus|248", "P4 박시은"], ["olympus|251", "P5 정혜빈"]]);

  type Stat = {
    raw: string; norm: string | null; rows: number; users: Set<number>; activeRows: number;
    activeUserWeeks: Set<string>; sources: Set<string>; targetUsers: Set<string>; pilotUsers: Set<string>;
  };
  const byRaw = new Map<string, Stat>();
  let totalRows = 0;
  for (const src of SOURCES) {
    for (const table of ["useractivities", "manageractivities"]) {
      const [rows] = (await conn.query(`
        SELECT Season, SeasonWeek, UserId, IsActive FROM ${src}.${table}`)) as [any[], unknown];
      for (const r of rows) {
        totalRows++;
        const raw = String(r.Season ?? "");
        let s = byRaw.get(raw);
        if (!s) {
          s = { raw, norm: normSeason(raw), rows: 0, users: new Set(), activeRows: 0, activeUserWeeks: new Set(), sources: new Set(), targetUsers: new Set(), pilotUsers: new Set() };
          byRaw.set(raw, s);
        }
        s.rows++;
        s.users.add(Number(r.UserId));
        s.sources.add(src);
        if (r.IsActive === 1) {
          s.activeRows++;
          s.activeUserWeeks.add(`${src}|${r.UserId}|${raw}|${r.SeasonWeek}`);
        }
        if (targetIds.get(src)!.has(Number(r.UserId))) s.targetUsers.add(`${src}|${r.UserId}`);
        const pk = PILOT.get(`${src}|${r.UserId}`);
        if (pk) s.pilotUsers.add(pk);
      }
    }
  }
  await conn.end();

  const all = [...byRaw.values()].sort((a, b) => b.rows - a.rows);
  const polluted = all.filter((s) => s.norm === null);
  const normalVariants = all.filter((s) => s.norm !== null && !["봄", "여름", "가을", "겨울"].includes(s.raw));
  const clean = all.filter((s) => ["봄", "여름", "가을", "겨울"].includes(s.raw));

  console.log(`전체 활동행 ${totalRows} | distinct Season 문자열 ${all.length} (정상 4종 ${clean.length} · 정규화 흡수 변형 ${normalVariants.length} · 오염 ${polluted.length})`);
  console.log("\n══ 오염 (정규화 실패 — 귀속 누락) ══");
  console.log("문자열".padEnd(20), "| 행 수 | 사용자 | 인정행 | 누락예상(user×주차) | 276대상 | pilot | 소스");
  let pollutedActiveUW = 0, pollutedTargetUsers = new Set<string>();
  for (const s of polluted) {
    pollutedActiveUW += s.activeUserWeeks.size;
    for (const u of s.targetUsers) pollutedTargetUsers.add(u);
    console.log(show(s.raw).padEnd(20), "|", String(s.rows).padStart(5), "|", String(s.users.size).padStart(5), "|", String(s.activeRows).padStart(5), "|", String(s.activeUserWeeks.size).padStart(8), "|", String(s.targetUsers.size).padStart(5), "|", [...s.pilotUsers].join(",") || "-", "|", [...s.sources].join(","));
  }
  console.log("\n══ 정규화가 흡수하는 변형 (참고 — 누락 없음) ══");
  for (const s of normalVariants.slice(0, 15)) {
    console.log(show(s.raw).padEnd(24), "→", s.norm, "|", s.rows, "행");
  }
  console.log(`\n오염 합계: 행 ${polluted.reduce((x, s) => x + s.rows, 0)} · 인정행 ${polluted.reduce((x, s) => x + s.activeRows, 0)} · 누락 예상 user×주차 ${pollutedActiveUW} · 276대상 영향 사용자 ${pollutedTargetUsers.size}`);
  writeFileSync(OUT, JSON.stringify({
    totalRows, distinct: all.length,
    polluted: polluted.map((s) => ({ raw: s.raw, rows: s.rows, users: s.users.size, activeRows: s.activeRows, missUserWeeks: s.activeUserWeeks.size, targetUsers: [...s.targetUsers], pilot: [...s.pilotUsers], sources: [...s.sources] })),
    variants: normalVariants.map((s) => ({ raw: s.raw, norm: s.norm, rows: s.rows })),
    pollutedTargetUsers: [...pollutedTargetUsers],
  }, null, 1));
  console.log("→", OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
