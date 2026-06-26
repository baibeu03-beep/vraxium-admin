import { supabaseAdmin } from "@/lib/supabaseAdmin";
const wt = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);
async function up(): Promise<boolean> {
  try { const r:any = await wt(supabaseAdmin.from("organizations").select("*",{count:"exact",head:true}) as any, 8000); return !r.error; }
  catch { return false; }
}
async function main() {
  for (let i = 1; i <= 30; i++) {
    if (await up()) { console.log(`DB UP (after ${i} checks)`); process.exit(0); }
    process.stdout.write(`.`);
    await new Promise((r) => setTimeout(r, 12000));
  }
  console.log("\nDB still DOWN after ~6min");
  process.exit(1);
}
main();
