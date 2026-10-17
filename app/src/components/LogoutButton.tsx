"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  const supabase = createClient();

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <button
      onClick={handleLogout}
      className="text-xs font-medium px-3 py-1.5 rounded-lg border border-border-default bg-surface-card text-text-secondary hover:text-status-error hover:border-status-error/30 hover:bg-status-error-bg/50 transition shadow-2xs"
    >
      Sign out
    </button>
  );
}