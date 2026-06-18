/**
 * 진단 전용(read-only): 휴식 데이터 체인 전수 확인.
 *  Layer A — PMS MySQL 원본(restdates/seasonrestlogs/...) 존재·건수
 *  Layer B — 현재 Supabase DB(user_season_statuses/user_week_statuses/...) 건수
 *  Layer C — direct function listMembersRoster() displayGrowthStatus 분포
 *  npx tsx --env-file=.env.local scripts/diag-rest-data-chain.ts
 */
import mysql from "mysql2/promise";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listMembersRoster } from "@/lib/adminMembersData";

const env = (k: string) => process.env[k];
const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(64));

async function layerA() {
  hr();
  line("LAYER A — PMS MySQL 원본 (휴식 관련 테이블 존재·건수)");
  hr();
  const conn = await mysql.createConnection({
    host: env("MYSQL_HOST"),
    port: Number(env("MYSQL_PORT") ?? 3306),
    user: env("MYSQL_USER"),
    password: env("MYSQL_PASSWORD"),
    database: env("MYSQL_DATABASE"),
  });
  // 오랑캐 PMS 외 다른 org DB(hrdb/olympus)도 같은 서버에 있을 수 있어 함께 탐침.
  const dbs = ["oranke", "hrdb", "olympus"];
  const restTables = [
    "restdates",
    "restlogs",
    "restchangelogs",
    "seasonrestlogs",
    "seasonchangeusers",
    "seasonteamdatas",
  ];
  for (const db of dbs) {
    try {
      const [tbls] = (await conn.query(
        `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
        [db],
      )) as any;
      const present = new Set((tbls as any[]).map((r) => r.TABLE_NAME));
      if (present.size === 0) {
        line(`  [${db}] (DB 접근 불가/빈 스키마)`);
        continue;
      }
      line(`  [${db}] 휴식 관련 테이블:`);
      for (const t of restTables) {
        if (!present.has(t)) {
          line(`    - ${t}: (테이블 없음)`);
          continue;
        }
        try {
          const [c] = (await conn.query(
            `SELECT COUNT(*) n FROM \`${db}\`.\`${t}\``,
          )) as any;
          // 컬럼도 같이 노출
          const [cols] = (await conn.query(
            `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`,
            [db, t],
          )) as any;
          line(
            `    - ${t}: ${c[0].n} rows  cols=[${(cols as any[])
              .map((x) => x.COLUMN_NAME)
              .join(", ")}]`,
          );
        } catch (e: any) {
          line(`    - ${t}: (count 실패: ${e.message})`);
        }
      }
    } catch (e: any) {
      line(`  [${db}] 스키마 조회 실패: ${e.message}`);
    }
  }
  await conn.end();
}

async function sbCount(table: string, filter?: (q: any) => any): Promise<string> {
  let q = supabaseAdmin.from(table).select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count, error } = await q;
  if (error) return `(오류: ${error.message})`;
  return String(count ?? 0);
}

async function layerB() {
  hr();
  line("LAYER B — 현재 Supabase DB (휴식 데이터 건수)");
  hr();
  line("  • 달력급(조직 전체 휴식):");
  line(`    - official_rest_periods (전체): ${await sbCount("official_rest_periods")}`);
  line(
    `    - weeks.is_official_rest=true: ${await sbCount("weeks", (q) =>
      q.eq("is_official_rest", true),
    )}`,
  );
  line("  • 개인급(사용자별 휴식):");
  line(
    `    - user_season_statuses status='rest': ${await sbCount(
      "user_season_statuses",
      (q) => q.eq("status", "rest"),
    )}`,
  );
  line(
    `    - user_season_statuses (전체 row): ${await sbCount("user_season_statuses")}`,
  );
  line(
    `    - user_week_statuses status='personal_rest': ${await sbCount(
      "user_week_statuses",
      (q) => q.eq("status", "personal_rest"),
    )}`,
  );
  line(
    `    - user_week_statuses status='official_rest': ${await sbCount(
      "user_week_statuses",
      (q) => q.eq("status", "official_rest"),
    )}`,
  );
  line(
    `    - user_week_statuses (전체 row): ${await sbCount("user_week_statuses")}`,
  );
  line(
    `    - user_profiles growth_status='weekly_rest': ${await sbCount(
      "user_profiles",
      (q) => q.eq("growth_status", "weekly_rest"),
    )}`,
  );
  line(
    `    - user_profiles growth_status='seasonal_rest': ${await sbCount(
      "user_profiles",
      (q) => q.eq("growth_status", "seasonal_rest"),
    )}`,
  );
  // growth_status 분포 전체
  const { data: gs } = await supabaseAdmin
    .from("user_profiles")
    .select("growth_status");
  if (gs) {
    const dist: Record<string, number> = {};
    for (const r of gs as any[]) {
      const k = r.growth_status ?? "(null)";
      dist[k] = (dist[k] ?? 0) + 1;
    }
    line(`    - user_profiles.growth_status 분포: ${JSON.stringify(dist)}`);
  }
  line(
    `    - crew_personal_rest_periods (전체): ${await sbCount(
      "crew_personal_rest_periods",
    )}`,
  );
}

async function layerC() {
  hr();
  line("LAYER C — direct function listMembersRoster() displayGrowthStatus 분포");
  hr();
  for (const mode of ["operating", "test"] as const) {
    try {
      const { members, partialFailure } = await listMembersRoster({ mode });
      const dist: Record<string, number> = {};
      for (const m of members) {
        const k = (m as any).displayGrowthStatus ?? "(null)";
        dist[k] = (dist[k] ?? 0) + 1;
      }
      line(`  [mode=${mode}] members=${members.length} partialFailure=${JSON.stringify(partialFailure)}`);
      line(`    displayGrowthStatus 분포: ${JSON.stringify(dist)}`);
      const restMembers = members.filter((m) =>
        ["weekly_rest", "seasonal_rest", "official_rest"].includes(
          (m as any).displayGrowthStatus,
        ),
      );
      line(`    휴식류(weekly/seasonal/official_rest) 행 수: ${restMembers.length}`);
    } catch (e: any) {
      line(`  [mode=${mode}] 실패: ${e.message}`);
    }
  }
}

async function main() {
  await layerA().catch((e) => line(`LAYER A 실패: ${e.message}`));
  await layerB().catch((e) => line(`LAYER B 실패: ${e.message}`));
  await layerC().catch((e) => line(`LAYER C 실패: ${e.message}`));
  hr();
  line("DONE");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
