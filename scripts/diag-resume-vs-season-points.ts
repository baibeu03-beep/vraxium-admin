// 이력서 카드 누적 포인트 vs 시즌 상세 페이지네이션(시즌별 pointSummary 합) 불일치 진단.
//
//   A. admin 이력서 카드 SoT  = lib/adminResumeCardData.ts
//        user_weekly_points 전기간 직접합산 (무필터)
//        별=Σpoints · 방패(net)=Σadvantages-|Σpenalty| · 번개=Σpenalty
//   B. 고객앱 이력서 카드 SoT = vraxium /api/profile/summary
//        user_cumulative_points 캐시 (total_stars / total_shields-total_lightnings / total_lightnings)
//   C. 시즌 상세 페이지네이션 SoT = vraxium /(host)/api/cluster4/weekly-growth buildSeasonSummaries
//        후보주차(uwp+uws) → weeks → 비-break season_key 별 startSet 매칭 합산
//        별=Σpoints · 방패(raw)=Σadvantages · 번개=Σpenalty
//
//   비교: A vs ΣC (별/방패/번개), A vs B, 그리고 C 에서 제외되는 uwp 주차 dump.
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// PostgREST 1000행 cap 회피 — order+range 전수 페이지네이션 (memory: postgrest-cap)
async function fetchAll(table: string, select: string, orderCol: string): Promise<any[]> {
  const out: any[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .order(orderCol, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

async function main() {
  const [uwp, uws, weeks, cum, markers] = await Promise.all([
    fetchAll("user_weekly_points", "user_id, week_start_date, points, advantages, penalty", "id"),
    fetchAll("user_week_statuses", "user_id, week_start_date", "id"),
    fetchAll("weeks", "start_date, season_key", "start_date"),
    fetchAll("user_cumulative_points", "user_id, total_checks, total_advantages, total_penalties, updated_at", "user_id"),
    fetchAll("test_user_markers", "user_id", "user_id"),
  ]);

  const testers = new Set(markers.map((m) => m.user_id));
  const weekSeason = new Map<string, string | null>(); // start_date → season_key
  for (const w of weeks) weekSeason.set(w.start_date, w.season_key ?? null);
  const isBreakKey = (k: string | null) => !!k && k.toLowerCase().includes("break");

  const cumBy = new Map<string, any>();
  for (const c of cum) cumBy.set(c.user_id, c);

  // user → uwp rows
  const uwpBy = new Map<string, any[]>();
  for (const r of uwp) {
    if (!uwpBy.has(r.user_id)) uwpBy.set(r.user_id, []);
    uwpBy.get(r.user_id)!.push(r);
  }
  // user → uws dates (시즌 후보 주차에 포함됨 — front 로직 동일)
  const uwsBy = new Map<string, Set<string>>();
  for (const r of uws) {
    if (!r.week_start_date) continue;
    if (!uwsBy.has(r.user_id)) uwsBy.set(r.user_id, new Set());
    uwsBy.get(r.user_id)!.add(r.week_start_date);
  }

  type Row = {
    userId: string;
    tester: boolean;
    A: { star: number; shield: number; lightning: number }; // admin resume (net shield)
    Araw: { shield: number }; // Σadvantages (정의차 분리용)
    B: { star: number; shield: number; lightning: number } | null; // cumulative cache (net shield)
    C: { star: number; shield: number; lightning: number }; // Σ season pages (raw shield)
    excluded: Array<{ date: string; season: string | null; points: number; adv: number; pen: number }>;
  };

  const rows: Row[] = [];
  const userIds = new Set<string>([...uwpBy.keys(), ...cumBy.keys()]);
  for (const userId of userIds) {
    const myUwp = uwpBy.get(userId) ?? [];
    let aStar = 0, aAdv = 0, aPen = 0;
    for (const r of myUwp) {
      aStar += r.points ?? 0;
      aAdv += r.advantages ?? 0;
      aPen += r.penalty ?? 0;
    }

    // C: front buildSeasonSummaries 재현
    const candidate = new Set<string>(uwsBy.get(userId) ?? []);
    for (const r of myUwp) if (r.week_start_date) candidate.add(r.week_start_date);
    const seasonKeys = new Set<string>();
    for (const d of candidate) {
      const k = weekSeason.get(d);
      if (k && !isBreakKey(k)) seasonKeys.add(k);
    }
    // 시즌별 startSet = 그 시즌 모든 주차 start_date
    const seasonStartUnion = new Set<string>();
    for (const w of weeks) {
      if (w.season_key && seasonKeys.has(w.season_key) && w.start_date) seasonStartUnion.add(w.start_date);
    }
    let cStar = 0, cShield = 0, cLight = 0;
    const excluded: Row["excluded"] = [];
    for (const r of myUwp) {
      if (r.week_start_date && seasonStartUnion.has(r.week_start_date)) {
        cStar += r.points ?? 0;
        cShield += r.advantages ?? 0;
        cLight += r.penalty ?? 0;
      } else if ((r.points ?? 0) || (r.advantages ?? 0) || (r.penalty ?? 0)) {
        excluded.push({
          date: r.week_start_date ?? "(null)",
          season: r.week_start_date ? (weekSeason.get(r.week_start_date) ?? "(weeks 미존재)") : null,
          points: r.points ?? 0,
          adv: r.advantages ?? 0,
          pen: r.penalty ?? 0,
        });
      }
    }

    const c = cumBy.get(userId);
    rows.push({
      userId,
      tester: testers.has(userId),
      A: { star: aStar, shield: aAdv - Math.abs(aPen), lightning: aPen },
      Araw: { shield: aAdv },
      // 고객앱 /api/profile 매핑: stars=total_checks, shields=total_advantages(raw), lightnings=total_penalties
      B: c
        ? {
            star: c.total_checks ?? 0,
            shield: c.total_advantages ?? 0,
            lightning: c.total_penalties ?? 0,
          }
        : null,
      C: { star: cStar, shield: cShield, lightning: cLight },
      excluded,
    });
  }

  // ── 집계 리포트 ──
  const real = rows.filter((r) => !r.tester);
  const summarize = (label: string, set: Row[]) => {
    let starMis = 0, shieldNetMis = 0, shieldRawMis = 0, lightMis = 0, abMis = 0, excludedUsers = 0;
    for (const r of set) {
      if (r.A.star !== r.C.star) starMis++;
      if (r.A.shield !== r.C.shield) shieldNetMis++; // 정의 그대로 비교 (net vs raw)
      if (r.Araw.shield !== r.C.shield) shieldRawMis++; // raw vs raw — 정의차 제거 후
      if (r.A.lightning !== r.C.lightning) lightMis++;
      if (r.B && (r.B.star !== r.A.star || r.B.lightning !== r.A.lightning)) abMis++;
      if (r.excluded.length > 0) excludedUsers++;
    }
    console.log(`\n[${label}] n=${set.length}`);
    console.log(`  별   A(이력서)≠ΣC(시즌합): ${starMis}명`);
    console.log(`  방패 A.net≠ΣC.raw: ${shieldNetMis}명 | A.raw≠ΣC.raw(정의차 제거): ${shieldRawMis}명`);
    console.log(`  번개 A≠ΣC: ${lightMis}명`);
    console.log(`  고객앱 캐시 B≠A (별·번개): ${abMis}명 (B 보유 ${set.filter((r) => r.B).length}명)`);
    console.log(`  시즌합산에서 제외된 uwp 주차 보유: ${excludedUsers}명`);
  };
  summarize("실유저", real);
  summarize("테스터", rows.filter((r) => r.tester));

  // 별 불일치 상위 사례 dump (실유저 우선)
  const mism = rows
    .filter((r) => r.A.star !== r.C.star || r.A.lightning !== r.C.lightning || r.Araw.shield !== r.C.shield)
    .sort((a, b) => Number(a.tester) - Number(b.tester));
  console.log(`\n── 불일치(별/번개/방패raw 기준) 사례 ${mism.length}명 — 상위 10 dump ──`);
  for (const r of mism.slice(0, 10)) {
    console.log(
      `${r.tester ? "[T]" : "[R]"} ${r.userId}\n` +
        `   A 이력서(live): star=${r.A.star} shield(net)=${r.A.shield} (raw=${r.Araw.shield}) light=${r.A.lightning}\n` +
        `   B 캐시:        ${r.B ? `star=${r.B.star} shield(net)=${r.B.shield} light=${r.B.lightning}` : "(row 없음)"}\n` +
        `   ΣC 시즌합:     star=${r.C.star} shield(raw)=${r.C.shield} light=${r.C.lightning}\n` +
        `   제외 주차: ${r.excluded.length ? JSON.stringify(r.excluded) : "없음"}`,
    );
  }

  // 캐시 stale 여부 (별 기준) 전수
  const staleB = rows.filter((r) => r.B && r.B.star !== r.A.star);
  console.log(`\n캐시(user_cumulative_points) star ≠ live 합: ${staleB.length}명 / B보유 ${rows.filter((r) => r.B).length}명`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
