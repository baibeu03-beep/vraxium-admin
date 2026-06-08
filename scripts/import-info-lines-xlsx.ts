import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createClient } from "@supabase/supabase-js";
import { resolvePeriodLabelFromWeek } from "@/lib/cluster4PeriodLabel";

type Mode = "weekly" | "recurring_weekly";

type SheetSpec = {
  sheetName: string;
  activityTypeId: "wisdom" | "essay" | "forum" | "infodesk" | "calendar";
  mode: Mode;
};

type WeekRow = {
  id: string;
  start_date: string;
  end_date: string;
  iso_year: number | null;
  iso_week: number | null;
  week_number: number | null;
  season_key: string | null;
  is_official_rest: boolean | null;
};

type ImportCandidate = {
  activityTypeId: string;
  sheetName: string;
  mode: Mode;
  rowNumber: number;
  periodLabel: string | null;
  startDate: string;
  endDate: string;
  weekId: string;
  weekLabel: string;
  mainTitle: string;
  outputLinks: OutputLink[];
  sourceType: "excel_import";
  recognitionMode: "legacy_allowed";
  isReadonly: false;
  isRecurringContent: boolean;
  recurringSourceSheetName: string | null;
};

type OutputLink = {
  label: string | null;
  url: string;
};

type Failure = {
  sheetName: string;
  activityTypeId: string;
  rowNumber: number | null;
  periodLabel?: string;
  startDate?: string | null;
  endDate?: string | null;
  mainTitle?: string | null;
  reason: string;
};

type Duplicate = {
  sheetName: string;
  activityTypeId: string;
  rowNumber: number;
  weekId: string;
  weekLabel: string;
  startDate: string;
  mainTitle: string;
  existingLineId: string;
  action: "upsert_update";
};

type ImportActionResult = {
  row: ImportCandidate;
  lineId: string | null;
  action: "inserted" | "updated" | "skipped" | "failed";
  error?: string;
};

type SheetData = {
  name: string;
  rows: Record<number, string>[];
};

const SHEETS: SheetSpec[] = [
  { sheetName: "위즈덤 (수정)", activityTypeId: "wisdom", mode: "weekly" },
  { sheetName: "에세이(수정)", activityTypeId: "essay", mode: "weekly" },
  { sheetName: "포럼 (수정)", activityTypeId: "forum", mode: "weekly" },
  { sheetName: "씽크탱크", activityTypeId: "infodesk", mode: "recurring_weekly" },
  { sheetName: "캘린더", activityTypeId: "calendar", mode: "recurring_weekly" },
];

const WEEKLY_ACTIVITY_TYPES = new Set(["wisdom", "essay", "forum"]);
const DAY_MS = 86_400_000;

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

function hasArg(name: string): boolean {
  return process.argv.includes(name);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Run with --env-file=.env.local if needed.`);
  }
  return value;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : null;
}

function textOf(xml: string, tagName: string): string {
  const matches = [...xml.matchAll(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, "g"))];
  return matches.map((m) => m[1].replace(/<[^>]+>/g, "")).join("");
}

function columnIndex(cellRef: string): number {
  const letters = cellRef.replace(/[0-9]/g, "").toUpperCase();
  let value = 0;
  for (const ch of letters) {
    value = value * 26 + (ch.charCodeAt(0) - 64);
  }
  return value - 1;
}

function extractXlsx(filePath: string): string {
  const outDir = join(tmpdir(), `vraxium-info-lines-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(outDir, { recursive: true });
  const script = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$zip = $env:VRAXIUM_XLSX_ZIP_PATH",
    "$dest = $env:VRAXIUM_XLSX_DEST_PATH",
    "[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $dest)",
  ].join("; ");
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        VRAXIUM_XLSX_ZIP_PATH: filePath,
        VRAXIUM_XLSX_DEST_PATH: outDir,
      },
    },
  );
  return outDir;
}

