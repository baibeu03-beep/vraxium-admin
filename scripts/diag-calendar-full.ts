/**
 * diag-calendar-full.ts (READ-ONLY)
 * activity_type_id='calendar' 인 모든 cluster4_lines (제목 무관·part_type 무관·is_active 무관) 전수.
 * + getInfoLineResultsForWeek 로 W10/W11/W13 의 캘린더 결과 DTO 실제 확인.
 * 실행: npx tsx --env-file=.env.local scripts/diag-calendar-full.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getInfoLineResultsForWeek } from "@/lib/adminCluster4InfoLineResults";
import { fetchTestUserMarkerIds } from "@/lib/testUsers";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const W10 = "6cc59d70-3aa6-4823-8854-5b82691d1a84"; // 2026-spring W10
const W11 = "67e07106-564e-4dab-b180-8f11c909973a"; // 2026-spring W11
const W13 = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc"; // 2026-spring W13

async function main() {
  const testIds = await fetchTestUserMarkerIds();

  // ── 1) activity_type_id='calendar' 전수 (어떤 필터도 없이) ──
  const { data: calLines, error } = await sb
    .from("cluster4_lines")
    .select(
      "id,part_type,activity_type_id,line_code,week_id,main_title,is_active,created_at,opened_at",
    )
    .eq("activity_type_id", "calendar");
  if (error) throw new Error(error.message);
  const lines = (calLines ?? []) as Array<Record<string, unknown>>;
  console.log(`\n=== activity_type_id='calendar' 라인 전수: ${lines.length}건 ===`);
  for (const l of lines) {
    console.log(
      `  part=${l.part_type} active=${l.is_active} code=${l.line_code} week_id=${String(l.week_id ?? "—").slice(0, 8)} title="${l.main_title}" id=${l.id}`,
    );
  }

  // ── 2) 그 라인들의 타깃 → 어느 주차에 걸려있나 ──
  const lineIds = lines.map((l) => String(l.id));
  if (lineIds.length) {
    const { data: tg } = await sb
      .from("cluster4_line_targets")
      .select("line_id,week_id,target_mode,target_user_id")
      .in("line_id", lineIds);
    const targets = (tg ?? []) as Array<{
      line_id: string;
      week_id: string;
      target_mode: string;
      target_user_id: string | null;
    }>;
    // 주차별 라벨.
    const weekIds = Array.from(new Set(targets.map((t) => t.week_id)));
    const { data: wRows } = await sb
      .from("weeks")
      .select("id,season_key,week_number")
      .in("id", weekIds);
    const wLabel = new Map(
      ((wRows ?? []) as Array<{ id: string; season_key: string; week_number: number }>).map(
        (w) => [w.id, `${w.season_key} W${w.week_number}`],
      ),
    );
    console.log(`\n=== 캘린더 타깃 → 주차 분포 (${targets.length}건) ===`);
    const byWeek = new Map<string, { user: number; rule: number; test: number; real: number }>();
    for (const t of targets) {
      const key = wLabel.get(t.week_id) ?? t.week_id;
      const b = byWeek.get(key) ?? { user: 0, rule: 0, test: 0, real: 0 };
      if (t.target_mode === "user") {
        b.user++;
        if (t.target_user_id && testIds.has(t.target_user_id)) b.test++;
        else if (t.target_user_id) b.real++;
      } else b.rule++;
      byWeek.set(key, b);
    }
    for (const [k, b] of byWeek) {
      console.log(
        `  ${k}: user타깃 ${b.user} (test ${b.test}/real ${b.real}) · rule(sentinel) ${b.rule}`,
      );
    }
  }

  // ── 3) 실제 결과 DTO (admin 화면 SoT) — W10/W11/W13, 통합/encre 둘 다 ──
  for (const [label, wid] of [["W10", W10], ["W11", W11], ["W13", W13]] as const) {
    for (const org of [null, "encre"] as const) {
      const dto = await getInfoLineResultsForWeek({ weekId: wid, organization: org });
      const cal = dto.lines.find((l) => l.activityTypeId === "calendar");
      console.log(
        `\n[결과DTO ${label} org=${org ?? "통합"}] ${dto.weekLabel} | 캘린더: status=${cal?.status} lineId=${cal?.lineId ?? "—"} title="${cal?.mainTitle ?? "—"}" target=${cal?.targetCount ?? "—"}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
