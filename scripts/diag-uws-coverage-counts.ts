import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";
import { acquireScriptLock } from "./_lib/scriptLock";

const ACTIVITY_STARTS = [
  "2026-03-02","2026-03-09","2026-03-16","2026-03-23","2026-03-30",
  "2026-04-27","2026-05-04","2026-05-11","2026-05-18","2026-05-25",
];

async function main() {
  // DB 포화 방지 — 다른 diag/verify 스크립트와 동시 실행 차단(공유 락).
  const lock = await acquireScriptLock("diag-uws-coverage-counts");
  try {
  const testIds = await fetchTestUserMarkerIds();
  const { data: profs } = await supabaseAdmin.from("user_profiles").select("user_id, growth_status");
  const ops = (profs ?? []).filter((p: any) => !testIds.has(p.user_id)) as any[];

  // 전체 운영 유저 uws 커버리지(정확 컬럼)
  const total = new Map<string, number>();
  const actCov = new Map<string, number>();
  const ids = ops.map((p) => p.user_id);
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const { data } = await supabaseAdmin.from("user_week_statuses")
      .select("user_id, week_start_date").in("user_id", chunk);
    for (const r of (data ?? []) as any[]) {
      total.set(r.user_id, (total.get(r.user_id) ?? 0) + 1);
      if (ACTIVITY_STARTS.includes(r.week_start_date)) actCov.set(r.user_id, (actCov.get(r.user_id) ?? 0) + 1);
    }
  }

  const bucket = (list: any[]) => {
    let zero = 0, full = 0, partial = 0;
    for (const p of list) {
      const c = actCov.get(p.user_id) ?? 0;
      const t = total.get(p.user_id) ?? 0;
      if (t === 0) zero++;
      else if (c === 10) full++;
      else partial++; // c 0~9 but has some uws elsewhere
    }
    return { n: list.length, zero, full, partial };
  };

  for (const g of ["active", "seasonal_rest", "paused", "graduated", "suspended"]) {
    const list = ops.filter((p) => p.growth_status === g);
    const b = bucket(list);
    console.log(`${g.padEnd(14)} n=${b.n}  uws0행=${b.zero}  활동10/10=${b.full}  그외(부분/타시즌만)=${b.partial}`);
  }
  const nullg = ops.filter((p) => !p.growth_status);
  const bn = bucket(nullg);
  console.log(`(null)        n=${bn.n}  uws0행=${bn.zero}  활동10/10=${bn.full}  그외=${bn.partial}`);

  // 활동주차(10주) 중 카드 누락이 생기는 운영유저(uws>0 이면서 활동커버<10) 총수
  const partialActive = ops.filter((p) => (total.get(p.user_id) ?? 0) > 0 && (actCov.get(p.user_id) ?? 0) < 10);
  const zeroAll = ops.filter((p) => (total.get(p.user_id) ?? 0) === 0);
  console.log(`\n운영 전체 ${ops.length}명 중: uws완전0=${zeroAll.length}, uws있으나 2026-spring 활동주차 일부+누락=${partialActive.length}`);
  } finally {
    lock.release();
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
