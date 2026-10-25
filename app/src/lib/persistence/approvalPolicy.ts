/** Automatic publication requires both deterministic verification and an explicit educational signal. */
export function qualifiesForAutomaticApproval(input: {
  verificationStatus: "verified" | "failed";
  educationalEvidencePresent: boolean;
}): boolean {
  return input.verificationStatus === "verified" && input.educationalEvidencePresent;
}
