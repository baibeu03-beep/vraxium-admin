/**
 * diag-info-zerotarget-census.ts  (READ-ONLY)
 *
 * 실무 정보(info) 허브의 활성 라인 전수 census — 0-target(sentinel 유무) 분포를 확인한다.
 *   - 고객 weekly-card 의 openedByWeek 는 cluster4_line_targets(active inner-join) 기반.
 *     → user-target 0 + sentinel(rule, zeroTargetOpen) 0 = "고객 미노출"(not_applicable).
 *     → sentinel >=1 또는 user-target >=1 = "고객 노출"(개설/강화).
 *   - admin '주차별 개설 결과' 는 cluster4_lines.is_active 기준 = 항상 '개설 완료'.
 *
 * 실행: npx tsx --env-file=.env.local scripts/diag-info-zerotarget-census.ts
 * 절대 write 없음.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type LineRow = {
  id: string;
  activity_type_id: string | null;
  line_code: string | null;
  week_id: string | null;
  source_type: string | null;
  source_file_name: string | null;
  created_at: string | null;
};

type TargetRow = {
  line_id: string;
  week_id: string | null;
  target_mode: string;
  target_user_id: string | null;
  target_rule: Record<string, unknown> | null;
};

async function fetchAll<T>(
  table: string,
  cols: string,
  apply: (q: any) => any,
): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  let from = 0;
  for (;;) {
    let q = supabaseAdmin.from(table).select(cols).order("id", { ascending: true });
    q = apply(q).range(from, from + page - 1);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < page) break;
    from += page;
  }
  return out;
}

async function main() {
  // 1) 활성 info 라인 전수.
  const lines = await fetchAll<LineRow>(
    "cluster4_lines",
    "id,activity_type_id,line_code,week_id,source_type,source_file_name,created_at",
    (q) => q.eq("part_type", "info").eq("is_active", true),
  );
  console.log(`활성 info 라인: ${lines.length}건`);

  // 2) 이 라인들의 모든 타깃.
  const lineIds = lines.map((l) => l.id);
  const targets: TargetRow[] = [];
  const CHUNK = 200;
  for (let i = 0; i < lineIds.length; i += CHUNK) {
    const slice = lineIds.slice(i, i + CHUNK);
    const rows = await fetchAll<TargetRow>(
      "cluster4_line_targets",
      "line_id,week_id,target_mode,target_user_id,target_rule",
      (q) => q.in("line_id", slice),
    );
    targets.push(...rows);
  }

  // 3) 라인별 타깃 집계.
  type Agg = { user: number; sentinel: number; ruleOther: number };
  const byLine = new Map<string, Agg>();
  for (const t of targets) {
    const a = byLine.get(t.line_id) ?? { user: 0, sentinel: 0, ruleOther: 0 };
    if (t.target_mode === "user") a.user++;
    else if (t.target_mode === "rule") {
      if (t.target_rule && (t.target_rule as any).zeroTargetOpen === true) a.sentinel++;
      else a.ruleOther++;
    }
    byLine.set(t.line_id, a);
  }

  // 4) 분류.
  type Bucket = "customer_visible_user" | "customer_visible_sentinel" | "customer_hidden_zero";
  const classify = (a: Agg | undefined): Bucket => {
    if (a && a.user > 0) return "customer_visible_user";
    if (a && a.sentinel > 0) return "customer_visible_sentinel";
    return "customer_hidden_zero";
  };

  // 5) activity_type 별 요약.
  const byActivity = new Map<string, Record<Bucket, number>>();
  const hiddenLines: LineRow[] = [];
  for (const l of lines) {
    const a = byLine.get(l.id);
    const bucket = classify(a);
    const act = l.activity_type_id ?? "(null)";
    const rec =
      byActivity.get(act) ??
      ({ customer_visible_user: 0, customer_visible_sentinel: 0, customer_hidden_zero: 0 } as Record<Bucket, number>);
    rec[bucket]++;
    byActivity.set(act, rec);
    if (bucket === "customer_hidden_zero") hiddenLines.push(l);
  }

  console.log(`\n──── activity_type 별 분포 (고객 노출 관점) ────`);
  console.log(
    `${"activity_type".padEnd(18)} ${"user타깃".padStart(8)} ${"sentinel".padStart(9)} ${"0행(미노출)".padStart(12)}`,
  );
  for (const [act, rec] of [...byActivity.entries()].sort()) {
    console.log(
      `${act.padEnd(18)} ${String(rec.customer_visible_user).padStart(8)} ${String(rec.customer_visible_sentinel).padStart(9)} ${String(rec.customer_hidden_zero).padStart(12)}`,
    );
  }

  console.log(`\n──── 고객 미노출(0행, sentinel 없음) 라인 상세: ${hiddenLines.length}건 ────`);
  for (const l of hiddenLines.sort((a, b) => (a.activity_type_id ?? "").localeCompare(b.activity_type_id ?? ""))) {
    console.log(
      `  [${(l.activity_type_id ?? "?").padEnd(12)}] code=${l.line_code ?? "—"} week=${l.week_id ?? "—"} src=${l.source_type ?? "—"}/${l.source_file_name ?? "—"} id=${l.id}`,
    );
  }

  // 6) infodesk 전용 상세.
  console.log(`\n──── infodesk 라인 상세 ────`);
  const infodesk = lines.filter((l) => l.activity_type_id === "infodesk");
  for (const l of infodesk) {
    const a = byLine.get(l.id) ?? { user: 0, sentinel: 0, ruleOther: 0 };
    console.log(
      `  code=${l.line_code ?? "—"} week=${l.week_id ?? "—"} user=${a.user} sentinel=${a.sentinel} ruleOther=${a.ruleOther} src=${l.source_type ?? "—"} -> ${classify(a)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
