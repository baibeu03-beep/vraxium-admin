// 수정 전/후 HTTP 결과 비교 + 완료 조건 판정.
//   기대값(회귀 전 화면값) = user_weekly_points 전체기간 합 — DB 에서 직접 읽어 대조한다.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(get("NEXT_PUBLIC_SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"));

const before = JSON.parse(readFileSync(resolve(__dirname, "_point-abc-before.json"), "utf8"));
const after = JSON.parse(readFileSync(resolve(__dirname, "_point-abc-after.json"), "utf8"));

let fail = 0;
const ck = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

async function expected(userId) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from("user_weekly_points")
      .select("points,advantages,penalty")
      .eq("user_id", userId)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
    from += 1000;
  }
  let A = 0, raw = 0, C = 0;
  for (const r of rows) {
    A += r.points ?? 0;
    raw += r.advantages ?? 0;
    C += Math.abs(r.penalty ?? 0);
  }
  return { A, B: raw - C, C };
}

const fmt = (v) => (v && v.A !== undefined ? `${v.A}/${v.B}/${v.C}` : "n/a");

console.log("\n=== 사용자별 A/B/C — 수정 전 → 수정 후 (기대값 = user_weekly_points 전체합) ===\n");
const header = [
  "사용자", "기대 A/B/C",
  "전:Cluster3", "전:회원상세", "전:이력서카드",
  "후:Cluster3", "후:회원상세", "후:이력서카드", "판정",
];
const table = [];

for (const [id, rec] of Object.entries(after.users)) {
  const exp = await expected(id);
  const b = before.users[id].screens;
  const a = rec.screens;

  // 수정 후 모든 화면이 기대값과 같은가 (접근 불가(422) 화면은 판정에서 제외)
  const screens = Object.entries(a).filter(([, v]) => v.A !== undefined);
  const allMatch = screens.every(([, v]) => v.A === exp.A && v.B === exp.B && v.C === exp.C);
  const cPositive = screens.every(([, v]) => v.C >= 0 && (v.C_compat === undefined || v.C_compat === v.C));
  const noShrink = screens.every(([k, v]) => {
    const prev = b[k];
    return !prev || prev.A === undefined || v.A >= prev.A;
  });
  const testSame =
    (a["cluster3StatsCards"]?.A ?? null) === (a["cluster3StatsCards:test"]?.A ?? null) &&
    (a["memberDetail"]?.A ?? null) === (a["memberDetail:test"]?.A ?? null) &&
    (a["roster:encre"]?.A ?? null) === (a["roster:encre:test"]?.A ?? null);

  table.push([
    rec.name,
    `${exp.A}/${exp.B}/${exp.C}`,
    fmt(b.cluster3StatsCards), fmt(b.memberDetail), fmt(b.resumeCard),
    fmt(a.cluster3StatsCards), fmt(a.memberDetail), fmt(a.resumeCard),
    allMatch && cPositive && testSame ? "PASS" : "FAIL",
  ]);

  console.log(`[${rec.name}] ${rec.cat}`);
  ck(allMatch, "모든 화면 == 기대값(uwp 전체합)", `기대 ${exp.A}/${exp.B}/${exp.C}, 화면 ${screens.length}종`);
  ck(cPositive, "C 항상 양수 · 호환필드 동일 부호/값");
  ck(noShrink, "수정 전 대비 A 감소 없음");
  ck(testSame, "일반 == mode=test");
  console.log();
}

const widths = header.map((h, i) =>
  Math.max(h.length, ...table.map((r) => String(r[i]).length)),
);
const line = (cells) => "| " + cells.map((c, i) => String(c).padEnd(widths[i])).join(" | ") + " |";
console.log(line(header));
console.log("|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|");
for (const r of table) console.log(line(r));

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
