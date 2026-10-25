import { describe, expect, it } from "vitest";
import { qualifiesForAutomaticApproval } from "../approvalPolicy";

describe("resource auto-approval policy", () => {
  it("retains the explicit educational-evidence path for verified pages", () => {
    expect(qualifiesForAutomaticApproval({
      verificationStatus: "verified",
      educationalEvidencePresent: true,
    })).toBe(true);
  });

  it("approves a short verified page when it contains explicit educational evidence", () => {
    expect(qualifiesForAutomaticApproval({
      verificationStatus: "verified",
      educationalEvidencePresent: true,
    })).toBe(true);
  });

  it("does not approve a verified resource without explicit educational evidence", () => {
    expect(qualifiesForAutomaticApproval({
      verificationStatus: "verified",
      educationalEvidencePresent: false,
    })).toBe(false);
  });

  it("keeps failed verification ineligible even if educational evidence was extracted", () => {
    expect(qualifiesForAutomaticApproval({
      verificationStatus: "failed",
      educationalEvidencePresent: true,
    })).toBe(false);
  });
});
