// app/api/admin/applicants/[id]/approve-existing/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: applicantId } = await params;
  const { user_id } = await req.json();

  if (!user_id) {
    return NextResponse.json({ error: "user_id is required" }, { status: 400 });
  }

  const { data: applicant, error: applicantError } = await supabaseAdmin
    .from("applicants")
    .select("id, email, provider, status")
    .eq("id", applicantId)
    .single();

  if (applicantError || !applicant) {
    return NextResponse.json({ error: "Applicant not found" }, { status: 404 });
  }

  if (applicant.status !== "pending") {
    return NextResponse.json(
      { error: "Applicant is not pending" },
      { status: 400 },
    );
  }

  const { data: userProfile, error: userError } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, auth_email")
    .eq("user_id", user_id)
    .single();

  if (userError || !userProfile) {
    return NextResponse.json(
      { error: "User profile not found" },
      { status: 404 },
    );
  }

  const { error: profileUpdateError } = await supabaseAdmin
    .from("user_profiles")
    .update({
      auth_email: applicant.email,
    })
    .eq("user_id", user_id);

  if (profileUpdateError) {
    return NextResponse.json(
      { error: profileUpdateError.message },
      { status: 500 },
    );
  }

  const { error: applicantUpdateError } = await supabaseAdmin
    .from("applicants")
    .update({
      status: "approved",
      linked_user_id: user_id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", applicantId);

  if (applicantUpdateError) {
    return NextResponse.json(
      { error: applicantUpdateError.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    linked_user_id: user_id,
  });
}
