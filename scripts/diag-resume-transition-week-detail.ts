// 전환 주차(2026-02-23) 집중 진단 — 26겨울 누락/0주 증상의 데이터 원인 분리.
// ① 시즌누락 테스터(전환행만 보유)의 전체 uws 타임라인 + updated_at(v11 flip 흔적)
// ② record 는 있는데 approvedWeeks=0 이면서 전환 success 만 있는 사용자(증상 B 후보)
// ③ 26-winter 비전환 행의 status 분포 (flip 영향 범위)
import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { isTransitionWeekStart } = await import("../lib/seasonCalendar");

  type Uws = {
    user_id: string;
    season_key: string | null;
    week_start_date: string | null;
    status: string;
    updated_at: string | null;
    created_at: string | null;
  };
  const all: Uws[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("user_week_statuses")
      .select("user_id,season_key,week_start_date,status,updated_at,created_at")
      .order("user_id", { ascending: true })
      .order("week_start_date", { ascending: true })
      .range(from, from + 999);
    if (error) throw error;
    const rows = (data ?? []) as Uws[];
    all.push(...rows);
    if (rows.length < 1000) break;
  }

  const { data: profs } = await sb.from("user_profiles").select("user_id, display_name");
  const nameOf = new Map(((profs ?? []) as any[]).map((p) => [p.user_id, p.display_name]));

  // ③ 26-winter 행 status 분포 (전환/비전환)
  const win = all.filter((r) => r.season_key === "2026-winter");
  const dist = (rows: Uws[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.status, (m.get(r.status) ?? 0) + 1);
    return [...m].map(([k, v]) => `${k}:${v}`).join(" ");
  };
  const winTrans = win.filter((r) => r.week_start_date && isTransitionWeekStart(r.week_start_date));
  const winReg = win.filter((r) => !(r.week_start_date && isTransitionWeekStart(r.week_start_date)));
  console.log(`=== 26-winter 행 분포 ===`);
  console.log(`비전환 ${winReg.length}행: ${dist(winReg)}`);
  console.log(`전환   ${winTrans.length}행: ${dist(winTrans)}`);
  // updated_at 군집 (flip 시각 확인)
  const upd = new Map<string, number>();
  for (const r of winReg) {
    const k = String(r.updated_at ?? "").slice(0, 16);
    upd.set(k, (upd.get(k) ?? 0) + 1);
  }
  console.log(`비전환 updated_at 군집(상위):`, [...upd].sort((a, b) => b[1] - a[1]).slice(0, 6));
  const updT = new Map<string, number>();
  for (const r of winTrans) {
    const k = String(r.updated_at ?? "").slice(0, 16);
    updT.set(k, (updT.get(k) ?? 0) + 1);
  }
  console.log(`전환 updated_at 군집(상위):`, [...updT].sort((a, b) => b[1] - a[1]).slice(0, 6));

  // ① 시즌누락 테스터 5명 타임라인
  const byUser = new Map<string, Uws[]>();
  for (const r of all) {
    const arr = byUser.get(r.user_id) ?? [];
    arr.push(r);
    byUser.set(r.user_id, arr);
  }
  const missing: string[] = [];
  const zeroWithTransSuccess: string[] = [];
  for (const [uid, rows] of byUser) {
    const bySeason = new Map<string, Uws[]>();
    for (const r of rows) {
      if (!r.season_key) continue;
      const arr = bySeason.get(r.season_key) ?? [];
      arr.push(r);
      bySeason.set(r.season_key, arr);
    }
    for (const [sk, srows] of bySeason) {
      const reg = srows.filter((r) => !(r.week_start_date && isTransitionWeekStart(r.week_start_date)));
      const trans = srows.filter((r) => r.week_start_date && isTransitionWeekStart(r.week_start_date));
      const transSuccess = trans.filter((r) => r.status === "success").length;
      if (reg.length === 0 && trans.length > 0) missing.push(uid);
      // 증상B 후보: 비전환 success=0 인데 전환 success>0, 비전환 행은 존재(record 0주 표시)
      if (reg.length > 0 && reg.filter((r) => r.status === "success").length === 0 && transSuccess > 0) {
        zeroWithTransSuccess.push(`${nameOf.get(uid)} | ${sk} | 비전환 ${reg.length}행(${dist(reg)}) + 전환 success ${transSuccess}`);
      }
    }
  }
  console.log(`\n=== 증상B 후보 (record 존재·approvedWeeks=0·전환 success 보유) ===`);
  for (const z of zeroWithTransSuccess) console.log(z);
  if (!zeroWithTransSuccess.length) console.log("없음");

  console.log(`\n=== 증상A 테스터 타임라인 (시즌누락, 5명) ===`);
  for (const uid of [...new Set(missing)].slice(0, 5)) {
    console.log(`\n${nameOf.get(uid)} (${uid})`);
    for (const r of (byUser.get(uid) ?? [])) {
      const t = r.week_start_date && isTransitionWeekStart(r.week_start_date) ? "← 전환" : "";
      console.log(
        `  ${r.week_start_date} ${r.season_key} ${r.status.padEnd(13)} created=${String(r.created_at).slice(0, 16)} updated=${String(r.updated_at).slice(0, 16)} ${t}`,
      );
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
