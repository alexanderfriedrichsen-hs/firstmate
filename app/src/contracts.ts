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
  provider: "codex" | "claude";
  providerId?: string;
  model: string;
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
    rollout: "gated_pending_permission_approval_and_accounting",
    version: "2.1.265",
    stream: "verified_in_isolated_fixture",
    history: "unsupported",
    resume: "verified_in_isolated_fixture",
    steer: "unsupported",
    interrupt: "unverified",
    permissionReply: "unverified",
    interactiveTakeover: "unverified",
    usage: "verified_in_isolated_fixture",
  },
  cursor: {
    status: "unavailable",
    reason:
      "Whole-run input and output token bound and account allowance are unverified. Hard cap: 5,000 tokens per calendar month, America/Los_Angeles, no rollover.",
  },
};
export const now = () => new Date().toISOString();
