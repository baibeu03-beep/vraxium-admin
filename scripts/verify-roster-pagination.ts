/**
 * 검증(read-only): /admin/members 서버 페이지네이션 + 캐시 품계.
 *   npx tsx --env-file=.env.local scripts/verify-roster-pagination.ts
 */
import { listMembersRoster } from "@/lib/adminMembersData";

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(70));
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { line(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function main() {
  hr(); line("A. page 1 (pageSize 50, 필터 없음)"); hr();
  const p1 = await listMembersRoster({ mode: "operating", page: 1, pageSize: 50 });
  line(`  members=${p1.members.length} total=${p1.total} filteredTotal=${p1.filteredTotal} counts=${JSON.stringify(p1.statusCounts)} page=${p1.page}/${Math.ceil(p1.filteredTotal / p1.pageSize)}`);
  ck("page1 members <= 50", p1.members.length <= 50 && p1.members.length === 50, `${p1.members.length}`);
  ck("total 318", p1.total === 318, `${p1.total}`);
  ck("filteredTotal 318(필터없음)", p1.filteredTotal === 318, `${p1.filteredTotal}`);
  ck("counts active201/rest51/stopped66", p1.statusCounts.active === 201 && p1.statusCounts.rest === 51 && p1.statusCounts.stopped === 66, JSON.stringify(p1.statusCounts));
  ck("품계(캐시) 존재 — page1 중 grade!=null 1명 이상", p1.members.some((m) => m.rankGradeNumber != null));

  hr(); line("B. page 2 — 다른 50명"); hr();
  const p2 = await listMembersRoster({ mode: "operating", page: 2, pageSize: 50 });
  const overlap = p1.members.filter((a) => p2.members.some((b) => b.userId === a.userId)).length;
  ck("page2 members 50", p2.members.length === 50, `${p2.members.length}`);
  ck("page1∩page2 = 0 (중복 없음)", overlap === 0, `${overlap}`);

  hr(); line("C. 상태 필터(서버)"); hr();
  const rest = await listMembersRoster({ mode: "operating", page: 1, pageSize: 50, filter: "seasonal_rest" });
  ck("seasonal_rest filteredTotal 51", rest.filteredTotal === 51, `${rest.filteredTotal}`);
  const stop = await listMembersRoster({ mode: "operating", page: 1, pageSize: 50, filter: "suspended" });
  ck("suspended filteredTotal 66", stop.filteredTotal === 66, `${stop.filteredTotal}`);

  hr(); line("D. 검색(서버)"); hr();
  const search = await listMembersRoster({ mode: "operating", page: 1, pageSize: 50, search: "김" });
  ck("검색 '김' filteredTotal>0 & 결과 이름에 김 포함", search.filteredTotal > 0 && search.members.every((m) => JSON.stringify(m).includes("김")), `${search.filteredTotal}`);

  hr(); line("E. 정렬(서버) — Po.A desc / 품계 asc"); hr();
  const byPoA = await listMembersRoster({ mode: "operating", page: 1, pageSize: 50, sort: [{ key: "poA", dir: "desc" }] });
  const poaSorted = byPoA.members.every((m, i) => i === 0 || (byPoA.members[i - 1].poA ?? 0) >= (m.poA ?? 0));
  ck("Po.A desc 정렬", poaSorted);
  const byRank = await listMembersRoster({ mode: "operating", page: 1, pageSize: 50, sort: [{ key: "rank", dir: "asc" }] });
  const ranks = byRank.members.map((m) => m.rankGradeNumber).filter((x): x is number => x != null);
  const rankSorted = ranks.every((v, i) => i === 0 || ranks[i - 1] <= v);
  ck("품계(캐시) asc 정렬 — null 후순위", rankSorted && byRank.members[0].rankGradeNumber != null);

  hr();
  line(fail === 0 ? "✅ roster 페이지네이션 direct 검증 PASS" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
