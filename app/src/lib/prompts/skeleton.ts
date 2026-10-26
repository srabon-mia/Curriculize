export function buildSkeletonPrompt(
  topic: string,
  gradeLevel: string,
  difficulty: string,
  existingKnowledge: string,
  learningGoal: string,
  timeAvailable: string,
  addedContext: string
): string {
  return `You are helping build an educational curriculum guide.

A student wants to learn: "${topic}"
Grade level: ${gradeLevel}
Difficulty: ${difficulty}
Learning goal: ${learningGoal}
Time available: ${timeAvailable}
Existing knowledge: ${existingKnowledge || "none specified"}
Additional context: ${addedContext || "none"}

Your job is to find or create the best possible curriculum structure for this topic.

First, search the web for existing curricula from reputable sources:
- Official course frameworks (AP, IB, state education departments)
- University course syllabi (MIT OCW, Stanford, etc.)
- Established educational organizations (Khan Academy, College Board, etc.)

If you find a reputable existing human-written curriculum or syllabus, adapt its actual topic sequence and use its exact consulted page URL as source_url. The source_url must be one of the pages returned by web search. Do not claim a source based on memory, a generic homepage, or an uncited URL. If no suitable source is found, create a logical topic sequence and set source_type to "ai_organized" with null source_attribution and source_url. Use the student's learning goal and time available to calibrate depth — someone with 1 week preparing for an exam needs a different structure than someone with a semester exploring out of curiosity.

Return ONLY a JSON object, no other text, no markdown backticks:
{
  "title": "full curriculum title",
  "source_type": "adapted" or "ai_organized",
  "source_attribution": "where the structure came from, or null if ai_organized",
  "source_url": "URL of the source curriculum, or null",
  "nodes": [
    {
      "title": "topic title",
      "order_index": 1,
      "major_understandings": [
        {
          "code": "short code like 1.1 or null",
          "description": "specific concept the student should understand"
        }
      ]
    }
  ]
}

Rules:
- 6-12 topics maximum
- 4-8 major understandings per topic
- Be specific — major understandings should be concrete concepts, not vague themes
- Order topics so prerequisites come first
- Adjust depth based on time available: less time = fewer topics, more focused
- Return only the JSON object, nothing else
CRITICAL: Your entire response must be ONLY the JSON object starting with { and ending with }. No introduction, no explanation, no markdown. Start your response with { and end with }.`;
}
