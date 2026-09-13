import test from "node:test";
import assert from "node:assert/strict";
import { isRoutineActivity } from "../src/web/activity.ts";
test("only known routine audit references are quiet; substantive content and errors stay visible", () => {
  const message = {
    role: "tool",
    kind: "activity",
    content: JSON.stringify({
      label: "commandExecution",
      artifactId: "a".repeat(64),
    }),
  };
  assert.equal(isRoutineActivity(message), true);
  for (const label of ["fileChange", "mcpToolCall", "webSearch"])
    assert.equal(
      isRoutineActivity({
        ...message,
        content: JSON.stringify({ label, artifactId: "a".repeat(64) }),
      }),
      true,
    );
  for (const extra of [
    { error: "Permission denied" },
    { status: "failed" },
    { exitCode: 1 },
    { output: "Substantive finding" },
  ])
    assert.equal(
      isRoutineActivity({
        ...message,
        content: JSON.stringify({ ...JSON.parse(message.content), ...extra }),
      }),
      false,
    );
  assert.equal(isRoutineActivity({ ...message, role: "assistant" }), false);
  assert.equal(isRoutineActivity({ ...message, kind: "message" }), false);
  assert.equal(
    isRoutineActivity({ ...message, content: "A substantive tool warning" }),
    false,
  );
  assert.equal(
    isRoutineActivity({ ...message, attachments: [{ id: "report" }] }),
    false,
  );
  assert.equal(
    isRoutineActivity({
      ...message,
      content: JSON.stringify({
        label: "question",
        artifactId: "a".repeat(64),
      }),
    }),
    false,
  );
});
