import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, relative, dirname, resolve, basename } from "path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// /admin 전체 Help Key(요소 단위 도움말, AdminHelpIconButton helpKey) 정적 감사.
//   목적: semantic 공통화 후보 분류를 위한 원시 사실 수집(코드 변경 없음).
//   수집: 라우트/페이지 · 컴포넌트 파일 · 표시 문구(주변) · 현재 helpKey · 대상 종류(휴리스틱)
//         · 주변 문맥(title/label/id/name/인접 텍스트) · 동일 문구/유사 키 · 저장 도움말 존재 여부.
//   실행: npx tsx --env-file=.env.local scripts/audit-admin-help-keys.ts
//   산출: claudedocs/admin-help-keys-audit.json (전체) + 콘솔 요약.

const ROOT = resolve(__dirname, "..");
const SCAN_DIRS = [join(ROOT, "components", "admin"), join(ROOT, "app", "(portal)", "admin")];
const APP_ADMIN = join(ROOT, "app", "(portal)", "admin");

type Occurrence = {
  file: string; // repo-relative
  line: number;
  key: string | null; // null = 동적(런타임 생성)
  dynamicExpr?: string; // 동적일 때 원식
  title?: string; // 인접 title= prop
  label?: string; // 인접 label= prop
  size?: string;
  nearId?: string;
  nearName?: string;
  displayText: string; // 주변 표시 문구(태그 제거, 잘림)
  targetKind: string; // 대상 종류(휴리스틱)
  raw: string; // 해당 라인 원문(trim)
};

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p);
  }
  return out;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/[*_`#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function guessTargetKind(window: string): string {
  const w = window;
  if (/<th\b|columnHelp|column\.|table.*header|<thead/i.test(w)) return "표 컬럼";
  if (/<Label\b|<label\b|htmlFor=|FieldLabel/i.test(w)) return "입력 Label";
  if (/<Select\b|<select\b|SelectTrigger|SelectValue/i.test(w)) return "Select";
  if (/<button\b|<Button\b|onClick=/i.test(w)) return "버튼";
  if (/<h[1-4]\b|SectionTitle|CardTitle|text-lg font|font-semibold text-|섹션/i.test(w)) return "섹션 제목";
  if (/role="tab"|TabsTrigger|<Tab\b/i.test(w)) return "탭";
  return "설명/기타";
}

// ── 1) helpKey 점유 수집 ────────────────────────────────────────────────────
const files = SCAN_DIRS.flatMap((d) => walk(d));
const occurrences: Occurrence[] = [];

const KEY_DQ = /helpKey\s*[=:]\s*\{?\s*"([^"]+)"/;
const KEY_SQ = /helpKey\s*[=:]\s*\{?\s*'([^']+)'/;
const KEY_TPL = /helpKey\s*[=:]\s*\{?\s*`([^`]*)`/;
const KEY_DYN = /helpKey\s*[=:]\s*\{([^}]+)\}/;

for (const abs of files) {
  const rel = relative(ROOT, abs).replace(/\\/g, "/");
  const text = readFileSync(abs, "utf8");
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/helpKey/.test(line)) continue;
    // 같은 줄 + 다음 줄까지 붙여 파싱(줄바꿈 배치 대비)
    const scan = line + "\n" + (lines[i + 1] ?? "");
    let key: string | null = null;
    let dynamicExpr: string | undefined;
    const mdq = scan.match(KEY_DQ);
    const msq = scan.match(KEY_SQ);
    const mtpl = scan.match(KEY_TPL);
    if (mdq) key = mdq[1];
    else if (msq) key = msq[1];
    else if (mtpl && !mtpl[1].includes("${")) key = mtpl[1];
    else {
      const mdyn = scan.match(KEY_DYN) || scan.match(KEY_TPL);
      if (mdyn) {
        dynamicExpr = (mdyn[1] || "").trim();
        // 상수 참조/삼항/템플릿 등 — 동적 처리
        if (/^"[^"]+"$|^'[^']+'$/.test(dynamicExpr)) key = dynamicExpr.slice(1, -1);
      } else {
        // helpKey 라는 단어만 있고 값 배치가 다른 경우(정의/주석 등) 건너뜀
        if (!/helpKey\s*[=:]/.test(line)) continue;
      }
    }
    const winStart = Math.max(0, i - 3);
    const winEnd = Math.min(lines.length, i + 3);
    const window = lines.slice(winStart, winEnd).join("\n");
    const title = scan.match(/title\s*=\s*"([^"]+)"/)?.[1] ?? scan.match(/title\s*=\s*'([^']+)'/)?.[1];
    const label = scan.match(/\blabel\s*=\s*"([^"]+)"/)?.[1];
    const size = scan.match(/size\s*=\s*"([^"]+)"/)?.[1];
    const nearId = window.match(/\bid\s*=\s*"([^"]+)"/)?.[1];
    const nearName = window.match(/\bname\s*=\s*"([^"]+)"/)?.[1];
    occurrences.push({
      file: rel,
      line: i + 1,
      key,
      dynamicExpr,
      title,
      label,
      size,
      nearId,
      nearName,
      displayText: stripTags(window).slice(0, 160),
      targetKind: guessTargetKind(window),
      raw: line.trim().slice(0, 200),
    });
  }
}

