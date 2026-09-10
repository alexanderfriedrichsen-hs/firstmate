import React, { useState } from "react";

export function UserQuestions({
  request,
  reply,
}: {
  request: any;
  reply: (answers: Record<string, { answers: string[] }>) => Promise<any>;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const questions = request.data.questions ?? [];
  const answers = Object.fromEntries(
    questions.map((q: any) => [
      q.id,
      {
        answers: [
          ...new Set([
            ...(selected[q.id] ?? []),
            ...(other[q.id]?.trim() ? [other[q.id].trim()] : []),
          ]),
        ],
      },
    ]),
  );
  const ready =
    questions.length > 0 &&
    questions.every(
      (q: any) =>
        answers[q.id].answers.length > 0 &&
        answers[q.id].answers.length <= 50 &&
        (q.multiSelect || answers[q.id].answers.length === 1),
    );
  return (
    <form
      className="permission user-questions"
      aria-label="Questions from Firstmate"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        setError("");
        try {
          await reply(answers);
        } catch (e) {
          setError(String(e));
          setBusy(false);
        }
      }}
    >
      <strong>Your input is needed</strong>
      {questions.map((q: any) => (
        <fieldset key={q.id} disabled={busy}>
          <legend>{q.header || "Question"}</legend>
          <p>{q.question}</p>
          {(q.options ?? []).map((option: any) => (
            <label className="question-option" key={option.label}>
              <input
                type={q.multiSelect ? "checkbox" : "radio"}
                name={request.id + q.id}
                checked={(selected[q.id] ?? []).includes(option.label)}
                onChange={(e) => {
                  setSelected((current) => ({
                    ...current,
                    [q.id]: q.multiSelect
                      ? e.target.checked
                        ? [...(current[q.id] ?? []), option.label]
                        : (current[q.id] ?? []).filter(
                            (value) => value !== option.label,
                          )
                      : [option.label],
                  }));
                  if (!q.multiSelect)
                    setOther((current) => ({ ...current, [q.id]: "" }));
                }}
              />
              <span>
                {option.label}
                {option.description && <small>{option.description}</small>}
              </span>
            </label>
          ))}
          {(q.isOther !== false || !q.options?.length) && (
            <label>
              {q.options?.length ? "Other answer" : "Your answer"}
              <input
                aria-label={(q.header || q.question) + " answer"}
                type={q.isSecret ? "password" : "text"}
                autoComplete="off"
                maxLength={20000}
                value={other[q.id] ?? ""}
                onChange={(e) => {
                  setOther((current) => ({
                    ...current,
                    [q.id]: e.target.value,
                  }));
                  if (!q.multiSelect)
                    setSelected((current) => ({ ...current, [q.id]: [] }));
                }}
              />
            </label>
          )}
        </fieldset>
      ))}
      {error && <p role="alert">{error}</p>}
      <button className="primary" disabled={!ready || busy}>
        {busy ? "Sending answers…" : "Send answers"}
      </button>
    </form>
  );
}
