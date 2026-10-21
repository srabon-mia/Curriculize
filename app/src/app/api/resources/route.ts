import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth";

// GET /api/resources?node_id=... or ?major_understanding_id=...
// Admin only: returns all resources including draft/rejected.
export async function GET(request: Request) {
  const auth = await requireAdminApi();
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const nodeId = searchParams.get("node_id");
  const muId = searchParams.get("major_understanding_id");

  if (!nodeId && !muId) {
    return NextResponse.json(
      { error: "node_id or major_understanding_id query param is required" },
      { status: 400 }
    );
  }

  let query = auth.supabase.from("resources").select("*");
  query = nodeId ? query.eq("node_id", nodeId) : query.eq("major_understanding_id", muId!);

  const { data, error } = await query.order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ resources: data });
}

// POST /api/resources -- attach a resource to a node or major_understanding.
// Defaults to license_status: 'link_only' and status: 'draft' per the
// embed-vs-link policy from Phase 0 -- nothing is embeddable or public
// until explicitly reviewed and flipped by an admin.
export async function POST(request: Request) {
  const auth = await requireAdminApi();
  if (auth.error) return auth.error;

  const body = await request.json();

  const {
    node_id,
    major_understanding_id,
    url,
    title,
    source_domain,
    resource_type,
    license_status,
    ai_note,
  } = body;

  if (!url || !title || !resource_type) {
    return NextResponse.json(
      { error: "url, title, and resource_type are required" },
      { status: 400 }
    );
  }

  if (!node_id && !major_understanding_id) {
    return NextResponse.json(
      { error: "node_id or major_understanding_id is required" },
      { status: 400 }
    );
  }

  // Look up the domain's score to decide embed eligibility, rather than
  // trusting a client-supplied flag.
  let embedAllowed = false;
  const resolvedLicenseStatus = license_status ?? "link_only";

  if (source_domain) {
    const { data: domainScore } = await auth.supabase
      .from("domain_scores")
      .select("score, category")
      .eq("domain", source_domain)
      .maybeSingle();

    // Embed is only ever allowed if BOTH the domain is reputable AND the
    // license is explicitly confirmed open -- domain score alone never
    // authorizes embedding.
    if (domainScore && resolvedLicenseStatus === "cc_open") {
      embedAllowed = true;
    }
  }

  const { data, error } = await auth.supabase
    .from("resources")
    .insert({
      node_id: node_id ?? null,
      major_understanding_id: major_understanding_id ?? null,
      url,
      title,
      source_domain,
      resource_type,
      license_status: resolvedLicenseStatus,
      embed_allowed: embedAllowed,
      ai_note,
      status: "draft", // always lands in the review queue first
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ resource: data }, { status: 201 });
}
