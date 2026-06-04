/**
 * READ-ONLY PREVIEW: 테스터 실무경험 success 백필 v13 — 마스터 카탈로그 기반 주차별 개설 플랜.
 * 식별자: tester-experience-success-backfill-v13-20260604
 *
 *   npx tsx --env-file=.env.local scripts/preview-tester-exp-success-backfill.ts
 *
 * 플랜 규칙 (2026-06-04 합의):
 *   - 대상: test_user_markers 90명만 (실유저 절대 비포함)
 *   - 후보 주차: weeks.end_date < 오늘 AND result_published_at IS NOT NULL
 *               AND is_official_rest=false AND start_date < 2026-05-04(실유저 카드 범위 보호)
 *               → running/tallying/current/future/공식휴식 자동 제외
 *   - 테스터별 주차 선택: 본인 uws status='fail' 행 ∩ 후보 주차에서
 *               N = min(가용 수, seededRandInt(3..18)) 개를 시드 셔플로 선택
 *               (personal_rest/official_rest 행은 후보로 쓰지 않음 — 휴식 의미 보존)
 *   - 라인 인스턴스: (org × slot1/2/3 × 주차) 단위로 cluster4_experience_line_masters에서 생성
 *               (마스터 콘텐츠 그대로, 마감=그 주차 수요일 → verdict-pass 가능)
 *   - 타깃: 선택된 (tester, week)마다 그 org의 slot1/2/3 라인 3개에 user-mode 배정
 *   - 중복 방지: (tester, week)에 기존 experience 타깃 있으면 skip / 라인은 주차별 신규라 tester+line 중복 없음
 *   - uws 보정: 선택 (tester, week)의 fail 행만 success 로 UPDATE (가드 .eq status='fail')
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export const MARKER = "tester-experience-success-backfill-v13-20260604";
export const REALUSER_GUARD_DATE = "2026-05-04"; // 실유저 최초 활동주차 — 이 이전 주차만 사용
export const TODAY = "2026-06-04";

// ── 시드 RNG (md5 없이 단순 해시 + mulberry32) — 재실행해도 동일 플랜 ──
function hashStr(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type ExpPlan = {
  testers: Map<string, { name: string; org: string }>;
  candidateWeeks: { weekId: string; start: string }[];
  // org → slot → master {id, line_code, default_main_title}
  masterByOrgSlot: Map<string, { id: string; line_code: string; title: string }>;
  // (org|weekStart) → 생성할 라인 3종 (slot1/2/3)
  linePlan: Map<string, { org: string; weekId: string; weekStart: string; slots: number[] }>;
  // tester → 선택 주차 start[]
  selection: Map<string, string[]>;
  dedupSkipped: { userId: string; weekStart: string }[];
  totalLines: number;
  totalTargets: number;
  totalUwsUpdates: number;
};

export async function buildExpPlan(opts: { onlyUserId?: string } = {}): Promise<ExpPlan> {
  // 1) 테스터 + org
  const { data: mk } = await sb.from("test_user_markers").select("user_id");
  const testerIds = (mk ?? []).map((m: any) => m.user_id as string);
  const { data: profs } = await sb
    .from("user_profiles")
    .select("user_id, display_name, organization_slug")
    .in("user_id", testerIds);
  const testers = new Map<string, { name: string; org: string }>();
  for (const p of (profs ?? []) as any[]) {
    if (!p.organization_slug) continue; // org 미상 테스터는 라인 org 매칭 불가 → 제외
    testers.set(p.user_id, { name: p.display_name, org: p.organization_slug });
  }

  // 2) 후보 주차
  const { data: weeks } = await sb
    .from("weeks")
    .select("id, start_date, end_date, is_official_rest, result_published_at")
    .lt("end_date", TODAY)
    .lt("start_date", REALUSER_GUARD_DATE)
    .eq("is_official_rest", false)
    .not("result_published_at", "is", null)
    .order("start_date");
  const candidateWeeks = ((weeks ?? []) as any[]).map((w) => ({
    weekId: w.id as string,
    start: w.start_date as string,
  }));
  const weekIdByStart = new Map(candidateWeeks.map((w) => [w.start, w.weekId]));
  const candidateStartSet = new Set(candidateWeeks.map((w) => w.start));

  // 3) 마스터 카탈로그 (org × slot1/2/3, line_code 오름차순 첫 번째)
  const { data: masters } = await sb
    .from("cluster4_experience_line_masters")
    .select("id, line_code, default_main_title, organization_slug, experience_slot_order, is_active")
    .eq("is_active", true)
    .in("experience_slot_order", [1, 2, 3]);
  const masterByOrgSlot = new Map<string, { id: string; line_code: string; title: string }>();
  for (const m of ((masters ?? []) as any[]).sort((a, b) =>
    String(a.line_code).localeCompare(String(b.line_code)),
  )) {
    const k = `${m.organization_slug}:${m.experience_slot_order}`;
    if (!masterByOrgSlot.has(k)) {
      masterByOrgSlot.set(k, { id: m.id, line_code: m.line_code, title: m.default_main_title });
    }
  }

  // 4) 테스터별 후보 fail 주차 + 기존 experience 타깃 (tester,week) dedup 셋
  const { data: expLines } = await sb
    .from("cluster4_lines")
    .select("id")
    .eq("part_type", "experience");
  const expLineIds = ((expLines ?? []) as any[]).map((l) => l.id);
  const existingPairs = new Set<string>();
  if (expLineIds.length > 0) {
    const { data: existing } = await sb
      .from("cluster4_line_targets")
      .select("week_id, target_user_id")
      .eq("target_mode", "user")
      .in("line_id", expLineIds);
    for (const e of (existing ?? []) as any[]) {
      if (e.target_user_id) existingPairs.add(`${e.target_user_id}|${e.week_id}`);
    }
  }

  const ids = opts.onlyUserId ? [opts.onlyUserId] : [...testers.keys()];
  const selection = new Map<string, string[]>();
  const dedupSkipped: ExpPlan["dedupSkipped"] = [];
  for (let i = 0; i < ids.length; i += 30) {
    const batch = ids.slice(i, i + 30);
    const { data: ws } = await sb
      .from("user_week_statuses")
      .select("user_id, week_start_date, status")
      .in("user_id", batch)
      .eq("status", "fail");
    const byUser = new Map<string, string[]>();
    for (const r of (ws ?? []) as any[]) {
      if (!candidateStartSet.has(r.week_start_date)) continue;
      const arr = byUser.get(r.user_id) ?? [];
      arr.push(r.week_start_date);
      byUser.set(r.user_id, arr);
    }
    for (const uid of batch) {
      if (!testers.has(uid)) continue;
      let avail = (byUser.get(uid) ?? []).sort();
      // (tester, week) 기존 experience 타깃 dedup
      avail = avail.filter((wsd) => {
        const wid = weekIdByStart.get(wsd)!;
        if (existingPairs.has(`${uid}|${wid}`)) {
          dedupSkipped.push({ userId: uid, weekStart: wsd });
          return false;
        }
        return true;
      });
      if (avail.length === 0) continue;
      const rng = mulberry32(hashStr(MARKER + uid));
      const want = 3 + Math.floor(rng() * 16); // 3..18
      const n = Math.min(avail.length, want);
      // 시드 셔플
      const shuffled = [...avail];
      for (let j = shuffled.length - 1; j > 0; j--) {
        const k = Math.floor(rng() * (j + 1));
        [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
      }
      selection.set(uid, shuffled.slice(0, n).sort());
    }
  }

  // 5) 라인 플랜: (org × 선택 주차) → slot1/2/3
  const linePlan: ExpPlan["linePlan"] = new Map();
  for (const [uid, weeksSel] of selection) {
    const org = testers.get(uid)!.org;
    for (const wsd of weeksSel) {
      const key = `${org}|${wsd}`;
      if (!linePlan.has(key)) {
        linePlan.set(key, {
          org,
          weekId: weekIdByStart.get(wsd)!,
          weekStart: wsd,
          slots: [1, 2, 3],
        });
      }
    }
  }

  const totalUwsUpdates = [...selection.values()].reduce((n, v) => n + v.length, 0);
  return {
    testers,
    candidateWeeks,
    masterByOrgSlot,
    linePlan,
    selection,
    dedupSkipped,
    totalLines: linePlan.size * 3,
    totalTargets: totalUwsUpdates * 3,
    totalUwsUpdates,
  };
}

async function main() {
  const plan = await buildExpPlan();
  console.log("══════ PREVIEW: tester-experience-success-backfill-v13-20260604 ══════");
  console.log("대상 테스터 수:", plan.selection.size, `(풀 ${plan.testers.size}명 중 가용 fail 주차 보유자)`);
  console.log("후보 주차 수:", plan.candidateWeeks.length, `(종료+공표+비휴식+<${REALUSER_GUARD_DATE})`);
  console.log("생성 예정 cluster4_lines:", plan.totalLines, `(org×주차 ${plan.linePlan.size} × slot 3)`);
  console.log("생성 예정 cluster4_line_targets:", plan.totalTargets, "(선택 주차 × slot 3)");
  console.log("uws success 보정 예정:", plan.totalUwsUpdates, "row (fail → success)");
  console.log("중복 제외(기존 experience 타깃 보유 주차):", plan.dedupSkipped.length);
  console.log("실사용자 포함 여부: 0건 (test_user_markers 한정 + 주차 <", REALUSER_GUARD_DATE, ")");

  // org×slot 마스터 매핑
  console.log("\n사용 마스터 (org:slot → line_code):");
  for (const [k, m] of [...plan.masterByOrgSlot.entries()].sort()) {
    console.log(`  ${k} → ${m.line_code}`);
  }

  // 테스터별 배정 주차 수 분포
  const dist = new Map<number, number>();
  for (const v of plan.selection.values()) dist.set(v.length, (dist.get(v.length) ?? 0) + 1);
  console.log("\n테스터별 배정 주차 수 분포 (주차수→명):",
    JSON.stringify(Object.fromEntries([...dist.entries()].sort((a, b) => a[0] - b[0]))));
  const counts = [...plan.selection.values()].map((v) => v.length).sort((a, b) => a - b);
  console.log("min/median/max:", counts[0], counts[Math.floor(counts.length / 2)], counts[counts.length - 1]);

  // org×주차 라인 분포
  const orgWeeks = new Map<string, number>();
  for (const { org } of plan.linePlan.values()) orgWeeks.set(org, (orgWeeks.get(org) ?? 0) + 1);
  console.log("org별 개설 주차 수:", JSON.stringify(Object.fromEntries(orgWeeks)));
}

if (process.argv[1] && process.argv[1].includes("preview-tester-exp-success-backfill")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
