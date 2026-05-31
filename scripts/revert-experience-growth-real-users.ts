/**
 * 실사용자 오적용 원복 (2026-05-30) — 읽기 분류 + 실사용자 fail→success 복구.
 *
 *   npx tsx --env-file=.env.local scripts/revert-experience-growth-real-users.ts          (조회만)
 *   npx tsx --env-file=.env.local scripts/revert-experience-growth-real-users.ts --apply  (원복 실행)
 *
 * 대상: 오늘 sync 로 success→fail 된 행(status='fail' AND updated_at>=오늘).
 *   - 테스트 사용자(display_name ILIKE '%T%') → 유지
 *   - 실사용자(NOT ILIKE '%T%')              → success 로 원복 (--apply 시)
 * rest 는 status='fail' 필터로 자연 제외. 성장 실패 정책/판정 로직은 변경하지 않음.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const APPLY = process.argv.includes("--apply");

type Row = {
  user_id: string;
  year: number;
  week_number: number;
  status: string;
  updated_at: string | null;
};

function isTestName(name: string | null): boolean {
  // display_name ILIKE '%T%' 와 동일 (대소문자 무시)
  return !!name && name.toLowerCase().includes("t");
}

async function main() {
  const cutoff = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  console.log(`모드: ${APPLY ? "APPLY(원복 실행)" : "DRY-RUN(조회만)"}  | cutoff updated_at >= ${cutoff}\n`);

  const { data: failData, error } = await sb
    .from("user_week_statuses")
    .select("user_id,year,week_number,status,updated_at")
    .eq("status", "fail")
    .gte("updated_at", cutoff);
  if (error) {
    console.error("조회 실패:", error.message);
    process.exit(1);
  }
  const flipped = (failData ?? []) as Row[];

  const userIds = [...new Set(flipped.map((r) => r.user_id))];
  const nameById = new Map<string, { name: string | null; org: string | null }>();
  if (userIds.length > 0) {
    const { data: profiles } = await sb
      .from("user_profiles")
      .select("user_id,display_name,organization_slug")
      .in("user_id", userIds);
    for (const p of (profiles ?? []) as {
      user_id: string;
      display_name: string | null;
      organization_slug: string | null;
    }[]) {
      nameById.set(p.user_id, { name: p.display_name, org: p.organization_slug });
    }
  }

  const testRows: Row[] = [];
  const realRows: Row[] = [];
  for (const r of flipped) {
    const prof = nameById.get(r.user_id);
    (isTestName(prof?.name ?? null) ? testRows : realRows).push(r);
  }

  const fmt = (rows: Row[]) =>
    rows.map((r) => {
      const p = nameById.get(r.user_id);
      return `  ${p?.name ?? "?"} | ${p?.org ?? "-"} | ${r.year}/${r.week_number} | ${r.user_id.slice(0, 8)}`;
    });

  console.log(`■ 테스트 사용자 (유지) — ${testRows.length}건`);
  console.log(fmt(testRows).join("\n") || "  (없음)");
  console.log(`\n■ 실사용자 (원복 대상) — ${realRows.length}건`);
  console.log(fmt(realRows).join("\n") || "  (없음)");

  if (!APPLY) {
    console.log("\n※ DRY-RUN: --apply 를 붙이면 실사용자 건을 success 로 원복합니다.");
    return;
  }

  console.log("\n──────── 원복 실행 (실사용자 fail → success) ────────");
  let reverted = 0;
  for (const r of realRows) {
    const { data: upd, error: updErr } = await sb
      .from("user_week_statuses")
      .update({ status: "success", updated_at: new Date().toISOString() })
      .eq("user_id", r.user_id)
      .eq("year", r.year)
      .eq("week_number", r.week_number)
      .eq("status", "fail") // 현재 fail 만 복구 (rest/이미 success 보호 + 멱등)
      .select("year,week_number");
    if (!updErr && upd && upd.length > 0) reverted++;
    else if (updErr) console.error(`  ❌ ${r.user_id.slice(0, 8)} ${r.year}/${r.week_number}:`, updErr.message);
  }
  console.log(`원복 완료: 실사용자 ${reverted}건 success 복구`);

  // 검증: 동일 조건 실사용자 fail 잔존 0건
  const { data: after } = await sb
    .from("user_week_statuses")
    .select("user_id,status,updated_at")
    .eq("status", "fail")
    .gte("updated_at", cutoff);
  const afterReal = ((after ?? []) as { user_id: string }[]).filter((r) => {
    const p = nameById.get(r.user_id);
    return !isTestName(p?.name ?? null);
  });
  console.log(`검증: 실사용자 잔존 fail(오늘) = ${afterReal.length}건 ${afterReal.length === 0 ? "✅" : "❌"}`);
  console.log(`검증: 테스트 사용자 fail 유지 = ${testRows.length}건 (원복 대상 아님)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
