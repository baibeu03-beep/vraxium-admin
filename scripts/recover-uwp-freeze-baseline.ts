/**
 * 기준선 동결 (READ-ONLY · 운영 테이블 write 0) — 소실 중인 pre-wipe 캐시와 현재 uwp 를 파일로 고정한다.
 *   npx tsx --env-file=.env.local scripts/recover-uwp-freeze-baseline.ts
 *
 * 안전 계약:
 *   · 운영 원본에 UPDATE/DELETE/INSERT 없음 — select 만 발행한다(DDL 실행 수단 자체가 없음: exec_sql RPC 부재).
 *   · 기존 백업 덮어쓰지 않음 — 출력 경로에 timestamp 를 포함하고, 같은 stamp 파일이 있으면 중단한다.
 *   · 재실행해도 기존 파일은 그대로 두고 새 stamp 로만 쓴다(중복 백업 아님 — 각각 그 시점의 스냅샷).
 *   · 행 수 · 사용자 수 · A/raw advantage/penalty 합계를 manifest 에 기록한다.
 *   · 원본 updated_at · checks_migrated · 사용자/주차 식별자를 **전 컬럼 그대로** 보존한다.
 *   · 실패 시 원본 무영향(읽기 전용).
 *
 * 산출물(backups/uwp-baseline-freeze-<stamp>/):
 *   manifest.json                     집계·검증 수치
 *   user_weekly_points.json           전 컬럼 원본 사본 (복구 대조 기준)
 *   process_point_awards.json         전 컬럼 원본 사본 (계층 분리 검증 기준)
 *   roster_card_stats.json            전 컬럼 (pre-wipe 누적 A/rawAdv/C 기준선)
 *   user_cumulative_points.json       전 컬럼
 *   weekly_card_points.json           스냅샷에서 주차별 points 만 추출(경량·직접 대조용)
 *   weekly_card_snapshots.json.gz     cards jsonb 전량(gzip) — 원본 무손실 보존
 */
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { gzipSync } from "zlib";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const WIPE = "2026-07-25T04:52:05.480492+00:00";
const WIPE_LT = "2026-07-25T04:52:00Z";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const DIR = `backups/uwp-baseline-freeze-${STAMP}`;

async function pageAll<T>(
  b: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  page = 1000,
): Promise<T[]> {
  const o: T[] = [];
  for (let f = 0; ; f += page) {
    const { data, error } = await b(f, f + page - 1);
    if (error) throw new Error(error.message);
    const r = (data ?? []) as T[];
    o.push(...r);
    if (r.length < page) break;
  }
  return o;
}

