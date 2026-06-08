/**
 * oranke false-bridge 34건 전수 조사 (read-only — write 0).
 *
 *   npx tsx scripts/diag-false-bridge-34-census.ts
 *   (MYSQL_PASSWORD 특수문자 — .env.local 원문 직독, --env-file 불요)
 *
 * 대조 기준: 이름+생년월일+연락처 3중 키 (legacy_user_id 숫자 동일인 판단 금지 — FALSE_BRIDGE_NOTE).
 *   ① 같은 번호 PMS 사용자(UserId == legacy_user_id)와 3중 키 비교 — "번호 우연 충돌" 입증/반증
 *   ② PMS 전체(oranke 1,369명)에서 3중 키 검색 — 다른 번호의 실제 동일인 존재 여부
 *
 * 분류:
 *   - same-person      : 3중 키 완전 일치 (이름+생년월일+연락처)
 *   - same-person-weak : 이름+생년월일 일치, 연락처 한쪽 부재 (검토 후보)
 *   - rebaseline       : PMS 동일인 없음 + Vraxium 실계정(프로필/활동 보유) → legacy_user_id ≥1억 재채번 대상
 *   - exclude          : PMS 동일인 없음 + Vraxium 빈 계정(프로필·활동 없음) → 매칭 제외(정리 후보)
 */
import { writeFileSync, readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);
const OUT = "claudedocs/false-bridge-34-census-20260607.json";

const normName = (s: unknown) => String(s ?? "").replace(/\s+/g, "").trim();
const normPhone = (s: unknown) => {
  const d = String(s ?? "").replace(/\D/g, "");
  return d.length >= 8 ? d.slice(-8) : d; // 뒤 8자리 비교 (국번/하이픈/+82 표기 차이 흡수)
};
const normBirth = (s: unknown) => {
  const d = String(s ?? "").replace(/\D/g, "");
  if (d.length === 8) return d; // YYYYMMDD
  if (d.length === 6) return (Number(d.slice(0, 2)) <= 26 ? "20" : "19") + d; // YYMMDD 추정
  return d;
};

type PmsUser = { UserId: number; Name: string | null; BirthDay: string | null; Contact: string | null; mail: string | null };

