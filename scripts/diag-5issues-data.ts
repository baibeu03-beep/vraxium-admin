// 5개 이슈 데이터 진단 — T윤도현(bf3b4305) 기준
//  1) cluster2 quote-author 이미지 소스(profile_photo_url vs sub photos)
//  2) user_review_links 현재 상태(순서 제한 검증 대상)
//  3) portfolio_channel_cards / storage 상태 (삭제 후 재업로드 500)
//  4) weekly_reputations reviewer/target + snapshot fromProfile 이미지
//  5) weekly_colleagues + colleague 프로필 조인 (legacy vs snapshot)
import { config } from "dotenv";
config({ path: ".env.local" });

const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad"; // T윤도현
const W14_ID = "286ddd42-aa7c-4df8-bcff-c7c1a9f5425e"; // 2026-spring W14

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // ── 이슈1: cluster2 사진 소스 ──
  console.log("=== [이슈1] cluster2 사진 소스 ===");
  const { data: prof } = await sb
    .from("user_profiles")
    .select("user_id, display_name, english_name, profile_photo_url, school_name, department_name, profile_tagline, profile_keyword, vision, gender, birth_date, current_team_name, current_part_name")
    .eq("user_id", UID)
    .maybeSingle();
  console.log("user_profiles:", JSON.stringify(prof, null, 2));
  const { data: c2 } = await sb
    .from("user_cluster2")
    .select("main_photo_url, sub_photo_1_url, sub_photo_2_url, sub_photo_3_url, sub_photo_4_url")
    .eq("user_id", UID)
    .maybeSingle();
  console.log("user_cluster2 photos:", JSON.stringify(c2, null, 2));

  // ── 이슈2: user_review_links 상태 ──
  console.log("\n=== [이슈2] user_review_links ===");
  const { data: links } = await sb
    .from("user_review_links")
    .select("week_index, url, is_visible, updated_at")
    .eq("user_id", UID)
    .order("week_index");
  for (const l of links ?? []) console.log(l.week_index, l.url ? l.url.slice(0, 60) : "(null)", l.is_visible);
  const { data: win } = await sb
    .from("user_edit_windows")
    .select("resource_key, opened_at, expires_at")
    .eq("user_id", UID)
    .eq("resource_key", "cluster2.review_links");
  console.log("edit_windows:", JSON.stringify(win));

  // ── 이슈3: portfolio_channel_cards ──
  console.log("\n=== [이슈3] portfolio_channel_cards ===");
  const { data: pcc, error: pccErr } = await sb
    .from("portfolio_channel_cards")
    .select("card_index, image_urls, updated_at")
    .eq("user_id", UID)
    .order("card_index");
  if (pccErr) console.log("portfolio_channel_cards 조회 오류:", pccErr.message);
  for (const c of pcc ?? []) console.log("card", c.card_index, JSON.stringify(c.image_urls)?.slice(0, 200));
  // storage 버킷 존재/객체 확인
  for (const bucket of ["portfolio-channel-images", "portfolio-top-images"]) {
    const { data: objs, error: stErr } = await sb.storage.from(bucket).list(UID, { limit: 5 });
    console.log(`storage[${bucket}]/${UID}:`, stErr ? `ERROR ${stErr.message}` : `${(objs ?? []).length}개 항목`, (objs ?? []).map((o: any) => o.name).join(", "));
  }
  const { data: buckets, error: bErr } = await sb.storage.listBuckets();
  console.log("buckets:", bErr ? bErr.message : (buckets ?? []).map((b: any) => `${b.name}(public=${b.public})`).join(", "));

  // ── 이슈4: weekly_reputations (W14, target=UID) ──
  console.log("\n=== [이슈4] weekly_reputations W14 ===");
  const { data: reps } = await sb
    .from("weekly_reputations")
    .select("id, reviewer_id, target_user_id, rating, keyword, created_at")
    .eq("target_user_id", UID)
    .eq("week_card_id", W14_ID)
    .order("created_at");
  const reviewerIds = Array.from(new Set((reps ?? []).map((r: any) => r.reviewer_id)));
  const { data: revProfs } = await sb
    .from("user_profiles")
    .select("user_id, display_name, profile_photo_url")
    .in("user_id", [...reviewerIds, UID]);
  const profById = new Map((revProfs ?? []).map((p: any) => [p.user_id, p]));
  for (const r of reps ?? []) {
    const rp: any = profById.get(r.reviewer_id);
    console.log(`rep ${r.id.slice(0, 8)} reviewer=${rp?.display_name ?? r.reviewer_id} photo=${rp?.profile_photo_url ? rp.profile_photo_url.slice(-40) : "(없음)"} rating=${r.rating}`);
  }
  const owner: any = profById.get(UID);
  console.log(`owner(본인) photo=${owner?.profile_photo_url ? owner.profile_photo_url.slice(-40) : "(없음)"}`);

  // 다른 유저(일반 모드 비교용): W14에 평판 받은 비테스터 1명 샘플
  const { data: otherReps } = await sb
    .from("weekly_reputations")
    .select("target_user_id, reviewer_id")
    .eq("week_card_id", W14_ID)
    .neq("target_user_id", UID)
    .limit(5);
  console.log("W14 다른 수신자 샘플:", JSON.stringify(otherReps?.slice(0, 5)));

  // ── 이슈5: weekly_colleagues (W14, user=UID) ──
  console.log("\n=== [이슈5] weekly_colleagues W14 ===");
  const { data: cols } = await sb
    .from("weekly_colleagues")
    .select("id, colleague_id, rank, message, created_at")
    .eq("user_id", UID)
    .eq("week_card_id", W14_ID)
    .order("rank");
  const colIds = (cols ?? []).map((c: any) => c.colleague_id);
  if (colIds.length > 0) {
    const { data: colProfs } = await sb
      .from("user_profiles")
      .select("user_id, display_name, profile_photo_url, school_name, department_name, profile_tagline, profile_keyword, vision, current_team_name, current_part_name")
      .in("user_id", colIds);
    const { data: colEdus } = await sb
      .from("user_educations")
      .select("user_id, school_name, major_name_1, sort_order")
      .in("user_id", colIds);
    const { data: colMems } = await sb
      .from("user_memberships")
      .select("user_id, team_name, part_name, membership_level, is_current")
      .in("user_id", colIds);
    for (const c of cols ?? []) {
      const p: any = (colProfs ?? []).find((x: any) => x.user_id === c.colleague_id);
      const e = (colEdus ?? []).filter((x: any) => x.user_id === c.colleague_id);
      const m = (colMems ?? []).filter((x: any) => x.user_id === c.colleague_id);
      console.log(`colleague rank=${c.rank} ${p?.display_name}`);
      console.log(`  profiles: school=${p?.school_name} dept=${p?.department_name} photo=${p?.profile_photo_url ? "있음" : "없음"} tagline=${p?.profile_tagline} keyword=${p?.profile_keyword} vision=${p?.vision} curTeam=${p?.current_team_name} curPart=${p?.current_part_name}`);
      console.log(`  educations(${e.length}):`, e.map((x: any) => `${x.school_name}/${x.major_name_1}`).join("; "));
      console.log(`  memberships(${m.length}):`, m.map((x: any) => `${x.team_name}/${x.part_name}/${x.membership_level}/cur=${x.is_current}`).join("; "));
    }
  } else {
    console.log("(W14 연계동료 행 없음)");
  }

  // user_team_parts 테이블 존재 여부 (legacy 엔드포인트 의존)
  const { error: utpErr } = await sb.from("user_team_parts").select("user_id").limit(1);
  console.log("user_team_parts 테이블:", utpErr ? `오류 → ${utpErr.message}` : "존재");
  const { error: teamsErr } = await sb.from("teams").select("id").limit(1);
  console.log("teams 테이블:", teamsErr ? `오류 → ${teamsErr.message}` : "존재");

  // ── snapshot: W14 weekly-cards DTO 의 평판/동료 ──
  console.log("\n=== snapshot cluster4_weekly_cards_snapshots ===");
  const { data: snap, error: snapErr } = await sb
    .from("cluster4_weekly_cards_snapshots")
    .select("dto_version, is_stale, computed_at, payload")
    .eq("user_id", UID)
    .maybeSingle();
  if (snapErr) console.log("snapshot 조회 오류:", snapErr.message);
  if (snap) {
    console.log("dto_version:", snap.dto_version, "is_stale:", snap.is_stale, "computed_at:", snap.computed_at);
    const cards = (snap.payload as any)?.cards ?? (Array.isArray(snap.payload) ? snap.payload : []);
    const w14 = (cards as any[]).find((c: any) => c.weekId === W14_ID || c.id === W14_ID);
    if (w14) {
      console.log("W14 weeklyReputations:", JSON.stringify((w14.weeklyReputations ?? []).map((r: any) => ({
        from: r.fromProfile?.name, fromImg: r.fromProfile?.profileImageUrl ? r.fromProfile.profileImageUrl.slice(-40) : null,
        toImg: r.toProfile?.profileImageUrl ? r.toProfile.profileImageUrl.slice(-40) : null,
      })), null, 1));
      console.log("W14 weeklyColleagues:", JSON.stringify((w14.weeklyColleagues ?? []).map((c: any) => ({
        name: c.colleagueProfile?.name, school: c.colleagueProfile?.school, dept: c.colleagueProfile?.department,
        team: c.colleagueProfile?.team, part: c.colleagueProfile?.part, img: c.colleagueProfile?.profileImageUrl ? "있음" : "없음",
        tagline: c.colleagueProfile?.profileTagline,
      })), null, 1));
    } else {
      console.log("W14 카드 미발견. cards 키 샘플:", (cards as any[]).slice(0, 3).map((c: any) => c.weekId ?? c.id));
    }
  } else {
    console.log("(snapshot 행 없음 — 테이블명 확인 필요)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
