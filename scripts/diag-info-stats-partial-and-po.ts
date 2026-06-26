/**
 * 진단(수정 없음) — ① "일부 크루 스냅샷 미조회" 경고 원인  ② Po.A/B/C 값 정확성.
 *   읽기 전용. snapshot/user_profiles 무수정.
 * Usage: npx tsx --env-file=.env.local scripts/diag-info-stats-partial-and-po.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadMembersInfoStats } from "@/lib/adminMembersInfoStats";
import { ORGANIZATIONS } from "@/lib/organizations";

const SNAP = "cluster4_weekly_card_snapshots";
const LABEL: Record<string, string> = { encre: "엥크레", oranke: "오랑캐", phalanx: "팔랑크스" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// loadMembersInfoStats — statement timeout 등 transient 에 대비해 재시도. partialFailure 도 함께 본다.
async function loadStats(org: string) {
  let lastErr: any = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await loadMembersInfoStats({ organization: org as any, mode: "operating" });
    } catch (e) {
      lastErr = e;
      console.log(`   · loadStats(${org}) attempt ${attempt} 실패: ${(e as Error).message.slice(0, 60)} → 재시도`);
      await sleep(2000);
    }
  }
  throw lastErr;
}

// 스코프 로스터(operating) — adminMembersInfoStats.loadScopedRoster 와 동일 필터.
async function roster(orgs: string[]): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id, display_name")
      .in("organization_slug", orgs)
      .not("activity_started_at", "is", null)
      .or("role.is.null,role.neq.super_admin")
      .order("user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error("roster err", error.message); break; }
    const rows = (data ?? []) as any[];
    // operating: test_user_markers 제외
    out.push(...rows.map((r) => ({ id: r.user_id, name: r.display_name ?? "-" })));
    if (rows.length < PAGE) break;
  }
  // test 제외
  const { data: tm } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const testIds = new Set((tm ?? []).map((r: any) => r.user_id));
  return out.filter((r) => !testIds.has(r.id));
}

// 청크 완전조회(transient 제거) — 각 청크를 성공할 때까지 재시도. row 있는 id→{is_stale,cardsOk,cards}.
async function completeSnapshotRead(ids: string[]) {
  const map = new Map<string, { is_stale: boolean; cardsOk: boolean; cards: any[] }>();
  const CH = 50;
  for (let i = 0; i < ids.length; i += CH) {
    const chunk = ids.slice(i, i + CH);
    let okChunk = false;
    for (let attempt = 1; attempt <= 8 && !okChunk; attempt++) {
      const { data, error } = await supabaseAdmin.from(SNAP).select("user_id,is_stale,cards").in("user_id", chunk);
      if (error) { await sleep(1500); continue; }
      okChunk = true;
      for (const row of (data ?? []) as any[]) {
        map.set(row.user_id, { is_stale: !!row.is_stale, cardsOk: Array.isArray(row.cards), cards: Array.isArray(row.cards) ? row.cards : [] });
      }
    }
    if (!okChunk) console.log(`   ⚠ 청크 ${i}~${i + CH} 8회 재시도 실패(transient 지속)`);
  }
  return map;
}

async function part1() {
  console.log("════════════════════ ① 스냅샷 미조회 경고 진단 ════════════════════");
  const scopes: { tab: string; orgs: string[] }[] = [
    { tab: "통합", orgs: [...ORGANIZATIONS] },
    { tab: "엥크레", orgs: ["encre"] },
    { tab: "오랑캐", orgs: ["oranke"] },
    { tab: "팔랑크스", orgs: ["phalanx"] },
  ];
  for (const s of scopes) {
    const r = await roster(s.orgs);
    const ids = r.map((x) => x.id);
    const nameById = new Map(r.map((x) => [x.id, x.name]));
    const snapMap = await completeSnapshotRead(ids);
    const noRow = ids.filter((id) => !snapMap.has(id));
    const badCards = ids.filter((id) => snapMap.has(id) && !snapMap.get(id)!.cardsOk);
    const stale = ids.filter((id) => snapMap.get(id)?.is_stale);
    // DTO partialFailure 를 3회 측정 — transient 면 회차마다 값이 달라진다(영속 누락이면 일정).
    const org = s.orgs.length === 1 ? s.orgs[0] : "all";
    const pfs: number[] = [];
    for (let k = 0; k < 3; k++) {
      try { const d = await loadStats(org); pfs.push(d.partialFailure?.snapshotUnavailable ?? 0); }
      catch (e) { pfs.push(-1); }
    }
    console.log(`\n▶ [${s.tab}] 로스터 ${ids.length}명`);
    console.log(`   완전조회(재시도) 기준 → snapshot row 없음(영속 누락): ${noRow.length} · cards 손상: ${badCards.length} · is_stale: ${stale.length}`);
    console.log(`   DTO partialFailure 3회 측정: [${pfs.join(", ")}]  (-1=호출 실패/timeout)`);
    const varies = new Set(pfs.filter((n) => n >= 0)).size > 1 || pfs.some((n) => n > noRow.length);
    console.log(`   → 해석: 영속 누락(no row)=${noRow.length}. 경고값이 회차마다 다르거나 영속누락보다 큼=${varies} ⇒ ${
      varies ? "원인=transient read 실패(Postgres statement timeout 등). snapshot 재계산 불필요·조회 로직 안정화 필요"
             : (noRow.length > 0 ? "원인=snapshot 미생성(영속 누락). 재계산 필요" : "누락 없음(완전조회 시 0)")
    }`);
    if (noRow.length > 0) {
      console.log(`   영속 누락 user(최대 15):`);
      for (const id of noRow.slice(0, 15)) console.log(`     ${id}  ${nameById.get(id)}`);
    }
  }
}

async function part2() {
  console.log("\n\n════════════════════ ② Po.A/B/C 값 진단(엥크레/오랑캐/팔랑크스) ════════════════════");
  for (const org of ["encre", "oranke", "phalanx"]) {
    const r = await roster([org]);
    const nameById = new Map(r.map((x) => [x.id, x.name]));
    const snapMap = await completeSnapshotRead(r.map((x) => x.id)); // 완전조회
    const dto = await loadStats(org);
    const dtoPf = dto.partialFailure?.snapshotUnavailable ?? 0;
    console.log(`\n[${LABEL[org]}] DTO partialFailure(이 회차)=${dtoPf}`);

    // 표본 주차: 활동 주차(성공/실패 있음) 1 + 휴식 주차 1
    const actW = dto.weeks.find((w) => w.finalized && w.clubStatus === "공식 활동" && (w.growthSuccess ?? 0) + (w.growthFail ?? 0) > 0);
    const restW = dto.weeks.find((w) => w.finalized && w.clubStatus === "공식 휴식");
    for (const w of [actW, restW].filter(Boolean) as any[]) {
      // 완전조회 기준 그 주차 star>0 전수 → 정렬 top10
      const trueList: { name: string; star: number }[] = [];
      for (const [uid, snap] of snapMap) {
        const c = snap.cards.find((x: any) => x.weekId === w.weekId);
        const star = c?.points?.star;
        if (typeof star === "number" && star > 0) trueList.push({ name: nameById.get(uid) ?? "-", star });
      }
      trueList.sort((p, q) => q.star - p.star || p.name.localeCompare(q.name, "ko"));
      const dtoTop = w.weeklyTopPoints ?? [];
      const trueTop3 = trueList.slice(0, 3);
      const match = JSON.stringify(dtoTop.map((t: any) => [t.name, t.points])) === JSON.stringify(trueTop3.map((t) => [t.name, t.star]));
      console.log(`\n▶ [${LABEL[org]}] ${w.seasonWeekName} (${w.clubStatus}) — star>0 크루 ${trueList.length}명`);
      console.log(`   DTO Po.A/B/C : ${dtoTop.map((t: any, i: number) => `Po.${["A", "B", "C"][i]}=${t.name} ${t.points}`).join(" / ") || "(없음)"}`);
      console.log(`   완전조회 Top3: ${trueTop3.map((t, i) => `Po.${["A", "B", "C"][i]}=${t.name} ${t.star}`).join(" / ") || "(없음)"}`);
      console.log(`   완전조회 Top10: ${trueList.slice(0, 10).map((t) => `${t.name}:${t.star}`).join(", ")}`);
      console.log(`   ${match ? "✅ DTO == 완전조회 Top3" : "❌ 불일치 — partial read 로 상위 크루 누락 의심"}`);
    }
  }
}

async function main() {
  await part1();
  await part2();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
