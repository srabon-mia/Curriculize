import type { NodeWithChildren } from "@/lib/curriculum-data";

export function buildDiscoverPrompt(
  node: NodeWithChildren,
  granularity: "topic" | "understanding",
  understandingCode?: string,
  understandingDescription?: string,
  curriculumTitle?: string,
  prioritizedDomains?: string[]
): string {
  const courseContext = curriculumTitle ?? "the course";

  const context =
    granularity === "topic"
      ? `The topic is "${node.title}" from the course "${courseContext}". Resources must be specifically about this topic in the context of ${courseContext}.`
      : `The specific concept is "${understandingCode}: ${understandingDescription}" from the "${node.title}" topic in "${courseContext}".`;

  const domainGuidance =
    prioritizedDomains && prioritizedDomains.length > 0
      ? `Prioritize these domains which are known to be excellent for this subject: ${prioritizedDomains.join(", ")}. Search these first before looking elsewhere.`
      : `Prioritize well-known, reputable educational sources for this subject.`;

  return `You are helping curate an educational resource guide for students.

${context}

Search the web and find the best freely available resources for this. Return ONLY a JSON array, no other text, no markdown backticks. Each item should have exactly these fields:
- url: the full URL
- title: the page/video title
- resource_type: one of "video", "text", "textbook", "problem_set", "reference_tool", "practice_exam", "other"
- source_domain: just the domain name (e.g. "jmap.org")
- ai_note: one sentence explaining why this resource is useful here specifically
- license_status: "cc_open" if Creative Commons or openly licensed, otherwise "link_only"

Rules:
- Find 3-5 learning resources (explanations, videos, readings) AND 2-4 practice problem sources
- ${domainGuidance}
- Only include resources that actually exist and are freely accessible
- Do not include resources that require login or payment
- Be specific: link to a specific page/video for this topic, not a homepage
- Match the difficulty level of the course — don't include beginner resources for advanced courses

Return only the JSON array.`;
}

export function buildTopicBatchPrompt(
  node: NodeWithChildren,
  curriculumTitle: string,
  prioritizedDomains?: string[]
): string {
  const understandings = node.major_understandings
    .map((mu) => `- ${mu.code ?? mu.external_key}: ${mu.description}`)
    .join("\n");

  const domainGuidance =
    prioritizedDomains && prioritizedDomains.length > 0
      ? `Prioritize these domains which are known to be excellent for this subject: ${prioritizedDomains.join(", ")}. Search these sites first before looking elsewhere.`
      : `Prioritize well-known, reputable educational sources for this subject.`;

  return `You are helping curate an educational resource guide for students.

The course is: "${curriculumTitle}"
The topic within that course is: "${node.title}"

Here are the specific concepts students need to understand within this topic:
${understandings}

Search the web and find the best freely available resources for EACH concept listed above. Make sure resources are specifically about "${node.title}" in the context of "${curriculumTitle}" and match the difficulty level of that course.

${domainGuidance}

Return ONLY a JSON object, no other text, no markdown backticks:
{
  "topic_resources": [
    {
      "url": "...",
      "title": "...",
      "resource_type": "text",
      "source_domain": "...",
      "ai_note": "one sentence why this is useful",
      "license_status": "cc_open|link_only",
      "understanding_codes": ["1.1", "1.2"]
    }
  ]
}

Rules:
- Aim for 2-3 strong, distinct resources for EACH understanding, including at least one teaching resource and one practice resource when genuinely available
- A resource may cover multiple concepts only when its content materially teaches each listed concept
- Each resource must list every and only the understanding codes it actually covers in understanding_codes
- Prefer roughly 3-5 additional topic-wide resources in the separate topic discovery pass; do not substitute a general topic resource for a concept-specific one
- resource_type must be exactly one of: "video", "text", "textbook", "problem_set", "reference_tool", "practice_exam", "other". Do not combine values.
- If a resource covers the whole topic generally, list all codes
- Only freely accessible resources, no login or payment required
- Match difficulty to the course level — advanced courses need advanced resources
- Never invent a URL, duplicate a resource, or claim coverage unsupported by the linked content
- Return only the JSON object
CRITICAL: Your entire response must be ONLY the JSON object starting with { and ending with }. No introduction, no explanation, no markdown. Start your response with { and end with }.`;
}
