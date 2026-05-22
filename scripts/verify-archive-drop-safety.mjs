// One-off: pre-drop safety probe for *_reputation_scores archive tables.
// Usage: node scripts/verify-archive-drop-safety.mjs
//
// Auto-checks via service-role REST (pg_catalog is exposed in this project):
//   - row counts (must be 0)
//   - FK refs INTO the two archive tables
//   - views referencing either
//   - functions whose body mentions either
//   - triggers on either
//   - RLS policies on either
//
// Does NOT cover: Front repo / User App repo (string grep) or a separate staging DB.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const url = get("NEXT_PUBLIC_SUPABASE_URL");
const key = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(url, key, { auth: { persistSession: false } });

const ARCHIVE = ["weekly_reputation_scores", "season_reputation_scores"];

const banner = (s) => console.log(`\n## ${s}`);
console.log(`# Supabase URL: ${url}`);
console.log(`# (re-run against staging if separate project)`);

// ----- (1) row counts ------------------------------------------------------
banner("row counts");
for (const t of ARCHIVE) {
  const { count, error } = await sb.from(t).select("*", { count: "exact", head: true });
  console.log(`  ${t}: ${count ?? "ERR"}${error ? "  err=" + error.message : ""}`);
}

// ----- (2) FK refs INTO archive tables -------------------------------------
// pg_constraint exposes only its own columns; we need to resolve oids to names.
// Strategy: pull all FK rows (contype='f'), then resolve confrelid via pg_class.
banner("FK refs INTO archive tables (must be empty)");
{
  // Get target oids
  const { data: tgt } = await sb.from("pg_class")
    .select("oid,relname,relnamespace")
    .in("relname", ARCHIVE);
  // Filter to public namespace
  const { data: nsRows } = await sb.from("pg_namespace").select("oid,nspname").eq("nspname", "public");
  const publicOid = nsRows?.[0]?.oid;
  const targetOids = (tgt ?? []).filter((r) => r.relnamespace === publicOid).map((r) => r.oid);
  if (targetOids.length === 0) {
    console.log("  (target tables not found in pg_class — verify schema)");
  } else {
    const { data: fks, error } = await sb.from("pg_constraint")
      .select("conname,conrelid,confrelid,contype")
      .eq("contype", "f")
      .in("confrelid", targetOids);
    if (error) { console.log("  pg_constraint err:", error.message); }
    else if (!fks?.length) { console.log("  ✅ 0 FKs reference these tables"); }
    else {
      console.log("  ❌ FOUND incoming FKs:");
      // Resolve referencing table names
      const refOids = [...new Set(fks.map((r) => r.conrelid))];
      const { data: refClasses } = await sb.from("pg_class").select("oid,relname").in("oid", refOids);
      const oidName = Object.fromEntries((refClasses ?? []).map((r) => [r.oid, r.relname]));
      for (const r of fks) {
        const tgtName = (tgt ?? []).find((c) => c.oid === r.confrelid)?.relname;
        console.log(`    ${oidName[r.conrelid] ?? r.conrelid}.${r.conname} -> ${tgtName}`);
      }
    }
  }
}

// ----- (3) views referencing either ----------------------------------------
banner("views referencing either (must be empty)");
{
  const { data: views, error } = await sb.from("pg_views").select("schemaname,viewname,definition");
  if (error) { console.log("  pg_views err:", error.message); }
  else {
    const hits = (views ?? []).filter((v) =>
      ARCHIVE.some((t) => new RegExp(`\\b${t}\\b`).test(v.definition ?? ""))
    );
    if (!hits.length) console.log("  ✅ 0 views reference these tables");
    else hits.forEach((v) => console.log(`  ❌ ${v.schemaname}.${v.viewname}`));
  }
}

