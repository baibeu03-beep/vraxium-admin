import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("legacy_crew_import")
    .select("*")
    .order("cumulative_weeks", { ascending: true });

  if (error) {
    console.error(error);
    return Response.json({ success: false }, { status: 500 });
  }

  return Response.json({ success: true, data });
}
