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

// --- page context ---------------------------------------------------------

/**
 * A compact outline of what the user can see. The browser collects `[data-yoal-target]` elements
 * plus headings, buttons, links and tabs, and sends stable ids and CSS selectors. The agent picks
 * from this list, so it points at a real element instead of guessing at the DOM.
 */
export const assistantPageTargetSchema = z.object({
  /** Stable `data-yoal-target` id, when the element has one. */
  id: z.string().max(120).optional(),
  /** Authenticated CSS selector, as a fallback for elements without an id. */
  selector: z.string().max(500).optional(),
  label: z.string().max(200),
  kind: z
    .enum(["link", "button", "heading", "input", "tab", "region", "other"])
    .default("other"),
});

export const assistantPageContextSchema = z.object({
  /** Empty when the user turned page context off in the panel; then nothing below is sent. */
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
  /** Prefer a `data-yoal-target` id from the page outline. */
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
    }
  | {
      type: "text.delta";
      runId: string;
      text: string;
    }
  | {
      type: "tool.started";
      runId: string;
      callId: string;
      tool: string;
      title: string;
      /** Compact, truncated JSON of the arguments (file bodies summarised) for the step list. */
      args?: string;
    }
  | {
      type: "tool.finished";
      runId: string;
      callId: string;
      tool: string;
      ok: boolean;
      summary: string;
      /** A longer excerpt of the result for the expandable step (≤ 4,000 chars). */
      detail?: string;
      durationMs?: number;
    }
  | {
      type: "ui.guide";
      runId: string;
      guide: AssistantGuide;
    }
  | {
      type: "confirmation.required";
      runId: string;
      token: string;
      tool: string;
      title: string;
      summary: string;
      args: Record<string, unknown>;
    }
  | {
      type: "run.finished";
      runId: string;
      durationMs?: number;
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
}

/**
 * Owner-editable details of the assistant (Settings → Assistant → Instructions and tools). There
 * is one agent: it sees every MCP tool the caller may use unless the owner narrows the list.
 */
export interface AssistantAgentDetail {
  /** The full system prompt. */
  instructions: string;
  /** Optional model override; null uses YOAL_ASSISTANT_MODEL. */
  model: string | null;
  /** MCP tool names the assistant may call; null means every tool in the catalog. */
  tools: string[] | null;
  /** True when an owner has changed the assistant from its defaults. */
  customized: boolean;
}

/** A tool the owner can give the assistant. */
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