function readXml(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function parseSharedStrings(root: string): string[] {
  const path = join(root, "xl", "sharedStrings.xml");
  if (!existsSync(path)) return [];
  const xml = readFileSync(path, "utf8");
  const strings: string[] = [];
  for (const match of xml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)) {
    const raw = match[1];
    const text = textOf(raw, "t").replace(/\s+/g, " ").trim();
    strings.push(decodeXml(text));
  }
  return strings;
}

function parseSheets(root: string): SheetData[] {
  const workbook = readXml(root, "xl/workbook.xml");
  const rels = readXml(root, "xl/_rels/workbook.xml.rels");
  const sharedStrings = parseSharedStrings(root);

  const relTargetById = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0];
    const id = attr(tag, "Id");
    const target = attr(tag, "Target");
    if (id && target) relTargetById.set(id, target);
  }

  const sheets: SheetData[] = [];
  for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const tag = match[0];
    const name = attr(tag, "name");
    const relId = attr(tag, "r:id");
    if (!name || !relId) continue;
    const target = relTargetById.get(relId);
    if (!target) continue;
    const sheetPath = target.startsWith("/")
      ? target.slice(1)
      : join("xl", target).replace(/\\/g, "/");
    const xml = readXml(root, sheetPath);
    sheets.push({ name, rows: parseSheetRows(xml, sharedStrings) });
  }
  return sheets;
}

function parseSheetRows(xml: string, sharedStrings: string[]): Record<number, string>[] {
  const rows: Record<number, string>[] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowXml = rowMatch[1];
    const row: Record<number, string> = {};
    for (const cellMatch of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const cellAttrs = cellMatch[1];
      const cellXml = cellMatch[2];
      const ref = attr(`<c ${cellAttrs}>`, "r");
      if (!ref) continue;
      const type = attr(`<c ${cellAttrs}>`, "t");
      const value = textOf(cellXml, "v");
      let cellText = value;
      if (type === "s" && value !== "") {
        cellText = sharedStrings[Number(value)] ?? "";
      } else if (type === "inlineStr") {
        cellText = textOf(cellXml, "t");
      }
      row[columnIndex(ref)] = decodeXml(cellText).replace(/\s+/g, " ").trim();
    }
    rows.push(row);
  }
  return rows;
}

function excelSerialToIso(value: number): string {
  const base = Date.UTC(1899, 11, 30);
  return new Date(base + value * DAY_MS).toISOString().slice(0, 10);
}