// ----- (4) functions whose body mentions either ----------------------------
banner("functions referencing either in body (must be empty)");
{
  // pg_proc.prosrc holds the body for PL/pgSQL; not all langs but enough for typical Supabase use.
  const { data: procs, error } = await sb.from("pg_proc")
    .select("proname,prosrc,pronamespace");
  if (error) { console.log("  pg_proc err:", error.message); }
  else {
    const { data: ns } = await sb.from("pg_namespace").select("oid,nspname")
      .not("nspname", "in", "(pg_catalog,information_schema,pg_toast)");
    const allowedNs = new Set((ns ?? []).map((r) => r.oid));
    const hits = (procs ?? []).filter((p) =>
      allowedNs.has(p.pronamespace) &&
      ARCHIVE.some((t) => new RegExp(`\\b${t}\\b`).test(p.prosrc ?? ""))
    );
    if (!hits.length) console.log("  ✅ 0 functions reference these tables in their body");
    else hits.forEach((p) => console.log(`  ❌ ${p.proname}`));
  }
}

// ----- (5) triggers on either ----------------------------------------------
banner("triggers on either table (must be empty)");
{
  const { data: tgt } = await sb.from("pg_class")
    .select("oid,relname")
    .in("relname", ARCHIVE);
  const oids = (tgt ?? []).map((r) => r.oid);
  if (!oids.length) { console.log("  (no target oids)"); }
  else {
    const { data: trigs, error } = await sb.from("pg_trigger")
      .select("tgname,tgrelid,tgisinternal")
      .in("tgrelid", oids)
      .eq("tgisinternal", false);
    if (error) { console.log("  pg_trigger err:", error.message); }
    else if (!trigs?.length) console.log("  ✅ 0 user triggers on these tables");
    else {
      const oidName = Object.fromEntries((tgt ?? []).map((r) => [r.oid, r.relname]));
      trigs.forEach((t) => console.log(`  ❌ ${oidName[t.tgrelid]}.${t.tgname}`));
    }
  }
}

// ----- (6) RLS policies on either ------------------------------------------
banner("RLS policies on either (must be empty)");
{
  const { data: pol, error } = await sb.from("pg_policies")
    .select("schemaname,tablename,policyname")
    .in("tablename", ARCHIVE);
  if (error) { console.log("  pg_policies err:", error.message); }
  else if (!pol?.length) console.log("  ✅ 0 RLS policies on these tables");
  else pol.forEach((p) => console.log(`  ❌ ${p.schemaname}.${p.tablename}.${p.policyname}`));
}

// ----- (7) capture DDL stub for rollback -----------------------------------
banner("DDL stub for rollback (paste into migration comment before apply)");
{
  // information_schema.columns is rarely exposed via PostgREST; assemble from pg_attribute instead.
  const { data: tgt } = await sb.from("pg_class").select("oid,relname").in("relname", ARCHIVE);
  const oids = (tgt ?? []).map((r) => r.oid);
  const oidName = Object.fromEntries((tgt ?? []).map((r) => [r.oid, r.relname]));
  const { data: cols, error } = await sb.from("pg_attribute")
    .select("attrelid,attname,attnum,attnotnull,atttypid,atttypmod,attisdropped")
    .in("attrelid", oids)
    .gt("attnum", 0)
    .eq("attisdropped", false)
    .order("attnum");
  if (error) {
    console.log("  pg_attribute not exposed via REST. Use the SQL probe (g) in the migration header.");
  } else {
    // pg_type lookup for atttypid → typname
    const typeOids = [...new Set((cols ?? []).map((c) => c.atttypid))];
    const { data: types } = await sb.from("pg_type").select("oid,typname").in("oid", typeOids);
    const typeName = Object.fromEntries((types ?? []).map((r) => [r.oid, r.typname]));
    for (const t of ARCHIVE) {
      const tOid = (tgt ?? []).find((r) => r.relname === t)?.oid;
      const ts = (cols ?? []).filter((c) => c.attrelid === tOid);
      if (!ts.length) { console.log(`  -- ${t}: not found`); continue; }
      console.log(`  -- ${t}: (col name + base type only — modifiers/typmod not resolved over REST)`);
      console.log(`  CREATE TABLE public.${t} (`);
      console.log(ts.map((c) => `    ${c.attname} ${typeName[c.atttypid] ?? c.atttypid}${c.attnotnull ? " NOT NULL" : ""}`).join(",\n"));
      console.log("  );");
    }
  }
}
