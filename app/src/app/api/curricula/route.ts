import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth";

// GET /api/curricula -- list curricula.
// Admin only: returns all curricula including drafts.
export async function GET() {
  const auth = await requireAdminApi();
  if (auth.error) return auth.error;

  const { data, error } = await auth.supabase
    .from("curricula")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ curricula: data });
}

// POST /api/curricula -- create a new curriculum.
// Admin only.
export async function POST(request: Request) {
  const auth = await requireAdminApi();
  if (auth.error) return auth.error;

  const body = await request.json();

  const { title, subject, source_type, source_attribution, source_url, notes } = body;

  if (!title || !subject || !source_type) {
    return NextResponse.json(
      { error: "title, subject, and source_type are required" },
      { status: 400 }
    );
  }

  const { data, error } = await auth.supabase
    .from("curricula")
    .insert({ title, subject, source_type, source_attribution, source_url, notes })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ curriculum: data }, { status: 201 });
}