// ── 2) 컴포넌트 → 라우트 역참조 그래프 ───────────────────────────────────────
// import 그래프를 만들고 역방향으로 page.tsx 조상까지 도달 라우트를 계산.
const allSrc = SCAN_DIRS.flatMap((d) => walk(d));
// 컴포넌트 전역(components/**)도 import 대상이 될 수 있으니 포함.
const compAll = walk(join(ROOT, "components"));
const universe = Array.from(new Set([...allSrc, ...compAll, ...walk(join(ROOT, "lib"))]));

function resolveImport(fromAbs: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromAbs), spec);
  else return null; // 외부 패키지
  const cands = [
    base + ".tsx",
    base + ".ts",
    join(base, "index.tsx"),
    join(base, "index.ts"),
  ];
  for (const c of cands) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* noop */
    }
  }
  return null;
}

// importedBy: target -> Set(importer)
const importedBy = new Map<string, Set<string>>();
const importRe = /import[^"']*from\s*["']([^"']+)["']/g;
for (const abs of universe) {
  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    continue;
  }
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(text))) {
    const tgt = resolveImport(abs, m[1]);
    if (!tgt) continue;
    if (!importedBy.has(tgt)) importedBy.set(tgt, new Set());
    importedBy.get(tgt)!.add(abs);
  }
}

function routeOf(pageAbs: string): string {
  let r = relative(APP_ADMIN, pageAbs).replace(/\\/g, "/").replace(/\/page\.tsx$/, "");
  return "/admin" + (r ? "/" + r : "");
}

const routeCache = new Map<string, string[]>();
function routesForComponent(abs: string): string[] {
  if (routeCache.has(abs)) return routeCache.get(abs)!;
  const routes = new Set<string>();
  const seen = new Set<string>();
  const stack = [abs];
  let guard = 0;
  while (stack.length && guard++ < 5000) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (/[\\/]page\.tsx$/.test(cur) && cur.startsWith(APP_ADMIN)) {
      routes.add(routeOf(cur));
      continue; // page 이상으로 올라갈 필요 없음
    }
    const parents = importedBy.get(cur);
    if (parents) for (const p of parents) stack.push(p);
  }
  const arr = Array.from(routes).sort();
  routeCache.set(abs, arr);
  return arr;
}

for (const o of occurrences) {
  const abs = join(ROOT, o.file);
  (o as Occurrence & { routes: string[] }).routes = routesForComponent(abs);
}

// ── 3) 저장 도움말 존재 여부(DB) ─────────────────────────────────────────────
const distinctKeys = Array.from(
  new Set(occurrences.map((o) => o.key).filter((k): k is string => !!k)),
).sort();

async function loadSaved(keys: string[]): Promise<Map<string, { len: number; preview: string }>> {
  const out = new Map<string, { len: number; preview: string }>();
  const CHUNK = 200;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from("admin_page_help_contents")
      .select("page_path, content")
      .in("page_path", slice);
    if (error) {
      console.error("[DB] load error:", error.message);
      break;
    }
    for (const row of (data ?? []) as Array<{ page_path: string; content: string | null }>) {
      const c = row.content ?? "";
      if (c.trim().length > 0) out.set(row.page_path, { len: c.length, preview: c.slice(0, 60) });
    }
  }
  return out;
}

