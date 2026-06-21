/**
 * backfill-calendar-lines.ts
 *
 * 실무정보 '캘린더' 라인 백필 — 2025-winter W1 ~ 2026-spring W11 연속 범위에서 활성 캘린더
 * 라인이 없는 주차에, 기존 시리즈(info-OK-calendar-*, oranke, excel_import recurring)와
 * 동일한 형태의 활성 라인을 생성한다.
 *
 * 정책(사용자 확정 2026-06-21):
 *   - org = oranke (line_code = info-OK-calendar-{iso_year}w{iso_week2}).
 *   - 타깃 0개 (시리즈 표준). 고객 weekly-card 의 openedByWeek/분모 A 는 둘 다 target 기반이라
 *     0-target 라인은 고객 무영향 — admin '주차별 개설 결과' 보드만 '개설 완료'로 전환된다.
 *   - 콘텐츠 = canonical(오랑캐 카페 24106 + notion ORANKALENDAR), 시리즈 21개 콘텐츠주와 동일.
 *   - main_title / source_type / recurring 메타 / submission window = import 시리즈와 동일.
 *
 * 멱등: 이미 활성 캘린더 라인이 있는 주차(W10/W11 포함)는 건너뛴다(중복 생성 금지).
 * 기존 라인/타깃/비활성 구버전 라인은 일절 건드리지 않는다.
 *
 * 실행(미리보기):  npx tsx --env-file=.env.local scripts/backfill-calendar-lines.ts
 * 실행(반영):      npx tsx --env-file=.env.local scripts/backfill-calendar-lines.ts --execute
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { resolvePeriodLabelFromWeek } from "@/lib/cluster4PeriodLabel";
import { getInfoLineResultsForWeek } from "@/lib/adminCluster4InfoLineResults";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const EXECUTE = process.argv.includes("--execute");
const RANGE_START = "2024-12-30"; // 2025-winter W1 시작
const RANGE_END = "2026-05-17"; // 2026-spring W11 종료
const DAY_MS = 86_400_000;

// canonical 캘린더 콘텐츠(시리즈 21개 콘텐츠주와 byte-동일).
const CANONICAL_LINKS = [
  { url: "https://cafe.naver.com/oranke/24106", label: "[캘린더] 진행장소" },
  {
    url: "https://peppermint-geese-bc8.notion.site/ORANKALENDAR-152de44d123881a08538f2e19002da0b?pvs=4",
    label: "[캘린더] 클럽 공식 캘린더",
  },
];
const MAIN_TITLE = "관심있는 산업/직무 분야에서 정보를 얻을 수 있는 어떤 일정들이 있을까?";
const SOURCE_FILE = "backfill-calendar-lines.ts";
const SHEET = "캘린더";

// import-info-lines-xlsx.ts 와 동일한 기입기간(귀속 주차 = week_id 주차) 공식.
//   opens  = 주차 시작(월) 00:00 KST = -9h UTC
//   closes = 주차 수요일 22:00 KST = +2d +22h -9h UTC
function submissionWindowForWeek(startDate: string): {
  submission_opens_at: string;
  submission_closes_at: string;
} {
  const weekStartMs = Date.UTC(
    Number(startDate.slice(0, 4)),
    Number(startDate.slice(5, 7)) - 1,
    Number(startDate.slice(8, 10)),
  );
  const wednesdayMs = weekStartMs + 2 * DAY_MS;
  return {
    submission_opens_at: new Date(weekStartMs - 9 * 3600_000).toISOString(),
    submission_closes_at: new Date(wednesdayMs + 22 * 3600_000 - 9 * 3600_000).toISOString(),
  };
}

type WeekRow = {
  id: string;
  season_key: string;
  week_number: number;
  start_date: string;
  end_date: string;
  iso_year: number;
  iso_week: number;
  is_official_rest: boolean | null;
};

async function main() {
  console.log(`════ 캘린더 라인 백필 ${EXECUTE ? "(EXECUTE)" : "(DRY-RUN)"} ════`);
  console.log(`범위: ${RANGE_START} ~ ${RANGE_END}`);

  // 1) 범위 weeks.
  const { data: wRows } = await sb
    .from("weeks")
    .select("id,season_key,week_number,start_date,end_date,iso_year,iso_week,is_official_rest")
    .gte("start_date", RANGE_START)
    .lte("start_date", RANGE_END)
    .order("start_date", { ascending: true });
  const weeks = (wRows ?? []) as WeekRow[];

  // 2) 이미 활성 캘린더 라인이 있는 week_id 집합.
  const { data: lRows } = await sb
    .from("cluster4_lines")
    .select("week_id")
    .eq("part_type", "info")
    .eq("activity_type_id", "calendar")
    .eq("is_active", true)
    .not("week_id", "is", null);
  const hasActive = new Set(
    ((lRows ?? []) as Array<{ week_id: string }>).map((r) => r.week_id),
  );

  // 3) 결손 주차.
  const missing = weeks.filter((w) => !hasActive.has(w.id));
  console.log(`\n결손 주차: ${missing.length}건`);
  for (const w of missing) {
    console.log(`  ${w.season_key} W${w.week_number} iso=${w.iso_year}w${String(w.iso_week).padStart(2, "0")} [${w.start_date}~${w.end_date}] rest=${w.is_official_rest ?? false}`);
  }
  if (missing.length === 0) {
    console.log("\n결손 없음 — 종료.");
    return;
  }

  // 4) 각 결손 주차에 대한 payload.
  const payloads = missing.map((w) => {
    const code = `info-OK-calendar-${w.iso_year}w${String(w.iso_week).padStart(2, "0")}`;
    const win = submissionWindowForWeek(w.start_date);
    return {
      week: w,
      code,
      payload: {
        part_type: "info" as const,
        activity_type_id: "calendar",
        line_code: code,
        main_title: MAIN_TITLE,
        output_link_1: CANONICAL_LINKS[0].url,
        output_link_2: CANONICAL_LINKS[1].url,
        output_links: CANONICAL_LINKS,
        output_images: [] as unknown[],
        submission_opens_at: win.submission_opens_at,
        submission_closes_at: win.submission_closes_at,
        is_active: true,
        source_type: "excel_import",
        recognition_mode: "legacy_allowed",
        is_readonly: false,
        period_label: resolvePeriodLabelFromWeek({
          isoYear: w.iso_year,
          seasonKey: w.season_key,
          weekNumber: w.week_number,
        }),
        start_date: w.start_date,
        end_date: w.end_date,
        week_id: w.id,
        source_file_name: SOURCE_FILE,
        source_sheet_name: SHEET,
        is_recurring_content: true,
        recurring_source_sheet_name: SHEET,
      },
    };
  });

  // 5) line_code 충돌 가드(이미 같은 code 가 있으면 중단).
  const codes = payloads.map((p) => p.code);
  const { data: codeRows } = await sb
    .from("cluster4_lines")
    .select("id,line_code,is_active")
    .in("line_code", codes);
  if ((codeRows ?? []).length > 0) {
    console.error(`\n⛔ 이미 존재하는 line_code 발견 — 중단:`);
    for (const r of codeRows as Array<{ line_code: string; is_active: boolean }>) {
      console.error(`   ${r.line_code} (active=${r.is_active})`);
    }
    process.exit(1);
  }

  console.log(`\n생성 예정: ${payloads.length}건 (타깃 0개, org=oranke, canonical 콘텐츠)`);
  console.log(`예시 payload:\n${JSON.stringify(payloads[0].payload, null, 2)}`);

  if (!EXECUTE) {
    console.log(`\n[DRY-RUN] write 없이 종료. 반영하려면 --execute.`);
    return;
  }

  // 6) insert.
  const { data: inserted, error } = await sb
    .from("cluster4_lines")
    .insert(payloads.map((p) => p.payload))
    .select("id,line_code,week_id");
  if (error) {
    console.error(`\n⛔ insert 실패: ${error.message}`);
    process.exit(1);
  }
  console.log(`\n✅ ${(inserted ?? []).length}건 insert 완료.`);
  for (const r of (inserted ?? []) as Array<{ id: string; line_code: string; week_id: string }>) {
    console.log(`   ${r.line_code} week=${r.week_id} id=${r.id}`);
  }

  // 7) 즉시 검증 — getInfoLineResultsForWeek(통합) 에서 캘린더 opened 확인.
  console.log(`\n──── 검증: getInfoLineResultsForWeek(통합) 캘린더 status ────`);
  let okCount = 0;
  for (const p of payloads) {
    const dto = await getInfoLineResultsForWeek({ weekId: p.week.id, organization: null });
    const cal = dto.lines.find((l) => l.activityTypeId === "calendar");
    const ok = cal?.status === "opened";
    if (ok) okCount++;
    console.log(`   ${ok ? "✅" : "❌"} ${dto.weekLabel}: status=${cal?.status} lineId=${cal?.lineId ?? "—"}`);
  }
  console.log(`\n검증 결과: ${okCount}/${payloads.length} opened`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
