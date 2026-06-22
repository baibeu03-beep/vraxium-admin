/**
 * PMS → Vraxium pointlogs 증분 동기화 — 수동 실행(검증·비상용) CLI.
 *   npx tsx --env-file=.env.local scripts/sync-pms-pointlogs.ts              # dry-run (write 0)
 *   npx tsx --env-file=.env.local scripts/sync-pms-pointlogs.ts --apply      # 실제 반영
 *   npx tsx --env-file=.env.local scripts/sync-pms-pointlogs.ts --source hrdb --apply
 *
 * 실제 로직 = lib/pmsPointlogsSync (route=cron 과 동일 단일 SoT). CLI 는 게이트와
 * 무관하게 실행하되(운영자 수동 도구) ENABLE 상태를 경고로만 표시한다.
 */
import { syncPmsPointlogsIncremental, PMS_SYNC_SOURCES } from "@/lib/pmsPointlogsSync";
import type { PmsSourceSystem } from "@/lib/pmsMigration";

async function main() {
  const apply = process.argv.includes("--apply");
  const srcIdx = process.argv.indexOf("--source");
  const sources: PmsSourceSystem[] =
    srcIdx >= 0 ? [process.argv[srcIdx + 1] as PmsSourceSystem] : PMS_SYNC_SOURCES;

  if (process.env.ENABLE_PMS_INCREMENTAL_SYNC !== "true") {
    console.log("⚠ ENABLE_PMS_INCREMENTAL_SYNC != 'true' — 자동(cron) 경로는 비활성. (수동 실행은 계속 진행)");
  }
  console.log(`\n=== PMS pointlogs 증분 동기화 [${apply ? "APPLY" : "DRY-RUN"}] sources=${sources.join(",")} ===\n`);

  const report = await syncPmsPointlogsIncremental({ apply, sources, log: (m) => console.log("  " + m) });

  console.log("\n──────── 결과 요약 ────────");
  console.table([
    {
      mode: report.apply ? "APPLY" : "DRY-RUN",
      "신규 조회": report.newLogsFetched,
      "이미이관 제외": report.alreadyMigratedSkipped,
      "ledger insert": report.ledgerInserted,
      "영향 user": report.affectedUsers,
      "영향 week": report.affectedWeeks,
      "미매칭 로그": report.unmatchedUserLogs,
      "미귀속 로그": report.unattributedLogs,
      "테스트 skip 로그": report.testSkippedLogs,
      "삭제의심 skip": report.suspectDeletedLogs,
      "snapshot 재계산": report.snapshotsRecomputed,
    },
  ]);
  console.log("source별 watermark/조회:", JSON.stringify(report.perSource));
  console.log("캐시 동기화:", JSON.stringify(report.cacheSynced), "snapshotMode:", report.snapshotMode);
  console.log("테스트 제외 user:", report.testSkippedUsers.length, "명");
  if (report.unmatchedUsers.length)
    console.log("미매칭 user(상위10):", JSON.stringify(report.unmatchedUsers.slice(0, 10)));
  if (report.unattributedSample.length)
    console.log("미귀속 샘플(상위10):", JSON.stringify(report.unattributedSample.slice(0, 10)));
  if (report.sampleAffected.length) {
    console.log("\n영향 user 상위(별 추가순):");
    console.table(report.sampleAffected.slice(0, 30));
  }
  console.log(`\n[done] ${report.durationMs}ms · ${report.apply ? "WRITE 반영됨" : "WRITE 0(dry-run)"}\n`);
}

main().then(
  () => process.exit(0),
  (e) => { console.error(e); process.exit(1); },
);
