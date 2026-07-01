/**
 * 검증(read-only): 현재 시즌 참여자 공통 헬퍼 통합(lib/operationalSeasonParticipants).
 *   - 독립 DB 베이스라인(user_season_statuses) vs 공통 헬퍼 결과 일치
 *   - listMembersRoster / getWeekRecognitions 가 현재 시즌 참여자 외 인원을 안 섞는지(누수 0)
 *   - 두 화면의 모집단 기준이 동일 헬퍼로 정렬됐는지
 *   결과를 scratchpad JSON 으로 써서 HTTP 스크립트가 direct==HTTP 비교에 쓴다.
 *
 *   npx tsx --env-file=.env.local scripts/verify-season-scope-consolidation.ts
 */
import { writeFileSync } from "node:fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { operationalSeasonDbKey } from "@/lib/seasonCalendar";
import { fetchOperationalSeasonParticipants } from "@/lib/operationalSeasonParticipants";
import { listMembersRoster } from "@/lib/adminMembersData";
import { getWeekRecognitions } from "@/lib/adminWeekRecognitionsData";

const OUT = process.env.OUT_JSON ?? "scripts/.tmp-season-scope-direct.json";
const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(72));
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  line(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};
const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

async function baseline(seasonKey: string) {
  const ids = new Set<string>();
  const counts = { total: 0, active: 0, rest: 0, stopped: 0 };
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("user_season_statuses")
      .select("user_id,status")
      .eq("season_key", seasonKey)
      .order("user_id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ user_id: string; status: string }>;
    for (const r of rows) {
      ids.add(r.user_id);
      counts.total += 1;
      if (r.status === "active") counts.active += 1;
      else if (r.status === "rest") counts.rest += 1;
      else if (r.status === "stopped") counts.stopped += 1;
    }
    if (rows.length < 1000) break;
  }
  return { ids, counts };
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const opKey = operationalSeasonDbKey(today);
  hr();
  line(`A. 운영 기준 시즌  오늘=${today}  operationalSeasonDbKey=${opKey}`);
  hr();
  ck("operationalSeasonDbKey 해소됨", !!opKey, `${opKey}`);
  if (!opKey) {
    line("off-season — 검증 중단");
    process.exit(1);
  }

  // 독립 베이스라인 vs 공통 헬퍼
  const base = await baseline(opKey);
  const helper = await fetchOperationalSeasonParticipants(today);
  hr();
  line("B. 공통 헬퍼(fetchOperationalSeasonParticipants) == 독립 DB 베이스라인");
  hr();
  ck("seasonKey 일치", helper.seasonKey === opKey, `${helper.seasonKey}`);
  ck("참여자 id 집합 일치", sameSet(helper.idSet, base.ids), `helper=${helper.idSet.size} base=${base.ids.size}`);
  ck("ids 배열==idSet 크기(중복없음)", helper.ids.length === helper.idSet.size, `${helper.ids.length}`);
  ck(
    `counts 일치 (t=${base.counts.total} a=${base.counts.active} r=${base.counts.rest} s=${base.counts.stopped})`,
    JSON.stringify(helper.counts) === JSON.stringify(base.counts),
    JSON.stringify(helper.counts),
  );

  // listMembersRoster — 전 페이지 수집(누수 검사)
  hr();
  line("C. listMembersRoster(operating) — 현재 시즌 참여자 외 인원 누수 0");
  hr();
  const rosterIds: string[] = [];
  let rosterStatusCounts: unknown = null;
  let rosterTotal = 0;
  {
    const pageSize = 200;
    let page = 1;
    let filteredTotal = Infinity;
    while (rosterIds.length < filteredTotal) {
      const r = await listMembersRoster({ mode: "operating", page, pageSize });
      filteredTotal = r.filteredTotal;
      rosterTotal = r.total;
      rosterStatusCounts = r.statusCounts;
      for (const m of r.members) rosterIds.push(m.userId);
      if (r.members.length === 0) break;
      page++;
      if (page > 100) break; // 안전 상한
    }
  }
  const rosterLeak = rosterIds.filter((id) => !base.ids.has(id));
  ck(`roster 전원 현재 시즌 참여자 (수집 ${rosterIds.length}명)`, rosterLeak.length === 0, `누수 ${rosterLeak.length}`);
  ck(
    "roster statusCounts == 베이스라인 counts",
    JSON.stringify(rosterStatusCounts) === JSON.stringify(base.counts),
    JSON.stringify(rosterStatusCounts),
  );
  line(`  roster total(모집단)=${rosterTotal} · 수집 member=${rosterIds.length}`);

  // getWeekRecognitions — 무필터: 현재 시즌 참여자 외 인원 누수 0
  hr();
  line("D. getWeekRecognitions({}) — 현재 시즌 참여자 외 인원 누수 0");
  hr();
  const wr = await getWeekRecognitions({});
  const wrUserIds = Array.from(new Set(wr.rows.map((r) => r.user_id)));
  const wrLeak = wrUserIds.filter((id) => !base.ids.has(id));
  ck(`week-recognitions 전원 현재 시즌 참여자 (고유 ${wrUserIds.length}명)`, wrLeak.length === 0, `누수 ${wrLeak.length}`);
  line(`  rows=${wr.rows.length} truncated=${wr.truncated} summary=${JSON.stringify(wr.summary)}`);

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        opKey,
        baselineIds: [...base.ids].sort(),
        baselineCounts: base.counts,
        rosterIds: [...rosterIds].sort(),
        rosterStatusCounts,
        rosterTotal,
        wrUserIds: [...wrUserIds].sort(),
        wrSummary: wr.summary,
        wrRowCount: wr.rows.length,
      },
      null,
      0,
    ),
  );
  line(`\n  → direct 결과 기록: ${OUT}`);

  hr();
  line(fail === 0 ? "✅ DIRECT PASS" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