function parseDate(value: string | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 20000 && asNumber < 80000) {
    return excelSerialToIso(Math.floor(asNumber));
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const ms = Date.UTC(
    Number(isoDate.slice(0, 4)),
    Number(isoDate.slice(5, 7)) - 1,
    Number(isoDate.slice(8, 10)),
  );
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

function findColumn(headers: Record<number, string>, pattern: RegExp): number | null {
  for (const [index, label] of Object.entries(headers)) {
    if (pattern.test(label)) return Number(index);
  }
  return null;
}

function isBlankRow(row: Record<number, string>): boolean {
  return Object.values(row).every((value) => !String(value ?? "").trim());
}

function isRestOrEmptyTitle(title: string): boolean {
  return /휴식|없음/.test(title);
}

function parseOutputLinks(raw: string): OutputLink[] {
  const text = raw.trim();
  if (!text || text === "(아웃풋 링크 없음)") return [];
  const urlRegex = /https?:\/\/[^\s\[]+/g;
  const matches = [...text.matchAll(urlRegex)];
  const links: OutputLink[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const url = match[0].replace(/[),.;]+$/g, "");
    const labelStart = i === 0 ? 0 : (matches[i - 1].index ?? 0) + matches[i - 1][0].length;
    const label = text.slice(labelStart, match.index).replace(/[:：\s]+$/g, "").trim();
    links.push({ label: label || null, url });
  }
  return links;
}

function weekLabel(week: WeekRow): string {
  if (week.iso_year && week.iso_week) {
    return `${week.iso_year}-W${String(week.iso_week).padStart(2, "0")}`;
  }
  return `${week.start_date}~${week.end_date}`;
}

// period_label SoT: Excel 셀(직접 입력)이나 ISO weekLabel 을 신뢰하지 않고, 항상 week 행의
// iso_year(YY) + season_key(시즌명) + week_number(N) 에서 "{YY} {시즌명} {N}주차" 로 생성한다.
// ⛔ start_date 계산 금지. 세 값 중 하나라도 없으면 null(period_label 미기입).
function periodLabelForWeek(week: WeekRow): string | null {
  return resolvePeriodLabelFromWeek({
    isoYear: week.iso_year,
    seasonKey: week.season_key,
    weekNumber: week.week_number,
  });
}

function findWeekByStartDate(weeks: WeekRow[], startDate: string): WeekRow | null {
  return weeks.find((week) => week.start_date === startDate) ?? null;
}

function findWeekByDateRange(weeks: WeekRow[], startDate: string, endDate: string): WeekRow | null {
  return weeks.find((week) => week.start_date === startDate && week.end_date === endDate) ?? null;
}

function buildSheetRows(sheet: SheetData): Array<{ rowNumber: number; values: Record<number, string> }> {
  return sheet.rows
    .map((row, index) => ({ rowNumber: index + 1, values: row }))
    .filter((entry) => entry.rowNumber > 1 && !isBlankRow(entry.values));
}

function existingKey(row: Pick<ImportCandidate, "activityTypeId" | "weekId" | "mainTitle">): string {
  return `${row.activityTypeId}\u0000${row.weekId}\u0000${row.mainTitle}`;
}

async function main() {
  const file = argValue("--file");
  if (!file) throw new Error("--file is required");
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  const execute = hasArg("--execute");

  const supabase = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } },
  );

  const { data: weeksData, error: weeksError } = await supabase
    .from("weeks")
    .select("id,start_date,end_date,iso_year,iso_week,week_number,season_key,is_official_rest")
    .order("start_date", { ascending: true });
  if (weeksError) throw new Error(`weeks query failed: ${weeksError.message}`);
  const weeks = (weeksData ?? []) as WeekRow[];

  const tempDir = extractXlsx(file);
  try {
    const allSheets = parseSheets(tempDir);
    const sheetByName = new Map(allSheets.map((sheet) => [sheet.name, sheet]));
    const failures: Failure[] = [];
    const weeklyCandidates: ImportCandidate[] = [];
    const weeklyParsedRanges: Array<{ startDate: string; endDate: string }> = [];
    const recurringTemplateRows: Array<{
      spec: SheetSpec;
      rowNumber: number;
      mainTitle: string;
      outputLinks: OutputLink[];
    }> = [];

    for (const spec of SHEETS) {
      const sheet = sheetByName.get(spec.sheetName);
      if (!sheet) {
        failures.push({
          sheetName: spec.sheetName,
          activityTypeId: spec.activityTypeId,
          rowNumber: null,
          reason: "required sheet not found",
        });
        continue;
      }

      const headers = sheet.rows[0] ?? {};
      const periodCol = findColumn(headers, /주차|기간|날짜/i);
      const startCol = findColumn(headers, /시작일/i);
      const titleCol = findColumn(headers, /Main Title|메인/i);
      const linkCol = findColumn(headers, /Output|아웃풋/i);

      if (periodCol === null || titleCol === null || linkCol === null) {
        failures.push({
          sheetName: spec.sheetName,
          activityTypeId: spec.activityTypeId,
          rowNumber: 1,
          reason: "required columns not found",
        });
        continue;
      }

      for (const entry of buildSheetRows(sheet)) {
        const periodLabel = entry.values[periodCol] ?? "";
        const mainTitle = (entry.values[titleCol] ?? "").trim();
        const outputLinks = parseOutputLinks(entry.values[linkCol] ?? "");

        if (!mainTitle) {
          failures.push({
            sheetName: spec.sheetName,
            activityTypeId: spec.activityTypeId,
            rowNumber: entry.rowNumber,
            periodLabel,
            mainTitle,
            reason: "main_title is empty",
          });
          continue;
        }
        if (isRestOrEmptyTitle(mainTitle)) {
          failures.push({
            sheetName: spec.sheetName,
            activityTypeId: spec.activityTypeId,
            rowNumber: entry.rowNumber,
            periodLabel,
            mainTitle,
            reason: "휴식/없음 row는 import 제외",
          });
          continue;
        }

        if (spec.mode === "recurring_weekly") {
          recurringTemplateRows.push({
            spec,
            rowNumber: entry.rowNumber,
            mainTitle,
            outputLinks,
          });
          continue;
        }

        const startDate = startCol === null ? null : parseDate(entry.values[startCol]);
        if (!startDate) {
          failures.push({
            sheetName: spec.sheetName,
            activityTypeId: spec.activityTypeId,
            rowNumber: entry.rowNumber,
            periodLabel,
            startDate,
            mainTitle,
            reason: "start_date parse failed",
          });
          continue;
        }

        const endDate = addDays(startDate, 6);
        weeklyParsedRanges.push({ startDate, endDate });
        const week = findWeekByStartDate(weeks, startDate);
        if (!week) {
          failures.push({
            sheetName: spec.sheetName,
            activityTypeId: spec.activityTypeId,
            rowNumber: entry.rowNumber,
            periodLabel,
            startDate,
            endDate,
            mainTitle,
            reason: "weeks row 매칭 실패",
          });
          continue;
        }

        weeklyCandidates.push({
          activityTypeId: spec.activityTypeId,
          sheetName: spec.sheetName,
          mode: spec.mode,
          rowNumber: entry.rowNumber,
          // 직접 입력값(Excel 셀)을 신뢰하지 않고 week 기준 정규 표기로 생성한다.
          periodLabel: periodLabelForWeek(week),
          startDate: week.start_date,
          endDate: week.end_date,
          weekId: week.id,
          weekLabel: weekLabel(week),
          mainTitle,
          outputLinks,
          sourceType: "excel_import",
          recognitionMode: "legacy_allowed",
          isReadonly: false,
          isRecurringContent: false,
          recurringSourceSheetName: null,
        });
      }
    }

    const weeklyDates = weeklyParsedRanges.map((row) => row.startDate).sort();
    const minStartDate = weeklyDates[0] ?? null;
    const maxEndDate = weeklyParsedRanges.map((row) => row.endDate).sort().at(-1) ?? null;
    const recurringWeeks =
      minStartDate && maxEndDate
        ? weeks.filter((week) => week.start_date >= minStartDate && week.end_date <= maxEndDate)
        : [];

    const recurringCandidates: ImportCandidate[] = [];
    for (const template of recurringTemplateRows) {
      for (const week of recurringWeeks) {
        recurringCandidates.push({
          activityTypeId: template.spec.activityTypeId,
          sheetName: template.spec.sheetName,
          mode: template.spec.mode,
          rowNumber: template.rowNumber,
          // 반복 콘텐츠도 동일하게 week 기준 정규 표기(구: ISO weekLabel)로 생성한다.
          periodLabel: periodLabelForWeek(week),
          startDate: week.start_date,
          endDate: week.end_date,
          weekId: week.id,
          weekLabel: weekLabel(week),
          mainTitle: template.mainTitle,
          outputLinks: template.outputLinks,
          sourceType: "excel_import",
          recognitionMode: "legacy_allowed",
          isReadonly: false,
          isRecurringContent: true,
          recurringSourceSheetName: template.spec.sheetName,
        });
      }
    }

    const candidates = [...weeklyCandidates, ...recurringCandidates];
    const activityTypeIds = Array.from(new Set(candidates.map((row) => row.activityTypeId)));
    const weekIds = Array.from(new Set(candidates.map((row) => row.weekId)));
    const { data: existingData, error: existingError } =
      activityTypeIds.length > 0 && weekIds.length > 0
        ? await supabase
            .from("cluster4_lines")
            .select("id,activity_type_id,week_id,main_title")
            .eq("part_type", "info")
            .eq("source_type", "excel_import")
            .in("activity_type_id", activityTypeIds)
            .in("week_id", weekIds)
        : { data: [], error: null };
    const schemaWarnings: string[] = [];
    if (existingError && existingError.code === "42703") {
      schemaWarnings.push(
        "cluster4_lines import metadata columns are not applied yet; duplicate/upsert detection was skipped.",
      );
    } else if (existingError) {
      throw new Error(`existing import line query failed: ${existingError.message}`);
    }

    const existingByKey = new Map<string, { id: string }>();
    for (const row of (!existingError ? existingData ?? [] : []) as Array<{
      id: string;
      activity_type_id: string;
      week_id: string;
      main_title: string;
    }>) {
      existingByKey.set(
        `${row.activity_type_id}\u0000${row.week_id}\u0000${row.main_title}`,
        { id: row.id },
      );
    }

    const duplicates: Duplicate[] = [];
    for (const row of candidates) {
      const existing = existingByKey.get(existingKey(row));
      if (!existing) continue;
      duplicates.push({
        sheetName: row.sheetName,
        activityTypeId: row.activityTypeId,
        rowNumber: row.rowNumber,
        weekId: row.weekId,
        weekLabel: row.weekLabel,
        startDate: row.startDate,
        mainTitle: row.mainTitle,
        existingLineId: existing.id,
        action: "upsert_update",
      });
    }

    const importableRows = candidates.length;
    const byActivityType = SHEETS.map((spec) => {
      const rows = candidates.filter((row) => row.activityTypeId === spec.activityTypeId);
      const specFailures = failures.filter((row) => row.activityTypeId === spec.activityTypeId);
      const specDuplicates = duplicates.filter((row) => row.activityTypeId === spec.activityTypeId);
      return {
        activityTypeId: spec.activityTypeId,
        sheetName: spec.sheetName,
        mode: spec.mode,
        importableRows: rows.length,
        recurringGeneratedRows: rows.filter((row) => row.isRecurringContent).length,
        duplicateRows: specDuplicates.length,
        failedRows: specFailures.length,
      };
    });

    const dryRunOutput = {
      mode: "dry-run",
      file: basename(file),
      targetCreation: {
        enabled: false,
        targetRowsToCreate: 0,
        reason: "Excel에는 사용자 식별 정보가 없으므로 cluster4_line_targets를 생성하지 않음",
      },
      selectedSheets: SHEETS,
      schemaWarnings,
      recurringWeekRange: {
        source: "weekly sheets minimum start_date through maximum end_date",
        minStartDate,
        maxEndDate,
        matchedWeeks: recurringWeeks.length,
      },
      summary: {
        totalImportPlannedRows: importableRows,
        weeklyImportPlannedRows: weeklyCandidates.length,
        recurringImportPlannedRows: recurringCandidates.length,
        recurringTemplateRows: recurringTemplateRows.length,
        duplicateOrUpsertRows: duplicates.length,
        failedRows: failures.length,
      },
      byActivityType,
      weekMatchFailures: failures.filter((row) => row.reason === "weeks row 매칭 실패"),
      restExcludedRows: failures.filter((row) => row.reason === "휴식/없음 row는 import 제외"),
      failures,
      duplicates,
      sampleImportRows: candidates.slice(0, 10),
    };

    if (!execute) {
      console.log(JSON.stringify(dryRunOutput, null, 2));
      return;
    }

    const results = await executeImportRows({
      supabase,
      rows: candidates,
      existingByKey,
      fileName: basename(file),
    });
    const inserted = results.filter((row) => row.action === "inserted");
    const updated = results.filter((row) => row.action === "updated");
    const skipped = results.filter((row) => row.action === "skipped");
    const failed = results.filter((row) => row.action === "failed");

    const executeByActivityType = SHEETS.map((spec) => {
      const rows = results.filter((row) => row.row.activityTypeId === spec.activityTypeId);
      return {
        activityTypeId: spec.activityTypeId,
        sheetName: spec.sheetName,
        mode: spec.mode,
        insertedRows: rows.filter((row) => row.action === "inserted").length,
        updatedRows: rows.filter((row) => row.action === "updated").length,
        skippedRows: rows.filter((row) => row.action === "skipped").length,
        failedRows: rows.filter((row) => row.action === "failed").length,
      };
    });

    const executeOutput = {
      mode: "execute",
      file: basename(file),
      targetCreation: dryRunOutput.targetCreation,
      dryRunSummary: dryRunOutput.summary,
      insertedRows: inserted.length,
      updatedRows: updated.length,
      skippedRows: skipped.length,
      failedRows: failed.length,
      byActivityType: executeByActivityType,
      sampleInsertedRows: inserted.slice(0, 10).map((result) => ({
        lineId: result.lineId,
        activityTypeId: result.row.activityTypeId,
        sheetName: result.row.sheetName,
        weekId: result.row.weekId,
        weekLabel: result.row.weekLabel,
        mainTitle: result.row.mainTitle,
      })),
      failures: failed.map((result) => ({
        activityTypeId: result.row.activityTypeId,
        sheetName: result.row.sheetName,
        rowNumber: result.row.rowNumber,
        weekId: result.row.weekId,
        mainTitle: result.row.mainTitle,
        error: result.error ?? "unknown error",
      })),
    };

    console.log(JSON.stringify(executeOutput, null, 2));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

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

function linePayload(row: ImportCandidate, fileName: string) {
  const links = row.outputLinks.slice(0, 2);
  const window = submissionWindowForWeek(row.startDate);
  return {
    part_type: "info",
    activity_type_id: row.activityTypeId,
    main_title: row.mainTitle,
    output_link_1: links[0]?.url ?? null,
    output_link_2: links[1]?.url ?? null,
    output_links: links,
    output_images: [],
    submission_opens_at: window.submission_opens_at,
    submission_closes_at: window.submission_closes_at,
    is_active: true,
    source_type: row.sourceType,
    recognition_mode: row.recognitionMode,
    is_readonly: row.isReadonly,
    period_label: row.periodLabel,
    start_date: row.startDate,
    end_date: row.endDate,
    week_id: row.weekId,
    source_file_name: fileName,
    source_sheet_name: row.sheetName,
    is_recurring_content: row.isRecurringContent,
    recurring_source_sheet_name: row.recurringSourceSheetName,
  };
}

async function executeImportRows({
  supabase,
  rows,
  existingByKey,
  fileName,
}: {
  supabase: any;
  rows: ImportCandidate[];
  existingByKey: Map<string, { id: string }>;
  fileName: string;
}): Promise<ImportActionResult[]> {
  const results: ImportActionResult[] = [];

  for (const row of rows) {
    const existing = existingByKey.get(existingKey(row));
    const payload = linePayload(row, fileName);

    if (existing) {
      const { data, error } = await supabase
        .from("cluster4_lines")
        .update(payload)
        .eq("id", existing.id)
        .eq("part_type", "info")
        .eq("source_type", "excel_import")
        .select("id")
        .maybeSingle();

      if (error || !data) {
        results.push({
          row,
          lineId: existing.id,
          action: "failed",
          error: error?.message ?? "existing excel_import row was not updated",
        });
        continue;
      }
      results.push({ row, lineId: data.id as string, action: "updated" });
      continue;
    }

    const { data, error } = await supabase
      .from("cluster4_lines")
      .insert(payload)
      .select("id")
      .single();

    if (error || !data) {
      results.push({
        row,
        lineId: null,
        action: "failed",
        error: error?.message ?? "insert failed",
      });
      continue;
    }
    results.push({ row, lineId: data.id as string, action: "inserted" });
  }

  return results;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
