/**
 * [검수 완료] 신규 공표 경로(alreadyPublished=false) 검증 — 안전 라운드트립.
 *
 *  운영 DB 무손상: 작은 코호트(공식 휴식) 공표 주차 1건을 골라
 *    published/reviewed 를 임시 null → 검수 완료(신규 공표+코호트 재계산+검수) → 원본 시각 원복.
 *  공식 휴식 주차는 성공/실패가 아니라 공식 휴식으로 표시되므로(공표 무관) 재계산해도 크루 표시 불변.
 *  → "신규 공표 분기가 publishWeekResult(공표+코호트 재계산)를 호출하고 검수까지 세팅"하는 배선만 검증.
 *
 *   npx tsx --env-file=.env.local scripts/verify-team-parts-week-finalize-publish.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { markTeamPartsWeekReviewed } from "@/lib/adminTeamPartsInfoWeekDetailData";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}

async function cohortSize(weekStart: string): Promise<number> {
  const { count } = await supabaseAdmin.from("user_week_statuses")
    .select("*", { count: "exact", head: true }).eq("week_start_date", weekStart);
  return count ?? 0;
}

async function main() {
  // 공표+검수된 과거 주차 중 코호트가 작은(공식 휴식) 것을 고른다.
  const { data: weeks } = await supabaseAdmin
    .from("weeks")
    .select("id,season_key,week_number,start_date,result_published_at,result_reviewed_at")
    .not("result_published_at", "is", null)
    .not("result_reviewed_at", "is", null)
    .order("start_date", { ascending: false });
  const W = (weeks ?? []) as any[];

  let target: any = null;
  for (const w of W) {
    const n = await cohortSize(w.start_date);
    const { data: st } = await supabaseAdmin.from("user_week_statuses").select("status").eq("week_start_date", w.start_date);
    const rows = (st ?? []) as any[];
    const allRest = rows.length > 0 && rows.every((r) => r.status === "official_rest" || r.status === "personal_rest");
    if (n > 0 && n <= 20 && allRest) { target = w; break; }
  }
  if (!target) { console.log("⚠ 작은 휴식 코호트 공표 주차 없음 — 신규 공표 배선 검증 생략."); process.exit(2); }

  const weekId = target.id as string;
  const origPub = target.result_published_at as string;
  const origRev = target.result_reviewed_at as string;
  const n = await cohortSize(target.start_date);
  console.log(`   대상(휴식) 주차 = ${target.season_key} W${target.week_number} start=${target.start_date} cohort=${n} id=${weekId.slice(0, 8)}`);

  try {
    // 임시로 미공표·미검수로 되돌린다(스냅샷은 그대로 두어 표시 불변).
    await supabaseAdmin.from("weeks").update({ result_published_at: null, result_reviewed_at: null }).eq("id", weekId);

    const r = await markTeamPartsWeekReviewed(weekId, null);
    check("신규 공표 분기: alreadyPublished=false", r.alreadyPublished === false);
    check("신규 공표 분기: reviewed=true", r.reviewed === true);
    check("신규 공표 분기: publishedAt 신규 세팅", typeof r.publishedAt === "string" && r.publishedAt !== origPub, { publishedAt: r.publishedAt });
    check("신규 공표 분기: reviewedAt 세팅", typeof r.reviewedAt === "string");
    check("신규 공표 분기: 코호트 재계산 발생(requested=cohort)", r.snapshotRecompute.requested === n, { recompute: r.snapshotRecompute, cohort: n });
    check("신규 공표 분기: 재계산 실패 0", r.snapshotRecompute.failed === 0, r.snapshotRecompute);

    const { data: after } = await supabaseAdmin.from("weeks")
      .select("result_published_at,result_reviewed_at").eq("id", weekId).maybeSingle();
    check("공표+검수 세팅됨", (after as any)?.result_published_at != null && (after as any)?.result_reviewed_at != null);
  } finally {
    // 항상 원복(원본 시각 복원 — 감사 로그 무손상).
    await supabaseAdmin.from("weeks").update({ result_published_at: origPub, result_reviewed_at: origRev }).eq("id", weekId);
    const { data: restored } = await supabaseAdmin.from("weeks")
      .select("result_published_at,result_reviewed_at").eq("id", weekId).maybeSingle();
    check("원복: published 원본", (restored as any)?.result_published_at === origPub);
    check("원복: reviewed 원본", (restored as any)?.result_reviewed_at === origRev);
  }

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
