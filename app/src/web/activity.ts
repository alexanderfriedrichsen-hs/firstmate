/** Hide only known routine audit references, never substantive text or errors. */
export function isRoutineActivity(message: {
  role?: string;
  kind?: string;
  content?: string;
  attachments?: unknown[];
}) {
  if (
    message.role !== "tool" ||
    message.kind !== "activity" ||
    message.attachments?.length
  )
    return false;
  try {
    const data = JSON.parse(message.content ?? "");
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    // Older providers expose only an audit reference. Unknown richer payloads stay visible.
    return (
      Object.keys(data).every((key) => ["label", "artifactId"].includes(key)) &&
      ["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(
        data.label,
      ) &&
      typeof data.artifactId === "string" &&
      /^[a-f0-9]{64}$/.test(data.artifactId)
    );
  } catch {
    return false;
  }
}
