// 검증: listMembersRoster 직렬→병렬 청크 최적화가 결과를 바꾸지 않았는지 + 소요/쿼리수.
//   npx tsx --env-file=.env.local scripts/verify-roster-parallel-opt.ts
// 출력: 멤버 수·total·filteredTotal·statusCounts + 안정 체크섬(정렬된 members 직렬화 해시) + ms.
import { createHash } from "node:crypto";
import { runWithQueryMeter } from "@/lib/supabaseQueryMeter";
import { listMembersRoster } from "@/lib/adminMembersData";

function checksum(members: unknown[]): string {
  // 페이지(50행) 응답을 그대로 직렬화 — 행 순서·값이 모두 동일해야 같은 해시.
  return createHash("sha256").update(JSON.stringify(members)).digest("hex").slice(0, 16);
}

async function main() {
  for (const mode of ["operating", "test"] as const) {
    const s = Date.now();
    const out = await runWithQueryMeter(`roster:${mode}`, async (meter) => {
      const r = await listMembersRoster({ mode, page: 1, pageSize: 50 });
      return { r, meter };
    });
    const ms = Date.now() - s;
    const r = out.r;
    console.log(
      `[${mode}] ms=${ms} q=${out.meter.count} timeouts=${out.meter.timeouts} ` +
        `page=${r.members.length} total=${r.total} filtered=${r.filteredTotal} ` +
        `counts=${JSON.stringify(r.statusCounts)} partial=${JSON.stringify(r.partialFailure)} ` +
        `checksum=${checksum(r.members)}`,
    );
  }
  // 2페이지·필터·정렬도 1회씩 — 병렬화가 페이지네이션/필터/정렬 결과를 깨지 않는지.
  const sorted = await listMembersRoster({
    mode: "operating", page: 1, pageSize: 50,
    filter: "clubbing_expand", sort: [{ key: "poA", dir: "desc" }],
  });
  console.log(
    `[filter+sort] page=${sorted.members.length} filtered=${sorted.filteredTotal} ` +
      `top=${sorted.members[0]?.displayName ?? "-"}/${sorted.members[0]?.poA ?? "-"} ` +
      `checksum=${checksum(sorted.members)}`,
  );
}

main().then(() => process.exit(0), (e) => { console.error("FATAL", e); process.exit(1); });
