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
      <div className="relative bg-surface-card rounded-2xl border border-border-default shadow-xl px-6 py-5 max-w-sm w-full mx-auto">
        <h3 className="font-display text-lg font-bold text-text-primary mb-1">
          Delete resource?
        </h3>
        <p className="text-sm text-text-secondary mb-5 leading-relaxed">
          &ldquo;{title}&rdquo; will be permanently removed. This cannot be undone.
        </p>
        <div className="flex gap-2.5 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="text-xs sm:text-sm font-medium px-4 py-2 rounded-lg border border-border-default text-text-secondary hover:border-border-hover hover:text-text-primary transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="text-xs sm:text-sm font-medium px-4 py-2 rounded-lg bg-status-error text-white hover:bg-status-error/90 transition shadow-xs"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export function ResourceCard({
  resource,
  onApprove,
  onReject,
  onDelete,
}: {
  resource: Resource;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
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
              className="font-medium text-text-primary hover:text-brand-forest underline decoration-border-default underline-offset-2 break-words text-sm transition-colors"
            >
              {resource.title}
            </a>
            {resource.source_domain && (
              <p className="text-xs font-mono text-text-tertiary mt-0.5">
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
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-canvas-subtle text-text-secondary capitalize border border-border-default">
              {resource.resource_type.replace("_", " ")}
            </span>
            <button
              type="button"
              onClick={() => setShowDeleteModal(true)}
              className="text-text-tertiary hover:text-status-error transition text-sm p-1 rounded hover:bg-status-error-bg/50"
              title="Delete resource"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <span
            className={`text-[11px] font-medium px-2.5 py-0.5 rounded-full ${LICENSE_COLOR[resource.license_status]}`}
          >
            {LICENSE_LABEL[resource.license_status]}
          </span>
          <span
            className={`text-[11px] font-medium px-2.5 py-0.5 rounded-full capitalize ${STATUS_COLOR[resource.status]}`}
          >
            {resource.status}
          </span>
        </div>

        {resource.status === "draft" && (
          <div className="flex gap-2.5 mt-3 pt-3 border-t border-border-subtle">
            <button
              type="button"
              onClick={() => onApprove(resource.id)}
              className="text-xs sm:text-sm font-medium px-3.5 py-1.5 rounded-lg bg-brand-forest text-white hover:bg-brand-forest-hover transition shadow-xs"
            >
              Approve
            </button>
            <button
              type="button"
              onClick={() => onReject(resource.id)}
              className="text-xs sm:text-sm font-medium px-3.5 py-1.5 rounded-lg border border-border-default text-text-secondary hover:border-status-error/40 hover:text-status-error transition"
            >
              Reject
            </button>
          </div>
        )}
      </div>
    </>
  );
}