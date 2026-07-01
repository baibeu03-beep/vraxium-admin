/**
 * diag-seasonal-rest-weekcards.ts  (READ-ONLY)
 *
 * 목적: growth_status='seasonal_rest'(시즌 휴식) 회원의 "주차 정보"가 크루 페이지에서
 *       정상 노출되지 않는 원인을 DB → direct → snapshot 전 구간으로 추적.
 *       (HTTP/브라우저는 별도 단계에서 확인)
 *
 * 절대 write 안 함. getCluster4WeeklyCardsForProfileUser(=live builder)와
 * readWeeklyCardsSnapshot(=snapshot 조회)만 호출(둘 다 read-only). recompute(=write)는 호출 금지.
 *
 * 실행: npx tsx --env-file=.env.local scripts/diag-seasonal-rest-weekcards.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { getSeasonForDate, seasonDbKey } from "@/lib/seasonCalendar";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(78));

const TODAY = new Date().toISOString().slice(0, 10);
const CUR_SEASON = getSeasonForDate(TODAY);
const CUR_SEASON_KEY = CUR_SEASON ? seasonDbKey(CUR_SEASON) : null;

type Cand = { userId: string; name: string | null; growth: string | null; via: string };

async function findCandidates(): Promise<Cand[]> {
  const map = new Map<string, Cand>();

  // A) user_profiles.growth_status='seasonal_rest'
  const { data: gs } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, display_name, growth_status")
    .eq("growth_status", "seasonal_rest");
  for (const r of (gs ?? []) as any[]) {
    map.set(r.user_id, {
      userId: r.user_id,
      name: r.display_name ?? null,
      growth: r.growth_status ?? null,
      via: "profile.growth_status",
    });
  }

  // B) user_season_statuses.status='rest' (현재 시즌 = seasonRestActive 원천)
  //    season_key 컬럼 유무를 모를 수 있어 전체 rest 를 받아 현재 시즌 추정 표시.
  const { data: ss, error: ssErr } = await supabaseAdmin
    .from("user_season_statuses")
    .select("user_id, status, season_key")
    .eq("status", "rest");
  if (ssErr) line(`  (user_season_statuses 조회 경고: ${ssErr.message})`);
  for (const r of (ss ?? []) as any[]) {
    const cur = CUR_SEASON_KEY && r.season_key === CUR_SEASON_KEY;
    const existing = map.get(r.user_id);
    const via = `uss.rest${cur ? "(current)" : `(${r.season_key ?? "?"})`}`;
    if (existing) existing.via += ` + ${via}`;
    else map.set(r.user_id, { userId: r.user_id, name: null, growth: null, via });
  }

  // 이름 보강
  const need = Array.from(map.values()).filter((c) => !c.name).map((c) => c.userId);
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    const { data } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id, display_name, growth_status")
      .in("user_id", chunk);
    for (const r of (data ?? []) as any[]) {
      const c = map.get(r.user_id);
      if (c) {
        c.name = r.display_name ?? null;
        if (!c.growth) c.growth = r.growth_status ?? null;
      }
    }
  }
  return Array.from(map.values());
}

async function dbRaw(userId: string) {
  const { data: ss } = await supabaseAdmin
    .from("user_season_statuses")
    .select("season_key, status")
    .eq("user_id", userId);
  const { data: uws } = await supabaseAdmin
    .from("user_week_statuses")
    .select("week_id, status")
    .eq("user_id", userId);
  const uwsDist: Record<string, number> = {};
  for (const r of (uws ?? []) as any[]) {
    const k = r.status ?? "(null)";
    uwsDist[k] = (uwsDist[k] ?? 0) + 1;
  }
  return {
    seasonStatuses: (ss ?? []).map((r: any) => `${r.season_key ?? "?"}:${r.status}`),
    uwsCount: (uws ?? []).length,
    uwsDist,
  };
}

function cardSummary(cards: any[]) {
  const byStatus: Record<string, number> = {};
  let restFlag = 0;
  const rows = cards.map((c) => {
    const st = String(c.userWeekStatus ?? "(null)");
    byStatus[st] = (byStatus[st] ?? 0) + 1;
    if (c.isRestWeek) restFlag++;
    return {
      w: c.weekNumber,
      season: c.seasonKey,
      status: st,
      rest: !!c.isRestWeek,
      label: c.statusLabel,
    };
  });
  return { count: cards.length, byStatus, restFlag, rows };
}

async function trace(c: Cand, label: string) {
  hr();
  line(`▶ [${label}] ${c.name ?? "(이름?)"}  user=${c.userId}`);
  line(`   growth_status=${c.growth}  via=${c.via}`);

  const raw = await dbRaw(c.userId);
  line(`   DB  season_statuses=[${raw.seasonStatuses.join(", ")}]`);
  line(`   DB  user_week_statuses: count=${raw.uwsCount} dist=${JSON.stringify(raw.uwsDist)}`);

  // direct (live builder) — read-only
  let direct: ReturnType<typeof cardSummary> | null = null;
  try {
    const cards = await getCluster4WeeklyCardsForProfileUser(c.userId);
    direct = cardSummary(cards);
    line(`   DIRECT cards=${direct.count} byStatus=${JSON.stringify(direct.byStatus)} isRestWeek=true:${direct.restFlag}`);
  } catch (e: any) {
    line(`   DIRECT 실패: ${e.message}`);
  }

  // snapshot read — read-only
  const snap = await readWeeklyCardsSnapshot(c.userId);
  if (snap.status === "hit" || snap.status === "stale") {
    const s = cardSummary(snap.cards as any[]);
    line(
      `   SNAP  status=${snap.status}${snap.status === "stale" ? `(${(snap as any).reason})` : ""} ` +
        `computedAt=${(snap as any).computedAt} cards=${s.count} byStatus=${JSON.stringify(s.byStatus)} isRestWeek=true:${s.restFlag}`,
    );
    if (direct) {
      const sameCount = direct.count === s.count;
      const sameDist = JSON.stringify(direct.byStatus) === JSON.stringify(s.byStatus);
      line(`   CMP   direct==snap? count:${sameCount} byStatus:${sameDist}`);
    }
  } else {
    line(`   SNAP  status=${snap.status}${snap.status === "error" ? ` (${(snap as any).message})` : ""}`);
  }

  // 현재 시즌 카드만 표로
  if (direct) {
    const curRows = direct.rows.filter((r) => r.season === CUR_SEASON_KEY);
    line(`   현재시즌(${CUR_SEASON_KEY}) 카드 ${curRows.length}건:`);
    for (const r of curRows) {
      line(`      W${r.w} status=${r.status} rest=${r.rest} label="${r.label}"`);
    }
  }
}

async function main() {
  line(`오늘=${TODAY} 현재시즌키=${CUR_SEASON_KEY}`);
  const testIds = await fetchTestUserMarkerIds();
  line(`test_user_markers=${testIds.size}명`);

  const cands = await findCandidates();
  const operating = cands.filter((c) => !testIds.has(c.userId));
  const test = cands.filter((c) => testIds.has(c.userId));
  hr();
  line(`seasonal_rest 후보 총 ${cands.length}명 → 운영=${operating.length} 테스트=${test.length}`);
  line(`운영 후보: ${operating.map((c) => `${c.name ?? "?"}(${c.userId.slice(0, 8)})`).join(", ")}`);
  line(`테스트 후보: ${test.map((c) => `${c.name ?? "?"}(${c.userId.slice(0, 8)})`).join(", ")}`);

  for (const c of operating.slice(0, 4)) await trace(c, "운영");
  for (const c of test.slice(0, 4)) await trace(c, "테스트");
  hr();
  line("DONE (read-only)");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
