import { z } from "zod";
export const uuid = z.string().uuid();
export const handling = z.enum(["agent_managed", "human_only"]);
export const priority = z.enum(["urgent", "high", "normal", "low"]);
export const commandSchema = z
  .object({
    commandId: uuid,
    type: z.string().min(1),
    targetId: uuid.optional(),
    expectedVersion: z.number().int().nonnegative().optional(),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type Command = z.infer<typeof commandSchema>;
export type Actor = {
  kind: "user" | "supervisor" | "worker" | "collector";
  id: string;
  ticketId?: string;
};
export type Ticket = {
  id: string;
  slug: string;
  title: string;
  brief: string;
  kind: "change" | "investigation";
  handling: z.infer<typeof handling>;
  priority: z.infer<typeof priority>;
  order: number;
  projectId?: string;
  status: string;
  version: number;
  revision?: string;
  completionContract: "merge" | "report" | "reviewed_draft";
  links: { kind: string; url: string }[];
  createdAt: string;
  updatedAt: string;
};
export type Conversation = {
  id: string;
  ticketId?: string;
  provider: "codex" | "claude" | "cursor";
  providerId?: string;
  model: string;
  effort?: string;
  role: string;
  cwd: string;
  runnerId?: string;
  incarnation: number;
  state: string;
  inputOwner: string;
  version: number;
  draft?: string;
  retiredAt?: string;
  previousConversationId?: string;
  stage?: "implement" | "investigate" | "review" | "repair";
  reviewRevision?: string;
  baseRevision?: string;
};
export type Attempt = {
  id: string;
  ticketId: string;
  conversationId: string;
  role: string;
  state: string;
  revision?: string;
  ordinal: number;
  parentId?: string;
  createdAt: string;
  endedAt?: string;
  result?: string;
};
export const capabilities = {
  codex: {
    version: "0.153.4",
    stream: "verified_in_isolated_fixture",
    history: "unverified",
    resume: "verified_in_isolated_fixture",
    steer: "unverified",
    interrupt: "verified_in_isolated_fixture",
    permissionReply: "verified_in_isolated_fixture",
    interactiveTakeover: "unverified",
    usage: "verified_in_isolated_fixture",
  },
  claude: {
    rollout: "available_with_native_subscription_auth",
    verification:
      "Native authentication and model metadata checked; paid-turn smoke not performed in this rollout.",
    version: "2.1.265",
    stream: "verified_in_isolated_fixture",
    history: "unsupported",
    resume: "verified_in_isolated_fixture",
    steer: "unsupported",
    interrupt: "verified_in_isolated_fixture",
    permissionReply: "implemented_native_sdk_callback_not_live_smoke_tested",
    interactiveTakeover: "unverified",
    usage: "verified_in_isolated_fixture",
  },
  cursor: {
    status: "available_with_native_subscription_auth",
    version: "2026.09.08-6caf4ff",
    stream: "verified_in_native_subscription_smoke",
    newSession: "verified_in_native_subscription_smoke",
    model: "verified_in_native_subscription_smoke",
    resume: "verified_in_isolated_fixture",
    permissionReply: "verified_in_isolated_fixture",
    interrupt: "verified_in_isolated_fixture",
    usage: "unavailable_in_native_smoke",
    hardCapEnforced: false,
    reason:
      "Subscription usage reporting requires an explicit provider setting. Native smoke verified session creation, model selection, and streamed output. Resume, interruption, and permissions have fixture coverage. Token usage and account allowance are unavailable when Cursor does not report them; strict token caps are not enforced.",
  },
};
export const now = () => new Date().toISOString();