async function main() {
  if (existsSync(DIR)) throw new Error(`${DIR} 이미 존재 — 덮어쓰기 방지 위해 중단`);
  mkdirSync(DIR, { recursive: true });
  console.log(`[freeze] → ${DIR} (운영 테이블 write 0)`);

  // ── 1) user_weekly_points 전 컬럼 ──
  const uwp = await pageAll<Record<string, unknown>>((f, t) =>
    supabaseAdmin.from("user_weekly_points").select("*").order("id").range(f, t));
  writeFileSync(`${DIR}/user_weekly_points.json`, JSON.stringify(uwp), "utf8");

  const num = (v: unknown) => Number(v ?? 0);
  const sumA = uwp.reduce((s, r) => s + num(r.points), 0);
  const sumAdv = uwp.reduce((s, r) => s + num(r.advantages), 0);
  const sumPen = uwp.reduce((s, r) => s + num(r.penalty), 0);
  const users = new Set(uwp.map((r) => String(r.user_id)));
  const cmTrue = uwp.filter((r) => r.checks_migrated === true).length;
  const wiped = uwp.filter((r) => String(r.updated_at ?? "") === WIPE);
  const cols = Object.keys(uwp[0] ?? {});

  // ── 2) process_point_awards 전 컬럼 ──
  const ppa = await pageAll<Record<string, unknown>>((f, t) =>
    supabaseAdmin.from("process_point_awards").select("*").order("id").range(f, t));
  writeFileSync(`${DIR}/process_point_awards.json`, JSON.stringify(ppa), "utf8");
  const ppaActive = ppa.filter((r) => !r.cancelled_at);

  // ── 3) roster slim / cumulative ──
  const roster = await pageAll<Record<string, unknown>>((f, t) =>
    supabaseAdmin.from("cluster4_roster_card_stats").select("*").order("user_id").range(f, t));
  writeFileSync(`${DIR}/roster_card_stats.json`, JSON.stringify(roster), "utf8");
  const rosterPre = roster.filter((r) => String(r.updated_at ?? "") < WIPE_LT);

  const ucp = await pageAll<Record<string, unknown>>((f, t) =>
    supabaseAdmin.from("user_cumulative_points").select("*").order("user_id").range(f, t));
  writeFileSync(`${DIR}/user_cumulative_points.json`, JSON.stringify(ucp), "utf8");

  // ── 4) weekly-card snapshots (cards jsonb 큼 — 25행씩) ──
  const snaps = await pageAll<{ user_id: string; cards: any; computed_at: string | null; dto_version: number | null; is_stale: boolean | null; updated_at: string | null }>(
    (f, t) => supabaseAdmin.from("cluster4_weekly_card_snapshots").select("user_id,cards,computed_at,dto_version,is_stale,updated_at").order("user_id").range(f, t), 25);
  writeFileSync(`${DIR}/weekly_card_snapshots.json.gz`, gzipSync(Buffer.from(JSON.stringify(snaps), "utf8")));

  // 경량 추출 — 주차별 points 만
  const pts: Array<{ user_id: string; computed_at: string | null; pre_wipe: boolean; weeks: Record<string, { star: number | null; shield: number | null; pointC: number | null }> }> = [];
  let preWipeSnaps = 0;
  for (const s of snaps) {
    const preWipe = String(s.computed_at ?? "") < WIPE_LT;
    if (preWipe) preWipeSnaps++;
    const weeks: Record<string, { star: number | null; shield: number | null; pointC: number | null }> = {};
    for (const c of Array.isArray(s.cards) ? s.cards : []) {
      if (!c?.startDate || !c?.points) continue;
      weeks[c.startDate] = { star: c.points.star ?? null, shield: c.points.shield ?? null, pointC: c.points.pointC ?? null };
    }
    pts.push({ user_id: s.user_id, computed_at: s.computed_at, pre_wipe: preWipe, weeks });
  }
  writeFileSync(`${DIR}/weekly_card_points.json`, JSON.stringify(pts), "utf8");

  // ── 5) manifest ──
  const manifest = {
    frozenAt: new Date().toISOString(),
    mode: "READ-ONLY — 운영 테이블 write 0",
    wipeTimestamp: WIPE,
    user_weekly_points: {
      rows: uwp.length,
      users: users.size,
      columnsPreserved: cols,
      sumA,
      sumRawAdvantage: sumAdv,
      sumPenaltyMagnitude: sumPen,
      checksMigratedTrue: cmTrue,
      checksMigratedFalse: uwp.length - cmTrue,
      wipedRows: wiped.length,
      wipedUsers: new Set(wiped.map((r) => String(r.user_id))).size,
      wipedAllZero: wiped.filter((r) => num(r.points) === 0 && num(r.advantages) === 0 && num(r.penalty) === 0).length,
      penaltyNegativeRows: uwp.filter((r) => num(r.penalty) < 0).length,
    },
    process_point_awards: {
      rows: ppa.length,
      active: ppaActive.length,
      cancelled: ppa.length - ppaActive.length,
      activeKeys: new Set(ppaActive.map((r) => `${r.user_id}|${r.year}|${r.week_number}`)).size,
      activeSumA: ppaActive.reduce((s, r) => s + num(r.point_check), 0),
      activeSumAdvantage: ppaActive.reduce((s, r) => s + num(r.point_advantage), 0),
      activeSumPenaltyMagnitude: ppaActive.reduce((s, r) => s + Math.abs(num(r.point_penalty)), 0),
    },
    cluster4_roster_card_stats: {
      rows: roster.length,
      preWipeRows: rosterPre.length,
      preWipeSumPoA: rosterPre.reduce((s, r) => s + num(r.po_a), 0),
      preWipeSumPoB_rawAdvantage: rosterPre.reduce((s, r) => s + num(r.po_b), 0),
      preWipeSumPoC: rosterPre.reduce((s, r) => s + num(r.po_c), 0),
    },
    user_cumulative_points: { rows: ucp.length },
    cluster4_weekly_card_snapshots: { rows: snaps.length, preWipeRows: preWipeSnaps },
  };
  writeFileSync(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 1), "utf8");

  console.log(JSON.stringify(manifest, null, 2));
  console.log(`\n[freeze] 완료 — 운영 테이블 write 0행. → ${DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
