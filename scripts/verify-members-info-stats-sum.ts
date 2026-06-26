/**
 * [섹션.1] 통합 = 클럽 합산 결정성 검증(단일 프로세스, direct 호출 — 같은 스냅샷 상태에서 비교).
 *   통합(all)의 각 확정 주차 집계가 엥크레+오랑캐+팔랑크스 동일 주차 합과 정확히 일치하는지.
 *   (브라우저 교차검증의 cross-instant 흔들림을 배제 — direct 4회를 연속 호출해 같은 상태에서 비교.)
 * Usage: npx tsx --env-file=.env.local scripts/verify-members-info-stats-sum.ts
 */
import { loadMembersInfoStats } from "@/lib/adminMembersInfoStats";

let fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

// 4 org 을 모두 partialFailure 없이(완전 조회) 받을 때까지 재시도.
//   통합(all)은 632 크루 fat 조회라 dev Supabase 에서 transient 청크 실패가 잦다 → 부분조회면
//   합산이 어긋난다(코드 발산 아님). 모든 read 가 완전할 때만 비교(by construction all=union이라 동치).
async function loadAllClean() {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const en = await loadMembersInfoStats({ organization: "encre", mode: "operating" });
    const ok = await loadMembersInfoStats({ organization: "oranke", mode: "operating" });
    const px = await loadMembersInfoStats({ organization: "phalanx", mode: "operating" });
    const all = await loadMembersInfoStats({ organization: "all", mode: "operating" });
    const pf = [en, ok, px, all].map((d) => d.partialFailure?.snapshotUnavailable ?? 0);
    if (pf.every((n) => n === 0)) return { en, ok, px, all };
    console.log(`  · attempt ${attempt}: 부분조회(en/ok/px/all 미조회=${pf.join("/")}) → 재시도`);
  }
  throw new Error("6회 내 완전 조회 실패(dev Supabase transient) — snapshot 자체는 무영향");
}

async function main() {
  const { en, ok, px, all } = await loadAllClean();

  const idx = (d: typeof all) => new Map(d.weeks.map((w) => [w.weekId, w]));
  const mEn = idx(en), mOk = idx(ok), mPx = idx(px);

  // 누적(1-A) 합산.
  ck(
    "누적 클러빙 all = en+ok+px",
    all.cumulative.cumulativeClubbing ===
      en.cumulative.cumulativeClubbing + ok.cumulative.cumulativeClubbing + px.cumulative.cumulativeClubbing,
    `${all.cumulative.cumulativeClubbing} = ${en.cumulative.cumulativeClubbing}+${ok.cumulative.cumulativeClubbing}+${px.cumulative.cumulativeClubbing}`,
  );
  ck(
    "누적 엘리트 = null(졸업/엘리트 기획 미정) 전 org 동일",
    all.cumulative.cumulativeElite === null &&
      en.cumulative.cumulativeElite === null &&
      ok.cumulative.cumulativeElite === null &&
      px.cumulative.cumulativeElite === null,
  );
  ck(
    "누적 활동중단 all = en+ok+px",
    all.cumulative.cumulativeSuspended ===
      en.cumulative.cumulativeSuspended + ok.cumulative.cumulativeSuspended + px.cumulative.cumulativeSuspended,
  );

  // 주차별(1-B) — 확정 주차마다 all = 합산. (휴식 2종·a·b·클러빙)
  let checked = 0;
  let mism = 0;
  for (const w of all.weeks) {
    if (!w.finalized) continue;
    const sum = (key: "growthSuccess" | "growthFail" | "weeklyRest" | "seasonalRest" | "clubbing") =>
      [mEn, mOk, mPx].reduce((s, m) => {
        const r = m.get(w.weekId);
        return s + ((r && r.finalized ? (r[key] as number | null) ?? 0 : 0));
      }, 0);
    const fields = ["growthSuccess", "growthFail", "weeklyRest", "seasonalRest", "clubbing"] as const;
    let weekOk = true;
    for (const f of fields) {
      const a = (w[f] as number | null) ?? 0;
      const b = sum(f);
      if (a !== b) {
        weekOk = false;
        if (mism < 5) console.log(`   ✗ [${w.seasonWeekName}] ${f}: all=${a} vs sum=${b}`);
      }
    }
    checked++;
    if (!weekOk) mism++;
  }
  ck(`확정 주차 ${checked}건 전부 all = en+ok+px (불일치 ${mism})`, mism === 0);

  console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
