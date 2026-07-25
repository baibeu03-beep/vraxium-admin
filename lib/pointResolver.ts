import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { processPointAwardsHasCancelColumns } from "@/lib/processPointAwardsCancelState";

export type ResolvedPoints = {
  pointA: number;
  pointB: number;
  pointC: number;
  rawAdvantage: number;
};

export type PointAwardValues = {
  point_check?: number | null;
  point_advantage?: number | null;
  point_penalty?: number | null;
};

export function resolvePointAwardRows(rows: readonly PointAwardValues[]): ResolvedPoints {
  let pointA = 0;
  let rawAdvantage = 0;
  let pointC = 0;
  for (const row of rows) {
    pointA += Number(row.point_check ?? 0);
    rawAdvantage += Number(row.point_advantage ?? 0);
    pointC += Math.abs(Number(row.point_penalty ?? 0));
  }
  return {
    pointA,
    pointB: rawAdvantage - pointC,
    pointC,
    rawAdvantage,
  };
}

export async function resolveCumulativePointsBatch(
  userIds: readonly string[],
): Promise<Map<string, ResolvedPoints>> {
  return loadLedgerPoints(userIds, null);
}

export async function resolveWeeklyPointsBatch(input: {
  userIds: readonly string[];
  year: number;
  weekNumber: number;
}): Promise<Map<string, ResolvedPoints>> {
  return loadLedgerPoints(input.userIds, {
    year: input.year,
    weekNumber: input.weekNumber,
  });
}

export async function resolvePointHistoryBatch(
  inputIds: readonly string[],
): Promise<Map<string, Map<string, ResolvedPoints>>> {
  const ids = Array.from(new Set(inputIds.filter(Boolean)));
  const out = new Map<string, Map<string, ResolvedPoints>>();
  if (ids.length === 0) return out;
  const hasCancel = await processPointAwardsHasCancelColumns();
  const grouped = new Map<string, PointAwardValues[]>();
  const weekKeys = new Set<string>();

  for (let i = 0; i < ids.length; i += 100) {
    let from = 0;
    while (true) {
      let query = supabaseAdmin
        .from("process_point_awards")
        .select("user_id,year,week_number,point_check,point_advantage,point_penalty")
        .in("user_id", ids.slice(i, i + 100))
        .range(from, from + 999);
      if (hasCancel) query = query.is("cancelled_at", null);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<PointAwardValues & {
        user_id: string;
        year: number;
        week_number: number;
      }>;
      for (const row of rows) {
        const weekKey = `${row.year}::${row.week_number}`;
        const key = `${row.user_id}::${weekKey}`;
        const list = grouped.get(key) ?? [];
        list.push(row);
        grouped.set(key, list);
        weekKeys.add(weekKey);
      }
      if (rows.length < 1000) break;
      from += 1000;
    }
  }

  const { data: weeks, error: weeksError } = await supabaseAdmin
    .from("weeks")
    .select("iso_year,iso_week,start_date");
  if (weeksError) throw new Error(weeksError.message);
  const startByWeek = new Map<string, string>();
  for (const week of (weeks ?? []) as Array<{
    iso_year: number | null;
    iso_week: number | null;
    start_date: string | null;
  }>) {
    if (week.iso_year == null || week.iso_week == null || !week.start_date) continue;
    const key = `${week.iso_year}::${week.iso_week}`;
    if (weekKeys.has(key)) startByWeek.set(key, week.start_date);
  }

  for (const [key, rows] of grouped) {
    const [userId, year, weekNumber] = key.split("::");
    const start = startByWeek.get(`${year}::${weekNumber}`);
    if (!start) continue;
    const user = out.get(userId) ?? new Map<string, ResolvedPoints>();
    user.set(start, resolvePointAwardRows(rows));
    out.set(userId, user);
  }
  return out;
}

async function loadLedgerPoints(
  inputIds: readonly string[],
  week: { year: number; weekNumber: number } | null,
): Promise<Map<string, ResolvedPoints>> {
  const ids = Array.from(new Set(inputIds.filter(Boolean)));
  const out = new Map<string, ResolvedPoints>();
  if (ids.length === 0) return out;
  const hasCancel = await processPointAwardsHasCancelColumns();

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    let from = 0;
    const rowsByUser = new Map<string, PointAwardValues[]>();
    while (true) {
      let query = supabaseAdmin
        .from("process_point_awards")
        .select("user_id,point_check,point_advantage,point_penalty")
        .in("user_id", chunk)
        .order("user_id", { ascending: true })
        .range(from, from + 999);
      if (week) {
        query = query.eq("year", week.year).eq("week_number", week.weekNumber);
      }
      if (hasCancel) query = query.is("cancelled_at", null);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<PointAwardValues & { user_id: string }>;
      for (const row of rows) {
        const list = rowsByUser.get(row.user_id) ?? [];
        list.push(row);
        rowsByUser.set(row.user_id, list);
      }
      if (rows.length < 1000) break;
      from += 1000;
    }
    for (const id of chunk) {
      out.set(id, resolvePointAwardRows(rowsByUser.get(id) ?? []));
    }
  }
  return out;
}
