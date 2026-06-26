/**
 * 진단(read-only): '26 여름 최종.xlsx' 전 시트/행 덤프 + 정규화.
 *   npx tsx scripts/diag-read-summer-final-xlsx.ts ["<xlsx 경로>"]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const XLSX = process.argv[2] || "C:/Users/vanua/OneDrive/Desktop/26 여름 최종.xlsx";
const line = (s = "") => console.log(s);

function decodeXml(v: string) {
  return v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
function attr(tag: string, name: string) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
}
function textOf(xml: string, t: string) {
  const ms = [...xml.matchAll(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "g"))];
  return ms.map((m) => m[1].replace(/<[^>]+>/g, "")).join("");
}
function colIdx(ref: string) {
  const L = ref.replace(/[0-9]/g, "").toUpperCase();
  let v = 0;
  for (const c of L) v = v * 26 + (c.charCodeAt(0) - 64);
  return v - 1;
}
function extractXlsx(fp: string): string {
  const out = join(tmpdir(), `summer-final-${Date.now()}`);
  mkdirSync(out, { recursive: true });
  const script = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "[System.IO.Compression.ZipFile]::ExtractToDirectory($env:VRAXIUM_XLSX_ZIP_PATH, $env:VRAXIUM_XLSX_DEST_PATH)",
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
    stdio: "pipe", env: { ...process.env, VRAXIUM_XLSX_ZIP_PATH: fp, VRAXIUM_XLSX_DEST_PATH: out },
  });
  return out;
}
function parseSharedStrings(root: string): string[] {
  const p = join(root, "xl", "sharedStrings.xml");
  if (!existsSync(p)) return [];
  const xml = readFileSync(p, "utf8");
  const s: string[] = [];
  for (const m of xml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)) s.push(decodeXml(textOf(m[1], "t").replace(/\s+/g, " ").trim()));
  return s;
}
function parseSheetRows(xml: string, ss: string[]): Record<number, string>[] {
  const rows: Record<number, string>[] = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: Record<number, string> = {};
    for (const cm of rm[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const ref = attr(`<c ${cm[1]}>`, "r");
      if (!ref) continue;
      const type = attr(`<c ${cm[1]}>`, "t");
      const val = textOf(cm[2], "v");
      let txt = val;
      if (type === "s" && val !== "") txt = ss[Number(val)] ?? "";
      else if (type === "inlineStr") txt = textOf(cm[2], "t");
      row[colIdx(ref)] = decodeXml(txt).replace(/\s+/g, " ").trim();
    }
    rows.push(row);
  }
  return rows;
}
function parseSheets(root: string) {
  const wb = readFileSync(join(root, "xl/workbook.xml"), "utf8");
  const rels = readFileSync(join(root, "xl/_rels/workbook.xml.rels"), "utf8");
  const ss = parseSharedStrings(root);
  const rel = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id"), t = attr(m[0], "Target");
    if (id && t) rel.set(id, t);
  }
  const out: Array<{ name: string; rows: Record<number, string>[] }> = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], "name"), rid = attr(m[0], "r:id");
    if (!name || !rid) continue;
    const tgt = rel.get(rid);
    if (!tgt) continue;
    const sp = tgt.startsWith("/") ? tgt.slice(1) : join("xl", tgt).replace(/\\/g, "/");
    out.push({ name, rows: parseSheetRows(readFileSync(join(root, sp), "utf8"), ss) });
  }
  return out;
}

function main() {
  if (!existsSync(XLSX)) throw new Error(`파일 없음: ${XLSX}`);
  const root = extractXlsx(XLSX);
  const sheets = parseSheets(root);
  const dump: any = { file: XLSX, sheets: [] };
  for (const sh of sheets) {
    line("═".repeat(70));
    line(`시트: ${sh.name}  (행 ${sh.rows.length})`);
    line("═".repeat(70));
    const maxCol = Math.max(0, ...sh.rows.map((r) => Math.max(-1, ...Object.keys(r).map(Number))));
    const tableRows: string[][] = [];
    sh.rows.forEach((r, i) => {
      const cells: string[] = [];
      for (let c = 0; c <= maxCol; c++) cells.push(r[c] ?? "");
      tableRows.push(cells);
      if (i < 60) line(`  [${String(i).padStart(3)}] ${cells.map((c) => c || "·").join(" | ")}`);
    });
    if (sh.rows.length > 60) line(`  ... (총 ${sh.rows.length}행)`);
    dump.sheets.push({ name: sh.name, maxCol: maxCol + 1, rows: tableRows });
  }
  writeFileSync("claudedocs/summer-final-xlsx-dump.json", JSON.stringify(dump, null, 1));
  line(`\n→ claudedocs/summer-final-xlsx-dump.json`);
}
main();
