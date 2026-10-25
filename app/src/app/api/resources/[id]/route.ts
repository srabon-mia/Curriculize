import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth";

// PATCH /api/resources/[id] -- update a resource's review status.
// Admin only.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdminApi();
  if (auth.error) return auth.error;

  const { id } = await params;
  const body = await request.json();

  const { status } = body;

  if (!status || !["draft", "approved", "rejected"].includes(status)) {
    return NextResponse.json(
      { error: "status must be one of: draft, approved, rejected" },
      { status: 400 }
    );
  }

  const { data, error } = await auth.supabase
    .from("resources")
    // Persist every admin-selected status, including an intentional draft, so
    // later automated upserts cannot reinterpret it as an unreviewed default.
    .update({ status, status_reviewed_by: auth.user.id })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ resource: data });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdminApi();
  if (auth.error) return auth.error;

  const { id } = await params;

  const { error } = await auth.supabase
    .from("resources")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
