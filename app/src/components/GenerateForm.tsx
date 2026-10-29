"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";

const LEARNING_GOALS = [
  "Pass an exam (Regents, AP, IB, SAT, etc.)",
  "Understand the subject deeply",
  "Prepare for college coursework",
  "Personal interest / curiosity",
  "Professional or career preparation",
];

const TIME_AVAILABLE = [
  "Less than 1 week",
  "1-2 weeks",
  "1 month",
  "A full semester",
  "No time pressure",
];

const GRADE_LEVELS = [
  "Middle school (6-8)",
  "High school (9-12)",
  "AP / IB level",
  "Introductory college",
  "Intermediate college",
];

const DIFFICULTIES = [
  "Standard",
  "Honors / accelerated",
  "Advanced / rigorous",
];

export function GenerateForm() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [gradeLevel, setGradeLevel] = useState("High school (9-12)");
  const [difficulty, setDifficulty] = useState("Standard");
  const [existingKnowledge, setExistingKnowledge] = useState("");
  const [learningGoal, setLearningGoal] = useState("Understand the subject deeply");
  const [timeAvailable, setTimeAvailable] = useState("1 month");
  const [addedContext, setAddedContext] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!topic.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          grade_level: gradeLevel,
          difficulty,
          existing_knowledge: existingKnowledge,
          learning_goal: learningGoal,
          time_available: timeAvailable,
          added_context: addedContext,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Something went wrong");
      }

      if (data.cached) {
        // Already exists — go straight to it
        router.push(`/curriculum/${data.curriculum_id}`);
      } else {
        // New generation — go to progress page
        router.push(`/generate/${data.curriculum_id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* 1. Topic (Primary Field) */}
      <div>
        <label
          htmlFor="topic-input"
          className="block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-1.5"
        >
          What do you want to learn?
        </label>
        <input
          id="topic-input"
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="e.g. AP Chemistry, Calculus AB, World History"
          className="w-full rounded-lg border border-border-default bg-surface-card px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:border-brand-forest transition shadow-xs"
        />
      </div>

      {/* 2 & 3. Grade Level and Difficulty */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label
            htmlFor="grade-level-select"
            className="block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-1.5"
          >
            Grade level
          </label>
          <div className="relative">
            <select
              id="grade-level-select"
              value={gradeLevel}
              onChange={(e) => setGradeLevel(e.target.value)}
              className="w-full rounded-lg border border-border-default bg-surface-card px-3.5 py-2.5 text-sm text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:border-brand-forest transition appearance-none cursor-pointer pr-9 shadow-xs"
            >
              {GRADE_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-text-tertiary text-xs">
              ▾
            </span>
          </div>
        </div>

        <div>
          <label
            htmlFor="difficulty-select"
            className="block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-1.5"
          >
            Difficulty
          </label>
          <div className="relative">
            <select
              id="difficulty-select"
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value)}
              className="w-full rounded-lg border border-border-default bg-surface-card px-3.5 py-2.5 text-sm text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:border-brand-forest transition appearance-none cursor-pointer pr-9 shadow-xs"
            >
              {DIFFICULTIES.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-text-tertiary text-xs">
              ▾
            </span>
          </div>
        </div>
      </div>

      {/* 4. Existing Knowledge */}
      <div>
        <label
          htmlFor="existing-knowledge-input"
          className="block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-1.5"
        >
          Existing knowledge (optional)
        </label>
        <input
          id="existing-knowledge-input"
          type="text"
          value={existingKnowledge}
          onChange={(e) => setExistingKnowledge(e.target.value)}
          placeholder="e.g. completed Algebra 2, familiar with basic biology"
          className="w-full rounded-lg border border-border-default bg-surface-card px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:border-brand-forest transition shadow-xs"
        />
      </div>

      {/* 5 & 6. Learning Goal and Time Available */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label
            htmlFor="learning-goal-select"
            className="block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-1.5"
          >
            Learning goal
          </label>
          <div className="relative">
            <select
              id="learning-goal-select"
              value={learningGoal}
              onChange={(e) => setLearningGoal(e.target.value)}
              className="w-full rounded-lg border border-border-default bg-surface-card px-3.5 py-2.5 text-sm text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:border-brand-forest transition appearance-none cursor-pointer pr-9 shadow-xs"
            >
              {LEARNING_GOALS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-text-tertiary text-xs">
              ▾
            </span>
          </div>
        </div>

        <div>
          <label
            htmlFor="time-available-select"
            className="block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-1.5"
          >
            Time available
          </label>
          <div className="relative">
            <select
              id="time-available-select"
              value={timeAvailable}
              onChange={(e) => setTimeAvailable(e.target.value)}
              className="w-full rounded-lg border border-border-default bg-surface-card px-3.5 py-2.5 text-sm text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:border-brand-forest transition appearance-none cursor-pointer pr-9 shadow-xs"
            >
              {TIME_AVAILABLE.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-text-tertiary text-xs">
              ▾
            </span>
          </div>
        </div>
      </div>

      {/* 7. Additional Context */}
      <div>
        <label
          htmlFor="added-context-textarea"
          className="block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-1.5"
        >
          Anything else? (optional)
        </label>
        <textarea
          id="added-context-textarea"
          value={addedContext}
          onChange={(e) => setAddedContext(e.target.value)}
          placeholder="e.g. I'm preparing for the MCAT, focus on the math-heavy parts, I already know basic algebra…"
          rows={2}
          className="w-full rounded-lg border border-border-default bg-surface-card px-3.5 py-2.5 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:border-brand-forest transition resize-none shadow-xs"
        />
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-status-error-bg text-status-error text-sm font-medium border border-status-error/20 flex items-center gap-2">
          <span>⚠️</span>
          <span>{error}</span>
        </div>
      )}

      <button
        type="submit"
        disabled={loading || !topic.trim()}
        className="w-full py-3.5 rounded-lg bg-brand-forest text-white text-sm sm:text-base font-semibold hover:bg-brand-forest-hover active:scale-[0.99] transition shadow-sm hover:shadow flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? (
          <>
            <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            <span>Starting…</span>
          </>
        ) : (
          <span>Build my curriculum →</span>
        )}
      </button>

      <p className="text-xs text-text-tertiary text-center pt-1">
        Takes 3-5 minutes · No account required ·{" "}
        <Link
          href="/curriculum"
          className="text-brand-forest hover:text-brand-forest-hover font-medium underline underline-offset-2"
        >
          Browse existing curricula
        </Link>
      </p>
    </form>
  );
}