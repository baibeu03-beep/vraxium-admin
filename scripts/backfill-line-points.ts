/**
 * 라인 강화 Point.A / Point.B 결정론적 배정 backfill — 대상 = cluster4_line_point_configs.  [Phase 3]
 *
 *   ⚠️ 기본 dry-run. 운영 DB 변경은 명시적 `--apply` 필요. ledger(process_point_awards)는 무접촉 —
 *      이 스크립트는 config 테이블의 "설정값"만 채운다(사용자 누적 포인트 불변).
 *
 *   config_key(확정 정책): info=activity_types.id · experience=카테고리enum · competency=master line_code.
 *   배정: A만 30% / B만 30% / A+B 40% · 1~20 · seed=`org:hub:config_key`(동일 키=항상 동일 결과).
 *
 *   안전 조건: dry-run 기본 · deterministic · idempotent · 기존값(NOT NULL) skip · 대상수 사전출력 ·
 *              manifest 기록 · rollback 가능.
 *   전제: 2026-07-11_DRAFT_cluster4_line_point_configs.sql 수동 적용 후에만 --apply 가능.
 *
 *   사용:
 *     dry-run(기본):  npx tsx --env-file=.env.local scripts/backfill-line-points.ts
 *     실제 적용:      ... scripts/backfill-line-points.ts --apply
 *     롤백:           ... scripts/backfill-line-points.ts --rollback=claudedocs/line-point-backfill-manifest.json
 */
import { writeFileSync, readFileSync } from "fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { assignLinePoints } from "@/lib/linePointBackfill";
import { EXPERIENCE_LINE_TYPES } from "@/lib/adminTeamPartsInfoWeekDetailData";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const rollbackArg = args.find((a) => a.startsWith("--rollback="))?.split("=")[1] ?? null;
const MANIFEST = "claudedocs/line-point-backfill-manifest.json";

type Target = { organization: string; hub: string; configKey: string; pointA: number; pointB: number; bucket: string };

