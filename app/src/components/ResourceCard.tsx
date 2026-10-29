"use client";

import { useState } from "react";
import type { Resource } from "@/lib/curriculum-data";

const LICENSE_LABEL: Record<Resource["license_status"], string> = {
  cc_open: "Open license — embeddable",
  link_only: "Link only",
  unknown_review_needed: "Needs license review",
};

const LICENSE_COLOR: Record<Resource["license_status"], string> = {
  cc_open: "bg-[#EAF7ED] text-[#166534] border border-[#CEEBD3]",
  link_only: "bg-canvas-subtle text-text-secondary border border-border-default",
  unknown_review_needed: "bg-status-error-bg text-status-error border border-status-error/20",
};

const STATUS_COLOR: Record<Resource["status"], string> = {
  draft: "bg-status-warning-bg text-status-warning border border-status-warning/20",
  approved: "bg-status-success-bg text-status-success border border-status-success/20",
  rejected: "bg-canvas-subtle text-text-tertiary border border-border-default line-through",
};

function DeleteModal({
  title,
  onConfirm,
  onCancel,
}: {
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-brand-navy/40 backdrop-blur-xs transition-opacity"
        onClick={onCancel}
      />
      {/* Modal */}
      <div className="relative bg-surface-card rounded-2xl border border-border-default shadow-xl w-full max-w-md mx-auto max-h-[90vh] overflow-y-auto">
        <div className="p-5 sm:p-6">
          <h3 className="font-display text-lg font-bold text-text-primary mb-2">
            Delete resource?
          </h3>
          <p className="text-sm text-text-secondary mb-6 leading-relaxed">
            &ldquo;{title}&rdquo; will be permanently removed. This cannot be undone.
          </p>
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onCancel}
              className="text-sm font-medium px-5 py-3 rounded-lg border border-border-default text-text-secondary hover:border-border-hover hover:text-text-primary transition min-h-[44px] min-w-[100px]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="text-sm font-medium px-5 py-3 rounded-lg bg-status-error text-white hover:bg-status-error/90 transition shadow-xs min-h-[44px] min-w-[100px]"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ResourceCard({
  resource,
  onApprove,
  onReject,
  onKeepDraft,
  onDelete,
}: {
  resource: Resource;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onKeepDraft: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  return (
    <>
      {showDeleteModal && (
        <DeleteModal
          title={resource.title}
          onConfirm={() => {
            setShowDeleteModal(false);
            onDelete(resource.id);
          }}
          onCancel={() => setShowDeleteModal(false)}
        />
      )}

      <div className="rounded-xl border border-border-default bg-surface-card p-4 shadow-xs hover:border-border-hover transition">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <a
              href={resource.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-text-primary hover:text-brand-forest underline decoration-border-default underline-offset-2 break-words text-sm transition-colors block min-h-[44px] flex items-start"
            >
              {resource.title}
            </a>
            {resource.source_domain && (
              <p className="text-xs font-mono text-text-tertiary mt-1">
                {resource.source_domain}
              </p>
            )}
            {resource.ai_note && (
              <p className="text-xs text-text-secondary mt-2 italic bg-canvas-subtle/50 p-2 rounded-lg border border-border-subtle">
                &ldquo;{resource.ai_note}&rdquo;
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-canvas-subtle text-text-secondary capitalize border border-border-default min-h-[28px] flex items-center">
              {resource.resource_type.replace("_", " ")}
            </span>
            <button
              type="button"
              onClick={() => setShowDeleteModal(true)}
              className="text-text-tertiary hover:text-status-error transition p-2.5 rounded-lg hover:bg-status-error-bg/50 min-h-[44px] min-w-[44px] flex items-center justify-center"
              title="Delete resource"
              aria-label={`Delete "${resource.title}"`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                width="20"
                height="20"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <span
            className={`text-xs font-medium px-2.5 py-1 rounded-full ${LICENSE_COLOR[resource.license_status]}`}
          >
            {LICENSE_LABEL[resource.license_status]}
          </span>
          <span
            className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${STATUS_COLOR[resource.status]}`}
          >
            {resource.status}
          </span>
        </div>

        {resource.status === "draft" && (
          <div className="flex gap-3 mt-4 pt-3 border-t border-border-subtle flex-wrap">
            <button
              type="button"
              onClick={() => onKeepDraft(resource.id)}
              className="text-sm font-medium px-4 py-2.5 rounded-lg border border-border-default text-text-secondary hover:border-border-hover transition min-h-[44px]"
            >
              Keep as draft
            </button>
            <button
              type="button"
              onClick={() => onApprove(resource.id)}
              className="text-sm font-medium px-4 py-2.5 rounded-lg bg-brand-forest text-white hover:bg-brand-forest-hover transition shadow-xs min-h-[44px]"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => onReject(resource.id)}
              className="text-sm font-medium px-4 py-2.5 rounded-lg border border-border-default text-text-secondary hover:border-status-error/40 hover:text-status-error transition min-h-[44px]"
            >
              Reject
            </button>
          </div>
        )}
      </div>
    </>
  );
}
