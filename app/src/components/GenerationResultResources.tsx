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
        <div className="mt-4 rounded-xl border border-border-default bg-surface-card p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">More learning resources</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {candidates.filter((resource) => resource.title?.trim() && /^https?:\/\//i.test(resource.url)).map((resource) => <li key={resource.id}><a className="text-brand-forest underline" href={resource.url} target="_blank" rel="noreferrer">{resource.title}</a></li>)}
          </ul>
        </div>
      )}
    </>
  );
}
