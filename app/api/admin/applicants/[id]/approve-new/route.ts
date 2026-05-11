// app/api/admin/applicants/[id]/approve-new/route.ts
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { randomUUID } from "crypto";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: applicantId } = await params;

  const { data: applicant, error: applicantError } = await supabaseAdmin
    .from("applicants")
    .select("id, email, provider, status, name")
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

  if (!applicant.email) {
    return NextResponse.json(
      { error: "Applicant email is required to create a user profile" },
      { status: 400 },
    );
  }

  const newUserId = randomUUID();
  const fallbackName =
    applicant.name && applicant.name !== "kakao-user"
      ? applicant.name
      : applicant.email.split("@")[0];

  const { error: userInsertError } = await supabaseAdmin
    .from("users")
    .insert({
      id: newUserId,
    });

  if (userInsertError) {
    console.error("approve-new userInsertError", userInsertError);
    return NextResponse.json(
      {
        step: "insert_users",
        error: userInsertError.message ?? "Failed to create user",
        details: userInsertError,
      },
      { status: 500 },
    );
  }

  const { data: newProfile, error: insertError } = await supabaseAdmin
    .from("user_profiles")
    .insert({
      user_id: newUserId,
      display_name: fallbackName,
      auth_email: applicant.email,
      contact_email: applicant.email,
      status: "active",
      growth_status: "active",
    })
    .select("user_id")
    .single();

  if (insertError || !newProfile) {
    console.error("approve-new insertError", insertError);
    const { error: rollbackUserError } = await supabaseAdmin
      .from("users")
      .delete()
      .eq("id", newUserId);
    if (rollbackUserError) {
      console.error(
        "approve-new rollback users delete failed",
        rollbackUserError,
      );
    }
    return NextResponse.json(
      {
        step: "insert_user_profile",
        error: insertError?.message ?? "Failed to create user profile",
        details: insertError,
      },
      { status: 500 },
    );
  }

  const { error: applicantUpdateError } = await supabaseAdmin
    .from("applicants")
    .update({
      status: "approved",
      linked_user_id: newProfile.user_id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", applicantId);

  if (applicantUpdateError) {
    console.error("approve-new applicantUpdateError", applicantUpdateError);
    const { error: rollbackProfileError } = await supabaseAdmin
      .from("user_profiles")
      .delete()
      .eq("user_id", newUserId);
    if (rollbackProfileError) {
      console.error(
        "approve-new rollback user_profiles delete failed",
        rollbackProfileError,
      );
    }
    const { error: rollbackUserError } = await supabaseAdmin
      .from("users")
      .delete()
      .eq("id", newUserId);
    if (rollbackUserError) {
      console.error(
        "approve-new rollback users delete failed",
        rollbackUserError,
      );
    }
    return NextResponse.json(
      {
        step: "update_applicant",
        error: applicantUpdateError.message,
        details: applicantUpdateError,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    linked_user_id: newProfile.user_id,
  });
}