async function main() {
  // ── Vraxium false-bridge 34행 ──
  const { data: bridgeRows, error } = await sb
    .from("users")
    .select("id,legacy_user_id,created_at")
    .gte("legacy_user_id", 1)
    .lte("legacy_user_id", 1374)
    .order("legacy_user_id", { ascending: true })
    .range(0, 999);
  if (error) throw new Error(error.message);
  const { data: markers } = await sb.from("test_user_markers").select("user_id").range(0, 4999);
  const markerSet = new Set(((markers ?? []) as { user_id: string }[]).map((m) => m.user_id));
  const bridges = ((bridgeRows ?? []) as { id: string; legacy_user_id: number; created_at: string }[]).filter(
    (u) => !markerSet.has(u.id),
  );
  console.log("false-bridge 대상:", bridges.length, "건 (기대 34)");

  // ── PMS oranke 전체 사용자 ──
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"),
    port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"),
    password: envGet("MYSQL_PASSWORD"),
    dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const [pmsRows] = (await conn.query(
    "SELECT UserId, Name, BirthDay, Contact, mail FROM oranke.users",
  )) as [PmsUser[], unknown];
  await conn.end();
  const pmsById = new Map(pmsRows.map((p) => [Number(p.UserId), p]));
  // 전체 검색 인덱스: 이름 → 후보들
  const pmsByName = new Map<string, PmsUser[]>();
  for (const p of pmsRows) {
    const k = normName(p.Name);
    if (!k) continue;
    const a = pmsByName.get(k) ?? [];
    a.push(p);
    pmsByName.set(k, a);
  }

  const rows: Array<Record<string, unknown>> = [];
  const counts = { "same-person": 0, "same-person-weak": 0, rebaseline: 0, exclude: 0 };
  for (const b of bridges) {
    // Vraxium 신원
    const { data: prof } = await sb
      .from("user_profiles")
      .select("display_name,birth_date,contact_phone,contact_email,organization_slug,status,growth_status")
      .eq("user_id", b.id)
      .maybeSingle();
    const p = prof as {
      display_name: string | null; birth_date: string | null; contact_phone: string | null;
      contact_email: string | null; organization_slug: string | null; status: string | null; growth_status: string | null;
    } | null;
    const { count: uwsCount } = await sb
      .from("user_week_statuses")
      .select("user_id", { count: "exact", head: true })
      .eq("user_id", b.id);
    const vName = normName(p?.display_name);
    const vBirth = normBirth(p?.birth_date);
    const vPhone = normPhone(p?.contact_phone);

    // ① 같은 번호 PMS 사용자 비교
    const samePms = pmsById.get(b.legacy_user_id) ?? null;
    const sameNumberMatch = samePms
      ? {
          nameEq: !!vName && vName === normName(samePms.Name),
          birthEq: !!vBirth && vBirth === normBirth(samePms.BirthDay),
          phoneEq: !!vPhone && vPhone === normPhone(samePms.Contact),
        }
      : null;

    // ② 전체 3중 키 검색
    const candidates = (vName ? (pmsByName.get(vName) ?? []) : []).map((c) => ({
      pmsUserId: c.UserId,
      birthEq: !!vBirth && vBirth === normBirth(c.BirthDay),
      phoneEq: !!vPhone && vPhone === normPhone(c.Contact),
      phoneBothPresent: !!vPhone && !!normPhone(c.Contact),
    }));
    const full = candidates.filter((c) => c.birthEq && c.phoneEq);
    const weak = candidates.filter((c) => c.birthEq && !c.phoneEq && !c.phoneBothPresent);

    // 분류
    let cls: keyof typeof counts;
    if (full.length > 0) cls = "same-person";
    else if (weak.length > 0) cls = "same-person-weak";
    else {
      const hasIdentity = !!p?.display_name;
      const hasActivity = (uwsCount ?? 0) > 0;
      cls = hasIdentity || hasActivity ? "rebaseline" : "exclude";
    }
    counts[cls]++;

    rows.push({
      legacy_user_id: b.legacy_user_id,
      vraxium_user_id: b.id,
      vraxium: {
        name: p?.display_name ?? null,
        birth: p?.birth_date ?? null,
        phoneTail: vPhone || null,
        org: p?.organization_slug ?? null,
        status: p?.status ?? null,
        growth: p?.growth_status ?? null,
        uwsCount: uwsCount ?? 0,
        created_at: b.created_at,
      },
      pmsSameNumber: samePms
        ? { name: samePms.Name, birth: samePms.BirthDay, match: sameNumberMatch }
        : "PMS UserId 부재",
      pmsFullKeyMatches: full.map((c) => c.pmsUserId),
      pmsWeakMatches: weak.map((c) => c.pmsUserId),
      nameOnlyCandidates: candidates.length,
      classification: cls,
    });
  }

  const summary = {
    generatedAt: "2026-06-07 false-bridge 34 전수 조사 (read-only)",
    total: bridges.length,
    counts,
    sameNumberFullMatches: rows.filter(
      (r) => r.pmsSameNumber !== "PMS UserId 부재" &&
        (r.pmsSameNumber as { match: { nameEq: boolean; birthEq: boolean; phoneEq: boolean } }).match.nameEq &&
        (r.pmsSameNumber as { match: { birthEq: boolean } }).match.birthEq,
    ).length,
  };
  writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  for (const r of rows) {
    const v = r.vraxium as { name: string | null; org: string | null; uwsCount: number; growth: string | null };
    console.log(
      `  ${String(r.legacy_user_id).padStart(3)} | ${r.classification} | vrax='${v.name}' org=${v.org} uws=${v.uwsCount}` +
        ` | 전체일치=${(r.pmsFullKeyMatches as number[]).join(",") || "-"} 약일치=${(r.pmsWeakMatches as number[]).join(",") || "-"}`,
    );
  }
  console.log("→", OUT);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