// ── 4) 집계 + 리포트 ─────────────────────────────────────────────────────────
async function main() {
  const saved = await loadSaved(distinctKeys);

  type Agg = {
    key: string;
    count: number;
    files: string[];
    routes: string[];
    titles: string[];
    displayTexts: string[];
    targetKinds: string[];
    savedLen: number;
    savedPreview: string;
  };
  const aggMap = new Map<string, Agg>();
  for (const o of occurrences) {
    if (!o.key) continue;
    let a = aggMap.get(o.key);
    if (!a) {
      a = {
        key: o.key,
        count: 0,
        files: [],
        routes: [],
        titles: [],
        displayTexts: [],
        targetKinds: [],
        savedLen: 0,
        savedPreview: "",
      };
      aggMap.set(o.key, a);
    }
    a.count++;
    if (!a.files.includes(o.file)) a.files.push(o.file);
    const rs = (o as Occurrence & { routes: string[] }).routes ?? [];
    for (const r of rs) if (!a.routes.includes(r)) a.routes.push(r);
    if (o.title && !a.titles.includes(o.title)) a.titles.push(o.title);
    if (o.displayText && a.displayTexts.length < 3 && !a.displayTexts.includes(o.displayText))
      a.displayTexts.push(o.displayText);
    if (!a.targetKinds.includes(o.targetKind)) a.targetKinds.push(o.targetKind);
  }
  for (const a of aggMap.values()) {
    const s = saved.get(a.key);
    if (s) {
      a.savedLen = s.len;
      a.savedPreview = s.preview;
    }
  }

  const aggs = Array.from(aggMap.values()).sort((x, y) => x.key.localeCompare(y.key));

  // 마지막 세그먼트(leaf) 기준으로 "동일 문구/유사 키" 그룹핑 — 공통화 후보 탐지용.
  const byLeaf = new Map<string, string[]>();
  for (const k of distinctKeys) {
    const leaf = k.split(".").slice(-1)[0].toLowerCase();
    if (!byLeaf.has(leaf)) byLeaf.set(leaf, []);
    byLeaf.get(leaf)!.push(k);
  }
  // title(표시 문구)별 키 그룹핑 — 같은 문구가 여러 키로 흩어진 경우 후보.
  const byTitle = new Map<string, Set<string>>();
  for (const a of aggs) {
    for (const t of a.titles) {
      if (!byTitle.has(t)) byTitle.set(t, new Set());
      byTitle.get(t)!.add(a.key);
    }
  }

  const dynamicOccs = occurrences.filter((o) => !o.key);

  const report = {
    generatedAt: new Date().toISOString(),
    totals: {
      occurrences: occurrences.length,
      distinctKeys: distinctKeys.length,
      dynamicOccurrences: dynamicOccs.length,
      keysWithSavedContent: saved.size,
      files: new Set(occurrences.map((o) => o.file)).size,
    },
    aggregates: aggs,
    dynamicOccurrences: dynamicOccs.map((o) => ({
      file: o.file,
      line: o.line,
      expr: o.dynamicExpr,
      routes: (o as Occurrence & { routes: string[] }).routes,
      displayText: o.displayText,
      raw: o.raw,
    })),
    sameLeafGroups: Object.fromEntries(
      Array.from(byLeaf.entries()).filter(([, v]) => v.length > 1),
    ),
    sameTitleGroups: Object.fromEntries(
      Array.from(byTitle.entries())
        .filter(([, v]) => v.size > 1)
        .map(([t, v]) => [t, Array.from(v)]),
    ),
  };

  const outPath = join(ROOT, "claudedocs", "admin-help-keys-audit.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

  console.log("=== /admin Help Key 감사 ===");
  console.log(JSON.stringify(report.totals, null, 2));
  console.log(`\n산출: ${relative(ROOT, outPath).replace(/\\/g, "/")}`);

  console.log(`\n── 동일 leaf(마지막 세그먼트) 다중 키 그룹 (공통화 1차 후보) ──`);
  for (const [leaf, keys] of Object.entries(report.sameLeafGroups)) {
    if ((keys as string[]).length < 2) continue;
    console.log(`\n[leaf=${leaf}] (${(keys as string[]).length})`);
    for (const k of keys as string[]) {
      const a = aggMap.get(k)!;
      console.log(
        `  ${k}  | ${a.count}x | saved:${a.savedLen} | ${a.targetKinds.join("/")} | ${a.routes.join(",") || "?"} | titles:${a.titles.join("¦") || "-"}`,
      );
    }
  }

  console.log(`\n── 동일 표시문구(title) 다중 키 그룹 ──`);
  for (const [t, keys] of Object.entries(report.sameTitleGroups)) {
    console.log(`\n"${t}" →`);
    for (const k of keys as string[]) {
      const a = aggMap.get(k)!;
      console.log(`  ${k}  | saved:${a.savedLen} | ${a.routes.join(",") || "?"}`);
    }
  }

  console.log(`\n── 동적(런타임 생성) helpKey ${dynamicOccs.length}건 ──`);
  for (const o of dynamicOccs.slice(0, 60)) {
    console.log(`  ${o.file}:${o.line}  expr=${o.dynamicExpr ?? "?"}  | ${o.displayText.slice(0, 40)}`);
  }
  if (dynamicOccs.length > 60) console.log(`  … +${dynamicOccs.length - 60} more (see JSON)`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
