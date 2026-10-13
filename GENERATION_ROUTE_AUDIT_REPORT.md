I've completed the read-only audit and produced the report at GENERATION_ROUTE_AUDIT_REPORT.md.

Summary

Verdict: UNSAFE — The generation streaming route (/api/generate/[id]/stream) violates verification and publication invariants:

1. False verification claim — content_type_verified: true is hardcoded (lines 302, 420) without ever calling the verification pipeline (acquireCandidate → extractEducationalEvidence → verifyContent → persistVerifiedResource)
2. No verification evidence — Zero verification_records rows created for ge
… +423 lines

  Thought for 3s

I've completed the read-only audit and produced the report at GENERATION_RO
                                                                                                                                                           mary
                                                                                                                                                           dict: UNSAFE — The generation streaming route (/api/generate/[id]/streamublication invariants:

1. False verification claim — content_type_verified: true is hardcoded (lines 302, 420) without ever calling the verification pipeline (acquireCandidate → extractEducationalEvidence → verifyContent → persistVerifiedResource)
2. No verification evidence — Zero verification_records rows created for generation-pipeline resources
3. Pipeline exists but unused — The admin discovery route (/api/discover) correctly uses the full pipeline; the generation route bypasses it entirely
4. Current mitigation — Resources insert as status: "draft" (not approved as architecture.md claims), so students don't see them via RLS. But the content_type_verified column is still a lie.

Recommendation: Option A (Minimal Correction)

Don't integrate the full pipeline into the SSE route yet — latency (~10-15sVercel's 300s limit. The architecture intends this for Phase 12 afterdurable acquisition jobs (Phase 9) exist.

Do this instead (2 lines):
- Line 302: content_type_verified: true → content_type_verified: false
- Line 420: content_type_verified: true → content_type_verified: false

This stops the false claim immediately with zero risk. Add TODO comments pointing to Phase 12.

The report includes:
- Verified findings with exact file paths and line numbers
- Resource lifecycle/visibility analysis (RLS, CurriculumViewer, progress endpoint)
- A/B/C remediation comparison with tradeoffs
- Recommended action with precise scope
- Required automated + manual tests
- Remaining uncertainties