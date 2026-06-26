/**
 * english_name **자동 생성** 백필 (dry-run 기본 · --apply 로만 write).
 *   npx tsx --env-file=.env.local scripts/backfill-english-name.ts          # dry-run (write 0)
 *   npx tsx --env-file=.env.local scripts/backfill-english-name.ts --apply  # 실제 백필
 *
 * 정책:
 *   - 대상: user_profiles.english_name 가 비어있거나 "-" 인 사용자 전원(이미 값이 있으면 보존·미접촉).
 *   - 값: lib/koreanRomanization.romanizeKoreanName(display_name) — "자동 생성 영문명"(공식 아님).
 *   - 한글 음절이 없어 생성 불가한 행은 skip(별도 집계).
 *   - english_name 은 weekly-cards snapshot 에 포함되지 않는 프로필 표시 필드 → snapshot 재계산 불필요.
 * write 는 user_profiles.english_name 단일 컬럼만. 멱등(재실행 시 이미 채워진 행은 대상에서 빠짐).
 */
import { createClient } from "@supabase/supabase-js";
import { romanizeKoreanName } from "@/lib/koreanRomanization";

const APPLY = process.argv.includes("--apply");
const env = process.env as Record<string, string>;
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

type Prof = { user_id: string; display_name: string | null; english_name: string | null };

async function main() {
  const profs = await fetchAll<Prof>("user_profiles", "user_id,display_name,english_name", "user_id");
  const users = await fetchAll<{ id: string; source_system: string | null }>("users", "id,source_system", "id");
  const srcByUser = new Map(users.map((u) => [u.id, u.source_system]));

  const preserved = profs.filter((p) => !blank(p.english_name));
  const candidates = profs.filter((p) => blank(p.english_name));

  const targets: Array<{ user_id: string; display_name: string; englishName: string; src: string }> = [];
  const ungeneratable: Array<{ user_id: string; display_name: string | null; src: string }> = [];
  for (const p of candidates) {
    const src = srcByUser.get(p.user_id) ?? "native";
    const r = romanizeKoreanName(p.display_name);
    if (r.englishName) targets.push({ user_id: p.user_id, display_name: p.display_name ?? "", englishName: r.englishName, src });
    else ungeneratable.push({ user_id: p.user_id, display_name: p.display_name, src });
  }

  // 집계
  const bySrc = new Map<string, number>();
  for (const t of targets) bySrc.set(t.src, (bySrc.get(t.src) ?? 0) + 1);

  console.log(`\n=== english_name 자동 생성 백필 ${APPLY ? "(APPLY)" : "(DRY-RUN · write 0)"} ===`);
  console.log(`전체 프로필            : ${profs.length}`);
  console.log(`기존 english_name 보존 : ${preserved.length} (미접촉)`);
  console.log(`생성 대상(blank)       : ${candidates.length}`);
  console.log(`  → 생성 가능          : ${targets.length}`);
  console.log(`  → 생성 불가(한글없음): ${ungeneratable.length}`);
  console.log(`source_system 별 생성 대상: ${[...bySrc.entries()].map(([s, n]) => `${s}=${n}`).join(", ")}`);

  console.log(`\n샘플 20명 (한글명 → 자동 생성 영문명):`);
  for (const t of targets.slice(0, 20)) console.log(`  ${t.display_name.padEnd(8)} → "${t.englishName}"  [${t.src}]`);

  if (ungeneratable.length) {
    console.log(`\n생성 불가 샘플(최대 10):`);
    for (const u of ungeneratable.slice(0, 10)) console.log(`  user_id=${u.user_id} display_name=${JSON.stringify(u.display_name)} [${u.src}]`);
  }

  if (!APPLY) {
    console.log(`\n→ DRY-RUN 종료. 실제 적용: --apply`);
    return;
  }

  // ── APPLY ──
  let ok = 0;
  for (const t of targets) {
    const { error } = await sb.from("user_profiles").update({ english_name: t.englishName }).eq("user_id", t.user_id);
    if (error) { console.error(`✖ ${t.display_name} (${t.user_id}): ${error.message}`); process.exit(1); }
    ok++;
    if (ok % 100 === 0) console.log(`  …${ok}/${targets.length}`);
  }
  console.log(`\n✔ 백필 완료: ${ok}건 english_name 설정 (snapshot 재계산 불필요 — 프로필 표시 필드).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
