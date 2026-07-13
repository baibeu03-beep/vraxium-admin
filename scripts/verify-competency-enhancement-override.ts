/**
 * [실무 역량] competency 강화 override 회귀 점검 (2026-07-07, v35 후속).
 *
 *   npx tsx --env-file=.env.local scripts/verify-competency-enhancement-override.ts [--http] [--recompute]
 *
 * 배경: [실무 경험] 이슈의 원인은 레거시 submission-based override 가 rating 기반 SoT(success)를
 *   제출폼 미작성(base.status="fail")로 덮은 것. experience 를 override 에서 제외해 수정(v35).
 *   본 스크립트는 동일 결함이 competency 에 남아있는지 실제 snapshot/DB/direct/HTTP 로 점검한다.
 *
 * competency SoT (computeCluster4Enhancement, careerGradeVerdict/experienceRatingVerdict 미전달):
 *   - 배정(lineTargetId != null) + 마감 후 = success  (제출 무관)
 *   - 배정 + 마감 전                    = pending
 *   - 미배정/미개설(비대상자)           = not_applicable (0/0)  ← 2026-07-13 정책: synthetic fail·
 *       합성 placeholder 폐지. 분모(1)는 개설 라인의 대상자에게만 생성.
 *   → 배정된(lineTargetId != null) competency 라인이 enhancementStatus="fail" 이면 결함 신호.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "../lib/cluster4WeeklyCardsData";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
} from "../lib/cluster4WeeklyCardsSnapshot";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const WANT_HTTP = process.argv.includes("--http");
const WANT_RECOMPUTE = process.argv.includes("--recompute");
const key = process.env.INTERNAL_API_KEY;

type LineLite = {
  weekId: string | null;
  partType: string;
  lineId: string | null;
  lineTargetId: string | null;
  lineCode: string | null;
  status: string;
  enhancementStatus: string;
  enhancementReason: string | null;
  submissionStatus: string | null;
  experienceRating: number | null;
};

function competencyLines(cards: any[]): LineLite[] {
  const out: LineLite[] = [];
  for (const card of cards ?? []) {
    for (const line of card.lines ?? []) {
      if (line.partType !== "competency") continue;
      out.push({
        weekId: card.weekId ?? line.weekId ?? null,
        partType: line.partType,
        lineId: line.lineId ?? null,
        lineTargetId: line.lineTargetId ?? null,
        lineCode: line.lineCode ?? null,
        status: line.status,
        enhancementStatus: line.enhancementStatus,
        enhancementReason: line.enhancementReason ?? null,
        submissionStatus: line.submissionStatus ?? null,
        experienceRating: line.experienceRating ?? null,
      });
    }
  }
  return out;
}

// 결함 신호: 배정된(lineTargetId != null) competency 라인이 fail.
//   → 배정+마감 후는 반드시 success 여야 한다. 제출 미작성(status="fail")로 덮이면 안 됨.
function isSuspectFail(l: LineLite): boolean {
  return (
    l.partType === "competency" &&
    l.lineTargetId != null &&
    l.enhancementStatus === "fail"
  );
}

// 참고 신호: status="fail"(제출폼 미작성 축)인데 enhancementStatus 가 그와 무관하게 유지되는지.
function submissionFailButEnhancementNotFail(l: LineLite): boolean {
  return (
    l.partType === "competency" &&
    l.lineTargetId != null &&
    l.status === "fail" &&
    l.enhancementStatus !== "fail"
  );
}

async function main() {
  const report: any = {
    generatedAt: new Date().toISOString(),
    checks: {},
  };

  // 1) 스냅샷 전수 스캔 — competency 라인 분류.
  //    fat jsonb 이므로 청크로 끊어 읽는다.
  const pageSize = 200;
  let from = 0;
  const allCompLines: Array<LineLite & { userId: string }> = [];
  let scannedUsers = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("cluster4_weekly_card_snapshots")
      .select("user_id,cards,dto_version,is_stale")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data as any[]) {
      scannedUsers++;
      if (!Array.isArray(row.cards)) continue;
      for (const l of competencyLines(row.cards)) {
        allCompLines.push({ ...l, userId: row.user_id });
      }
    }
    if (data.length < pageSize) break;
    from += pageSize;
  }

  const suspects = allCompLines.filter(isSuspectFail);
  const submissionFailKept = allCompLines.filter(submissionFailButEnhancementNotFail);

  // 분포 요약.
  const byEnh: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const assignedByEnh: Record<string, number> = {};
  for (const l of allCompLines) {
    byEnh[l.enhancementStatus] = (byEnh[l.enhancementStatus] ?? 0) + 1;
    const r = l.enhancementReason ?? "(null)";
    byReason[r] = (byReason[r] ?? 0) + 1;
    if (l.lineTargetId != null) {
      assignedByEnh[l.enhancementStatus] =
        (assignedByEnh[l.enhancementStatus] ?? 0) + 1;
    }
  }

  report.checks.snapshotScan = {
    scannedUsers,
    totalCompetencyLines: allCompLines.length,
    enhancementStatusDistribution: byEnh,
    assignedEnhancementDistribution: assignedByEnh,
    reasonDistribution: byReason,
    suspectAssignedFailCount: suspects.length,
    suspectSamples: suspects.slice(0, 30),
    submissionFailButEnhancementKeptCount: submissionFailKept.length,
    submissionFailButEnhancementKeptSamples: submissionFailKept.slice(0, 30),
  };

  // 2) DB 원천 대조: part_type=competency 라인/타깃 수 (레거시/전체).
  const { data: compLinesDb } = await supabase
    .from("cluster4_lines")
    .select("id,line_code,part_type")
    .eq("part_type", "competency");
  report.checks.dbCompetencyLines = {
    totalLines: compLinesDb?.length ?? 0,
    lineIds: (compLinesDb ?? []).map((r: any) => r.id),
  };

  // 3) direct vs snapshot 정합 — competency 를 보유한 유저 표본에서 대조.
  const compUserIds = Array.from(
    new Set(
      allCompLines
        .filter((l) => l.lineTargetId != null)
        .map((l) => l.userId),
    ),
  ).slice(0, 15);

  const parity: any[] = [];
  for (const uid of compUserIds) {
    if (WANT_RECOMPUTE) {
      await recomputeAndStoreWeeklyCardsSnapshot(uid);
    }
    const direct = await getCluster4WeeklyCardsForProfileUser(uid);
    const snap = await readWeeklyCardsSnapshot(uid);
    const directComp = competencyLines((direct as any)?.cards ?? direct ?? []);
    const snapComp =
      snap.status === "hit" || snap.status === "stale"
        ? competencyLines(snap.cards as any[])
        : [];

    // (weekId,lineId,lineTargetId) 키로 enhancementStatus 대조.
    const dmap = new Map(
      directComp.map((l) => [`${l.weekId}|${l.lineId}|${l.lineTargetId}`, l]),
    );
    const mismatches: any[] = [];
    for (const s of snapComp) {
      const k = `${s.weekId}|${s.lineId}|${s.lineTargetId}`;
      const d = dmap.get(k);
      if (!d) continue;
      if (d.enhancementStatus !== s.enhancementStatus) {
        mismatches.push({
          key: k,
          direct: d.enhancementStatus,
          snapshot: s.enhancementStatus,
          directReason: d.enhancementReason,
          snapshotReason: s.enhancementReason,
        });
      }
    }
    parity.push({
      userId: uid,
      snapStatus: snap.status,
      dtoVersionMatch: snap.status !== "stale" ? true : `stale(${(snap as any).reason})`,
      directCompCount: directComp.length,
      snapCompCount: snapComp.length,
      directSuspectFails: directComp.filter(isSuspectFail).length,
      mismatchCount: mismatches.length,
      mismatches: mismatches.slice(0, 10),
    });
  }
  report.checks.directVsSnapshotParity = {
    sampledUsers: compUserIds.length,
    results: parity,
    anyMismatch: parity.some((p) => p.mismatchCount > 0),
    anyDirectSuspectFail: parity.some((p) => p.directSuspectFails > 0),
  };

  // 4) (선택) HTTP 대조.
  if (WANT_HTTP && key && compUserIds.length > 0) {
    const uid = compUserIds[0];
    try {
      const res = await fetch(
        `http://localhost:3000/api/cluster4/weekly-cards?userId=${uid}`,
        { headers: { "x-internal-api-key": key } },
      );
      const json = await res.json();
      // 라우트 응답: cards 는 json.data (배열). (일부 경로는 {data:{cards}} 형태일 수 있어 폴백.)
      const httpCards = Array.isArray(json?.data)
        ? json.data
        : (json?.data?.cards ?? json?.cards ?? []);
      const httpComp = competencyLines(httpCards);
      report.checks.httpParity = {
        userId: uid,
        httpStatus: res.status,
        httpCompCount: httpComp.length,
        httpSuspectFails: httpComp.filter(isSuspectFail).length,
        sample: httpComp.slice(0, 10),
      };
    } catch (e: any) {
      report.checks.httpParity = { error: String(e?.message ?? e) };
    }
  }

  // 최종 판정.
  report.verdict = {
    competencyExcludedFromLegacyOverride: true, // 코드: dbPartType !== "competency"
    snapshotSuspectAssignedFails: suspects.length,
    directSuspectFails: parity.reduce(
      (a, p) => a + p.directSuspectFails,
      0,
    ),
    directVsSnapshotAnyMismatch: report.checks.directVsSnapshotParity.anyMismatch,
    PASS:
      suspects.length === 0 &&
      !report.checks.directVsSnapshotParity.anyMismatch &&
      !report.checks.directVsSnapshotParity.anyDirectSuspectFail,
  };

  const out = "claudedocs/verify-competency-enhancement-override.json";
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.verdict, null, 2));
  console.log("distribution:", JSON.stringify(report.checks.snapshotScan.enhancementStatusDistribution));
  console.log("assigned distribution:", JSON.stringify(report.checks.snapshotScan.assignedEnhancementDistribution));
  console.log("written:", out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
