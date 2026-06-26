// is_stale 드레인 모니터: 운영자 편집(invalidate)이 멈춘 뒤 백그라운드 재계산이
// is_stale 을 0 으로 수렴시키는지 확인한다. 30초 간격 폴링.
//   - is_stale 수 + dev 로그의 "mark stale (many)" 누적 횟수(운영자 편집 활동 지표)를 함께 본다.
//   - is_stale==0 이면 성공 종료. 운영자가 계속 편집하면 markStale 카운트가 증가한다.
import { config } from "dotenv";
config({ path: ".env.local" });
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const LOG = "claudedocs/devserver-converge.log";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function counts() {
  let stale = 0, v24 = 0, tot = 0;
  for (let f = 0; ; f += 1000) {
    const { data } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("is_stale,dto_version")
      .range(f, f + 999);
    const b = (data ?? []) as { is_stale: boolean; dto_version: number }[];
    tot += b.length;
    stale += b.filter((r) => r.is_stale).length;
    v24 += b.filter((r) => r.dto_version === 24).length;
    if (b.length < 1000) break;
  }
  return { stale, v24, tot };
}
function markStaleEvents(): number {
  try {
    return (readFileSync(LOG, "utf8").match(/mark stale \(many\) ok/g) ?? []).length;
  } catch {
    return -1;
  }
}

async function main() {
  console.log("is_stale 드레인 모니터 (30s 간격, 최대 20분)");
  let prevMark = markStaleEvents();
  let idleStreak = 0;
  for (let i = 1; i <= 40; i++) {
    const c = await counts();
    const mark = markStaleEvents();
    const newEdits = mark - prevMark;
    if (newEdits > 0) idleStreak = 0; else idleStreak++;
    prevMark = mark;
    console.log(
      `[${String(i).padStart(2)}] tot=${c.tot} v24=${c.v24} non-v24=${c.tot - c.v24} is_stale=${c.stale} | 신규 운영자편집(markStale)=${newEdits} | 운영자 idle 연속=${idleStreak}`,
    );
    if (c.stale === 0) {
      console.log(`\n✅ is_stale = 0 도달 (전수 v24=${c.v24}/${c.tot}). 드레인 완료.`);
      return;
    }
    await sleep(30000);
  }
  const c = await counts();
  console.log(`\n⏱ 모니터 종료(20분). 최종 is_stale=${c.stale} (운영자 편집이 지속되면 0 미도달 — 편집 종료 후 자가복구).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
