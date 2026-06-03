/**
 * BACKFILL: active crew 전체에 대해 "현재 활성 시즌"의 user_season_histories 누락 row 를 생성.
 *
 * 배경:
 *   cluster-4-1 타 크루 시즌 평판 저장은 peer_review.season_history_id (FK → user_season_histories.id)
 *   를 필요로 한다. 그런데 일부 active 크루는 user_season_histories row 가 아예 없어서
 *   /api/profile 의 seasonHistories 가 [] 로 내려가고, 저장 대상 UUID 를 못 찾아 실패한다.
 *   → 활성 시즌(seasons, uuid) 기준으로 누락 row 를 rating/review=null 로 채운다.
 *
 * 멱등: (user_id, season_id) 가 이미 있으면 건너뛴다. 재실행해도 중복 INSERT 없음.
 *
 *   적용:   npx tsx --env-file=.env.local scripts/fix-backfill-season-histories.ts
 *   드라이런: npx tsx --env-file=.env.local scripts/fix-backfill-season-histories.ts --dry
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const DRY = process.argv.includes("--dry");

type SeasonRow = { id: string; name: string | null; started_at: string | null; ended_at: string | null };

async function main() {
  const nowIso = new Date().toISOString();

  // 1) 현재 활성 시즌 (seasons.uuid). started_at <= now <= ended_at.
  const { data: seasons, error: sErr } = await admin
    .from("seasons")
    .select("id, name, started_at, ended_at")
    .order("started_at", { ascending: true });
  if (sErr) throw sErr;
  const activeSeasons = (seasons ?? []).filter(
    (s: SeasonRow) =>
      (!s.started_at || s.started_at <= nowIso) &&
      (!s.ended_at || s.ended_at >= nowIso),
  ) as SeasonRow[];

  console.log(`[seasons] 전체 ${seasons?.length ?? 0} / 활성 ${activeSeasons.length}`);
  for (const s of activeSeasons) console.log(`  활성 시즌: ${s.id} (${s.name})`);
  if (activeSeasons.length === 0) {
    console.log("활성 시즌 없음 — backfill 중단.");
    return;
  }

  // 2) active 크루 user_id 전체 (user_profiles.status='active').
  const { data: profiles, error: pErr } = await admin
    .from("user_profiles")
    .select("user_id, status")
    .eq("status", "active");
  if (pErr) throw pErr;
  const activeUserIds = (profiles ?? []).map((p: { user_id: string }) => p.user_id);
  console.log(`[crews] active 크루 = ${activeUserIds.length}명`);

  let totalInserted = 0;
  for (const season of activeSeasons) {
    // 3) 이 시즌에 이미 row 가 있는 user_id 집합.
    const { data: existing, error: eErr } = await admin
      .from("user_season_histories")
      .select("user_id")
      .eq("season_id", season.id);
    if (eErr) throw eErr;
    const have = new Set((existing ?? []).map((r: { user_id: string }) => r.user_id));

    // 4) 누락 = active 크루 - 이미 보유.
    const missing = activeUserIds.filter((uid) => !have.has(uid));
    console.log(
      `\n[${season.name}] 기존 row ${have.size} / active 크루 ${activeUserIds.length} → 누락 ${missing.length}`,
    );
    if (missing.length === 0) continue;

    if (DRY) {
      console.log(`  (--dry) ${missing.length}건 INSERT 예정 — 실제 쓰기 없음.`);
      console.log(`  예시 user_id: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " ..." : ""}`);
      continue;
    }

    // 5) 배치 INSERT (rating/review=null).
    const rows = missing.map((uid) => ({
      user_id: uid,
      season_id: season.id,
      rating: null,
      review: null,
    }));
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const { data: inserted, error: iErr } = await admin
        .from("user_season_histories")
        .insert(chunk)
        .select("id");
      if (iErr) {
        console.error(`  ❌ INSERT 실패 (batch ${i / BATCH})`, iErr.message);
        throw iErr;
      }
      totalInserted += inserted?.length ?? 0;
      console.log(`  ✅ batch ${i / BATCH}: ${inserted?.length ?? 0}건 INSERT`);
    }
  }

  console.log(`\n[done] 총 INSERT = ${totalInserted}건 (dry=${DRY})`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
