// 대량 조회 포화 방지 검증 — 50 / 100 / 300+ 규모에서 배치 함수가 timeout 없이 완료되는지,
// 그리고 direct function 결과가 실제 HTTP API 응답과 동일한지 실측한다.
//
// 실행:
//   tsx --env-file=.env.local scripts/verify-batch-saturation-guard.ts
//   (HTTP 동등성까지: PERF_BASE_URL=http://localhost:3000 추가 — dev 서버 필요)
//
// 검증 항목(사용자 요청 8 완료조건):
//   1) direct function 결과 (행 수/elapsed/queries/timeouts)
//   2) 실제 HTTP API 응답 결과 (PERF_BASE_URL 지정 시)
//   3) direct == HTTP 동일 여부 (displayGrowthStatus per user)
//   7) 300명+ org 에서도 timeout 없이 완료
//   8) (락) 다중 실행 시 DB 포화 재발 방지 — 본 스크립트도 공유 락을 잡는다
//
// snapshot 정책 유지: 이 스크립트는 조회 전용 — snapshot 을 굽거나 재계산하지 않는다.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { runWithQueryMeter } from "@/lib/supabaseQueryMeter";
import {
  getGrowthStatusResolutionBatch,
  getGrowthRosterBatch,
} from "@/lib/cluster3GrowthData";
import { acquireScriptLock } from "./_lib/scriptLock";

type Measure = {
  label: string;
  n: number;
  out: number;
  elapsedMs: number;
  queries: number;
  timeouts: number;
};

async function timed<T extends { length: number }>(
  label: string,
  ids: string[],
  fn: (ids: string[]) => Promise<T>,
): Promise<Measure> {
  return runWithQueryMeter(label, async (meter) => {
    const t = Date.now();
    const res = await fn(ids);
    const elapsedMs = Date.now() - t;
    const m: Measure = {
      label,
      n: ids.length,
      out: res.length,
      elapsedMs,
      queries: meter.count,
      timeouts: meter.timeouts,
    };
    console.log(
      `  ${label.padEnd(28)} n=${String(m.n).padStart(4)} out=${String(m.out).padStart(4)} ` +
        `elapsed=${String(m.elapsedMs).padStart(6)}ms queries=${String(m.queries).padStart(4)} ` +
        `timeouts=${m.timeouts}`,
    );
    return m;
  });
}

async function main() {
  const lock = await acquireScriptLock("verify-batch-saturation-guard");
  try {
    // ── 운영 로스터(조직 소속 전원) 수집 ──────────────────────────────
    const idsByOrg = new Map<string, string[]>();
    const allIds: string[] = [];
    {
      let from = 0;
      const PAGE = 1000;
      for (;;) {
        const { data, error } = await supabaseAdmin
          .from("user_profiles")
          .select("user_id,organization_slug")
          .not("organization_slug", "is", null)
          .order("user_id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as Array<{ user_id: string; organization_slug: string }>;
        for (const r of rows) {
          allIds.push(r.user_id);
          const list = idsByOrg.get(r.organization_slug) ?? [];
          list.push(r.user_id);
          idsByOrg.set(r.organization_slug, list);
        }
        if (rows.length < PAGE) break;
        from += PAGE;
      }
    }
    console.log(`\n운영 로스터 총 ${allIds.length}명, 조직 ${idsByOrg.size}개`);
    for (const [org, list] of [...idsByOrg].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  - ${org.padEnd(12)} ${list.length}명`);
    }

    // 가장 큰 단일 org(가능하면 300+) — direct==HTTP 동등성 대상.
    const biggestOrg = [...idsByOrg].sort((a, b) => b[1].length - a[1].length)[0];

    // ── 1) direct function 규모별 실측 (50 / 100 / 300+) ──────────────
    const sizes = [50, 100, 300];
    const measures: Measure[] = [];
    console.log(`\n[direct] getGrowthStatusResolutionBatch (/crews graft 경로):`);
    for (const size of sizes) {
      const n = Math.min(size, allIds.length);
      const ids = allIds.slice(0, n);
      measures.push(await timed("growth-status-batch", ids, getGrowthStatusResolutionBatch));
    }
    console.log(`\n[direct] getGrowthRosterBatch (members roster 폴백 경로):`);
    for (const size of sizes) {
      const n = Math.min(size, allIds.length);
      const ids = allIds.slice(0, n);
      measures.push(await timed("roster-batch", ids, getGrowthRosterBatch));
    }
    // 전체 로스터(최대 규모) — 300+ org timeout-free 완료 증명.
    if (allIds.length > 300) {
      console.log(`\n[direct] 전체 로스터 ${allIds.length}명:`);
      measures.push(await timed("growth-status-batch", allIds, getGrowthStatusResolutionBatch));
    }

    const timedOut = measures.filter((m) => m.timeouts > 0);
    if (timedOut.length > 0) {
      console.error(`\n❌ timeout 발생: ${timedOut.map((m) => `${m.label}(n=${m.n})`).join(", ")}`);
      process.exitCode = 1;
    } else {
      console.log(`\n✅ 모든 규모에서 timeout 0 (총 ${measures.length} 측정).`);
    }

    // ── 2&3) direct == HTTP 동등성 (선택, dev 서버 필요) ───────────────
    const baseUrl = process.env.PERF_BASE_URL?.replace(/\/$/, "") || null;
    const internalKey = process.env.INTERNAL_API_KEY || null;
    if (baseUrl && internalKey && biggestOrg) {
      const [org, orgIds] = biggestOrg;
      console.log(`\n[direct==HTTP] org=${org} (${orgIds.length}명) 동등성 검증:`);

      const tDirect = Date.now();
      const direct = await getGrowthStatusResolutionBatch(orgIds);
      const directMs = Date.now() - tDirect;

      const tHttp = Date.now();
      const res = await fetch(`${baseUrl}/api/cluster3/growth-status-batch?org=${org}`, {
        headers: { "x-internal-api-key": internalKey },
      });
      const httpMs = Date.now() - tHttp;
      if (!res.ok) {
        console.error(`  ❌ HTTP ${res.status} — 동등성 검증 불가`);
        process.exitCode = 1;
      } else {
        const body = (await res.json()) as {
          success: boolean;
          data: Array<{ userId: string; displayGrowthStatus: string }>;
        };
        const directMap = new Map(direct.map((r) => [r.userId, r.displayGrowthStatus]));
        const httpMap = new Map(body.data.map((r) => [r.userId, r.displayGrowthStatus]));
        let mismatches = 0;
        for (const [uid, ds] of directMap) {
          if (httpMap.get(uid) !== ds) mismatches++;
        }
        const countEqual = directMap.size === httpMap.size;
        console.log(
          `  direct: ${directMap.size}명 ${directMs}ms | http: ${httpMap.size}명 ${httpMs}ms | ` +
            `mismatches=${mismatches} countEqual=${countEqual}`,
        );
        if (mismatches === 0 && countEqual) {
          console.log(`  ✅ direct == HTTP (displayGrowthStatus 전원 일치)`);
        } else {
          console.error(`  ❌ direct != HTTP`);
          process.exitCode = 1;
        }
      }
    } else {
      console.log(
        `\n[direct==HTTP] 건너뜀 — PERF_BASE_URL / INTERNAL_API_KEY 미설정(dev 서버 필요).`,
      );
    }
  } finally {
    lock.release();
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
