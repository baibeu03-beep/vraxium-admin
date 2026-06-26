/**
 * 진단(수정 없음) — Po.A/B/C 의 "원천 기준 올바른 Top3"를 thin 테이블(user_weekly_points)로 산출.
 *   card.points.star = user_weekly_points.points (주차 키 iso_year-iso_week, 조직 로스터 한정).
 *   fat snapshot read(통계 timeout 주범) 없이 원천 정답을 보여준다.
 *   별도 DTO 1회(best-effort)로 partialFailure 동반 여부도 표기.
 * Usage: npx tsx --env-file=.env.local scripts/diag-po-vs-source.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const LABEL: Record<string, string> = { encre: "엥크레", oranke: "오랑캐", phalanx: "팔랑크스" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// thin 쿼리 재시도(transient 대비).
async function retry<T>(fn: () => Promise<{ data: T | null; error: any }>, n = 6): Promise<T | null> {
  for (let a = 1; a <= n; a++) {
    const { data, error } = await fn();
    if (!error) return data;
    await sleep(1500);
  }
  return null;
}

async function clubRoster(org: string) {
  const out: { id: string; name: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabaseAdmin.from("user_profiles").select("user_id, display_name")
      .eq("organization_slug", org).not("activity_started_at", "is", null).or("role.is.null,role.neq.super_admin")
      .order("user_id", { ascending: true }).range(from, from + 999);
    const rows = (data ?? []) as any[];
    out.push(...rows.map((r) => ({ id: r.user_id, name: r.display_name ?? "-" })));
    if (rows.length < 1000) break;
  }
  const { data: tm } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const testIds = new Set((tm ?? []).map((r: any) => r.user_id));
  return out.filter((r) => !testIds.has(r.id));
}

// 원천 정답 — user_weekly_points(year=iso_year, week_number=iso_week) roster 한정 points>0, 정렬.
async function sourceTop(roster: { id: string; name: string }[], iy: number, iw: number) {
  const nameById = new Map(roster.map((r) => [r.id, r.name]));
  const ids = roster.map((r) => r.id);
  const list: { name: string; points: number }[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const data = await retry<any[]>(() => supabaseAdmin.from("user_weekly_points").select("user_id, points")
      .eq("year", iy).eq("week_number", iw).in("user_id", chunk) as any);
    for (const r of (data ?? []) as any[]) { const p = Number(r.points); if (p > 0) list.push({ name: nameById.get(r.user_id) ?? "-", points: p }); }
  }
  list.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name, "ko"));
  return list;
}

async function main() {
  // 표본 주차: 2026-spring W13(활동)·W16(휴식) — 최근 확정 주차.
  const wks = await retry<any[]>(() => supabaseAdmin.from("weeks")
    .select("id, week_number, iso_year, iso_week, is_official_rest, result_published_at")
    .eq("season_key", "2026-spring").in("week_number", [13, 16]).order("week_number", { ascending: true }) as any);
  const weeks = (wks ?? []) as any[];
  console.log(`표본 주차 ${weeks.length}건 로드`);

  for (const org of ["encre", "oranke", "phalanx"]) {
    console.log(`\n════════ [${LABEL[org]}] (${org}) ════════`);
    const roster = await clubRoster(org);
    console.log(`로스터 ${roster.length}명`);
    for (const w of weeks) {
      const src = await sourceTop(roster, w.iso_year, w.iso_week);
      const top3 = src.slice(0, 3);
      const distinct = new Set(src.map((s) => s.points));
      console.log(`\n▶ 2026 봄 ${w.week_number}주차 (${w.is_official_rest ? "공식 휴식" : "공식 활동"}) · weekId=${w.id} · iso=${w.iso_year}-${w.iso_week} · published=${w.result_published_at ? "Y" : "N"}`);
      console.log(`   원천 points>0 ${src.length}명 · 서로 다른 점수값 ${distinct.size}종(=${[...distinct].slice(0, 8).join(",")}...)`);
      console.log(`   ✅ 원천 올바른 Top3: ${top3.map((t, i) => `Po.${["A", "B", "C"][i]}=${t.name} 님 (${t.points}개)`).join(" / ") || "(없음)"}`);
      console.log(`      원천 Top10: ${src.slice(0, 10).map((t) => `${t.name}:${t.points}`).join(", ")}`);
    }
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
