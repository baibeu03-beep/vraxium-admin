import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
sb.from("user_profiles").select("display_name, organization_slug").eq("user_id", process.argv[2]).maybeSingle().then(({ data }) => console.log(JSON.stringify(data)));
