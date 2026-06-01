/**
 * READ-ONLY 진단: career 라인이 weekly-cards snapshot/DTO 에 반영되는지 실데이터로 확인.
 *
 *   npx tsx --env-file=.env.local scripts/diag-career-snapshot.ts [profileUserId] [weekId]
 *
 * 인자 없으면 가장 최근 active career 라인 + 그 target 으로 (profileUserId, weekId) 자동 발견.
 * 변경 없음 — snapshot 강제 재계산은 별도 backfill 스크립트로 수행한다.
 */
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, key);

function j(label: string, v: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(v, null, 2));
}

async function discoverTarget(): Promise<{ userId: string; weekId: string } | null> {
  // 가장 최근 생성된 active career 라인.
  const { data: lines, error: lineErr } = await sb
    .from("cluster4_lines")
    .select("id,created_at")
    .eq("part_type", "career")
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(5);
  if (lineErr) { console.error("line discover err", lineErr.message); return null; }
  const lineIds = (lines ?? []).map((l: any) => l.id);
  if (lineIds.length === 0) { console.log("active career 라인 없음"); return null; }

  const { data: tgts, error: tErr } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id,week_id,line_id,target_mode,created_at")
    .in("line_id", lineIds)
    .eq("target_mode", "user")
    .order("created_at", { ascending: false })
    .limit(1);
  if (tErr) { console.error("target discover err", tErr.message); return null; }
  const t = (tgts ?? [])[0] as any;
  if (!t) { console.log("career user-mode target 없음"); return null; }
  return { userId: t.target_user_id, weekId: t.week_id };
}

async function main() {
  let userId = process.argv[2]?.trim();
  let weekId = process.argv[3]?.trim();

  if (!userId) {
    const found = await discoverTarget();
    if (!found) { console.log("자동 발견 실패 — profileUserId 를 인자로 주세요"); return; }
    userId = found.userId;
    weekId = found.weekId;
    console.log(`[auto-discovered] profileUserId=${userId} weekId=${weekId}`);
  }

  // ── STEP 5 (먼저): DB target/line/project 매칭 ──
  const { data: careerLines } = await sb
    .from("cluster4_lines")
    .select("id,part_type,is_active,line_code,career_project_id,main_title,created_at")
    .eq("part_type", "career")
    .eq("is_active", true)
    .order("created_at", { ascending: false });
  const careerLineIds = (careerLines ?? []).map((l: any) => l.id);

  const { data: tgtRows } = await sb
    .from("cluster4_line_targets")
    .select("id,line_id,week_id,target_mode,target_user_id")
    .eq("target_user_id", userId)
    .in("line_id", careerLineIds.length ? careerLineIds : ["00000000-0000-0000-0000-000000000000"]);

  const matchThisWeek = (tgtRows ?? []).filter((r: any) => r.week_id === weekId);
  j("STEP5 career active lines (latest 10)", (careerLines ?? []).slice(0, 10));
  j("STEP5 career targets for this user", tgtRows);
  j("STEP5 career targets matching weekId", matchThisWeek);

  // project 연결 확인
  const projIds = Array.from(new Set((careerLines ?? []).map((l: any) => l.career_project_id).filter(Boolean)));
  if (projIds.length) {
    const { data: projs } = await sb
      .from("career_projects")
      .select("id,line_code,line_name")
      .in("id", projIds as string[]);
    j("STEP5 career_projects", projs);
  }

  // ── STEP 2: snapshot row 상태 ──
  const { data: snap, error: snapErr } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,is_stale,dto_version,card_count,computed_at,updated_at,cards")
    .eq("user_id", userId)
    .maybeSingle();
  if (snapErr) {
    j("STEP2 snapshot row", { error: snapErr.message });
  } else if (!snap) {
    j("STEP2 snapshot row", { exists: false });
  } else {
    const s = snap as any;
    const cards = Array.isArray(s.cards) ? s.cards : [];
    const weekCard = cards.find((c: any) => c.weekId === weekId);
    const careerLineInSnap = weekCard?.lines?.find((l: any) => l.partType === "career") ?? null;
    j("STEP2 snapshot meta", {
      exists: true,
      is_stale: s.is_stale,
      dto_version: s.dto_version,
      card_count: s.card_count,
      computed_at: s.computed_at,
      updated_at: s.updated_at,
      weekCardFound: Boolean(weekCard),
    });
    j("STEP2 snapshot career line (for weekId)", careerLineInSnap);
  }

  // ── recompute 없이 "fresh DTO" 를 직접 계산해 비교 (snapshot 미반영분 노출) ──
  const fresh = await getCluster4WeeklyCardsForProfileUser(userId);
  const freshWeek = fresh.find((c: any) => c.weekId === weekId) ?? null;
  const freshCareer = freshWeek?.lines?.find((l: any) => l.partType === "career") ?? null;
  j("FRESH compute: weekIds present", fresh.map((c: any) => ({ weekId: c.weekId, weekNumber: c.weekNumber })));
  j("FRESH compute: career line (for weekId)", freshCareer);
}

main().catch((e) => { console.error("fatal", e); process.exit(1); });
