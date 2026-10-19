/**
 * scripts/verify-seed-resources.ts
 *
 * Runs the deterministic verification pipeline on existing seed resources
 * to set content_type_verified based on actual content.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/verify-seed-resources.ts
 */

import { createClient } from "@supabase/supabase-js";
import { acquireUrl, buildCleanedDocument, extractStructuredContentFromDoc } from "@/lib/acquisition";
import { extractEducationalEvidence } from "@/lib/evidence";
import { verifyContent, type VerificationResult } from "@/lib/verification";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !serviceRoleKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

interface SeedResource {
  id: string;
  url: string;
  title: string;
  node_id: string | null;
  major_understanding_id: string | null;
  content_type_verified: boolean;
  status: string;
}

async function verifySeedResources() {
  console.log("Fetching seed resources (approved but not verified)...");

  const { data: resources, error } = await supabase
    .from("resources")
    .select("id, url, title, node_id, major_understanding_id, content_type_verified, status")
    .eq("status", "approved")
    .eq("content_type_verified", false);

  if (error) {
    console.error("Error fetching resources:", error);
    process.exit(1);
  }

  if (!resources || resources.length === 0) {
    console.log("No seed resources found to verify.");
    return;
  }

  console.log(`Found ${resources.length} seed resources to verify.`);

  let verifiedCount = 0;
  let failedCount = 0;

  for (const resource of resources as SeedResource[]) {
    console.log(`\nVerifying: ${resource.title} (${resource.url})`);

    try {
      // Step 1: Acquire the page
      const acquiredPage = await acquireUrl(resource.url);
      if (!acquiredPage) {
        console.log("  ✗ Acquisition failed");
        failedCount++;
        continue;
      }

      // Step 2: Clean and structure
      const cleanedDoc = buildCleanedDocument(acquiredPage);
      const structuredContent = extractStructuredContentFromDoc(cleanedDoc);

      // Step 3: Extract educational evidence
      const educationalEvidence = extractEducationalEvidence(structuredContent);

      // Step 4: Verify
      const verificationResult: VerificationResult = verifyContent({
        acquiredPage: {
          contentHash: acquiredPage.contentHash,
          canonicalUrl: acquiredPage.canonicalUrl.url,
          finalUrl: acquiredPage.finalUrl,
          statusCode: acquiredPage.statusCode,
          contentType: acquiredPage.contentType,
          acquiredAt: acquiredPage.acquiredAt,
        },
        structuredContent,
        educationalEvidence,
      });

      // Step 5: Update resource
      const newContentTypeVerified = verificationResult.status === "verified";
      const autoApprove = verificationResult.status === "verified" && 
        verificationResult.advisorySignals.educationalEvidencePresent === true;

      const { error: updateError } = await supabase
        .from("resources")
        .update({
          content_type_verified: newContentTypeVerified,
          status: autoApprove ? "approved" : "draft",
        })
        .eq("id", resource.id);

      if (updateError) {
        console.error(`  ✗ Update failed: ${updateError.message}`);
        failedCount++;
        continue;
      }

      // Create verification record
      const deterministicChecks = {
        cleanedContentNonEmpty: verificationResult.deterministicChecks.cleanedContentNonEmpty,
        ...verificationResult.advisorySignals,
      };

      const { error: vrError } = await supabase
        .from("verification_records")
        .insert({
          resource_id: resource.id,
          url: acquiredPage.finalUrl,
          canonical_url: acquiredPage.canonicalUrl.url,
          content_hash: acquiredPage.contentHash,
          http_status: acquiredPage.statusCode,
          page_title: structuredContent.metadata.title || null,
          page_metadata: {
            description: structuredContent.metadata.description,
            author: structuredContent.metadata.author,
            date_published: structuredContent.metadata.datePublished,
            language: structuredContent.metadata.language,
          },
          content_evidence: JSON.stringify(educationalEvidence.interpreted),
          fetched_at: acquiredPage.acquiredAt,
          verified_at: verificationResult.verifiedAt,
          verification_method: "deterministic_v1",
          deterministic_checks: deterministicChecks,
          ai_verified: false,
          ai_verification_notes: null,
          human_reviewed: false,
          expires_at: null,
          status: verificationResult.status,
          notes: JSON.stringify({ source: "seed_verification" }),
        });

      if (vrError) {
        console.warn(`  ⚠ Verification record creation failed: ${vrError.message}`);
      }

      console.log(`  ✓ Verified: ${verificationResult.status}, educationalEvidencePresent: ${verificationResult.advisorySignals.educationalEvidencePresent}, wordCount: ${verificationResult.advisorySignals.wordCount}`);
      if (newContentTypeVerified) verifiedCount++;

    } catch (err) {
      console.error(`  ✗ Error: ${err instanceof Error ? err.message : String(err)}`);
      failedCount++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total: ${resources.length}`);
  console.log(`Verified (content_type_verified=true): ${verifiedCount}`);
  console.log(`Failed: ${failedCount}`);
}

verifySeedResources().catch(console.error);
