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

  // Shared input classes for consistency and touch targets
  const inputClasses =
    "w-full rounded-lg border border-border-default bg-surface-card px-4 py-3.5 text-base text-text-primary placeholder:text-text-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:border-brand-forest transition shadow-xs min-h-[44px]";
  const selectClasses =
    "w-full rounded-lg border border-border-default bg-surface-card px-4 py-3.5 text-base text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:border-brand-forest transition appearance-none cursor-pointer pr-10 shadow-xs min-h-[44px]";
  const labelClasses =
    "block text-xs font-semibold uppercase tracking-wider text-text-secondary mb-2";

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {/* 1. Topic (Primary Field) */}
      <div>
        <label htmlFor="topic-input" className={labelClasses}>
          What do you want to learn?
        </label>
        <input
          id="topic-input"
          type="text"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="e.g. AP Chemistry, Calculus AB, World History"
          className={inputClasses}
          autoComplete="off"
        />
      </div>

      {/* 2 & 3. Grade Level and Difficulty */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="grade-level-select" className={labelClasses}>
            Grade level
          </label>
          <div className="relative">
            <select
              id="grade-level-select"
              value={gradeLevel}
              onChange={(e) => setGradeLevel(e.target.value)}
              className={selectClasses}
            >
              {GRADE_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-4 text-text-tertiary">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </span>
          </div>
        </div>

        <div>
          <label htmlFor="difficulty-select" className={labelClasses}>
            Difficulty
          </label>
          <div className="relative">
            <select
              id="difficulty-select"
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value)}
              className={selectClasses}
            >
              {DIFFICULTIES.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-4 text-text-tertiary">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </span>
          </div>
        </div>
      </div>

      {/* 4. Existing Knowledge */}
      <div>
        <label htmlFor="existing-knowledge-input" className={labelClasses}>
          Existing knowledge (optional)
        </label>
        <input
          id="existing-knowledge-input"
          type="text"
          value={existingKnowledge}
          onChange={(e) => setExistingKnowledge(e.target.value)}
          placeholder="e.g. completed Algebra 2, familiar with basic biology"
          className={inputClasses}
          autoComplete="off"
        />
      </div>

      {/* 5 & 6. Learning Goal and Time Available */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="learning-goal-select" className={labelClasses}>
            Learning goal
          </label>
          <div className="relative">
            <select
              id="learning-goal-select"
              value={learningGoal}
              onChange={(e) => setLearningGoal(e.target.value)}
              className={selectClasses}
            >
              {LEARNING_GOALS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-4 text-text-tertiary">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </span>
          </div>
        </div>

        <div>
          <label htmlFor="time-available-select" className={labelClasses}>
            Time available
          </label>
          <div className="relative">
            <select
              id="time-available-select"
              value={timeAvailable}
              onChange={(e) => setTimeAvailable(e.target.value)}
              className={selectClasses}
            >
              {TIME_AVAILABLE.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-4 text-text-tertiary">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 9l6 6 6-6" />
              </svg>
            </span>
          </div>
        </div>
      </div>

      {/* 7. Additional Context */}
      <div>
        <label htmlFor="added-context-textarea" className={labelClasses}>
          Anything else? (optional)
        </label>
        <textarea
          id="added-context-textarea"
          value={addedContext}
          onChange={(e) => setAddedContext(e.target.value)}
          placeholder="e.g. I'm preparing for the MCAT, focus on the math-heavy parts, I already know basic algebra…"
          rows={3}
          className={`${inputClasses} resize-y min-h-[88px]`}
        />
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-status-error-bg text-status-error text-sm font-medium border border-status-error/20 flex items-center gap-3 min-h-[44px]">
          <span aria-hidden="true" className="text-lg shrink-0">⚠️</span>
          <span>{error}</span>
        </div>
      )}

      <button
        type="submit"
        disabled={loading || !topic.trim()}
        className="w-full py-4 rounded-lg bg-brand-forest text-white text-base font-semibold hover:bg-brand-forest-hover active:scale-[0.99] transition shadow-sm hover:shadow flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed min-h-[48px]"
      >
        {loading ? (
          <>
            <span className="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            <span>Starting…</span>
          </>
        ) : (
          <span>Build my curriculum →</span>
        )}
      </button>

      <p className="text-sm text-text-tertiary text-center pt-2 leading-relaxed">
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