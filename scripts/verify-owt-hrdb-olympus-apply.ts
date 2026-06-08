/**
 * HRDB/OLYMPUS 백필 apply 후 검증 (read-only — write 0).
 *
 *   npx tsx --env-file=.env.local scripts/verify-owt-hrdb-olympus-apply.ts
 *
 *   [1] encre org 행 93건  [2] phalanx org 행 76건  [3] oranke org 행 100건 + 내용 불변
 *   [4] org별 resolution: 3조직 값이 모두 다른 실주차에서 direct 함수가 각 org 의
 *       자기 값을 읽는지 (실데이터 — probe 불요)
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFileSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { fetchLegacyUnifiedExperienceByWeek } from "@/lib/lineAvailability";
import type { OrganizationSlug } from "@/lib/organizations";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const OUT = "claudedocs/owt-hrdb-olympus-postverify-20260607.json";
const APPLY_LOG = process.argv[2] ?? "claudedocs/owt-hrdb-olympus-apply-2026-06-07T05-25-12.json";
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

let pass = 0, fail = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function orgRows(slug: string) {
  const { data, error } = await sb
    .from("org_week_thresholds")
    .select("week_id,check_threshold,source_system,source_table,source_pk,updated_at")
    .eq("organization_slug", slug)
    .order("week_id", { ascending: true })
    .range(0, 4999);
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{ week_id: string; check_threshold: number; source_system: string | null; source_table: string | null; source_pk: string | null; updated_at: string }>;
}

async function main() {
  const [encre, phalanx, oranke] = await Promise.all([
    orgRows("encre"),
    orgRows("phalanx"),
    orgRows("oranke"),
  ]);

  check("[1] encre org 행 93건", encre.length === 93, `actual=${encre.length}`);
  check(
    "[1b] encre 전행 provenance = hrdb.weekssettings",
    encre.every((r) => r.source_system === "hrdb" && r.source_table === "hrdb.weekssettings" && r.source_pk),
  );
  check("[2] phalanx org 행 76건", phalanx.length === 76, `actual=${phalanx.length}`);
  check(
    "[2b] phalanx 전행 provenance = olympus.weekssettings",
    phalanx.every((r) => r.source_system === "olympus" && r.source_table === "olympus.weekssettings" && r.source_pk),
  );

  // [3] oranke 불변 — apply run log 의 before fingerprint 와 **동일 컬럼 집합**으로 재계산 비교
  //     (apply 스크립트 orankeFingerprint: week_id,check_threshold,source_table,source_pk,updated_at)
  {
    const applyLog = JSON.parse(readFileSync(APPLY_LOG, "utf8")) as {
      summary: { invariants: { orankeBefore: { count: number; hash: string } } };
    };
    const before = applyLog.summary.invariants.orankeBefore;
    const { data, error } = await sb
      .from("org_week_thresholds")
      .select("week_id,check_threshold,source_table,source_pk,updated_at")
      .eq("organization_slug", "oranke")
      .order("week_id", { ascending: true })
      .range(0, 4999);
    if (error) throw new Error(error.message);
    const nowHash = sha1(JSON.stringify(data ?? []));
    check(
      "[3] oranke org 행 100건 + 내용 불변 (apply 전 fingerprint 일치)",
      oranke.length === 100 && (data ?? []).length === before.count && nowHash === before.hash,
      `count=${oranke.length}/${before.count} hash=${nowHash}/${before.hash}`,
    );
  }

  // [4] org별 resolution — 3조직 값이 전부 다른 실주차에서 direct 검증
  {
    const encreBy = new Map(encre.map((r) => [r.week_id, r.check_threshold]));
    const phalanxBy = new Map(phalanx.map((r) => [r.week_id, r.check_threshold]));
    const triple = oranke
      .map((r) => ({
        week_id: r.week_id,
        oranke: r.check_threshold,
        encre: encreBy.get(r.week_id),
        phalanx: phalanxBy.get(r.week_id),
      }))
      .filter(
        (t) =>
          t.encre != null &&
          t.phalanx != null &&
          new Set([t.oranke, t.encre, t.phalanx]).size === 3,
      );
    check("[4-pre] 3조직 값이 전부 다른 주차 존재", triple.length > 0, `count=${triple.length}`);
    if (triple.length > 0) {
      // enforced 테스터 1명 (oranke) — organizationSlug override 로 3조직 resolution 검사.
      const { data: anyUser } = await sb
        .from("user_weekly_points")
        .select("user_id")
        .eq("checks_migrated", true)
        .limit(1)
        .maybeSingle();
      const uid = (anyUser as { user_id: string } | null)?.user_id;
      if (!uid) {
        check("[4] org별 resolution", false, "enforced 사용자 없음");
      } else {
        const t = triple[0];
        const now = Date.now();
        const get = async (slug: OrganizationSlug | null) =>
          (
            await fetchLegacyUnifiedExperienceByWeek(uid, [t.week_id], now, {
              organizationSlug: slug,
            })
          ).get(t.week_id)?.checkThreshold;
        const [e, p, o, c] = [await get("encre"), await get("phalanx"), await get("oranke"), await get(null)];
        check("[4a] encre → encre 값", e === t.encre, `got=${e} expected=${t.encre}`);
        check("[4b] phalanx → phalanx 값", p === t.phalanx, `got=${p} expected=${t.phalanx}`);
        check("[4c] oranke → oranke 값", o === t.oranke, `got=${o} expected=${t.oranke}`);
        check("[4d] org null → weeks 공통 폴백(=oranke seed 원본)", c === t.oranke, `got=${c}`);
      }
    }
  }

  writeFileSync(OUT, JSON.stringify({ pass, fail, results }, null, 2));
  console.log(`\n결과: PASS ${pass} / FAIL ${fail} → ${OUT}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