// 배정 대상 config_key 열거(각 허브 SoT read-only).
async function enumerateKeys(): Promise<Array<{ organization: string; hub: string; configKey: string }>> {
  const out: Array<{ organization: string; hub: string; configKey: string }> = [];

  // info = activity_types(practical_info), org='common'(활동유형 전역).
  const { data: at } = await supabaseAdmin.from("activity_types").select("id").eq("cluster_id", "practical_info").eq("is_active", true);
  for (const r of (at ?? []) as Array<{ id: string }>) out.push({ organization: "common", hub: "info", configKey: r.id });

  // experience = (org × 5 카테고리). org = line_registrations(hub=experience) 실사용 조직.
  const { data: lr } = await supabaseAdmin.from("line_registrations").select("organization_slug").eq("hub", "experience");
  const expOrgs = [...new Set(((lr ?? []) as Array<{ organization_slug: string | null }>).map((r) => r.organization_slug).filter((v): v is string => !!v && v !== "common"))];
  for (const org of expOrgs) for (const type of EXPERIENCE_LINE_TYPES) out.push({ organization: org, hub: "experience", configKey: type });

  // competency = master line_code(org별).
  const { data: cm } = await supabaseAdmin.from("cluster4_competency_line_masters").select("line_code, organization_slug").eq("is_active", true);
  const seen = new Set<string>();
  for (const r of (cm ?? []) as Array<{ line_code: string | null; organization_slug: string | null }>) {
    if (!r.line_code || !r.organization_slug) continue;
    const k = `${r.organization_slug}:${r.line_code}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ organization: r.organization_slug, hub: "competency", configKey: r.line_code });
  }
  return out;
}

async function tableExists(): Promise<boolean> {
  const { error } = await supabaseAdmin.from("cluster4_line_point_configs").select("id").limit(1);
  if (error && (error.code === "42703" || error.code === "PGRST205" || /cluster4_line_point_configs/.test(error.message))) return false;
  if (error) throw new Error(`선행 조회 실패: ${error.message}`);
  return true;
}

async function doRollback(path: string) {
  const manifest: Target[] = JSON.parse(readFileSync(path, "utf8"));
  console.log(`[rollback] manifest ${path} · ${manifest.length}행`);
  if (!APPLY) { console.log("[rollback] dry-run — 실제 되돌림은 --apply 필요."); return; }
  let reverted = 0;
  for (const e of manifest) {
    const { data: cur } = await supabaseAdmin.from("cluster4_line_point_configs").select("point_a, point_b").eq("organization_slug", e.organization).eq("hub", e.hub).eq("config_key", e.configKey).maybeSingle();
    if (!cur) continue;
    if ((cur as any).point_a !== e.pointA || (cur as any).point_b !== e.pointB) { console.log(`  skip(값 불일치) ${e.organization}/${e.hub}/${e.configKey}`); continue; }
    const { error } = await supabaseAdmin.from("cluster4_line_point_configs").delete().eq("organization_slug", e.organization).eq("hub", e.hub).eq("config_key", e.configKey);
    if (error) console.log(`  ERROR ${e.configKey}: ${error.message}`); else reverted++;
  }
  console.log(`[rollback] 완료 · ${reverted}행 삭제`);
}

async function main() {
  if (rollbackArg) { await doRollback(rollbackArg); return; }

  const exists = await tableExists();
  console.log(`마이그레이션 적용됨(cluster4_line_point_configs 존재): ${exists}`);
  if (!exists && APPLY) { console.error("❌ --apply 불가: 먼저 DRAFT 마이그레이션을 SQL Editor 로 적용하세요."); process.exit(1); }

  const keys = await enumerateKeys();
  // 기존값 있는(org,hub,config_key) 조회(테이블 있을 때만).
  const existing = new Set<string>();
  if (exists) {
    const { data } = await supabaseAdmin.from("cluster4_line_point_configs").select("organization_slug, hub, config_key, point_a, point_b");
    for (const r of (data ?? []) as Array<{ organization_slug: string; hub: string; config_key: string; point_a: number | null; point_b: number | null }>)
      if (r.point_a != null || r.point_b != null) existing.add(`${r.organization_slug}:${r.hub}:${r.config_key}`);
  }

  const targets: Target[] = [];
  let skipped = 0;
  for (const k of keys) {
    if (existing.has(`${k.organization}:${k.hub}:${k.configKey}`)) { skipped++; continue; }
    const a = assignLinePoints(`${k.organization}:${k.hub}:${k.configKey}`);
    targets.push({ ...k, pointA: a.pointA, pointB: a.pointB, bucket: a.bucket });
  }

  const dist = { a_only: 0, b_only: 0, both: 0 } as Record<string, number>;
  const byHub: Record<string, number> = {};
  for (const t of targets) { dist[t.bucket]++; byHub[t.hub] = (byHub[t.hub] ?? 0) + 1; }
  console.log(`\n전체 config_key: ${keys.length} · 기존값 skip: ${skipped} · 배정 대상: ${targets.length}`);
  console.log(`허브 분포:`, byHub);
  console.log(`버킷 분포: A만=${dist.a_only} · B만=${dist.b_only} · 둘다=${dist.both} (목표 0.3/0.3/0.4)`);
  console.log("샘플(최대 12):");
  for (const t of targets.slice(0, 12)) console.log(`  ${t.organization} / ${t.hub} / ${t.configKey} · ${t.bucket} · A=${t.pointA} B=${t.pointB}`);

  writeFileSync(MANIFEST, JSON.stringify(targets, null, 2), "utf8");
  console.log(`\nmanifest 기록: ${MANIFEST} (${targets.length}행)`);

  if (!APPLY) { console.log("\n[dry-run] 실제 쓰기 없음. 적용하려면 --apply. (ledger·snapshot 무접촉)"); return; }

  console.log("\n[apply] cluster4_line_point_configs upsert (설정값만)…");
  let upserted = 0;
  for (const t of targets) {
    const { error } = await supabaseAdmin.from("cluster4_line_point_configs").insert({
      organization_slug: t.organization, hub: t.hub, config_key: t.configKey, point_a: t.pointA, point_b: t.pointB,
    });
    if (error) { console.log(`  ERROR ${t.configKey}: ${error.message}`); continue; }
    upserted++;
  }
  console.log(`[apply] 완료 · ${upserted}행. rollback: --rollback=${MANIFEST}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
