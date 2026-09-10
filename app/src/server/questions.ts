import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
export type Question = {
  id: string;
  header: string;
  question: string;
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
  options?: Array<{ label: string; description?: string; nativeId?: string }>;
};
export type Answers = Record<string, { answers: string[] }>;
export function normalizeQuestions(
  provider: "codex" | "claude" | "cursor",
  input: any,
): Question[] {
  if (
    !Array.isArray(input?.questions) ||
    !input.questions.length ||
    input.questions.length > 16
  )
    throw Error("Provider returned invalid questions");
  if (
    input.questions.some(
      (q: any) =>
        !q ||
        typeof q !== "object" ||
        (q.options != null && !Array.isArray(q.options)),
    )
  )
    throw Error("Provider returned invalid question fields");
  const questions = input.questions.map((q: any, i: number) => ({
    id: provider === "claude" ? "q" + i : q.id,
    header: q.header ?? input.title ?? "Question",
    question: provider === "cursor" ? q.prompt : q.question,
    multiSelect: provider === "cursor" ? !!q.allowMultiple : !!q.multiSelect,
    isOther: provider === "cursor" ? false : q.isOther !== false,
    isSecret: !!q.isSecret,
    options: (q.options ?? []).map((o: any) => ({
      label: o?.label,
      description: o?.description ?? "",
      ...(provider === "cursor" ? { nativeId: o?.id } : {}),
    })),
  }));
  for (const q of questions) {
    if (
      typeof q.id !== "string" ||
      !q.id ||
      typeof q.header !== "string" ||
      typeof q.question !== "string" ||
      !q.question ||
      q.options.length > 50 ||
      (provider === "cursor" && !q.options.length) ||
      q.options.some(
        (o: any) =>
          typeof o.label !== "string" ||
          !o.label ||
          typeof o.description !== "string" ||
          (provider === "cursor" && typeof o.nativeId !== "string"),
      )
    )
      throw Error("Provider returned invalid question fields");
    if (new Set(q.options.map((o: any) => o.label)).size !== q.options.length)
      throw Error("Provider returned ambiguous question options");
  }
  if (new Set(questions.map((q: Question) => q.id)).size !== questions.length)
    throw Error("Provider returned duplicate question IDs");
  if (
    provider === "claude" &&
    new Set(questions.map((q: Question) => q.question)).size !==
      questions.length
  )
    throw Error("Provider returned duplicate question text");
  return questions;
}
export function validateQuestionAnswers(
  questions: Question[],
  answers: any,
): Answers {
  if (
    !answers ||
    typeof answers !== "object" ||
    Array.isArray(answers) ||
    Object.keys(answers).some((id) => !questions.some((q) => q.id === id))
  )
    throw Error("Answers must match the pending questions");
  return Object.fromEntries(
    questions.map((q) => {
      const values = answers[q.id]?.answers;
      if (
        !Array.isArray(values) ||
        !values.length ||
        values.length > 50 ||
        (!q.multiSelect && values.length !== 1) ||
        values.some(
          (v) => typeof v !== "string" || !v.trim() || v.length > 20000,
        ) ||
        new Set(values).size !== values.length
      )
        throw Error("Answer each question with a valid selection or text");
      if (
        q.isOther === false &&
        !!q.options?.length &&
        values.some((v) => !q.options?.some((o) => o.label === v))
      )
        throw Error("Select one of the offered answers");
      return [q.id, { answers: values }];
    }),
  );
}
export function claudeQuestionInput(
  input: any,
  questions: Question[],
  answers: Answers,
) {
  const valid = validateQuestionAnswers(questions, answers);
  return {
    ...input,
    answers: Object.fromEntries(
      questions.map((q, i) => [
        input.questions[i].question,
        valid[q.id].answers.join(", "),
      ]),
    ),
  };
}
export const fullAccessThread = {
  approvalPolicy: "never" as const,
  sandbox: "danger-full-access" as const,
};
export const fullAccessTurn = {
  approvalPolicy: "never" as const,
  sandboxPolicy: { type: "dangerFullAccess" as const },
};
export const fullAccessClaude = {
  permissionMode: "bypassPermissions" as const,
  allowDangerouslySkipPermissions: true,
};
export const fullAccessCursorArgs = [
  "--force",
  "--sandbox",
  "disabled",
  "--trust",
  "--approve-mcps",
  "acp",
];
export function codexApproval(method: string, params: any): any | undefined {
  if (
    [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
    ].includes(method)
  )
    return { decision: "accept" };
  if (["execCommandApproval", "applyPatchApproval"].includes(method))
    return { decision: "approved" };
  if (method === "item/permissions/requestApproval")
    return {
      permissions: Object.fromEntries(
        Object.entries(params.permissions ?? {}).filter(([, v]) => v !== null),
      ),
      scope: "session",
    };
}

export function claudeToolHandler(ask: CanUseTool): CanUseTool {
  return (tool, input, options) =>
    tool === "AskUserQuestion"
      ? ask(tool, input, options)
      : Promise.resolve({ behavior: "allow", updatedInput: input });
}
