// B7 dry-run 입력 5종 export — pms MySQL(oranke) 읽기 전용 SELECT 만 수행.
//   산출: claudedocs/pms-export/{weekssettings,seasondates,reportlogs_weeks,
//          pointlogs_activity_dates,activities_weeks}.json
//   계약: scripts/backfill-seasons-weeks-dryrun.ts 헤더의 입력 계약과 1:1.
//   ActivityTime 보정 규칙(A5-2 확정 4)은 dry-run 헤더의 export SQL 그대로.
//     node scripts/export-pms-b7-inputs.mjs
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const env = readFileSync(resolve(root, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();

const OUT_DIR = resolve(root, "claudedocs", "pms-export");
mkdirSync(OUT_DIR, { recursive: true });

const conn = await mysql.createConnection({
  host: get("MYSQL_HOST"),
  port: Number(get("MYSQL_PORT") ?? 3306),
  user: get("MYSQL_USER"),
  password: get("MYSQL_PASSWORD"),
  database: get("MYSQL_DATABASE"),
  // zero-date(0001-01-01 등) 드라이버 변환 이슈 방지 — 날짜는 문자열로 수신
  dateStrings: true,
  connectTimeout: 20000,
  // 서버가 SSL 필수(REQUIRE SSL) — 미사용 시 access denied. 서버 설정 변경 금지, 클라이언트만 SSL.
  ssl: { rejectUnauthorized: false },
});

// ── 0) preflight: 대상 테이블 컬럼 존재 확인 (계약 컬럼 누락 시 즉시 중단) ──
const EXPECT = {
  weekssettings: ["Id", "season", "week", "StartDate", "EndDate", "confirmStar", "IsPublic"],
  seasondates: ["Id", "SeasonName", "Week", "StartDate", "EndDate", "Comment", "IsRestWeek", "PassingScore"],
  reportlogs: ["Season", "Week", "Created"],
  pointlogs: ["ActivityTime", "createtime"],
  useractivities: ["Season", "SeasonWeek", "Activity", "Star"],
  manageractivities: ["Season", "SeasonWeek", "Activity", "Star"],
};
const [colRows] = await conn.query(
  `SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${Object.keys(EXPECT).map(() => "?").join(",")})`,
  Object.keys(EXPECT),
);
const colsByTable = new Map();
for (const r of colRows) {
  if (!colsByTable.has(r.t)) colsByTable.set(r.t, new Set());
  colsByTable.get(r.t).add(r.c);
}
for (const [table, cols] of Object.entries(EXPECT)) {
  const have = colsByTable.get(table);
  if (!have) throw new Error(`preflight 실패: 테이블 ${table} 부재`);
  const missing = cols.filter((c) => !have.has(c));
  if (missing.length) throw new Error(`preflight 실패: ${table} 컬럼 누락 ${JSON.stringify(missing)} (보유: ${[...have].join(",")})`);
}
console.log("[0] preflight OK —", Object.keys(EXPECT).join(", "));

async function exportQuery(name, sql) {
  const [rows] = await conn.query(sql);
  // BigInt/Buffer 방어 직렬화
  const plain = JSON.parse(JSON.stringify(rows, (_, v) => (typeof v === "bigint" ? Number(v) : v)));
  writeFileSync(resolve(OUT_DIR, `${name}.json`), JSON.stringify(plain, null, 1));
  console.log(`[+] ${name}.json — ${plain.length}행`);
  return plain;
}

// ── 1) weekssettings — 결산 속성 (전 행) ──────────────────────────────────
await exportQuery(
  "weekssettings",
  `SELECT Id, season, week,
          CAST(StartDate AS CHAR) AS StartDate, CAST(EndDate AS CHAR) AS EndDate,
          confirmStar, IsPublic
   FROM weekssettings ORDER BY StartDate, Id`,
);

// ── 2) seasondates — 달력·휴식 (전 행) ────────────────────────────────────
await exportQuery(
  "seasondates",
  `SELECT Id, SeasonName, Week,
          CAST(StartDate AS CHAR) AS StartDate, CAST(EndDate AS CHAR) AS EndDate,
          Comment, IsRestWeek, PassingScore
   FROM seasondates ORDER BY StartDate, Id`,
);

// ── 3) reportlogs_weeks — (Season, Week) 실적 역산용 집계 ─────────────────
await exportQuery(
  "reportlogs_weeks",
  `SELECT Season, Week,
          CAST(MIN(Created) AS CHAR) AS minCreated,
          CAST(MAX(Created) AS CHAR) AS maxCreated,
          COUNT(*) AS cnt
   FROM reportlogs GROUP BY Season, Week ORDER BY MIN(Created)`,
);

// ── 4) pointlogs_activity_dates — ActivityTime 보정 히스토그램 (확정 4 SQL) ──
await exportQuery(
  "pointlogs_activity_dates",
  `SELECT CAST(CASE
            WHEN YEAR(ActivityTime) BETWEEN 20 AND 99 THEN DATE(ActivityTime + INTERVAL 2000 YEAR)
            WHEN YEAR(ActivityTime) = 1 THEN DATE(createtime)
            ELSE DATE(ActivityTime) END AS CHAR) AS activity_date,
          CAST(SUM(YEAR(ActivityTime) = 1) AS SIGNED) AS date_substituted_rows,
          COUNT(*) AS \`rows\`
   FROM pointlogs GROUP BY 1 ORDER BY 1`,
);

// ── 5) activities_weeks — [통합] 임시 라인 복원성 (양 세대 UNION) ─────────
await exportQuery(
  "activities_weeks",
  `SELECT 'useractivities' AS source, Season, SeasonWeek,
          COUNT(*) AS cnt,
          CAST(SUM(Activity IS NOT NULL AND TRIM(Activity) <> '') AS SIGNED) AS withActivity,
          CAST(SUM(Star IS NOT NULL) AS SIGNED) AS withStar
   FROM useractivities GROUP BY Season, SeasonWeek
   UNION ALL
   SELECT 'manageractivities' AS source, Season, SeasonWeek,
          COUNT(*) AS cnt,
          CAST(SUM(Activity IS NOT NULL AND TRIM(Activity) <> '') AS SIGNED) AS withActivity,
          CAST(SUM(Star IS NOT NULL) AS SIGNED) AS withStar
   FROM manageractivities GROUP BY Season, SeasonWeek
   ORDER BY source, Season, SeasonWeek`,
);

await conn.end();
console.log(`\n✅ export 완료 → ${OUT_DIR}`);
