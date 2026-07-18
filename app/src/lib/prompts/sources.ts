export function buildSourceDiscoveryPrompt(
  curriculumTitle: string,
  difficulty: string,
  learningGoal: string
): string {
  return `You are an expert educator helping curate the best online resources for students.

A student wants to study: "${curriculumTitle}"
Difficulty level: ${difficulty}
Learning goal: ${learningGoal}

Your job is to identify the 10-15 best FREE online sources for this specific subject and difficulty level. Think like an expert in this field — what websites, platforms, and archives would YOU actually recommend to a serious student?

For competition math (AMC, AIME, USAMO, etc.) you might include: artofproblemsolving.com, evanchen.cc, usamoguide.com, maa.org, past contest archives
For AP/college sciences you might include: openstax.org, ocw.mit.edu, khanacademy.org, libretexts.org
For language arts you might include relevant literary databases, writing guides, etc.
But don't just use these examples — think carefully about what's actually best for "${curriculumTitle}" at ${difficulty} level.

Return ONLY a JSON array, no other text, no markdown backticks:
[
  {
    "domain": "artofproblemsolving.com",
    "name": "Art of Problem Solving",
    "why": "one sentence on why this is valuable for this specific subject/level",
    "best_for": "problems|explanations|videos|reference|practice_exams"
  }
]

Rules:
- Only include FREE resources (no paywalls)
- Prioritize sources that are well-known and trusted in this specific field
- Include a mix of: explanations/readings, videos, practice problems, and reference material
- Be specific to the difficulty level — don't include beginner resources for advanced students
CRITICAL: Your entire response must be ONLY the JSON array starting with [ and ending with ]. No introduction, no explanation, no markdown. Start your response with [ and end with ].`;
}