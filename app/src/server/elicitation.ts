import {
  normalizeQuestions,
  validateQuestionAnswers,
  type Question,
} from "./questions.ts";
export function mcpApproval(params: any) {
  const schema = params?.requestedSchema;
  if (
    params?.serverName === "codex_apps" &&
    ["form", "openai/form", "openaiForm"].includes(params.mode) &&
    params._meta?.codex_approval_kind === "tool_suggestion" &&
    schema?.type === "object" &&
    schema.properties &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties) &&
    Object.keys(schema.properties).length === 0 &&
    (!schema.required ||
      (Array.isArray(schema.required) && !schema.required.length))
  )
    return { action: "accept", content: {}, _meta: null };
}
export function mcpQuestions(params: any): {
  questions: Question[];
  url?: string;
} {
  if (params.mode === "url") {
    const url = new URL(params.url);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw Error("Unsupported authentication URL");
    return {
      url: url.href,
      questions: normalizeQuestions("codex", {
        questions: [
          {
            id: "confirm",
            header: "Authentication",
            question: params.message,
            options: [{ label: "Continue" }, { label: "Cancel" }],
            isOther: false,
          },
        ],
      }),
    };
  }
  if (!["form", "openai/form", "openaiForm"].includes(params.mode))
    throw Error("Unsupported elicitation mode");
  const schema = params.requestedSchema;
  if (
    schema?.type !== "object" ||
    !schema.properties ||
    Array.isArray(schema.properties) ||
    typeof schema.properties !== "object"
  )
    throw Error("Unsupported form schema");
  const keys = Object.keys(schema.properties);
  if (
    keys.length > 16 ||
    (schema.required &&
      (!Array.isArray(schema.required) ||
        schema.required.some((k: any) => !keys.includes(k))))
  )
    throw Error("Unsupported form fields");
  if (keys.some((id) => !schema.required?.includes(id)))
    throw Error("Optional form fields are not supported yet");
  const questions = keys.map((id) => {
    const f = schema.properties[id];
    if (
      !f ||
      !["string", "number", "integer", "boolean"].includes(f.type) ||
      f.format ||
      f.pattern ||
      f.oneOf
    )
      throw Error("Unsupported form field");
    if (
      f.enum &&
      (!Array.isArray(f.enum) || f.enum.some((v: any) => typeof v !== "string"))
    )
      throw Error("Unsupported form choices");
    return {
      id,
      header: f.title ?? id,
      question: f.description ?? params.message,
      isSecret: /password|secret|token/i.test(id),
      options:
        f.type === "boolean"
          ? [{ label: "true" }, { label: "false" }]
          : f.enum?.map((label: string) => ({ label })),
      isOther: !(f.enum || f.type === "boolean"),
    };
  });
  return {
    questions: normalizeQuestions("codex", {
      questions: questions.length
        ? questions
        : [
            {
              id: "confirm",
              header: "Question",
              question: params.message,
              options: [{ label: "Accept" }, { label: "Decline" }],
              isOther: false,
            },
          ],
    }),
  };
}
export function mcpAnswer(
  params: any,
  questions: Question[],
  answers: unknown,
) {
  const valid = validateQuestionAnswers(questions, answers);
  if (params.mode === "url")
    return {
      action: valid.confirm.answers[0] === "Continue" ? "accept" : "cancel",
      content: null,
      _meta: null,
    };
  const fields = params.requestedSchema.properties;
  if (!Object.keys(fields).length)
    return {
      action: valid.confirm.answers[0] === "Accept" ? "accept" : "decline",
      content: valid.confirm.answers[0] === "Accept" ? {} : null,
      _meta: null,
    };
  const content = Object.fromEntries(
    Object.entries(fields).map(([id, f]: [string, any]) => {
      const raw = valid[id].answers[0];
      let value: any = raw;
      if (f.type === "boolean") value = raw === "true";
      if (f.type === "number" || f.type === "integer") {
        value = Number(raw);
        if (
          !Number.isFinite(value) ||
          (f.type === "integer" && !Number.isInteger(value)) ||
          (f.minimum !== undefined && value < f.minimum) ||
          (f.maximum !== undefined && value > f.maximum)
        )
          throw Error("Enter a number within the requested limits");
      }
      if (
        f.type === "string" &&
        ((f.minLength !== undefined && raw.length < f.minLength) ||
          (f.maxLength !== undefined && raw.length > f.maxLength))
      )
        throw Error("Text length is outside the requested limits");
      return [id, value];
    }),
  );
  return { action: "accept", content, _meta: null };
}
