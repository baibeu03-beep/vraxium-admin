async function main() {
  try {
    const mod: any = await import("@/lib/adminWeekRecognitionsData");
    console.log("module keys:", Object.keys(mod));
    const t0 = Date.now();
    const data = await mod.getWeekRecognitions({ seasonKey: null, weekId: null, organizationSlug: null, status: null, search: null });
    console.log("DIRECT OK in", Date.now() - t0, "ms; rows:", data.rows.length, "weeks:", data.weeks.length);
  } catch (e: any) {
    console.error("FAILED name:", e?.name, "msg:", e?.message);
    if (e?.cause) console.error("cause:", e.cause);
    console.error(e?.stack);
  }
}
main();
