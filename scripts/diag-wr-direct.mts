import { getWeekRecognitions } from "@/lib/adminWeekRecognitionsData";

async function main() {
  const t0 = Date.now();
  try {
    const data = await getWeekRecognitions({
      seasonKey: null,
      weekId: null,
      organizationSlug: null,
      status: null,
      search: null,
    });
    console.log("DIRECT OK in", Date.now() - t0, "ms");
    console.log(
      "rows:",
      data.rows.length,
      "weeks:",
      data.weeks.length,
      "seasons:",
      data.seasons.length,
      "truncated:",
      data.truncated,
    );
  } catch (e: any) {
    console.error("DIRECT FAILED in", Date.now() - t0, "ms");
    console.error("name:", e?.name, "| message:", e?.message);
    if (e?.cause) console.error("cause:", e.cause);
    console.error(e?.stack);
  }
}
main();
