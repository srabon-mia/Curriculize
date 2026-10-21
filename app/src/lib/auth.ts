import { createClient } from "@/lib/supabase/server";

/**
 * Check if the current user is authenticated and is an admin.
 * Returns the user if authorized, null otherwise.
 */
export async function getAdminUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return null;

  // Check if user is in the admins table
  const { data: adminRow } = await supabase
    .from("admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!adminRow) return null;

  return user;
}

/**
 * Require admin authentication - throws redirect to login if not authorized.
 * Use in Server Components that must be admin-only.
 */
export async function requireAdmin() {
  const user = await getAdminUser();
  if (!user) {
    // Import redirect dynamically to avoid issues in non-Server-Component contexts
    const { redirect } = await import("next/navigation");
    redirect("/login");
  }
  return user;
}

/**
 * Check if current user is admin - for use in API routes.
 * Returns { user, supabase } if authorized, or { error: Response } if not.
 */
export async function requireAdminApi() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return { error: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } }) };
  }

  const { data: adminRow } = await supabase
    .from("admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!adminRow) {
    return { error: new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } }) };
  }

  return { user, supabase };
}