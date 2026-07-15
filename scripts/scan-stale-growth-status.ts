/**
 * READ-ONLY 전수 스캔 — 구 엔드포인트(재판정 미포함)로 액트 보완/취소된 (사용자·주차)의 성장 상태 stale 탐지.
 *   tsx --env-file=.env.local scripts/scan-stale-growth-status.ts
 *
 * 후보 = 액트 보완 수신자(process_irregular_acts.origin='act_supplement') ∪ 소프트취소 대상
 *        (process_point_awards.cancelled_at IS NOT NULL).
 * 각 후보에 대해 predictWeekStatusForUser(현재 포인트 기준)와 저장된 user_week_statuses.status 를 대조.
 * 쓰기 없음 — 불일치 목록만 보고. 백필은 확인 후 별도 스크립트로.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { predictWeekStatusForUser } from "@/lib/crewWeekGrowthRejudge";
import { ACT_SUPPLEMENT_ORIGIN } from "@/lib/adminProcessIrregularData";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";

const SEASON_KO: Record<string, string> = { winter: "겨울", spring: "봄", summer: "여름", autumn: "가을", fall: "가을" };
function weekLabel(seasonKey: string | null, weekNo: number | null): string {
  if (!seasonKey || weekNo == null) return `${seasonKey}/${weekNo}`;
  const m = seasonKey.toLowerCase().match(/^(\d{4})-(winter|spring|summer|autumn|fall)$/);
  return m ? `${m[1]} ${SEASON_KO[m[2]]} ${weekNo}주차` : `${seasonKey} ${weekNo}주차`;
}

type Cand = { userId: string; weekId: string; startDate: string; seasonKey: string | null; weekNo: number | null; sources: Set<string> };

async function pageAll<T>(build: (from: number, to: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const rows = await build(from, from + PAGE - 1);
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function main() {
  // 주차 메타 캐시(weekId → {startDate, seasonKey, weekNo}; iso → weekId).
  const { data: weekRows } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,season_key,week_number,iso_year,iso_week");
  const weekById = new Map<string, { startDate: string; seasonKey: string | null; weekNo: number | null }>();
  const weekByIso = new Map<string, string>();
  for (const w of (weekRows ?? []) as Array<{ id: string; start_date: string; season_key: string | null; week_number: number | null; iso_year: number | null; iso_week: number | null }>) {
    weekById.set(w.id, { startDate: w.start_date, seasonKey: w.season_key, weekNo: w.week_number });
    if (w.iso_year != null && w.iso_week != null) weekByIso.set(`${w.iso_year}-${w.iso_week}`, w.id);
  }

  const cand = new Map<string, Cand>(); // key = userId|weekId
  const add = (userId: string, weekId: string, source: string) => {
    const meta = weekById.get(weekId);
    if (!meta || !meta.startDate) return;
    const key = `${userId}|${weekId}`;
    let c = cand.get(key);
    if (!c) { c = { userId, weekId, startDate: meta.startDate, seasonKey: meta.seasonKey, weekNo: meta.weekNo, sources: new Set() }; cand.set(key, c); }
    c.sources.add(source);
  };

  // (A) 액트 보완 수신자.
  const suppActs = await pageAll(async (from, to) => {
    const { data } = await supabaseAdmin.from("process_irregular_acts")
      .select("id,week_id").eq("origin", ACT_SUPPLEMENT_ORIGIN).order("id").range(from, to);
    return (data ?? []) as { id: string; week_id: string | null }[];
  });
  const actWeek = new Map<string, string>();
  for (const a of suppActs) if (a.week_id) actWeek.set(a.id, a.week_id);
  const actIds = [...actWeek.keys()];
  for (let i = 0; i < actIds.length; i += 200) {
    const chunk = actIds.slice(i, i + 200);
    const { data } = await supabaseAdmin.from("process_check_review_recipients")
      .select("ref_id,user_id").eq("source", "irregular").in("ref_id", chunk);
    for (const r of (data ?? []) as { ref_id: string; user_id: string | null }[]) {
      const wk = actWeek.get(r.ref_id);
      if (r.user_id && wk) add(r.user_id, wk, "supplement");
    }
  }

  // (B) 소프트취소 대상.
  const cancelled = await pageAll(async (from, to) => {
    const { data } = await supabaseAdmin.from("process_point_awards")
      .select("user_id,year,week_number").not("cancelled_at", "is", null).order("id").range(from, to);
    return (data ?? []) as { user_id: string; year: number; week_number: number }[];
  });
  for (const r of cancelled) {
    const wk = weekByIso.get(`${r.year}-${r.week_number}`);
    if (wk) add(r.user_id, wk, "cancel");
  }

  const candidates = [...cand.values()];
  console.log(`후보 (사용자·주차) = ${candidates.length}건 (보완∪취소). 판정 대조 시작…\n`);

  // 프로필(이름·조직) 일괄.
  const uids = [...new Set(candidates.map((c) => c.userId))];
  const nameByUser = new Map<string, { name: string; org: string | null }>();
  for (let i = 0; i < uids.length; i += 300) {
    const chunk = uids.slice(i, i + 300);
    const { data } = await supabaseAdmin.from("user_profiles").select("user_id,display_name,organization_slug").in("user_id", chunk);
    for (const p of (data ?? []) as { user_id: string; display_name: string | null; organization_slug: string | null }[]) {
      nameByUser.set(p.user_id, { name: p.display_name ?? "(무명)", org: p.organization_slug });
    }
  }

  type Row = { user: string; org: string | null; week: string; stored: string; predicted: string; mismatch: boolean };
  const rows: Row[] = [];
  const CONC = 5;
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const c = candidates[cursor++];
      const prof = nameByUser.get(c.userId);
      const org = prof?.org && isOrganizationSlug(prof.org) ? (prof.org as OrganizationSlug) : null;
      const { data: uwsRows } = await supabaseAdmin.from("user_week_statuses")
        .select("status").eq("week_start_date", c.startDate).eq("user_id", c.userId).limit(1);
      const stored = ((uwsRows ?? [])[0] as { status?: string } | undefined)?.status ?? "(없음)";
      let predicted: string;
      try {
        const p = await predictWeekStatusForUser({ userId: c.userId, weekId: c.weekId, organizationSlug: org });
        predicted = p.skipped ? `skip(${p.skipReason})` : (p.targetStatus ?? "?");
      } catch (e) {
        predicted = `error(${e instanceof Error ? e.message : String(e)})`;
      }
      const bothConcrete = (stored === "success" || stored === "fail") && (predicted === "success" || predicted === "fail");
      const mismatch = bothConcrete && stored !== predicted;
      rows.push({ user: `${prof?.name ?? c.userId}`, org: prof?.org ?? null, week: weekLabel(c.seasonKey, c.weekNo), stored, predicted, mismatch });
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, candidates.length) }, () => worker()));

  rows.sort((a, b) => Number(b.mismatch) - Number(a.mismatch) || a.user.localeCompare(b.user));
  console.log("=== 전체 후보 대조 ===");
  console.table(rows.map((r) => ({ 사용자: r.user, 조직: r.org, 주차: r.week, "현재저장": r.stored, "예상": r.predicted, "불일치": r.mismatch ? "★" : "" })));

  const bad = rows.filter((r) => r.mismatch);
  console.log(`\n=== 불일치(백필 대상) = ${bad.length}건 ===`);
  console.table(bad.map((r) => ({ 사용자: r.user, 조직: r.org, 주차: r.week, "현재저장": r.stored, "→예상": r.predicted })));
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
