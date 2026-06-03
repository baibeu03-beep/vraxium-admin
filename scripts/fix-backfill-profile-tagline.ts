/**
 * profile_keyword → profile_tagline 백필 + snapshot 재계산 + 검증 (승인된 1회성 작업).
 *
 *   npx tsx --env-file=.env.local scripts/fix-backfill-profile-tagline.ts
 *
 * 동등 SQL:
 *   UPDATE public.user_profiles
 *      SET profile_tagline = btrim(profile_keyword)
 *    WHERE profile_tagline IS NULL
 *      AND profile_keyword IS NOT NULL
 *      AND btrim(profile_keyword) <> '';
 *
 * supabase-js 는 컬럼→컬럼 복사를 못 하므로, 대상 row 를 읽어 값별로 묶어 UPDATE 한다
 * (profile_tagline IS NULL 가드 유지). profile_keyword 는 절대 건드리지 않는다.
 *
 * 이후: snapshot 전체 재계산(임베드 fromProfile/toProfile/colleagueProfile 가 신값 반영) →
 *       direct(fetchWeeklyPeopleByWeek) vs snapshot(=HTTP) profileTagline 일치 검증.
 */
import { createClient } from "@supabase/supabase-js";
import { recomputeWeeklyCardsSnapshotsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";
import { fetchWeeklyPeopleByWeek } from "@/lib/cluster4WeeklyPeopleData";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const TABLE = "cluster4_weekly_card_snapshots";
const short = (id: unknown) => String(id ?? "").slice(0, 8);

async function main() {
  // ── 1. 백필 ─────────────────────────────────────────────────
  console.log("══════════ 1. profile_tagline 백필 ══════════");
  const { data: targets, error: selErr } = await sb
    .from("user_profiles")
    .select("user_id,display_name,profile_keyword")
    .is("profile_tagline", null)
    .not("profile_keyword", "is", null);
  if (selErr) throw new Error("대상 조회 실패: " + selErr.message);

  const rows = (targets ?? [])
    .map((r) => ({
      user_id: (r as { user_id: string }).user_id,
      display_name: (r as { display_name: string | null }).display_name,
      val: String((r as { profile_keyword: string | null }).profile_keyword ?? "").trim(),
    }))
    .filter((r) => r.val !== "");
  console.log(`백필 대상 row(profile_tagline NULL & keyword 값있음): ${rows.length}`);

  // 값별 그룹핑 후 한 번의 UPDATE (null 가드 유지)
  const byVal = new Map<string, string[]>();
  for (const r of rows) {
    const list = byVal.get(r.val) ?? [];
    list.push(r.user_id);
    byVal.set(r.val, list);
  }
  let updated = 0;
  const failed: string[] = [];
  for (const [val, ids] of byVal) {
    const { data: upd, error: updErr } = await sb
      .from("user_profiles")
      .update({ profile_tagline: val })
      .in("user_id", ids)
      .is("profile_tagline", null) // 동시성/멱등 가드 — 이미 채워진 건 건드리지 않음
      .select("user_id");
    if (updErr) {
      console.warn(`  UPDATE 실패 val="${val}" (${ids.length}건):`, updErr.message);
      failed.push(...ids);
      continue;
    }
    updated += (upd ?? []).length;
  }
  console.log(`✅ 백필된 row 수: ${updated} (실패 ${failed.length})`);

  // 백필 검증: profile_tagline 채워진 수 / profile_keyword 보존 확인
  const { data: after } = await sb
    .from("user_profiles")
    .select("user_id,profile_keyword,profile_tagline");
  const a = (after ?? []) as { profile_keyword: string | null; profile_tagline: string | null }[];
  const tagFilled = a.filter((r) => r.profile_tagline && r.profile_tagline.trim() !== "").length;
  const kwFilled = a.filter((r) => r.profile_keyword && r.profile_keyword.trim() !== "").length;
  const mismatch = a.filter(
    (r) =>
      r.profile_keyword &&
      r.profile_keyword.trim() !== "" &&
      r.profile_tagline !== r.profile_keyword.trim(),
  ).length;
  console.log(
    `검증: profile_tagline 값보유=${tagFilled}, profile_keyword 값보유(보존)=${kwFilled}, 불일치=${mismatch}`,
  );

  // ── 2. snapshot 전체 재계산 ─────────────────────────────────
  console.log("\n══════════ 2. snapshot 재계산 ══════════");
  const { data: snapUsers } = await sb.from(TABLE).select("user_id");
  const ids = ((snapUsers ?? []) as { user_id: string }[]).map((r) => r.user_id);
  console.log(`재계산 대상 snapshot 유저: ${ids.length}명 (concurrency=5)`);
  const t0 = Date.now();
  const recRes = await recomputeWeeklyCardsSnapshotsForUsers(ids, { concurrency: 5 });
  console.log(`완료 ${Math.round((Date.now() - t0) / 1000)}s`, JSON.stringify(recRes));

  // ── 3. direct vs snapshot(=HTTP) profileTagline 검증 ─────────
  console.log("\n══════════ 3. direct vs snapshot(=HTTP) profileTagline 검증 ══════════");
  // 백필된 인물이 colleague_id 로 등장하는 카드(owner+week) 표본 추출
  const filledIds = a
    .filter((r) => r.profile_tagline && r.profile_tagline.trim() !== "")
    .map((r) => (r as { user_id: string }).user_id);
  const { data: colRows } = await sb
    .from("weekly_colleagues")
    .select("user_id,week_card_id,colleague_id")
    .in("colleague_id", filledIds.slice(0, 200))
    .limit(30);

  const taglineByUser = new Map<string, string | null>();
  for (const r of a as { user_id: string; profile_tagline: string | null }[]) {
    taglineByUser.set(r.user_id, r.profile_tagline ?? null);
  }

  const fetchStored = async (uid: string): Promise<Cluster4WeeklyCardDto[]> => {
    const { data } = await sb.from(TABLE).select("cards").eq("user_id", uid).maybeSingle();
    return Array.isArray(data?.cards) ? (data!.cards as Cluster4WeeklyCardDto[]) : [];
  };

  let checked = 0;
  let allMatch = true;
  const seen = new Set<string>();
  for (const c of (colRows ?? []) as { user_id: string; week_card_id: string; colleague_id: string }[]) {
    if (checked >= 6) break;
    const key = `${c.user_id}|${c.week_card_id}|${c.colleague_id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const ledger = taglineByUser.get(c.colleague_id) ?? null;

    // direct
    let directVal: unknown = "<미도달>";
    const map = await fetchWeeklyPeopleByWeek(c.user_id, [c.week_card_id]);
    const wp = map.get(c.week_card_id);
    const dprof = wp?.weeklyColleagues.find((x) => x.colleagueUserId === c.colleague_id)
      ?.colleagueProfile;
    if (dprof) directVal = (dprof as { profileTagline?: unknown }).profileTagline;

    // snapshot(=HTTP)
    const stored = await fetchStored(c.user_id);
    let snapVal: unknown = "<없음>";
    for (const card of stored) {
      const col = (card as { weeklyColleagues?: unknown[] }).weeklyColleagues ?? [];
      const hit = col.find(
        (x) =>
          (x as { colleagueUserId?: string }).colleagueUserId === c.colleague_id &&
          (x as { weekId?: string }).weekId === c.week_card_id,
      );
      if (hit) {
        snapVal = ((hit as { colleagueProfile?: { profileTagline?: unknown } }).colleagueProfile ?? {})
          .profileTagline;
        break;
      }
    }

    checked++;
    const match = (directVal ?? null) === (snapVal ?? null);
    if (!match) allMatch = false;
    console.log(
      `\n[owner=${short(c.user_id)} week=${short(c.week_card_id)} colleague=${short(c.colleague_id)}]`,
    );
    console.log(`  원장 profile_tagline : ${JSON.stringify(ledger)}`);
    console.log(`  DTO direct           : ${JSON.stringify(directVal)}`);
    console.log(`  snapshot(=HTTP)      : ${JSON.stringify(snapVal)}`);
    console.log(`  direct==snapshot?    : ${match}`);
  }
  if (checked === 0) {
    console.log("colleague 표본 없음 — reputation 경로로 대체 검증 필요.");
  } else {
    console.log(
      `\n검증 결과: 표본 ${checked}건 direct==snapshot(=HTTP) ${allMatch ? "전부 일치 ✅" : "불일치 발생 ⚠"}`,
    );
  }

  console.log("\n══ 완료 (profile_keyword 보존, profile_tagline 백필 + snapshot 재계산) ══");
}

main().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});
