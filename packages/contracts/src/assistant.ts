import * as z from "zod";

/**
 * The optional dashboard assistant (docs/ASSISTANT.md).
 *
 * It is a chat surface over the *same* MCP tool catalog the remote MCP server exposes: one service
 * layer, one permission model, one audit trail. On top of the MCP tools it gets a small UI channel,
 * so it can navigate the dashboard and spotlight the element it is talking about.
 *
 * Nothing here is enabled until an owner configures a model provider in Settings → Assistant.
 */

/** Specialist agents the lead can hand a turn to. Keep in sync with the server prompts. */
export const ASSISTANT_AGENTS = [
  {
    id: "guide",
    label: "Guide",
    description:
      "Explains the dashboard, answers “where do I click?” and points at the right element.",
  },
  {
    id: "projects",
    label: "Projects",
    description:
      "Projects, releases, environments, workloads, access and share links.",
  },
  {
    id: "data",
    label: "Data",
    description:
      "Managed Postgres databases, object storage, buckets and attachments.",
  },
  {
    id: "platform",
    label: "Platform",
    description:
      "Fleet health, nodes, capacity, metrics, logs, audit and mass operations.",
  },
] as const;

export type AssistantAgentId = (typeof ASSISTANT_AGENTS)[number]["id"];
export const assistantAgentIds = ASSISTANT_AGENTS.map((agent) => agent.id) as [
  AssistantAgentId,
  ...AssistantAgentId[],
];

/** The lead agent is not selectable; it greets, routes and synthesises. */
export type AssistantSpeaker = AssistantAgentId | "lead";

export const assistantAgentLabel = (id: AssistantSpeaker): string =>
  id === "lead"
    ? "Skiff"
    : (ASSISTANT_AGENTS.find((agent) => agent.id === id)?.label ?? id);

// --- page context ---------------------------------------------------------

/**
 * A compact outline of what the user can see. The browser collects `[data-skiff-target]` elements
 * plus headings, buttons, links and tabs, and sends stable ids and CSS selectors. The agent picks
 * from this list, so it points at a real element instead of guessing at the DOM.
 */
export const assistantPageTargetSchema = z.object({
  /** Stable `data-skiff-target` id, when the element has one. */
  id: z.string().max(120).optional(),
  /** Authenticated CSS selector, as a fallback for elements without an id. */
  selector: z.string().max(500).optional(),
  label: z.string().max(200),
  kind: z
    .enum(["link", "button", "heading", "input", "tab", "region", "other"])
    .default("other"),
});

export const assistantPageContextSchema = z.object({
  path: z.string().max(500),
  title: z.string().max(200).optional(),
  /** Project slug when the user is on a project page. */
  project: z.string().max(100).optional(),
  targets: z.array(assistantPageTargetSchema).max(120).default([]),
});

export type AssistantPageContext = z.infer<typeof assistantPageContextSchema>;
export type AssistantPageTarget = z.infer<typeof assistantPageTargetSchema>;

// --- chat -----------------------------------------------------------------

export const assistantHistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(12_000),
});

export const assistantChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  /** Text-only history; tool calls are re-derived from the tools on every turn. */
  history: z.array(assistantHistoryMessageSchema).max(30).default([]),
  context: assistantPageContextSchema,
});

export type AssistantChatRequest = z.infer<typeof assistantChatRequestSchema>;

// --- guided tour ----------------------------------------------------------

export const assistantGuideStepSchema = z.object({
  /** Navigate first when the step is on another page. */
  path: z.string().max(500).optional(),
  /** Prefer a `data-skiff-target` id from the page outline. */
  target: z.string().max(120).optional(),
  /** Fallback CSS selector. */
  selector: z.string().max(500).optional(),
  title: z.string().min(1).max(140),
  body: z.string().min(1).max(700),
});

export const assistantGuideSchema = z.object({
  intro: z.string().max(500).optional(),
  steps: z.array(assistantGuideStepSchema).min(1).max(8),
});

export type AssistantGuide = z.infer<typeof assistantGuideSchema>;
export type AssistantGuideStep = z.infer<typeof assistantGuideStepSchema>;

// --- streamed events ------------------------------------------------------

export type AssistantEvent =
  | {
      type: "run.started";
      runId: string;
      agents: AssistantAgentId[];
      note?: string;
    }
  | {
      type: "agent.started";
      runId: string;
      agent: AssistantSpeaker;
      label: string;
    }
  | {
      type: "agent.finished";
      runId: string;
      agent: AssistantSpeaker;
      label: string;
    }
  | {
      type: "text.delta";
      runId: string;
      agent: AssistantSpeaker;
      text: string;
    }
  | {
      type: "tool.started";
      runId: string;
      agent: AssistantSpeaker;
      callId: string;
      tool: string;
      title: string;
    }
  | {
      type: "tool.finished";
      runId: string;
      agent: AssistantSpeaker;
      callId: string;
      tool: string;
      ok: boolean;
      summary: string;
    }
  | {
      type: "ui.guide";
      runId: string;
      agent: AssistantSpeaker;
      guide: AssistantGuide;
    }
  | {
      type: "confirmation.required";
      runId: string;
      agent: AssistantSpeaker;
      token: string;
      tool: string;
      title: string;
      summary: string;
      args: Record<string, unknown>;
    }
  | {
      type: "run.finished";
      runId: string;
      agents: AssistantAgentId[];
    }
  | {
      type: "error";
      runId: string;
      message: string;
    };

export interface AssistantStatus {
  /** False means the owner has not configured a provider. The launcher is hidden. */
  enabled: boolean;
  configured: boolean;
  provider: string | null;
  model: string | null;
  /** The base URL is not secret, but only shown to users who can see the settings page. */
  agents: ReadonlyArray<{
    id: AssistantAgentId;
    label: string;
    description: string;
    enabled: boolean;
  }>;
  maxAgents: number;
}

/** Owner-editable details for one specialist (Settings → Assistant → Agents). */
export interface AssistantAgentDetail {
  id: AssistantAgentId;
  /** Defaults to ASSISTANT_AGENTS.label. */
  label: string;
  /** The one-line routing description the lead sees. */
  description: string;
  /** The specialist's full system prompt. */
  instructions: string;
  enabled: boolean;
  /** Optional model override; null uses SKIFF_ASSISTANT_MODEL. */
  model: string | null;
  /** MCP tool names this agent may call. */
  tools: string[];
  /** True when an owner has changed this agent from its defaults. */
  customized: boolean;
}

/** A tool the owner can give an agent. */
export interface AssistantToolInfo {
  name: string;
  title: string;
  description: string;
  destructive: boolean;
}

/** A model the owner can pick in Settings → Assistant (currently OpenRouter's catalogue). */
export interface AssistantModelInfo {
  id: string;
  name: string;
  contextLength: number | null;
  /** USD per input token. */
  promptPrice: number | null;
  /** USD per output token. */
  completionPrice: number | null;
  supportsTools: boolean;
}

/** A pending destructive action the user must confirm in the chat before it runs. */
export interface AssistantConfirmation {
  token: string;
  tool: string;
  title: string;
  summary: string;
  args: Record<string, unknown>;
}

/** Settings → Assistant, and the test button. */
export type AssistantTestResult =
  | { ok: true; model: string; models: string[] }
  | { ok: false; message: string };
