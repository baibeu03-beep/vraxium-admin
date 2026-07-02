/**
 * 클럽 정보 > 주차 내역 > 활동 관리 — [검수 완료] 최종 확정 검증 (dev server 필요).
 *
 *  검수 완료 = ① 공표(weeks.result_published_at) + ② 코호트 snapshot 재계산 + ③ 검수(result_reviewed_at).
 *
 *  안전 원칙(운영 DB 무손상):
 *    - 공표는 절대 끄지 않는다(끄면 실크루가 '집계 중'을 봄). 이미 공표된 주차에서 result_reviewed_at
 *      만 임시로 null→검수→원복(published 불변 → 크루 성공/실패 표시 불변)한다.
 *    - 공표 전환(tallying→success/fail)은 순수 함수 resolveWeekResultStatus 로 인과만 증명(무변경).
 *
 *  검증:
 *   1) direct(markTeamPartsWeekReviewed) 결과
 *   2) HTTP POST /review 응답
 *   3) direct == HTTP (멱등 재확정 경로)
 *   4) 검수 완료 후 GET managedWeek.reviewed=true·목록 weekReviewed=true (새로고침 반영)
 *   5) 공표 인과: 같은 uws 가 미공표=tallying / 공표=success|fail (크루 주차 결과 전환)
 *   6) 크루 카드 성공/실패 실제 반영(공표 주차의 crew weekly-card DTO)
 *   7) snapshot: 검수(published 불변)는 재계산 없음 / 공표 전환 시에만 코호트 재계산
 *   8) 운영 weeks 공표 개수 불변(실주차 공표 상태 무손상)
 *
 *   npx tsx --env-file=.env.local scripts/verify-team-parts-info-week-review.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS } from "@/lib/organizations";
import {
  markTeamPartsWeekReviewed,
  loadTeamPartsInfoWeekDetail,
} from "@/lib/adminTeamPartsInfoWeekDetailData";
import { loadTeamPartsInfoWeeks } from "@/lib/adminTeamPartsInfoWeeksData";
import { resolveWeekResultStatus } from "@/lib/growthCore";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}

async function adminCookieHeader(): Promise<string> {
  const { data: adm } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as { email: string } | undefined)?.email;
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email: email! });
  const { data: v } = await N.auth.verifyOtp({ email: email!, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: { name: string; value: string }[] = [];
  const sv = createServerClient(u, a, {
    cookies: { getAll: () => [], setAll: (items) => cap.push(...items.map(({ name, value }: any) => ({ name, value }))) },
  });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function snapshotCount(): Promise<number> {
  const { count } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  return count ?? 0;
}
async function publishedWeeksCount(): Promise<number> {
  const { count } = await supabaseAdmin.from("weeks").select("*", { count: "exact", head: true }).not("result_published_at", "is", null);
  return count ?? 0;
}

async function main() {
  try {
    const h = await fetch(`${BASE}/api/health`);
    check("dev server 응답", h.ok, { base: BASE });
  } catch {
    console.log(`❌ dev server 미기동(${BASE}).`); process.exit(2);
  }
  const cookie = await adminCookieHeader();

  // 대상: 공표+검수 완료된 과거 주차 중 성장 성공/실패가 있는 주차(휴식만인 주차 제외).
  const { data: weeks } = await supabaseAdmin
    .from("weeks")
    .select("id,season_key,week_number,start_date,result_published_at,result_reviewed_at,iso_year,iso_week")
    .not("result_published_at", "is", null)
    .order("start_date", { ascending: false });
  const W = (weeks ?? []) as any[];

  let target: any = null;
  let successUser: string | null = null;
  let failUser: string | null = null;
  for (const w of W) {
    const { data: st } = await supabaseAdmin
      .from("user_week_statuses").select("user_id,status").eq("week_start_date", w.start_date);
    const rows = (st ?? []) as any[];
    const su = rows.find((r) => r.status === "success");
    const fu = rows.find((r) => r.status === "fail");
    if (su && fu) { target = w; successUser = su.user_id; failUser = fu.user_id; break; }
  }
  if (!target) { console.log("⚠ 성공/실패가 함께 있는 공표 주차 없음 — 검증 불가."); process.exit(2); }

  const weekId = target.id as string;
  const origPublishedAt = target.result_published_at as string;
  const origReviewedAt = target.result_reviewed_at as string | null;
  console.log(`   대상 주차 = ${target.season_key} W${target.week_number} start=${target.start_date} id=${weekId.slice(0, 8)}`);
  console.log(`   샘플 크루: success=${successUser?.slice(0, 8)} fail=${failUser?.slice(0, 8)}`);

  const snapBefore = await snapshotCount();
  const pubBefore = await publishedWeeksCount();

  // ── (5) 공표 인과 증명 (순수 함수·무변경) ──
  {
    const base = { isCurrentWeek: false, weekIsOfficialRest: false, experienceVerdictStatus: null } as const;
    const unpubSuccess = resolveWeekResultStatus({ ...base, uwsStatus: "success", isPublished: false }).status;
    const pubSuccess = resolveWeekResultStatus({ ...base, uwsStatus: "success", isPublished: true }).status;
    const unpubFail = resolveWeekResultStatus({ ...base, uwsStatus: "fail", isPublished: false }).status;
    const pubFail = resolveWeekResultStatus({ ...base, uwsStatus: "fail", isPublished: true }).status;
    check("공표 전 success→집계중(tallying)", unpubSuccess === "tallying", { unpubSuccess });
    check("공표 후 success→성장 성공(success)", pubSuccess === "success", { pubSuccess });
    check("공표 전 fail→집계중(tallying)", unpubFail === "tallying", { unpubFail });
    check("공표 후 fail→성장 실패(fail)", pubFail === "fail", { pubFail });
  }

  // ── (6) 공표 주차의 크루 카드가 성공/실패로 실제 반영 (snapshot-only 조회) ──
  {
    const wkStart = target.start_date as string;
    const cardStatusFor = async (userId: string): Promise<string | null> => {
      const out = await readWeeklyCardsSnapshot(userId);
      if (out.status !== "hit" && out.status !== "stale") return null;
      const c = out.cards.find((x) => x.startDate === wkStart);
      return c ? (c.userWeekStatus ?? null) : null;
    };
    const sStatus = await cardStatusFor(successUser!);
    const fStatus = await cardStatusFor(failUser!);
    check("크루 카드(success 유저) = success", sStatus === "success", { sStatus });
    check("크루 카드(fail 유저) = fail", fStatus === "fail", { fStatus });
  }

  // ── 안전한 검수 라운드트립: reviewed 만 임시 null→검수→원복 (published 불변) ──
  await supabaseAdmin.from("weeks").update({ result_reviewed_at: null }).eq("id", weekId);

  // (4-a) 미검수 상태 GET 확인
  {
    const d = await loadTeamPartsInfoWeekDetail({ weekId, organization: ORGANIZATIONS[0], mode: "operating" });
    check("검수 전 detail.reviewed=false", d.managedWeek.reviewed === false);
  }

  // (1) direct
  const direct = await markTeamPartsWeekReviewed(weekId, null);
  check("direct: reviewed=true", direct.reviewed === true);
  check("direct: alreadyPublished=true(공표 불변)", direct.alreadyPublished === true, { publishedAt: direct.publishedAt });
  check("direct: publishedAt == 원본(공표 시각 불변)", direct.publishedAt === origPublishedAt, { got: direct.publishedAt, orig: origPublishedAt });
  check("direct: 이미 공표 경로는 코호트 재계산 없음", direct.snapshotRecompute.requested === 0, direct.snapshotRecompute);

  // (2) HTTP — 멱등(이미 검수됨) 재호출
  const res = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/review?club=${ORGANIZATIONS[0]}`, { method: "POST", headers: { cookie } });
  const json: any = await res.json();
  check("HTTP 200·success·ok", res.ok && json?.success === true && json?.ok === true, { status: res.status });
  check("HTTP DTO: weekId·reviewed·reviewedAt 존재", json?.weekId === weekId && json?.reviewed === true && typeof json?.reviewedAt === "string");

  // (3) direct == HTTP (멱등 경로 안정 필드)
  const stable = (o: any) => ({ weekId: o.weekId, reviewed: o.reviewed, alreadyPublished: o.alreadyPublished, publishedAt: o.publishedAt });
  const eq = JSON.stringify(stable(direct)) === JSON.stringify(stable(json.data));
  check("direct == HTTP (안정 필드)", eq, eq ? undefined : { direct: stable(direct), http: stable(json.data) });

  // (4-b) 검수 후 GET detail·목록 반영
  {
    const d = await loadTeamPartsInfoWeekDetail({ weekId, organization: ORGANIZATIONS[0], mode: "operating" });
    check("검수 후 detail.reviewed=true", d.managedWeek.reviewed === true);

    const g = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}?club=${ORGANIZATIONS[0]}`, { headers: { cookie }, cache: "no-store" });
    const gj: any = await g.json();
    check("검수 후 HTTP GET managedWeek.reviewed=true", gj?.data?.managedWeek?.reviewed === true);

    // 목록: 대상 주차가 포함된 페이지를 찾아 weekReviewed 확인.
    let listReviewed: boolean | null = null;
    for (let page = 1; page <= 12; page++) {
      const list = await loadTeamPartsInfoWeeks({ organization: ORGANIZATIONS[0], page, pageSize: 20 });
      const it = list.items.find((x) => x.weekId === weekId);
      if (it) { listReviewed = it.weekReviewed; break; }
      if (page >= list.pagination.totalPages) break;
    }
    check("목록 weekReviewed=true(주차 검수 V)", listReviewed === true, { listReviewed });
  }

  // (7) 검수(published 불변)는 snapshot 재계산 없음 — count 불변
  const snapAfter = await snapshotCount();
  check("검수 라운드트립 후 snapshot count 불변", snapBefore === snapAfter, { before: snapBefore, after: snapAfter });

  // ── 원복: 원본 reviewed 시각으로 복원 (published 는 내내 불변) ──
  await supabaseAdmin.from("weeks").update({ result_reviewed_at: origReviewedAt }).eq("id", weekId);
  const { data: restored } = await supabaseAdmin.from("weeks").select("result_published_at,result_reviewed_at").eq("id", weekId).maybeSingle();
  check("원복: published 원본 유지", (restored as any)?.result_published_at === origPublishedAt);
  check("원복: reviewed 원본 복원", (restored as any)?.result_reviewed_at === origReviewedAt);

  // (8) 운영 weeks 공표 개수 불변
  const pubAfter = await publishedWeeksCount();
  check("운영 weeks 공표 개수 불변", pubBefore === pubAfter, { before: pubBefore, after: pubAfter });

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
