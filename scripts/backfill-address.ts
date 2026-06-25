/**
 * 거주지(address) 백필 — PMS users.Address(SoT) → user_profiles.address.
 *   npx tsx --env-file=.env.local scripts/backfill-address.ts          # dry-run (write 0)
 *   npx tsx --env-file=.env.local scripts/backfill-address.ts --apply  # 실제 백필
 *
 * 접속: SSH 터널 127.0.0.1:13306 → PMS MySQL(localhost:3306). (env MYSQL_USER/PASSWORD 사용)
 * 정책:
 *   - 대상: user_profiles.address 가 NULL / "" / "-" 인 사용자만. 정상 값 보유자는 절대 미접촉.
 *   - 값: PMS {source_system}.users.Address (원문 trim). 복합키 (source_system, legacy_user_id) 매칭.
 *   - PMS Address 가 비어있으면 백필 불가로 분류(skip).
 *   - address 는 weekly-cards snapshot 미포함 프로필 표시 필드 → snapshot 재계산 불필요.
 * write 는 user_profiles.address 단일 컬럼만. 멱등(재실행 시 이미 채워진 행은 대상에서 빠짐).
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";

const APPLY = process.argv.includes("--apply");
const env = process.env as Record<string, string>;
// MySQL 자격증명은 readFileSync 정규식으로 읽는다. --env-file 파서가 MYSQL_PASSWORD 의
// 특수문자를 잘못 처리해 1글자 누락(len 14≠15)시켜 'Access denied' 발생 → 원본 파일 직독.
const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const blank = (v: unknown) => v == null || String(v).trim() === "" || String(v).trim() === "-";

async function fetchAll<T>(table: string, select: string, order: string): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from(table).select(select).order(order, { ascending: true }).range(f, f + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

async function main() {
  // ── 터널 접속 ──
  const conn = await mysql.createConnection({
    host: "127.0.0.1", port: 13306,
    user: envGet("MYSQL_USER"), password: envGet("MYSQL_PASSWORD"),
    dateStrings: true, ssl: { rejectUnauthorized: false }, connectTimeout: 10000,
  });
  const [[who]] = (await conn.query("SELECT CURRENT_USER() u, @@version v")) as any;
  console.log(`[tunnel] 접속 OK — ${who.u} (MySQL ${who.v})`);

  // ── Vraxium: 이관자 + 현재 address ──
  type U = { id: string; legacy_user_id: number | null; source_system: string | null };
  const users = await fetchAll<U>("users", "id,legacy_user_id,source_system", "id");
  const profs = await fetchAll<{ user_id: string; display_name: string | null; address: string | null }>(
    "user_profiles", "user_id,display_name,address", "user_id");
  const profByUser = new Map(profs.map((p) => [p.user_id, p]));

  const migrated = users.filter((u) => u.source_system && u.legacy_user_id != null);
  // address 결측 이관자만
  const needAddr = migrated.filter((u) => blank(profByUser.get(u.id)?.address));

  // ── PMS Address 조회 (source 별 일괄) ──
  const pmsAddrByKey = new Map<string, string>(); // `${src}:${uid}` → Address
  const bySrcIds = new Map<string, number[]>();
  for (const u of needAddr) {
    const arr = bySrcIds.get(u.source_system!) ?? [];
    arr.push(u.legacy_user_id!);
    bySrcIds.set(u.source_system!, arr);
  }
  const pmsHave = new Map<string, number>(); // src → PMS Address 보유 수(결측 대상 중)
  for (const [src, ids] of bySrcIds) {
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const [rows] = (await conn.query(
        `SELECT UserId, Address FROM ${src}.users WHERE UserId IN (${chunk.join(",")})`,
      )) as [Array<{ UserId: number; Address: string | null }>, unknown];
      for (const r of rows) {
        if (!blank(r.Address)) {
          pmsAddrByKey.set(`${src}:${r.UserId}`, String(r.Address).trim());
          pmsHave.set(src, (pmsHave.get(src) ?? 0) + 1);
        }
      }
    }
  }
  await conn.end();

  // ── 백필 대상 산출 ──
  const targets: Array<{ user_id: string; display_name: string; address: string; src: string }> = [];
  const noPmsAddr: Array<{ user_id: string; src: string; uid: number }> = [];
  for (const u of needAddr) {
    const key = `${u.source_system}:${u.legacy_user_id}`;
    const addr = pmsAddrByKey.get(key);
    if (addr) targets.push({ user_id: u.id, display_name: profByUser.get(u.id)?.display_name ?? "", address: addr, src: u.source_system! });
    else noPmsAddr.push({ user_id: u.id, src: u.source_system!, uid: u.legacy_user_id! });
  }

  // ── 집계 ──
  const existingOk = profs.filter((p) => !blank(p.address)).length;
  const bySrcTarget = new Map<string, number>();
  for (const t of targets) bySrcTarget.set(t.src, (bySrcTarget.get(t.src) ?? 0) + 1);

  console.log(`\n=== 거주지 백필 ${APPLY ? "(APPLY)" : "(DRY-RUN · write 0)"} ===`);
  console.log(`전체 프로필                 : ${profs.length}`);
  console.log(`기존 정상 address(보존)     : ${existingOk}`);
  console.log(`이관자 중 address 결측       : ${needAddr.length}`);
  console.log(`  → PMS Address 보유(백필)   : ${targets.length}`);
  console.log(`  → PMS Address 없음(skip)   : ${noPmsAddr.length}`);
  console.log(`source별 백필 대상           : ${[...bySrcTarget.entries()].map(([s, n]) => `${s}=${n}`).join(", ")}`);
  console.log(`PMS Address 보유(결측대상 중): ${[...pmsHave.entries()].map(([s, n]) => `${s}=${n}`).join(", ")}`);

  console.log(`\n샘플 15 (한글명 → PMS Address):`);
  for (const t of targets.slice(0, 15)) console.log(`  ${t.display_name.padEnd(8)} → "${t.address}"  [${t.src}]`);
  if (noPmsAddr.length) {
    console.log(`\nPMS Address 없음 샘플(최대 10):`);
    for (const n of noPmsAddr.slice(0, 10)) console.log(`  ${n.src}:${n.uid} (user_id=${n.user_id})`);
  }

  if (!APPLY) { console.log(`\n→ DRY-RUN 종료. 실제 적용: --apply`); return; }

  // ── APPLY ──
  let ok = 0;
  for (const t of targets) {
    const { error } = await sb.from("user_profiles").update({ address: t.address }).eq("user_id", t.user_id);
    if (error) { console.error(`✖ ${t.display_name} (${t.user_id}): ${error.message}`); process.exit(1); }
    ok++;
    if (ok % 100 === 0) console.log(`  …${ok}/${targets.length}`);
  }
  console.log(`\n✔ 백필 완료: ${ok}건 address 설정 (snapshot 재계산 불필요 — 프로필 표시 필드).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
