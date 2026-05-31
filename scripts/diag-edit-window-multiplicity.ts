/**
 * user_edit_windows 다중 row 진단 + 프론트 수정 쿼리 검증 (2026-05-31).
 *   npx tsx --env-file=.env.local scripts/diag-edit-window-multiplicity.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const RESOURCE = "cluster4.weekly_reviews";

async function main() {
  const { data, error } = await sb
    .from("user_edit_windows")
    .select("user_id, resource_key, week_id, opened_at, expires_at")
    .eq("resource_key", RESOURCE)
    .order("user_id", { ascending: true });
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  console.log(`${RESOURCE} 전체 row 수: ${rows.length}\n`);

  const byUser = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byUser.get(r.user_id as string) ?? [];
    list.push(r);
    byUser.set(r.user_id as string, list);
  }

  for (const [userId, list] of byUser) {
    console.log(`user=${userId}  rows=${list.length}`);
    for (const r of list) {
      console.log(`    week_id=${r.week_id ?? "NULL(global)"}  opened=${r.opened_at}`);
    }

    // (구) 프론트 쿼리: week_id 필터 없음 → 다중 row 시 maybeSingle() 에러 재현
    const old = await sb
      .from("user_edit_windows")
      .select("opened_at, expires_at")
      .eq("user_id", userId)
      .eq("resource_key", RESOURCE)
      .maybeSingle();
    console.log(`    [OLD] week_id 필터 없음 → ${old.error ? `ERROR: ${old.error.message}` : "OK(1행)"}`);

    // (신) 프론트 쿼리: 각 주차 row 를 week_id 로 콕 집음 → 항상 ≤1행
    const weekIds = list.map((r) => r.week_id).filter((w): w is string => !!w);
    for (const w of weekIds) {
      const neu = await sb
        .from("user_edit_windows")
        .select("opened_at, expires_at")
        .eq("user_id", userId)
        .eq("resource_key", RESOURCE)
        .eq("week_id", w)
        .maybeSingle();
      console.log(`    [NEW] week_id=${w} → ${neu.error ? `ERROR: ${neu.error.message}` : `OK(${neu.data ? "1행" : "0행"})`}`);
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
