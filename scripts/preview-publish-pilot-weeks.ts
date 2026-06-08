/**
 * Pilot 5명 — 미공표 이관 주차 소급 공표 preview (read-only · write 0).
 *   npx tsx --env-file=.env.local scripts/preview-publish-pilot-weeks.ts
 *
 * 정책: 소급 공표값 = 주차 종료 직후(end_date+1일 00:00Z) — 기존 백필(05-25·06-01)과 동일.
 */
import { readFileSync, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);
const OUT = "claudedocs/preview-publish-pilot-weeks-20260607.json";

const PILOT = [
  { p: "P1", src: "oranke", uid: 1092, name: "장승완" },
  { p: "P2", src: "hrdb", uid: 1463, name: "안은비" },
  { p: "P3", src: "olympus", uid: 249, name: "성채윤" },
  { p: "P4", src: "olympus", uid: 248, name: "박시은" },
  { p: "P5", src: "olympus", uid: 251, name: "정혜빈" },
];
const addDays = (iso: string, d: number) => {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + d);
  return t.toISOString().slice(0, 10);
};

async function main() {
  // pilot uuid
  const uuids = new Map<string, { p: string; name: string }>();
  for (const t of PILOT) {
    const { data } = await sb.from("users").select("id").eq("source_system", t.src).eq("legacy_user_id", t.uid).maybeSingle();
    uuids.set((data as any).id, { p: t.p, name: t.name });
  }
  const ids = [...uuids.keys()];

  // pilot uws 주차 전수
  const uwsByUser = new Map<string, Array<{ week_start_date: string; status: string }>>();
  for (const id of ids) {
    const { data } = await sb.from("user_week_statuses").select("week_start_date,status").eq("user_id", id).order("week_start_date").range(0, 999);
    uwsByUser.set(id, (data ?? []) as any[]);
  }
  const allStarts = [...new Set([...uwsByUser.values()].flat().map((r) => r.week_start_date))].sort();

  // weeks 메타 + 미공표 필터
  const { data: wk } = await sb
    .from("weeks")
    .select("id,season_key,week_number,start_date,end_date,result_published_at")
    .in("start_date", allStarts)
    .order("start_date")
    .range(0, 999);
  // 대상 정제: 미공표 ∧ 과거 확정 시즌(2025-*) — 이관(B7·summer-restore) 생성 구간만.
  //   2026-spring W13 등 "현 운영 공표 사이클이 아직 안 돈 최근 주차"는 운영 publish-result
  //   플로우의 몫이라 소급 대상에서 제외 (테스터 75명·실사용자 다수 보유 — 침범 금지).
  const target = ((wk ?? []) as any[]).filter(
    (w) => w.result_published_at == null && String(w.season_key).startsWith("2025-"),
  );
  const excluded = ((wk ?? []) as any[]).filter(
    (w) => w.result_published_at == null && !String(w.season_key).startsWith("2025-"),
  );

  // affected users (전 사용자 기준 — pilot 외 영향 검출)
  const rows: any[] = [];
  const affectedAll = new Set<string>();
  const nonPilotAffected = new Set<string>();
  const { data: markers } = await sb.from("test_user_markers").select("user_id").range(0, 4999);
  const testerSet = new Set(((markers ?? []) as any[]).map((m) => m.user_id));
  let testersAffected = 0;
  for (const w of target) {
    const { data: holders } = await sb.from("user_week_statuses").select("user_id").eq("week_start_date", w.start_date).range(0, 4999);
    const users = ((holders ?? []) as any[]).map((h) => h.user_id);
    for (const u of users) {
      affectedAll.add(u);
      if (!uuids.has(u)) nonPilotAffected.add(u);
      if (testerSet.has(u)) testersAffected++;
    }
    rows.push({
      week_id: w.id,
      season_key: w.season_key,
      week_number: w.week_number,
      start_date: w.start_date,
      end_date: w.end_date,
      current_result_published_at: null,
      planned_result_published_at: `${addDays(w.end_date, 1)}T00:00:00Z`,
      affected_users: users.map((u) => (uuids.get(u) ? `${uuids.get(u)!.p} ${uuids.get(u)!.name}` : u.slice(0, 8) + "…(비대상!)")),
    });
  }

  // 장승완 expected 누적 시뮬: published 가정 시 success 카드 수 (FLIP 주차는 cm=false → 강등 없음)
  const p1 = ids.find((i) => uuids.get(i)!.p === "P1")!;
  const p1Uws = uwsByUser.get(p1)!;
  const targetStarts = new Set(target.map((w: any) => w.start_date));
  const { data: p1Weeks } = await sb.from("weeks").select("start_date,result_published_at").in("start_date", p1Uws.map((r) => r.week_start_date)).range(0, 999);
  const pubMap = new Map(((p1Weeks ?? []) as any[]).map((w) => [w.start_date, w.result_published_at != null]));
  const nowSuccess = p1Uws.filter((r) => r.status === "success" && pubMap.get(r.week_start_date)).length;
  const afterSuccess = p1Uws.filter((r) => r.status === "success" && (pubMap.get(r.week_start_date) || targetStarts.has(r.week_start_date))).length;

  // 사용자별 미공표 보유 수 + snapshot 재계산 대상
  const perUser = ids.map((id) => ({
    pilot: `${uuids.get(id)!.p} ${uuids.get(id)!.name}`,
    unpublishedWeeks: uwsByUser.get(id)!.filter((r) => targetStarts.has(r.week_start_date)).length,
  }));

  const report = {
    generatedAt: "2026-06-07 pilot 미공표 주차 소급 공표 preview (read-only)",
    excludedOperationalWeeks: excluded.map((w: any) => `${w.season_key} W${w.week_number} (${w.start_date}) — 운영 공표 사이클 몫·소급 제외`),
    policy: "planned = end_date+1일 00:00Z (기존 05-25·06-01 백필과 동일 소급 규칙)",
    targetWeeks: rows.length,
    weekIds: rows.map((r) => r.week_id),
    rows,
    affected: {
      total: affectedAll.size,
      pilot: [...affectedAll].filter((u) => uuids.has(u)).map((u) => `${uuids.get(u)!.p} ${uuids.get(u)!.name}`),
      nonPilot: [...nonPilotAffected],
      testers: testersAffected,
    },
    p1Simulation: { successPublishedNow: nowSuccess, successPublishedAfter: afterSuccess },
    perUser,
    snapshotRecomputeTargets: [...affectedAll].length,
  };
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(`공표 대상 주차: ${rows.length}`);
  for (const r of rows)
    console.log(` ${r.season_key.padEnd(12)} W${String(r.week_number).padEnd(3)} ${r.start_date}~${r.end_date} | NULL → ${r.planned_result_published_at} | ${r.affected_users.join(", ")}`);
  console.log(`affected 합계 ${affectedAll.size} (pilot ${affectedAll.size - nonPilotAffected.size} · 비대상 ${nonPilotAffected.size} · 테스터 ${testersAffected})`);
  console.log("사용자별 미공표:", perUser.map((p) => `${p.pilot}=${p.unpublishedWeeks}`).join(" · "));
  console.log(`P1 장승완 누적 시뮬: 현재 ${nowSuccess} → 공표 후 ${afterSuccess}`);
  console.log("→", OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
