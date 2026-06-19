/**
 * 진단 전용(read-only) — /admin/members 크루 목록 3대 이슈 데이터 조사.
 *   1) 프로필 사진(profile_photo_url) 분포·깨진 URL
 *   2) 한글 깨짐(U+FFFD) — 학교/전공/이름/소속 등 텍스트 필드 전수
 *   3) 품계 미계산 — roster 대상자 중 grade=null 원인 분류
 *
 *   npx tsx --env-file=.env.local scripts/diagnose-members-roster.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listAdminCrewDtos } from "@/lib/adminCrewData";
import { getClubRankGradeBatch, getRankPopulationExcludedUserIds } from "@/lib/cluster3ClubRankData";

const FFFD = "�";

async function pageAll<T>(table: string, columns: string, build?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    let q = supabaseAdmin.from(table).select(columns).order("user_id", { ascending: true }).range(from, from + pageSize - 1);
    if (build) q = build(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

async function main() {
  console.log("=== /admin/members 크루 목록 진단 ===\n");

  // ── 0) operating roster 대상자 ──────────────────────────────────────
  const crews = await listAdminCrewDtos(undefined, "operating");
  const userIds = crews.map((c) => c.userId);
  console.log(`[roster] operating 크루 = ${crews.length}명\n`);

  // ── 1) 프로필 사진 ──────────────────────────────────────────────────
  console.log("──── 1) 프로필 사진 ────");
  const photoRows = await pageAll<{ user_id: string; profile_photo_url: string | null }>(
    "user_profiles",
    "user_id,profile_photo_url",
  );
  const photoById = new Map(photoRows.map((r) => [r.user_id, r.profile_photo_url]));
  let nullPhoto = 0, hasPhoto = 0, supabaseUrl = 0, externalUrl = 0, relativeOrOdd = 0;
  const oddSamples: string[] = [];
  for (const c of crews) {
    const url = photoById.get(c.userId) ?? null;
    if (!url || !url.trim()) { nullPhoto++; continue; }
    hasPhoto++;
    if (/^https?:\/\//i.test(url)) {
      if (/supabase/i.test(url)) supabaseUrl++;
      else externalUrl++;
    } else {
      relativeOrOdd++;
      if (oddSamples.length < 10) oddSamples.push(`${c.displayName ?? c.userId}: ${url.slice(0, 80)}`);
    }
  }
  console.log(`  사진 없음(null/빈값) = ${nullPhoto}명 / 사진 있음 = ${hasPhoto}명`);
  console.log(`  └ Supabase Storage URL = ${supabaseUrl} · 외부 http(s) URL = ${externalUrl} · 상대/비정상 = ${relativeOrOdd}`);
  if (oddSamples.length) { console.log("  비정상(절대 URL 아님) 샘플:"); for (const s of oddSamples) console.log("    - " + s); }
  // distinct host 분포
  const hostCount = new Map<string, number>();
  for (const c of crews) {
    const url = photoById.get(c.userId);
    if (url && /^https?:\/\//i.test(url)) {
      try { const h = new URL(url).host; hostCount.set(h, (hostCount.get(h) ?? 0) + 1); } catch {}
    }
  }
  console.log("  호스트 분포:");
  for (const [h, n] of [...hostCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${h} = ${n}`);
  console.log();

  // ── 2) 한글 깨짐(U+FFFD) ────────────────────────────────────────────
  console.log("──── 2) 한글 깨짐(U+FFFD 치환문자) ────");
  // user_profiles 텍스트 필드
  const profTextRows = await pageAll<Record<string, any>>(
    "user_profiles",
    "user_id,display_name,profile_tagline,current_team_name,current_part_name,address",
  );
  // user_educations
  const eduRows = await pageAll<Record<string, any>>(
    "user_educations",
    "user_id,school_name,major_name_1,major_name_2",
  );
  // user_memberships
  const memRows = await pageAll<Record<string, any>>(
    "user_memberships",
    "user_id,team_name,part_name",
  );
  // schools 마스터(전체)
  const { data: schoolMaster } = await supabaseAdmin.from("schools").select("source,source_id,school_name").limit(100000);

  const scanField = (label: string, rows: Record<string, any>[], fields: string[]) => {
    const hits: string[] = [];
    for (const r of rows) {
      for (const f of fields) {
        const v = r[f];
        if (typeof v === "string" && v.includes(FFFD)) {
          hits.push(`${label}.${f} [user=${r.user_id ?? r.source_id}] = "${v}"`);
        }
      }
    }
    return hits;
  };

  const allHits = [
    ...scanField("user_profiles", profTextRows, ["display_name", "profile_tagline", "current_team_name", "current_part_name", "address"]),
    ...scanField("user_educations", eduRows, ["school_name", "major_name_1", "major_name_2"]),
    ...scanField("user_memberships", memRows, ["team_name", "part_name"]),
    ...scanField("schools", (schoolMaster ?? []) as Record<string, any>[], ["school_name"]),
  ];
  console.log(`  U+FFFD 포함 필드 = ${allHits.length}건`);
  for (const h of allHits.slice(0, 60)) console.log("    ! " + h);
  if (allHits.length > 60) console.log(`    … 외 ${allHits.length - 60}건`);
  console.log();

  // ── 3) 품계 미계산 ──────────────────────────────────────────────────
  console.log("──── 3) 품계 미계산 ────");
  const [gradeMap, excludedIds] = await Promise.all([
    getClubRankGradeBatch(userIds),
    getRankPopulationExcludedUserIds(),
  ]);
  // 보조 데이터: growth_status, uwp 보유여부, uws 보유여부, frozen 보유여부
  const profStatus = await pageAll<{ user_id: string; growth_status: string | null }>(
    "user_profiles", "user_id,growth_status",
  );
  const statusById = new Map(profStatus.map((r) => [r.user_id, r.growth_status]));

  const uwpUsers = new Set<string>();
  {
    const rows = await pageAll<{ user_id: string }>("user_weekly_points", "user_id");
    for (const r of rows) uwpUsers.add(r.user_id);
  }
  const uwsUsers = new Set<string>();
  {
    const rows = await pageAll<{ user_id: string }>("user_week_statuses", "user_id");
    for (const r of rows) uwsUsers.add(r.user_id);
  }
  const frozenUsers = new Set<string>();
  {
    const { data } = await supabaseAdmin.from("user_club_rank_frozen").select("user_id").limit(100000);
    for (const r of (data ?? []) as { user_id: string }[]) frozenUsers.add(r.user_id);
  }

  let withGrade = 0;
  const nullReasons = new Map<string, number>();
  const nullSamples: Record<string, string[]> = {};
  const bump = (reason: string, who: string) => {
    nullReasons.set(reason, (nullReasons.get(reason) ?? 0) + 1);
    (nullSamples[reason] ??= []);
    if (nullSamples[reason].length < 5) nullSamples[reason].push(who);
  };
  for (const c of crews) {
    const g = gradeMap.get(c.userId) ?? null;
    if (g) { withGrade++; continue; }
    const who = `${c.displayName ?? c.userId} (${c.organizationSlug ?? "-"})`;
    const gs = statusById.get(c.userId) ?? null;
    if (excludedIds.has(c.userId) || gs === "seasonal_rest") bump("seasonal_rest 모집단 제외", who);
    else if ((gs === "graduated" || gs === "suspended") && !frozenUsers.has(c.userId)) bump("graduated/suspended + frozen 행 없음", who);
    else if (!uwpUsers.has(c.userId)) bump("user_weekly_points 없음", who);
    else if (!uwsUsers.has(c.userId)) bump("user_week_statuses 없음(온보딩 주차 판정불가)", who);
    else bump("적격 주차 0(온보딩 1주차만 보유 등)", who);
  }
  console.log(`  품계 있음 = ${withGrade}명 / 품계 null = ${crews.length - withGrade}명`);
  for (const [reason, n] of [...nullReasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  · ${reason} = ${n}명`);
    for (const s of nullSamples[reason]) console.log(`      - ${s}`);
  }
  console.log("\n=== 진단 종료 ===");
}

main().catch((e) => { console.error("진단 실패:", e); process.exit(1); });
