import type { ResultResource } from "@/lib/generation/resultAccess";

type DisplayResource = Pick<ResultResource, "id" | "url" | "title">;

export function GenerationResultResources({
  approved,
  candidates,
}: {
  approved: DisplayResource[];
  candidates: DisplayResource[];
}) {
  return (
    <>
      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Approved resources</h3>
        {approved.length === 0 ? <p className="mt-2 text-sm text-text-muted">No approved resources yet.</p> : (
          <ul className="mt-2 space-y-2">
            {approved.map((resource) => <li key={resource.id}><a className="text-brand-forest underline" href={resource.url} target="_blank" rel="noreferrer">{resource.title}</a></li>)}
          </ul>
        )}
      </div>
      {candidates.length > 0 && (
        <div className="mt-4 rounded-lg border border-status-warning/30 bg-status-warning-bg p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-900">Discovered candidates · Not approved</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {candidates.map((resource) => <li key={resource.id}><a className="underline" href={resource.url} target="_blank" rel="noreferrer">{resource.title}</a><span className="ml-2 text-amber-900">Not approved</span></li>)}
          </ul>
        </div>
      )}
    </>
  );
}
