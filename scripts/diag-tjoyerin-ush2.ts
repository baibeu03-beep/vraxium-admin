import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function main() {
  const { data } = await sb
    .from("seasons")
    .select("*")
    .eq("id", "33333358-42e4-403b-a726-caa6459ae7e9");
  console.log(JSON.stringify(data, null, 2));
}
main();
