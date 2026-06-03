// 라인 개설 이력 데이터 레이어 검증 — listCluster4OpenedLines 를 실 DB 로 직접 호출한다.
// 어드민 HTTP 라우트는 supabase 세션 인증이 필요해 curl 검증이 어려우므로,
// 라우트가 호출하는 데이터 함수를 동일 입력으로 직접 실행해 쿼리 로직/실데이터 shape 을 검증한다.
//
// 실행: npx tsx --env-file=.env.local scripts/diag-line-history.ts
import {
  listCluster4OpenedLines,
} from "@/lib/adminCluster4LinesData";
import type { Cluster4OpenedLineDto } from "@/lib/adminCluster4LinesTypes";

const REQUIRED_FIELDS: (keyof Cluster4OpenedLineDto)[] = [
  "id",
  "lineName",
  "hubName",
  "seasonName",
  "startDate",
  "endDate",
  "status",
  "createdAt",
];

function sample(rows: Cluster4OpenedLineDto[], n = 3) {
  return rows.slice(0, n).map((r) => ({
    id: r.id.slice(0, 8),
    hub: r.hubName,
    cat: r.categoryName,
    name: r.lineName.slice(0, 24),
    season: r.seasonName,
    week: r.weekNumber,
    start: r.startDate?.slice(0, 10),
    end: r.endDate?.slice(0, 10),
    status: r.status,
    tgt: r.targetCount,
    sub: r.submissionCount,
  }));
}

async function main() {
  const all = await listCluster4OpenedLines({ status: "all", limit: 200 });
  const current = await listCluster4OpenedLines({ status: "current", limit: 200 });
  const past = await listCluster4OpenedLines({ status: "past", limit: 200 });

  console.log("=== status counts (total / loaded) ===");
  console.log(`all    : total=${all.total} loaded=${all.rows.length}`);
  console.log(`current: total=${current.total} loaded=${current.rows.length}`);
  console.log(`past   : total=${past.total} loaded=${past.rows.length}`);

  // 정합성: current + past == all (status 는 closes_at 기준 상호배타).
  console.log(
    `\n[check] current.total + past.total == all.total : ${
      current.total + past.total === all.total
    } (${current.total} + ${past.total} = ${current.total + past.total} vs ${all.total})`,
  );

  // 필수 필드 존재 검증.
  const missing: Record<string, number> = {};
  for (const r of all.rows) {
    for (const f of REQUIRED_FIELDS) {
      // seasonName 은 주차 미연결 라인에서 null 허용 → 존재(키)만 확인.
      if (!(f in r)) missing[f] = (missing[f] ?? 0) + 1;
    }
  }
  console.log(
    `\n[check] required fields present on every row: ${
      Object.keys(missing).length === 0
    } ${Object.keys(missing).length ? JSON.stringify(missing) : ""}`,
  );

  // 정렬 검증: startDate desc.
  let sortedOk = true;
  for (let i = 1; i < all.rows.length; i++) {
    if ((all.rows[i - 1].startDate ?? "") < (all.rows[i].startDate ?? "")) {
      sortedOk = false;
      break;
    }
  }
  console.log(`[check] sorted by startDate desc: ${sortedOk}`);

  // 허브별 분포.
  const byHub: Record<string, number> = {};
  for (const r of all.rows) byHub[r.partType] = (byHub[r.partType] ?? 0) + 1;
  console.log(`\n=== by hub (loaded) ===`);
  console.log(byHub);

  console.log(`\n=== sample (all) ===`);
  console.table(sample(all.rows));

  // partType 필터 검증.
  const careerOnly = await listCluster4OpenedLines({ partType: "career", limit: 50 });
  const careerPure = careerOnly.rows.every((r) => r.partType === "career");
  console.log(
    `\n[check] partType=career filter pure: ${careerPure} (rows=${careerOnly.rows.length})`,
  );

  // seasonKey 필터 검증 (데이터가 있으면).
  const seasonKey = all.rows.find((r) => r.seasonKey)?.seasonKey ?? null;
  if (seasonKey) {
    const bySeason = await listCluster4OpenedLines({ seasonKey, limit: 200 });
    const pure = bySeason.rows.every((r) => r.seasonKey === seasonKey);
    console.log(
      `[check] seasonKey='${seasonKey}' filter: rows=${bySeason.rows.length} pure=${pure}`,
    );
  } else {
    console.log("[check] seasonKey filter: (시즌 연결된 라인 없음 — 스킵)");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
