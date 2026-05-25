import {
  buildSessionContext,
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import os from "node:os";
import path from "node:path";
import { readPiYuConfigFile } from "../config.ts";
const HELPY_CWD = path.join(os.homedir(), "DotFiles");

type HelpyConfig = { thinking?: "off" | AiThinkingLevel };
async function loadHelpyConfig(cwd: string): Promise<HelpyConfig> {
  try {
    const { content } = await readPiYuConfigFile(cwd);
    if (!content) return {};
    const parsed = JSON.parse(content) as { helpy?: HelpyConfig };
    return parsed.helpy ?? {};
  } catch {
    return {};
  }
}
import { type AssistantMessage, type Message, type ThinkingLevel as AiThinkingLevel, type UserMessage } from "@earendil-works/pi-ai";
import {
  Box,
  Container,
  Input,
  Key,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type KeybindingsManager,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";

const HELPY_MESSAGE_TYPE = "helpy-note";
const HELPY_ENTRY_TYPE = "helpy-thread-entry";
const HELPY_RESET_TYPE = "helpy-thread-reset";
const HELPY_MODEL_OVERRIDE_TYPE = "helpy-model-override";
const HELPY_THINKING_OVERRIDE_TYPE = "helpy-thinking-override";
const HELPY_FOCUS_SHORTCUTS = [Key.alt("h"), Key.ctrlAlt("h")] as const;

function matchesHelpyFocusShortcut(data: string): boolean {
  return HELPY_FOCUS_SHORTCUTS.some((shortcut) => matchesKey(data, shortcut));
}

const HELPY_SYSTEM_PROMPT = [
  "You are the DotFiles Q&A assistant for Yuri.",
  "Working directory is ~/DotFiles. Treat the entire repo as your knowledge base.",
  "Authoritative entry point: HELP.md. Other key surfaces: home/.config/** (fish, nvim, zellij, starship), home/.pi/agent/** (pi extensions), keyboard/, dotfiles.conf, AGENTS.md.",
  "When asked a question: grep/read the actual files before answering, do not guess. Cite file paths and line numbers. Prefer concise answers, then a short pointer to where to look in the repo.",
  "If a question is about a tool not present in this repo, say so.",
  "Do not modify files unless the user explicitly asks for an edit.",
].join(" ");

const HELPY_SUMMARIZE_SYSTEM_PROMPT =
  "Summarize the side conversation concisely. Preserve key decisions, plans, insights, risks, and action items. Output only the summary.";

const HELPY_CONTINUE_THREAD_USER_TEXT = "[The following is a separate side conversation. Continue this thread.]";
const HELPY_CONTINUE_THREAD_ASSISTANT_TEXT = "Understood, continuing our side conversation.";

type SessionThinkingLevel = "off" | AiThinkingLevel;
type HelpyThreadMode = "contextual" | "tangent";
type SessionModel = NonNullable<ExtensionCommandContext["model"]>;
/**
 * Loose model reference parsed from `/helpy:model <provider> <id> <api>` and persisted to
 * session entries. Resolved to a full SessionModel via ctx.modelRegistry.find(...).
 */
type HelpyModelRef = Pick<SessionModel, "provider" | "id" | "api">;

type HelpyDetails = {
  question: string;
  thinking: string;
  answer: string;
  provider: string;
  model: string;
  api: string;
  thinkingLevel: SessionThinkingLevel;
  timestamp: number;
  usage?: AssistantMessage["usage"];
};

type ParsedHelpyArgs = {
  question: string;
  save: boolean;
};

type SaveState = "not-saved" | "saved" | "queued";

type HelpyResetDetails = {
  timestamp: number;
  mode?: HelpyThreadMode;
};

type HelpyModelOverrideDetails =
  | ({ timestamp: number; action: "set" } & Pick<SessionModel, "provider" | "id" | "api">)
  | { timestamp: number; action: "clear" };

type HelpyThinkingOverrideDetails =
  | { timestamp: number; action: "set"; thinkingLevel: SessionThinkingLevel }
  | { timestamp: number; action: "clear" };

type ResolvedHelpyModel = {
  model: SessionModel | null;
  source: "override" | "main" | "none";
  configuredOverride: SessionModel | null;
  fallbackReason?: string;
};

type ResolvedHelpySettings = {
  model: SessionModel | null;
  modelSource: "override" | "main" | "none";
  configuredModelOverride: SessionModel | null;
  thinkingLevel: SessionThinkingLevel;
  thinkingSource: "override" | "main";
  fallbackReason?: string;
};

type HelpyTranscriptEntry =
  | { id: number; turnId: number; type: "turn-boundary"; phase: "start" | "end" }
  | { id: number; turnId: number; type: "user-message"; text: string }
  | { id: number; turnId: number; type: "thinking"; text: string; streaming: boolean }
  | { id: number; turnId: number; type: "assistant-text"; text: string; streaming: boolean }
  | { id: number; turnId: number; type: "tool-call"; toolCallId: string; toolName: string; args: string }
  | {
      id: number;
      turnId: number;
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      content: string;
      truncated: boolean;
      isError: boolean;
      streaming: boolean;
    };

type HelpyTranscript = HelpyTranscriptEntry[];

type HelpyTranscriptState = {
  entries: HelpyTranscript;
  nextEntryId: number;
  nextTurnId: number;
  currentTurnId: number | null;
  lastTurnId: number | null;
  toolCalls: Map<string, { turnId: number; callEntryId: number; resultEntryId?: number }>;
};

type HelpySessionRuntime = {
  session: AgentSession;
  mode: HelpyThreadMode;
  subscriptions: Set<() => void>;
  sideThreadStartIndex: number;
};

type OverlayRuntime = {
  handle?: OverlayHandle;
  refresh?: () => void;
  close?: () => void;
  finish?: () => void;
  setDraft?: (value: string) => void;
  closed?: boolean;
};

function isVisibleHelpyMessage(message: { role: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType === HELPY_MESSAGE_TYPE;
}

function isCustomEntry(entry: unknown, customType: string): entry is { type: "custom"; customType: string; data?: unknown } {
  return !!entry && typeof entry === "object" && (entry as { type?: string }).type === "custom" && (entry as { customType?: string }).customType === customType;
}

function stripDynamicSystemPromptFooter(systemPrompt: string): string {
  return systemPrompt
    .replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
    .replace(/\nCurrent working directory:[^\n]*$/u, "")
    .trim();
}

function createHelpyResourceLoader(
  ctx: ExtensionCommandContext,
  appendSystemPrompt: string[] = [HELPY_SYSTEM_PROMPT],
): ResourceLoader {
  const extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());

  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => appendSystemPrompt,
    extendResources: () => {},
    reload: async () => {},
  };
}

function extractText(parts: AssistantMessage["content"], type: "text" | "thinking"): string {
  const chunks: string[] = [];

  for (const part of parts) {
    if (type === "text" && part.type === "text") {
      chunks.push(part.text);
    } else if (type === "thinking" && part.type === "thinking") {
      chunks.push(part.thinking);
    }
  }

  return chunks.join("\n").trim();
}

function extractAnswer(message: AssistantMessage): string {
  return extractText(message.content, "text") || "(No text response)";
}

function extractThinking(message: AssistantMessage): string {
  return extractText(message.content, "thinking");
}

function parseHelpyArgs(args: string): ParsedHelpyArgs {
  const save = /(?:^|\s)(?:--save|-s)(?=\s|$)/.test(args);
  const question = args.replace(/(?:^|\s)(?:--save|-s)(?=\s|$)/g, " ").trim();
  return { question, save };
}

function parseHelpyModelArgs(args: string):
  | { action: "show" }
  | { action: "clear" }
  | { action: "set"; model: HelpyModelRef }
  | { action: "invalid"; message: string } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { action: "show" };
  }

  if (trimmed === "clear") {
    return { action: "clear" };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 3) {
    return { action: "invalid", message: "Usage: /helpy:model <provider> <model> <api> | clear" };
  }

  const [provider, id, api] = parts;
  return { action: "set", model: { provider, id, api } as HelpyModelRef };
}

function parseHelpyThinkingArgs(args: string):
  | { action: "show" }
  | { action: "clear" }
  | { action: "set"; thinkingLevel: SessionThinkingLevel } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { action: "show" };
  }

  if (trimmed === "clear") {
    return { action: "clear" };
  }

  return { action: "set", thinkingLevel: trimmed as SessionThinkingLevel };
}

function formatModelRef(model: Pick<SessionModel, "provider" | "id" | "api">): string {
  return `${model.provider}/${model.id} (${model.api})`;
}

function buildHelpySeedState(
  ctx: ExtensionCommandContext,
  thread: HelpyDetails[],
  mode: HelpyThreadMode,
  sessionModel: SessionModel | null,
): { messages: Message[]; sideThreadStartIndex: number } {
  const messages: Message[] = [];

  if (mode === "contextual") {
    try {
      messages.push(
        ...(buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages as Message[]).filter(
          (message) => !isVisibleHelpyMessage(message),
        ),
      );
    } catch {
      messages.push(
        ...ctx.sessionManager.getEntries().flatMap((entry) => {
          if (!entry || typeof entry !== "object") {
            return [];
          }

          const message = entry as unknown as Partial<Message> & { role?: string; customType?: string; content?: unknown };
          if (typeof message.role !== "string" || !Array.isArray(message.content)) {
            return [];
          }

          return isVisibleHelpyMessage({ role: message.role, customType: message.customType }) ? [] : [message as Message];
        }),
      );
    }
  }

  const sideThreadStartIndex = messages.length;

  if (thread.length > 0) {
    messages.push(
      {
        role: "user",
        content: [{ type: "text", text: HELPY_CONTINUE_THREAD_USER_TEXT }],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: HELPY_CONTINUE_THREAD_ASSISTANT_TEXT }],
        provider: sessionModel?.provider ?? "unknown",
        model: sessionModel?.id ?? "unknown",
        api: sessionModel?.api ?? "openai-responses",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    );

    for (const entry of thread) {
      messages.push(
        {
          role: "user",
          content: [{ type: "text", text: entry.question }],
          timestamp: entry.timestamp,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: entry.answer }],
          provider: entry.provider,
          model: entry.model,
          api: entry.api || sessionModel?.api || ctx.model?.api || "openai-responses",
          usage:
            entry.usage ?? {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          stopReason: "stop",
          timestamp: entry.timestamp,
        },
      );
    }
  }

  return {
    messages,
    sideThreadStartIndex,
  };
}

function formatToolPreview(value: unknown): string {
  if (value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const path = (value as { path?: unknown }).path;
    if (typeof path === "string") {
      return path;
    }
  }

  try {
    const preview = JSON.stringify(value);
    if (!preview || preview === "{}") {
      return "";
    }
    return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
  } catch {
    return "";
  }
}

function createEmptyTranscriptState(): HelpyTranscriptState {
  return {
    entries: [],
    nextEntryId: 1,
    nextTurnId: 1,
    currentTurnId: null,
    lastTurnId: null,
    toolCalls: new Map(),
  };
}

function appendTranscriptEntry<T extends HelpyTranscriptEntry>(
  state: HelpyTranscriptState,
  entry: Omit<T, "id">,
): T {
  const nextEntry = { ...entry, id: state.nextEntryId++ } as T;
  state.entries.push(nextEntry);
  return nextEntry;
}

function ensureTranscriptTurn(state: HelpyTranscriptState): number {
  if (state.currentTurnId !== null) {
    return state.currentTurnId;
  }

  const turnId = state.nextTurnId++;
  state.currentTurnId = turnId;
  state.lastTurnId = turnId;
  appendTranscriptEntry(state, { type: "turn-boundary", turnId, phase: "start" } as Omit<Extract<HelpyTranscriptEntry, { type: "turn-boundary" }>, "id">);
  return turnId;
}

function finishTranscriptTurn(state: HelpyTranscriptState, turnId?: number | null): void {
  const resolvedTurnId = turnId ?? state.currentTurnId;
  if (resolvedTurnId === null || resolvedTurnId === undefined) {
    return;
  }

  const hasEndBoundary = state.entries.some(
    (entry) => entry.turnId === resolvedTurnId && entry.type === "turn-boundary" && entry.phase === "end",
  );
  if (!hasEndBoundary) {
    appendTranscriptEntry(state, { type: "turn-boundary", turnId: resolvedTurnId, phase: "end" } as Omit<Extract<HelpyTranscriptEntry, { type: "turn-boundary" }>, "id">);
  }

  for (const entry of state.entries) {
    if (entry.turnId !== resolvedTurnId) {
      continue;
    }

    if (entry.type === "thinking" || entry.type === "assistant-text" || entry.type === "tool-result") {
      entry.streaming = false;
    }
  }

  state.lastTurnId = resolvedTurnId;
  if (state.currentTurnId === resolvedTurnId) {
    state.currentTurnId = null;
  }
}

function removeTranscriptTurn(state: HelpyTranscriptState, turnId: number | null): void {
  if (turnId === null) {
    return;
  }

  state.entries = state.entries.filter((entry) => entry.turnId !== turnId);
  for (const [toolCallId, toolCall] of state.toolCalls.entries()) {
    if (toolCall.turnId === turnId) {
      state.toolCalls.delete(toolCallId);
    }
  }

  if (state.currentTurnId === turnId) {
    state.currentTurnId = null;
  }
  if (state.lastTurnId === turnId) {
    state.lastTurnId = null;
  }
}

function findLatestTranscriptEntry<TType extends HelpyTranscriptEntry["type"]>(
  state: HelpyTranscriptState,
  turnId: number,
  type: TType,
): Extract<HelpyTranscriptEntry, { type: TType }> | undefined {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const entry = state.entries[i];
    if (entry.turnId === turnId && entry.type === type) {
      return entry as Extract<HelpyTranscriptEntry, { type: TType }>;
    }
  }

  return undefined;
}

function ensureTranscriptTurnForUserMessage(state: HelpyTranscriptState): number {
  if (state.currentTurnId !== null) {
    const currentAssistant = findLatestTranscriptEntry(state, state.currentTurnId, "assistant-text");
    if (currentAssistant && !currentAssistant.streaming) {
      finishTranscriptTurn(state, state.currentTurnId);
    }
  }

  return ensureTranscriptTurn(state);
}

function extractMessageText(message: { content?: string | AssistantMessage["content"] | UserMessage["content"] }): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function upsertUserMessageEntry(state: HelpyTranscriptState, turnId: number, text: string): void {
  if (!text) {
    return;
  }

  const existing = findLatestTranscriptEntry(state, turnId, "user-message");
  if (existing) {
    existing.text = text;
    return;
  }

  appendTranscriptEntry(state, { type: "user-message", turnId, text } as Omit<Extract<HelpyTranscriptEntry, { type: "user-message" }>, "id">);
}

function upsertTranscriptTextEntry(
  state: HelpyTranscriptState,
  turnId: number,
  type: "thinking" | "assistant-text",
  text: string,
  streaming: boolean,
): void {
  if (!text) {
    return;
  }

  const existing = findLatestTranscriptEntry(state, turnId, type);
  if (existing) {
    existing.text = text;
    existing.streaming = streaming;
    return;
  }

  appendTranscriptEntry(state, { type, turnId, text, streaming } as Omit<Extract<HelpyTranscriptEntry, { type: "thinking" | "assistant-text" }>, "id">);
}

function summarizeToolResult(value: unknown, maxLength = 400): { content: string; truncated: boolean } {
  let content = "";

  if (value && typeof value === "object") {
    const toolValue = value as {
      content?: Array<{ type?: string; text?: string }>;
      error?: unknown;
      message?: unknown;
    };

    if (Array.isArray(toolValue.content)) {
      content = toolValue.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
    }

    if (!content && typeof toolValue.error === "string") {
      content = toolValue.error;
    }

    if (!content && typeof toolValue.message === "string") {
      content = toolValue.message;
    }
  }

  if (!content) {
    if (typeof value === "string") {
      content = value;
    } else if (value !== undefined) {
      try {
        content = JSON.stringify(value, null, 2);
      } catch {
        content = String(value);
      }
    }
  }

  if (!content) {
    content = "(no tool output)";
  }

  const truncated = content.length > maxLength;
  return {
    content: truncated ? `${content.slice(0, maxLength - 3)}...` : content,
    truncated,
  };
}

function ensureToolCallEntry(
  state: HelpyTranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  args: string,
): { turnId: number; callEntryId: number; resultEntryId?: number } {
  const existing = state.toolCalls.get(toolCallId);
  if (existing) {
    return existing;
  }

  const callEntry = appendTranscriptEntry(state, {
    type: "tool-call",
    turnId,
    toolCallId,
    toolName,
    args,
  } as Omit<Extract<HelpyTranscriptEntry, { type: "tool-call" }>, "id">);
  const record = { turnId, callEntryId: callEntry.id };
  state.toolCalls.set(toolCallId, record);
  return record;
}

function upsertToolResultEntry(
  state: HelpyTranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  content: string,
  truncated: boolean,
  isError: boolean,
  streaming: boolean,
): void {
  const toolCall = ensureToolCallEntry(state, turnId, toolCallId, toolName, "");
  const existing =
    toolCall.resultEntryId !== undefined
      ? state.entries.find((entry) => entry.id === toolCall.resultEntryId && entry.type === "tool-result")
      : undefined;

  if (existing && existing.type === "tool-result") {
    existing.content = content;
    existing.truncated = truncated;
    existing.isError = isError;
    existing.streaming = streaming;
    return;
  }

  const resultEntry = appendTranscriptEntry(state, {
    type: "tool-result",
    turnId,
    toolCallId,
    toolName,
    content,
    truncated,
    isError,
    streaming,
  } as Omit<Extract<HelpyTranscriptEntry, { type: "tool-result" }>, "id">);
  toolCall.resultEntryId = resultEntry.id;
}

function applyAssistantMessageToTranscript(
  state: HelpyTranscriptState,
  turnId: number,
  message: AssistantMessage,
  streaming: boolean,
): void {
  const assistantMessage = message;
  const thinking = extractThinking(assistantMessage);
  const answer = extractMessageText(assistantMessage);

  if (thinking) {
    upsertTranscriptTextEntry(state, turnId, "thinking", thinking, streaming);
  }

  if (answer) {
    upsertTranscriptTextEntry(state, turnId, "assistant-text", answer, streaming);
  }
}

function applyTranscriptEvent(state: HelpyTranscriptState, event: AgentSessionEvent): void {
  switch (event.type) {
    case "turn_start": {
      ensureTranscriptTurn(state);
      return;
    }
    case "message_start": {
      if (event.message.role === "user") {
        const turnId = ensureTranscriptTurnForUserMessage(state);
        upsertUserMessageEntry(state, turnId, extractMessageText(event.message));
        return;
      }

      if (event.message.role === "assistant") {
        const turnId = ensureTranscriptTurn(state);
        applyAssistantMessageToTranscript(state, turnId, event.message, true);
      }
      return;
    }
    case "message_update": {
      if (event.message.role !== "assistant") {
        return;
      }

      const turnId = ensureTranscriptTurn(state);
      applyAssistantMessageToTranscript(state, turnId, event.message, true);
      return;
    }
    case "message_end": {
      if (event.message.role === "user") {
        const turnId = ensureTranscriptTurnForUserMessage(state);
        upsertUserMessageEntry(state, turnId, extractMessageText(event.message));
        return;
      }

      if (event.message.role === "assistant") {
        const turnId = ensureTranscriptTurn(state);
        applyAssistantMessageToTranscript(state, turnId, event.message, false);
      }
      return;
    }
    case "tool_execution_start": {
      const turnId = ensureTranscriptTurn(state);
      ensureToolCallEntry(state, turnId, event.toolCallId, event.toolName, formatToolPreview(event.args));
      return;
    }
    case "tool_execution_update": {
      const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? ensureTranscriptTurn(state);
      const result = summarizeToolResult(event.partialResult);
      upsertToolResultEntry(
        state,
        turnId,
        event.toolCallId,
        event.toolName,
        result.content,
        result.truncated,
        false,
        true,
      );
      return;
    }
    case "tool_execution_end": {
      const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? ensureTranscriptTurn(state);
      const result = summarizeToolResult(event.result);
      upsertToolResultEntry(
        state,
        turnId,
        event.toolCallId,
        event.toolName,
        result.content,
        result.truncated,
        event.isError,
        false,
      );
      return;
    }
    case "turn_end": {
      finishTranscriptTurn(state);
      return;
    }
    default:
      return;
  }
}

function appendPersistedTranscriptTurn(state: HelpyTranscriptState, details: HelpyDetails): void {
  const turnId = ensureTranscriptTurn(state);
  upsertUserMessageEntry(state, turnId, details.question);
  if (details.thinking) {
    upsertTranscriptTextEntry(state, turnId, "thinking", details.thinking, false);
  }
  upsertTranscriptTextEntry(state, turnId, "assistant-text", details.answer, false);
  finishTranscriptTurn(state, turnId);
}

function setTranscriptFailure(state: HelpyTranscriptState, message: string): void {
  const turnId = state.currentTurnId ?? state.lastTurnId ?? ensureTranscriptTurn(state);
  upsertTranscriptTextEntry(state, turnId, "assistant-text", `❌ ${message}`, false);
  finishTranscriptTurn(state, turnId);
}

function hasStreamingTranscriptEntry(entries: HelpyTranscript): boolean {
  return entries.some(
    (entry) =>
      (entry.type === "thinking" || entry.type === "assistant-text" || entry.type === "tool-result") &&
      entry.streaming,
  );
}

function getCompletedExchangeCount(entries: HelpyTranscript): number {
  return entries.filter((entry) => entry.type === "assistant-text" && !entry.streaming).length;
}

function buildOverlayTranscript(entries: HelpyTranscript, theme: ExtensionContext["ui"]["theme"]): string[] {
  if (entries.length === 0) {
    return [theme.fg("dim", "No HELPY thread yet. Ask a side question to start one.")];
  }

  const lines: string[] = [];
  const userBadge = buildTranscriptBadge(theme, "You", "userMessageBg", "accent");
  const thinkingBadge = buildTranscriptBadge(theme, "Thinking", "toolPendingBg", "warning");
  const toolBadge = buildTranscriptBadge(theme, "Tool", "toolPendingBg", "warning");
  const assistantBadge = buildTranscriptBadge(theme, "Assistant", "customMessageBg", "success");
  const separator = theme.fg("borderMuted", "────────────────────────────────────────");
  const blockIndent = "    ";
  const resultIndent = blockIndent;

  const pushBlankLine = () => {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
  };

  const pushInlineBlock = (
    header: string,
    text: string,
    options: { blankBefore?: boolean; style?: (value: string) => string } = {},
  ) => {
    const bodyLines = text.split("\n");
    const style = options.style ?? ((value: string) => value);
    if (options.blankBefore !== false) {
      pushBlankLine();
    }

    const firstLine = bodyLines.shift() ?? "";
    lines.push(`${header}${firstLine ? ` ${style(firstLine)}` : ""}`);
    for (const line of bodyLines) {
      lines.push(`${blockIndent}${style(line)}`);
    }
  };

  const pushStackedBlock = (
    header: string,
    text: string,
    options: { blankBefore?: boolean; indent?: string; style?: (value: string) => string } = {},
  ) => {
    const bodyLines = text.split("\n");
    const indent = options.indent ?? blockIndent;
    const style = options.style ?? ((value: string) => value);
    if (options.blankBefore !== false) {
      pushBlankLine();
    }

    lines.push(header);
    for (const line of bodyLines) {
      lines.push(`${indent}${style(line)}`);
    }
  };

  for (const entry of entries) {
    if (entry.type === "turn-boundary") {
      if (entry.phase === "start" && lines.length > 0) {
        pushBlankLine();
        lines.push(separator);
      }
      continue;
    }

    if (entry.type === "user-message") {
      pushInlineBlock(userBadge, entry.text, { blankBefore: false });
      continue;
    }

    if (entry.type === "thinking") {
      const thinkingHeader = entry.streaming ? `${thinkingBadge} ${theme.fg("warning", "▍")}` : thinkingBadge;
      pushStackedBlock(thinkingHeader, entry.text, {
        style: (line) => theme.fg("warning", theme.italic(line)),
      });
      continue;
    }

    if (entry.type === "tool-call") {
      const toolLabel = theme.fg("warning", theme.bold(entry.toolName));
      const argsLabel = entry.args ? theme.fg("dim", ` · ${entry.args}`) : "";
      pushInlineBlock(toolBadge, `${toolLabel}${argsLabel}`);
      continue;
    }

    if (entry.type === "tool-result") {
      const resultHeaderLabel = entry.isError
        ? theme.fg("error", "↳ error")
        : entry.streaming
          ? theme.fg("warning", "↳ streaming result")
          : theme.fg("dim", "↳ result");
      const truncationLabel = entry.truncated ? theme.fg("dim", " (truncated)") : "";
      pushStackedBlock(`${resultHeaderLabel}${truncationLabel}`, entry.content, {
        blankBefore: false,
        indent: resultIndent,
        style: (line) => (entry.isError ? theme.fg("error", line) : theme.fg("dim", line)),
      });
      continue;
    }

    if (entry.type === "assistant-text") {
      const assistantHeader = entry.streaming ? `${assistantBadge} ${theme.fg("warning", "▍")}` : assistantBadge;
      pushStackedBlock(assistantHeader, entry.text);
    }
  }

  return lines;
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
  for (let i = session.state.messages.length - 1; i >= 0; i--) {
    const message = session.state.messages[i];
    if (message.role === "assistant") {
      return message as AssistantMessage;
    }
  }

  return null;
}

type HelpyHandoffExchange = {
  user: string;
  assistant: string;
};

function buildHelpyMessageContent(question: string, answer: string): string {
  return `Q: ${question}\n\nA: ${answer}`;
}

function formatThread(thread: HelpyHandoffExchange[]): string {
  return thread.map((entry) => `User: ${entry.user.trim()}\nAssistant: ${entry.assistant.trim()}`).join("\n\n---\n\n");
}

function isThreadContinuationMarker(messages: Message[], index: number): boolean {
  const userMessage = messages[index];
  const assistantMessage = messages[index + 1];
  return (
    userMessage?.role === "user" &&
    extractMessageText(userMessage) === HELPY_CONTINUE_THREAD_USER_TEXT &&
    assistantMessage?.role === "assistant" &&
    extractMessageText(assistantMessage) === HELPY_CONTINUE_THREAD_ASSISTANT_TEXT
  );
}

function extractHelpyHandoffThread(sessionRuntime: HelpySessionRuntime): HelpyHandoffExchange[] {
  const handoffMessages = sessionRuntime.session.state.messages.slice(sessionRuntime.sideThreadStartIndex);
  const threadMessages = isThreadContinuationMarker(handoffMessages as Message[], 0) ? handoffMessages.slice(2) : handoffMessages;
  const exchanges: HelpyHandoffExchange[] = [];
  let currentUser = "";
  let currentAssistant = "";

  const pushCurrent = () => {
    if (!currentUser && !currentAssistant) {
      return;
    }

    exchanges.push({
      user: currentUser.trim() || "(No user prompt)",
      assistant: currentAssistant.trim() || "(No assistant response)",
    });
    currentUser = "";
    currentAssistant = "";
  };

  for (const message of threadMessages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const text = extractMessageText(message).trim();
    if (!text) {
      continue;
    }

    if (message.role === "user") {
      pushCurrent();
      currentUser = text;
      continue;
    }

    currentAssistant = currentAssistant ? `${currentAssistant}\n\n${text}` : text;
  }

  pushCurrent();
  return exchanges;
}

function saveVisibleHelpyNote(
  pi: ExtensionAPI,
  details: HelpyDetails,
  saveRequested: boolean,
  wasBusy: boolean,
): SaveState {
  if (!saveRequested) {
    return "not-saved";
  }

  const message = {
    customType: HELPY_MESSAGE_TYPE,
    content: buildHelpyMessageContent(details.question, details.answer),
    display: true,
    details,
  };

  if (wasBusy) {
    pi.sendMessage(message, { deliverAs: "followUp" });
    return "queued";
  }

  pi.sendMessage(message);
  return "saved";
}

function notify(ctx: ExtensionContext | ExtensionCommandContext, message: string, level: "info" | "warning" | "error"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
}

function getOverlayTitle(mode: HelpyThreadMode): string {
  return mode === "tangent" ? "HELPY tangent" : "HELPY";
}

function buildTranscriptBadge(
  theme: ExtensionContext["ui"]["theme"],
  label: string,
  background: "userMessageBg" | "toolPendingBg" | "customMessageBg",
  foreground: "accent" | "warning" | "success",
): string {
  return theme.bg(background, theme.fg(foreground, theme.bold(` ${label} `)));
}

class HelpyOverlayComponent extends Container implements Focusable {
  private readonly input: Input;
  private readonly transcript: Container;
  private readonly statusText: Text;
  private readonly modeText: Text;
  private readonly summaryText: Text;
  private readonly hintsText: Text;
  private readonly readTranscriptEntries: () => HelpyTranscript;
  private readonly getStatus: () => string | null;
  private readonly getMode: () => HelpyThreadMode;
  private readonly onSubmitCallback: (value: string) => void;
  private readonly onDismissCallback: () => void;
  private readonly onUnfocusCallback: () => void;
  private readonly tui: TUI;
  private readonly theme: ExtensionContext["ui"]["theme"];
  private transcriptLines: string[] = [];
  private transcriptScrollOffset = 0;
  private transcriptViewportHeight = 8;
  private followTranscript = true;
  private _focused = false;
  private modeTextValue = "";
  private summaryTextValue = "";
  private statusTextValue = "";
  private hintsTextValue = "";

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    tui: TUI,
    theme: ExtensionContext["ui"]["theme"],
    keybindings: KeybindingsManager,
    readTranscriptEntries: () => HelpyTranscript,
    getStatus: () => string | null,
    getMode: () => HelpyThreadMode,
    onSubmit: (value: string) => void,
    onDismiss: () => void,
    onUnfocus: () => void,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.readTranscriptEntries = readTranscriptEntries;
    this.getStatus = getStatus;
    this.getMode = getMode;
    this.onSubmitCallback = onSubmit;
    this.onDismissCallback = onDismiss;
    this.onUnfocusCallback = onUnfocus;

    this.modeText = new Text("", 1, 0);
    this.summaryText = new Text("", 1, 0);
    this.transcript = new Container();
    this.statusText = new Text("", 1, 0);

    this.input = new Input();
    this.input.onSubmit = (value) => {
      this.followTranscript = true;
      this.onSubmitCallback(value);
    };
    this.input.onEscape = () => {
      this.onDismissCallback();
    };

    this.hintsText = new Text("", 1, 0);

    // Enable SGR mouse reporting so wheel/touchpad events reach handleInput().
    this.tui.terminal?.write?.("\x1b[?1000h\x1b[?1006h");

    const originalHandleInput = this.input.handleInput.bind(this.input);
    this.input.handleInput = (data: string) => {
      if (keybindings.matches(data, "app.clear")) {
        if (this.input.getValue().length > 0) {
          this.input.setValue("");
          this.tui.requestRender();
          return;
        }

        this.onDismissCallback();
        return;
      }

      if (keybindings.matches(data, "tui.select.cancel")) {
        this.onDismissCallback();
        return;
      }
      originalHandleInput(data);
    };

    this.refresh();
  }

  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${this.theme.fg("borderMuted", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("borderMuted", "│")}`;
  }

  private ruleLine(innerWidth: number): string {
    return this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`);
  }

  private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.theme.fg("borderMuted", `${left}${"─".repeat(innerWidth)}${right}`);
  }

  private wrapTranscript(innerWidth: number): string[] {
    const wrapped: string[] = [];
    for (const line of this.transcriptLines) {
      if (!line) {
        wrapped.push("");
        continue;
      }
      wrapped.push(...wrapTextWithAnsi(line, Math.max(1, innerWidth)));
    }
    return wrapped;
  }

  private getDialogHeight(): number {
    const terminalRows = process.stdout.rows ?? 30;
    return Math.max(18, Math.min(32, Math.floor(terminalRows * 0.78)));
  }

  private scrollTranscript(delta: number): void {
    if (delta < 0) {
      this.followTranscript = false;
    }
    this.transcriptScrollOffset = Math.max(0, this.transcriptScrollOffset + delta);
    this.tui.requestRender();
  }

  dispose(): void {
    this.tui.terminal?.write?.("\x1b[?1000l\x1b[?1006l");
  }

  private getMouseScrollDelta(data: string): number | null {
    const match = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
    if (!match) {
      return null;
    }

    const button = Number(match[1]);
    if ((button & 64) !== 64) {
      return null;
    }

    return (button & 1) === 0 ? -3 : 3;
  }

  handleInput(data: string): void {
    if (matchesHelpyFocusShortcut(data)) {
      this.onUnfocusCallback();
      return;
    }

    const mouseScrollDelta = this.getMouseScrollDelta(data);
    if (mouseScrollDelta !== null) {
      this.scrollTranscript(mouseScrollDelta);
      return;
    }

    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.up)) {
      const step = matchesKey(data, Key.pageUp) ? Math.max(1, this.transcriptViewportHeight - 1) : 1;
      this.scrollTranscript(-step);
      return;
    }

    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.down)) {
      const step = matchesKey(data, Key.pageDown) ? Math.max(1, this.transcriptViewportHeight - 1) : 1;
      this.scrollTranscript(step);
      return;
    }

    this.input.handleInput(data);
  }

  private inputFrameLine(dialogWidth: number): string {
    const targetWidth = Math.max(1, dialogWidth - 2);
    const previousFocused = this.input.focused;
    // Input.render() emits CURSOR_MARKER when focused. In overlay mode that APC marker
    // can skew width/composition on this one row before the TUI strips it, producing a
    // right-edge notch and shifted border. Render the embedded input unfocused here so
    // the row stays geometrically stable while the overlay still owns keyboard input.
    this.input.focused = false;
    try {
      const inputLine = this.input.render(targetWidth)[0] ?? "";
      return `${this.theme.fg("borderMuted", "│")}${inputLine}${this.theme.fg("borderMuted", "│")}`;
    } finally {
      this.input.focused = previousFocused;
    }
  }

  override render(width: number): string[] {
    const dialogWidth = Math.max(24, width);
    const innerWidth = Math.max(22, dialogWidth - 2);
    const transcriptLines = this.wrapTranscript(innerWidth);
    const dialogHeight = this.getDialogHeight();
    const chromeHeight = 8;
    const transcriptHeight = Math.max(6, dialogHeight - chromeHeight);
    this.transcriptViewportHeight = transcriptHeight;

    const maxScroll = Math.max(0, transcriptLines.length - transcriptHeight);
    if (this.followTranscript) {
      this.transcriptScrollOffset = maxScroll;
    } else {
      this.transcriptScrollOffset = Math.max(0, Math.min(this.transcriptScrollOffset, maxScroll));
      if (this.transcriptScrollOffset >= maxScroll) {
        this.followTranscript = true;
      }
    }

    const visibleTranscript = transcriptLines.slice(
      this.transcriptScrollOffset,
      this.transcriptScrollOffset + transcriptHeight,
    );
    const transcriptPadCount = Math.max(0, transcriptHeight - visibleTranscript.length);
    const hiddenAbove = this.transcriptScrollOffset;
    const hiddenBelow = Math.max(0, maxScroll - this.transcriptScrollOffset);
    const summary =
      hiddenAbove || hiddenBelow
        ? `${this.summaryTextValue.trim()} · ↑${hiddenAbove} ↓${hiddenBelow}`
        : this.summaryTextValue.trim();

    const lines = [this.borderLine(innerWidth, "top")];

    lines.push(this.frameLine(this.theme.fg("accent", this.theme.bold(this.modeTextValue.trim())), innerWidth));
    lines.push(this.frameLine(this.theme.fg("dim", summary), innerWidth));
    lines.push(this.ruleLine(innerWidth));

    for (const line of visibleTranscript) {
      lines.push(this.frameLine(line, innerWidth));
    }
    for (let i = 0; i < transcriptPadCount; i++) {
      lines.push(this.frameLine("", innerWidth));
    }

    lines.push(this.ruleLine(innerWidth));
    lines.push(this.frameLine(this.theme.fg("warning", this.statusTextValue.trim()), innerWidth));
    lines.push(this.inputFrameLine(dialogWidth));
    lines.push(this.frameLine(this.theme.fg("dim", this.hintsTextValue.trim()), innerWidth));
    lines.push(this.borderLine(innerWidth, "bottom"));

    return lines;
  }

  setDraft(value: string): void {
    this.input.setValue(value);
    this.tui.requestRender();
  }

  getDraft(): string {
    return this.input.getValue();
  }

  getTranscriptEntries(): HelpyTranscript {
    return this.readTranscriptEntries().map((entry) => ({ ...entry }));
  }

  refresh(): void {
    this.modeTextValue = `${getOverlayTitle(this.getMode())} · hidden thread preserved`;
    this.modeText.setText(this.modeTextValue);
    const entries = this.readTranscriptEntries();
    const exchanges = getCompletedExchangeCount(entries);
    const active = hasStreamingTranscriptEntry(entries) ? " · streaming" : " · idle";
    this.summaryTextValue = `${exchanges} exchange${exchanges === 1 ? "" : "s"}${active}`;
    this.summaryText.setText(this.summaryTextValue);

    this.transcriptLines = buildOverlayTranscript(entries, this.theme);
    this.transcript.clear();
    for (const line of this.transcriptLines) {
      this.transcript.addChild(new Text(line, 1, 0));
    }

    const status = this.getStatus() ?? "Ready. Enter submits; Escape dismisses without clearing.";
    this.statusTextValue = status;
    this.statusText.setText(this.statusTextValue);
    this.hintsTextValue = "Scroll wheel ↑↓ PgUp/PgDn · Enter · Alt+/ focus · Esc";
    this.hintsText.setText(this.hintsTextValue);
    this.tui.requestRender();
  }
}

export default function (pi: ExtensionAPI) {
  let pendingThread: HelpyDetails[] = [];
  let pendingMode: HelpyThreadMode = "contextual";
  let helpyModelOverride: SessionModel | null = null;
  let helpyThinkingOverride: SessionThinkingLevel | null = null;
  let transcriptState = createEmptyTranscriptState();
  let overlayStatus: string | null = null;
  let overlayDraft = "";
  let overlayRuntime: OverlayRuntime | null = null;
  let lastUiContext: ExtensionContext | ExtensionCommandContext | null = null;
  let activeHelpySession: HelpySessionRuntime | null = null;

  function syncUi(ctx?: ExtensionContext | ExtensionCommandContext): void {
    const activeCtx = ctx ?? lastUiContext;
    if (activeCtx?.hasUI) {
      activeCtx.ui.setWidget("helpy", undefined);
      overlayRuntime?.refresh?.();
    }
  }

  function setOverlayStatus(status: string | null, ctx?: ExtensionContext | ExtensionCommandContext): void {
    overlayStatus = status;
    syncUi(ctx);
  }

  function setOverlayDraft(value: string): void {
    overlayDraft = value;
    overlayRuntime?.setDraft?.(value);
  }

  function dismissOverlay(): void {
    overlayRuntime?.close?.();
    overlayRuntime = null;
  }

  function toggleOverlayFocus(): void {
    const handle = overlayRuntime?.handle;
    if (!handle) {
      return;
    }

    handle.setHidden(false);
    if (handle.isFocused()) {
      handle.unfocus();
    } else {
      handle.focus();
    }
    overlayRuntime?.refresh?.();
  }

  function focusOverlay(): void {
    const handle = overlayRuntime?.handle;
    if (!handle) {
      return;
    }

    handle.setHidden(false);
    handle.focus();
    overlayRuntime?.refresh?.();
  }

  function removeHelpySessionSubscription(sessionRuntime: HelpySessionRuntime, unsubscribe: () => void): void {
    if (!sessionRuntime.subscriptions.delete(unsubscribe)) {
      return;
    }

    try {
      unsubscribe();
    } catch {
      // Ignore unsubscribe errors during HELPY session replacement/shutdown.
    }
  }

  function clearHelpySessionSubscriptions(sessionRuntime: HelpySessionRuntime): void {
    for (const unsubscribe of [...sessionRuntime.subscriptions]) {
      removeHelpySessionSubscription(sessionRuntime, unsubscribe);
    }
  }

  function handleHelpySessionEvent(
    sessionRuntime: HelpySessionRuntime,
    event: AgentSessionEvent,
    ctx?: ExtensionContext | ExtensionCommandContext,
  ): void {
    if (activeHelpySession?.session !== sessionRuntime.session || !overlayRuntime) {
      return;
    }

    applyTranscriptEvent(transcriptState, event);

    if (event.type === "tool_execution_start") {
      setOverlayStatus(`⏳ running tool: ${event.toolName}`, ctx);
      return;
    }

    if (event.type === "tool_execution_end") {
      setOverlayStatus(sessionRuntime.session.isStreaming ? `⏳ running tool: ${event.toolName}` : "⏳ streaming...", ctx);
      return;
    }

    if (event.type === "turn_end") {
      setOverlayStatus("⏳ streaming...", ctx);
      return;
    }

    if (
      event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end" ||
      event.type === "turn_start"
    ) {
      syncUi(ctx);
    }
  }

  function subscribeOverlayToActiveHelpySession(ctx?: ExtensionContext | ExtensionCommandContext): void {
    const sessionRuntime = activeHelpySession;
    if (!sessionRuntime || sessionRuntime.subscriptions.size > 0) {
      return;
    }

    const unsubscribe = sessionRuntime.session.subscribe((event: AgentSessionEvent) => {
      handleHelpySessionEvent(sessionRuntime, event, ctx);
    });
    sessionRuntime.subscriptions.add(unsubscribe);
  }

  async function disposeHelpySession(): Promise<void> {
    const current = activeHelpySession;
    activeHelpySession = null;
    if (!current) {
      return;
    }

    clearHelpySessionSubscriptions(current);

    try {
      await current.session.abort();
    } catch {
      // Ignore abort errors during HELPY session replacement/shutdown.
    }

    current.session.dispose();
  }

  async function dismissOverlaySession(): Promise<void> {
    dismissOverlay();
    await disposeHelpySession();
  }

  async function resolveHelpyModel(
    ctx: ExtensionCommandContext,
    notifyOnFallback = false,
  ): Promise<ResolvedHelpyModel> {
    if (helpyModelOverride) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(helpyModelOverride);
      if (auth.ok && auth.apiKey) {
        return {
          model: helpyModelOverride,
          source: "override",
          configuredOverride: helpyModelOverride,
        };
      }

      const fallbackReason = ctx.model
        ? `Configured HELPY model ${formatModelRef(helpyModelOverride)} has no credentials. Falling back to main model ${formatModelRef(
            ctx.model,
          )}.`
        : `Configured HELPY model ${formatModelRef(helpyModelOverride)} has no credentials, and no main model is active.`;
      if (notifyOnFallback) {
        notify(ctx, fallbackReason, "warning");
      }

      if (ctx.model) {
        return {
          model: ctx.model,
          source: "main",
          configuredOverride: helpyModelOverride,
          fallbackReason,
        };
      }

      return {
        model: null,
        source: "none",
        configuredOverride: helpyModelOverride,
        fallbackReason,
      };
    }

    if (ctx.model) {
      return {
        model: ctx.model,
        source: "main",
        configuredOverride: null,
      };
    }

    return {
      model: null,
      source: "none",
      configuredOverride: null,
    };
  }

  async function resolveHelpySettings(
    ctx: ExtensionCommandContext,
    notifyOnFallback = false,
  ): Promise<ResolvedHelpySettings> {
    const resolvedModel = await resolveHelpyModel(ctx, notifyOnFallback);
    const cfg = await loadHelpyConfig(typeof ctx.cwd === "function" ? ctx.cwd() : (ctx.cwd as unknown as string));
    const configured = (cfg.thinking ?? "off") as SessionThinkingLevel;
    const thinkingLevel = helpyThinkingOverride ?? configured;

    return {
      model: resolvedModel.model,
      modelSource: resolvedModel.source,
      configuredModelOverride: resolvedModel.configuredOverride,
      thinkingLevel,
      thinkingSource: helpyThinkingOverride ? "override" : "main",
      fallbackReason: resolvedModel.fallbackReason,
    };
  }

  function describeResolvedModel(settings: ResolvedHelpySettings): string {
    if (!settings.model) {
      if (settings.configuredModelOverride && settings.fallbackReason) {
        return `HELPY model unavailable. ${settings.fallbackReason}`;
      }
      return "HELPY model unavailable. No active model selected.";
    }

    const source =
      settings.modelSource === "override"
        ? "override"
        : settings.configuredModelOverride
          ? "inherited fallback"
          : "inherits main thread";
    return `HELPY model: ${formatModelRef(settings.model)} (${source}).${
      settings.fallbackReason ? ` ${settings.fallbackReason}` : ""
    }`;
  }

  function describeResolvedThinking(settings: ResolvedHelpySettings): string {
    const source = settings.thinkingSource === "override" ? "override" : "inherits main thread";
    return `HELPY thinking: ${settings.thinkingLevel} (${source}).`;
  }

  async function setHelpyModelOverride(ctx: ExtensionCommandContext, nextModel: SessionModel | null): Promise<void> {
    helpyModelOverride = nextModel;
    const details: HelpyModelOverrideDetails = nextModel
      ? { action: "set", timestamp: Date.now(), provider: nextModel.provider, id: nextModel.id, api: nextModel.api }
      : { action: "clear", timestamp: Date.now() };
    pi.appendEntry(HELPY_MODEL_OVERRIDE_TYPE, details);
    await disposeHelpySession();
    const settings = await resolveHelpySettings(ctx);
    const message = nextModel
      ? `HELPY model override set to ${formatModelRef(nextModel)}.`
      : "HELPY model override cleared. HELPY now inherits the main thread model.";
    setOverlayStatus(message, ctx);
    notify(ctx, `${message} ${describeResolvedModel(settings)}`, "info");
  }

  async function setHelpyThinkingOverride(
    ctx: ExtensionCommandContext,
    nextThinkingLevel: SessionThinkingLevel | null,
  ): Promise<void> {
    helpyThinkingOverride = nextThinkingLevel;
    const details: HelpyThinkingOverrideDetails = nextThinkingLevel
      ? { action: "set", timestamp: Date.now(), thinkingLevel: nextThinkingLevel }
      : { action: "clear", timestamp: Date.now() };
    pi.appendEntry(HELPY_THINKING_OVERRIDE_TYPE, details);
    await disposeHelpySession();
    const settings = await resolveHelpySettings(ctx);
    const message = nextThinkingLevel
      ? `HELPY thinking override set to ${nextThinkingLevel}.`
      : "HELPY thinking override cleared. HELPY now inherits the main thread thinking level.";
    setOverlayStatus(message, ctx);
    notify(ctx, `${message} ${describeResolvedThinking(settings)}`, "info");
  }

  async function createHelpySubSession(ctx: ExtensionCommandContext, mode: HelpyThreadMode): Promise<HelpySessionRuntime> {
    const settings = await resolveHelpySettings(ctx, true);
    if (!settings.model) {
      throw new Error(settings.fallbackReason || "No active model selected.");
    }

    const { session } = await createAgentSession({
      cwd: HELPY_CWD,
      sessionManager: SessionManager.inMemory(),
      model: settings.model,
      modelRegistry: ctx.modelRegistry as AgentSession["modelRegistry"],
      thinkingLevel: settings.thinkingLevel,
      // Match pi's default coding-agent toolset (read/bash/edit/write).
      tools: ["read", "bash", "edit", "write"],
      resourceLoader: createHelpyResourceLoader(ctx),
    });

    const { messages: seedMessages, sideThreadStartIndex } = buildHelpySeedState(ctx, pendingThread, mode, settings.model);
    if (seedMessages.length > 0) {
      session.agent.state.messages = seedMessages as typeof session.state.messages;
    }

    return { session, mode, subscriptions: new Set(), sideThreadStartIndex };
  }

  async function ensureHelpySession(ctx: ExtensionCommandContext, mode: HelpyThreadMode): Promise<HelpySessionRuntime | null> {
    const settings = await resolveHelpySettings(ctx);
    if (!settings.model) {
      return null;
    }

    if (activeHelpySession?.mode === mode) {
      return activeHelpySession;
    }

    await disposeHelpySession();
    activeHelpySession = await createHelpySubSession(ctx, mode);
    return activeHelpySession;
  }

  async function ensureOverlay(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      return;
    }
    lastUiContext = ctx;

    if (overlayRuntime?.handle) {
      subscribeOverlayToActiveHelpySession(ctx);
      focusOverlay();
      return;
    }

    const runtime: OverlayRuntime = {};
    const closeRuntime = () => {
      if (runtime.closed) {
        return;
      }
      runtime.closed = true;
      if (activeHelpySession) {
        clearHelpySessionSubscriptions(activeHelpySession);
      }
      runtime.handle?.hide();
      if (overlayRuntime === runtime) {
        overlayRuntime = null;
      }
      runtime.finish?.();
    };

    runtime.close = closeRuntime;
    overlayRuntime = runtime;

    void ctx.ui
      .custom<void>(
        async (tui, theme, keybindings, done) => {
          runtime.finish = () => {
            done();
          };

          const overlay = new HelpyOverlayComponent(
            tui,
            theme,
            keybindings,
            () => transcriptState.entries,
            () => overlayStatus,
            () => pendingMode,
            (value) => {
              void submitFromOverlay(ctx, value);
            },
            () => {
              void dismissOverlaySession();
            },
            () => {
              overlayRuntime?.handle?.unfocus();
              overlayRuntime?.refresh?.();
            },
          );

          overlay.focused = runtime.handle?.isFocused() ?? true;
          overlay.setDraft(overlayDraft);
          runtime.setDraft = (value) => {
            overlay.setDraft(value);
          };
          runtime.refresh = () => {
            overlay.focused = runtime.handle?.isFocused() ?? false;
            overlay.refresh();
          };
          runtime.close = () => {
            overlayDraft = overlay.getDraft();
            overlay.dispose();
            closeRuntime();
          };

          subscribeOverlayToActiveHelpySession(ctx);

          if (runtime.closed) {
            done();
          }

          return overlay;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "78%",
            minWidth: 72,
            maxHeight: "78%",
            anchor: "top-center",
            margin: { top: 1, left: 2, right: 2 },
            nonCapturing: true,
          },
          onHandle: (handle) => {
            runtime.handle = handle;
            handle.focus();
            if (runtime.closed) {
              closeRuntime();
            }
          },
        },
      )
      .catch((error) => {
        if (overlayRuntime === runtime) {
          overlayRuntime = null;
        }
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      });
  }

  async function dispatchHelpyCommand(name: string, args: string, ctx: ExtensionCommandContext): Promise<boolean> {
    const trimmedArgs = args.trim();

    if (name === "helpy") {
      const { question, save } = parseHelpyArgs(trimmedArgs);
      if (!question) {
        await ensureHelpySession(ctx, "contextual");
        await ensureOverlay(ctx);
        return true;
      }
      await resetThread(ctx, true, "contextual");
      await runHelpy(ctx, question, save, "contextual");
      return true;
    }

    if (name === "helpy:tangent") {
      const { question, save } = parseHelpyArgs(trimmedArgs);
      if (pendingMode !== "tangent") {
        await resetThread(ctx, true, "tangent");
      }

      if (!question) {
        await ensureHelpySession(ctx, "tangent");
        await ensureOverlay(ctx);
        return true;
      }

      await runHelpy(ctx, question, save, "tangent");
      return true;
    }

    if (name === "helpy:new") {
      await resetThread(ctx, true, "contextual");
      const { question, save } = parseHelpyArgs(trimmedArgs);
      if (question) {
        await runHelpy(ctx, question, save, "contextual");
      } else {
        await ensureHelpySession(ctx, "contextual");
        setOverlayStatus("Started a fresh HELPY thread.", ctx);
        await ensureOverlay(ctx);
        notify(ctx, "Started a fresh HELPY thread.", "info");
      }
      return true;
    }

    if (name === "helpy:clear") {
      await resetThread(ctx);
      dismissOverlay();
      notify(ctx, "Cleared HELPY thread.", "info");
      return true;
    }

    if (name === "helpy:model") {
      const parsed = parseHelpyModelArgs(trimmedArgs);
      if (parsed.action === "invalid") {
        setOverlayStatus(parsed.message, ctx);
        notify(ctx, parsed.message, "error");
        return true;
      }

      if (parsed.action === "show") {
        const settings = await resolveHelpySettings(ctx);
        const message = describeResolvedModel(settings);
        setOverlayStatus(message, ctx);
        notify(ctx, message, settings.model ? "info" : "warning");
        return true;
      }

      if (parsed.action === "clear") {
        await setHelpyModelOverride(ctx, null);
        return true;
      }
      const ref = parsed.model;
      const resolved = ctx.modelRegistry.find(ref.provider, ref.id);
      if (!resolved) {
        const message = `Unknown model ${ref.provider}/${ref.id}. Use /login or /models to add it before setting it as the HELPY override.`;
        setOverlayStatus(message, ctx);
        notify(ctx, message, "error");
        return true;
      }
      await setHelpyModelOverride(ctx, resolved);
      return true;
    }

    if (name === "helpy:thinking") {
      const parsed = parseHelpyThinkingArgs(trimmedArgs);
      if (parsed.action === "show") {
        const settings = await resolveHelpySettings(ctx);
        const message = describeResolvedThinking(settings);
        setOverlayStatus(message, ctx);
        notify(ctx, message, "info");
        return true;
      }

      await setHelpyThinkingOverride(ctx, parsed.action === "clear" ? null : parsed.thinkingLevel);
      return true;
    }

    if (name === "helpy:inject") {
      if (pendingThread.length === 0) {
        notify(ctx, "No HELPY thread to inject.", "warning");
        return true;
      }

      setOverlayStatus("⏳ injecting into the main session...", ctx);
      await ensureOverlay(ctx);

      try {
        const { thread } = await getHelpyHandoffThread(ctx);
        const instructions = trimmedArgs;
        const content = instructions
          ? `Here is a side conversation I had. ${instructions}\n\n${formatThread(thread)}`
          : `Here is a side conversation I had for additional context:\n\n${formatThread(thread)}`;

        sendThreadToMain(ctx, content);
        const count = thread.length;
        await resetThread(ctx);
        dismissOverlay();
        notify(ctx, `Injected HELPY thread (${count} exchange${count === 1 ? "" : "s"}).`, "info");
      } catch (error) {
        setOverlayStatus("Inject failed. Thread preserved for retry or summarize.", ctx);
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return true;
    }

    if (name === "helpy:summarize") {
      if (pendingThread.length === 0) {
        notify(ctx, "No HELPY thread to summarize.", "warning");
        return true;
      }

      setOverlayStatus("⏳ summarizing...", ctx);
      await ensureOverlay(ctx);

      try {
        const { thread } = await getHelpyHandoffThread(ctx);
        const summary = await summarizeThread(ctx, thread);
        const instructions = trimmedArgs;
        const content = instructions
          ? `Here is a summary of a side conversation I had. ${instructions}\n\n${summary}`
          : `Here is a summary of a side conversation I had:\n\n${summary}`;

        sendThreadToMain(ctx, content);
        const count = thread.length;
        await resetThread(ctx);
        dismissOverlay();
        notify(ctx, `Injected HELPY summary (${count} exchange${count === 1 ? "" : "s"}).`, "info");
      } catch (error) {
        setOverlayStatus("Summarize failed. Thread preserved for retry or injection.", ctx);
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return true;
    }

    return false;
  }

  function parseOverlayHelpyCommand(value: string): { name: string; args: string } | null {
    const trimmed = value.trim();
    const match = trimmed.match(/^\/(helpy)(?:\s+(.*))?$/);
    if (!match) {
      return null;
    }

    return {
      name: match[1],
      args: match[2]?.trim() ?? "",
    };
  }

  async function submitFromOverlay(ctx: ExtensionCommandContext | ExtensionContext, value: string): Promise<void> {
    const question = value.trim();
    if (!question) {
      setOverlayStatus("Enter a HELPY prompt before submitting.", ctx);
      return;
    }

    if (!("getSystemPrompt" in ctx)) {
      setOverlayStatus("HELPY overlay submit requires a command context. Reopen HELPY from a command.", ctx);
      return;
    }

    const cmdCtx = ctx as ExtensionCommandContext;
    const helpyCommand = parseOverlayHelpyCommand(question);
    if (helpyCommand) {
      setOverlayDraft("");
      await dispatchHelpyCommand(helpyCommand.name, helpyCommand.args, cmdCtx);
      return;
    }

    setOverlayDraft("");
    setOverlayStatus("⏳ streaming...", ctx);
    syncUi(ctx);
    await runHelpy(cmdCtx, question, false, pendingMode);
  }

  async function resetThread(
    ctx: ExtensionContext | ExtensionCommandContext,
    persist = true,
    mode: HelpyThreadMode = "contextual",
  ): Promise<void> {
    await disposeHelpySession();
    pendingThread = [];
    pendingMode = mode;
    transcriptState = createEmptyTranscriptState();
    setOverlayDraft("");
    setOverlayStatus(null, ctx);
    if (persist) {
      const details: HelpyResetDetails = { timestamp: Date.now(), mode };
      pi.appendEntry(HELPY_RESET_TYPE, details);
    }
    syncUi(ctx);
  }

  async function restoreThread(ctx: ExtensionContext): Promise<void> {
    await disposeHelpySession();
    pendingThread = [];
    pendingMode = "contextual";
    helpyModelOverride = null;
    helpyThinkingOverride = null;
    transcriptState = createEmptyTranscriptState();
    overlayDraft = "";
    lastUiContext = ctx;
    overlayStatus = null;

    const branch = ctx.sessionManager.getBranch();
    let lastResetIndex = -1;

    for (let i = 0; i < branch.length; i++) {
      if (isCustomEntry(branch[i], HELPY_MODEL_OVERRIDE_TYPE)) {
        const details = (branch[i] as unknown as { data?: HelpyModelOverrideDetails }).data;
        if (details?.action === "set") {
          const resolved = ctx.modelRegistry.find(details.provider, details.id);
          if (resolved) {
            helpyModelOverride = resolved;
          } else {
            // Configured override is no longer in the registry; drop it on restore.
            helpyModelOverride = null;
          }
        } else if (details?.action === "clear") {
          helpyModelOverride = null;
        }
      }

      if (isCustomEntry(branch[i], HELPY_THINKING_OVERRIDE_TYPE)) {
        const details = (branch[i] as unknown as { data?: HelpyThinkingOverrideDetails }).data;
        helpyThinkingOverride =
          details?.action === "set"
            ? details.thinkingLevel
            : details?.action === "clear"
              ? null
              : helpyThinkingOverride;
      }

      if (isCustomEntry(branch[i], HELPY_RESET_TYPE)) {
        lastResetIndex = i;
        const details = (branch[i] as unknown as { data?: HelpyResetDetails }).data;
        pendingMode = details?.mode ?? "contextual";
      }
    }

    for (const entry of branch.slice(lastResetIndex + 1)) {
      if (!isCustomEntry(entry, HELPY_ENTRY_TYPE)) {
        continue;
      }

      const details = (entry as unknown as { data?: HelpyDetails }).data;
      if (!details?.question || !details.answer) {
        continue;
      }

      const normalizedDetails: HelpyDetails = {
        ...details,
        api: details.api || ctx.model?.api || "openai-responses",
      };

      pendingThread.push(normalizedDetails);
      appendPersistedTranscriptTurn(transcriptState, normalizedDetails);
    }

    syncUi(ctx);
  }

  async function runHelpy(
    ctx: ExtensionCommandContext,
    question: string,
    saveRequested: boolean,
    mode: HelpyThreadMode,
  ): Promise<void> {
    lastUiContext = ctx;
    const settings = await resolveHelpySettings(ctx);
    const model = settings.model;
    if (!model) {
      const message = settings.fallbackReason || "No active model selected.";
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      return;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      const message = auth.ok ? `No credentials available for ${model.provider}/${model.id}.` : auth.error;
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      await ensureOverlay(ctx);
      return;
    }

    const sessionRuntime = await ensureHelpySession(ctx, mode);
    if (!sessionRuntime) {
      setOverlayStatus("No active model selected.", ctx);
      notify(ctx, "No active model selected.", "error");
      return;
    }

    const session = sessionRuntime.session;
    const wasBusy = !ctx.isIdle();
    pendingMode = mode;
    const thinkingLevel = settings.thinkingLevel;

    setOverlayStatus("⏳ streaming...", ctx);
    await ensureOverlay(ctx);

    try {
      await session.prompt(question, { source: "extension" });

      const response = getLastAssistantMessage(session);
      if (!response) {
        throw new Error("HELPY request finished without a response.");
      }
      if (response.stopReason === "aborted") {
        removeTranscriptTurn(transcriptState, transcriptState.lastTurnId ?? transcriptState.currentTurnId);
        setOverlayStatus("Request aborted.", ctx);
        return;
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "HELPY request failed.");
      }

      const completedTurnId = transcriptState.lastTurnId ?? transcriptState.currentTurnId;
      const streamedThinking =
        completedTurnId !== null ? findLatestTranscriptEntry(transcriptState, completedTurnId, "thinking")?.text : "";
      const answer = extractAnswer(response);
      const thinking = extractThinking(response) || streamedThinking || "";

      const details: HelpyDetails = {
        question,
        thinking,
        answer,
        provider: model.provider,
        model: model.id,
        api: model.api,
        thinkingLevel,
        timestamp: Date.now(),
        usage: response.usage,
      };

      pendingThread.push(details);
      pi.appendEntry(HELPY_ENTRY_TYPE, details);

      const saveState = saveVisibleHelpyNote(pi, details, saveRequested, wasBusy);
      if (saveState === "saved") {
        notify(ctx, "Saved HELPY note to the session.", "info");
        setOverlayStatus("Saved HELPY note to the session.", ctx);
      } else if (saveState === "queued") {
        notify(ctx, "HELPY note queued to save after the current turn finishes.", "info");
        setOverlayStatus("HELPY note queued to save after the current turn finishes.", ctx);
      } else {
        setOverlayStatus("Ready for a follow-up. Hidden HELPY thread updated.", ctx);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setTranscriptFailure(transcriptState, errorMessage);
      setOverlayStatus("Request failed. Thread preserved for retry or follow-up.", ctx);
      notify(ctx, errorMessage, "error");
      await disposeHelpySession();
    } finally {
      syncUi(ctx);
    }
  }

  function getPendingThreadForHandoff(): HelpyHandoffExchange[] {
    return pendingThread.map((entry) => ({ user: entry.question, assistant: entry.answer }));
  }

  async function getHelpyHandoffThread(
    ctx: ExtensionCommandContext,
  ): Promise<{ sessionRuntime: HelpySessionRuntime | null; thread: HelpyHandoffExchange[] }> {
    const sessionRuntime = activeHelpySession ?? (await ensureHelpySession(ctx, pendingMode));
    const thread = sessionRuntime ? extractHelpyHandoffThread(sessionRuntime) : [];
    const resolvedThread = thread.length > 0 ? thread : getPendingThreadForHandoff();

    if (resolvedThread.length === 0) {
      throw new Error("No HELPY thread available for handoff.");
    }

    return { sessionRuntime, thread: resolvedThread };
  }

  async function summarizeThread(ctx: ExtensionCommandContext, thread: HelpyHandoffExchange[]): Promise<string> {
    const settings = await resolveHelpySettings(ctx, true);
    const model = settings.model;
    if (!model) {
      throw new Error(settings.fallbackReason || "No active model selected.");
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      throw new Error(auth.ok ? `No credentials available for ${model.provider}/${model.id}.` : auth.error);
    }

    const { session } = await createAgentSession({
      cwd: HELPY_CWD,
      sessionManager: SessionManager.inMemory(),
      model,
      modelRegistry: ctx.modelRegistry as AgentSession["modelRegistry"],
      thinkingLevel: "off",
      tools: [],
      resourceLoader: createHelpyResourceLoader(ctx, [HELPY_SUMMARIZE_SYSTEM_PROMPT]),
    });

    try {
      await session.prompt(formatThread(thread), { source: "extension" });

      const response = getLastAssistantMessage(session);
      if (!response) {
        throw new Error("HELPY summarize finished without a response.");
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "Failed to summarize HELPY thread.");
      }
      if (response.stopReason === "aborted") {
        throw new Error("HELPY summarize aborted.");
      }

      return extractAnswer(response);
    } finally {
      try {
        await session.abort();
      } catch {
        // Ignore abort errors during summarize session shutdown.
      }
      session.dispose();
    }
  }

  function sendThreadToMain(ctx: ExtensionCommandContext, content: string): void {
    if (ctx.isIdle()) {
      pi.sendUserMessage(content);
    } else {
      pi.sendUserMessage(content, { deliverAs: "followUp" });
    }
  }

  pi.registerMessageRenderer(HELPY_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details as HelpyDetails | undefined;
    const content = typeof message.content === "string" ? message.content : "[non-text helpy message]";
    const lines = [theme.fg("accent", theme.bold("[HELPY]")), content];

    if (expanded && details) {
      lines.push(
        theme.fg(
          "dim",
          `model: ${details.provider}/${details.model} (${details.api ?? "openai-responses"}) · thinking: ${details.thinkingLevel}`,
        ),
      );

      if (details.usage) {
        lines.push(
          theme.fg(
            "dim",
            `tokens: in ${details.usage.input} · out ${details.usage.output} · total ${details.usage.totalTokens}`,
          ),
        );
      }
    }

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });

  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((message) => !isVisibleHelpyMessage(message)),
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    await restoreThread(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreThread(ctx);
  });

  pi.on("session_shutdown", async () => {
    await disposeHelpySession();
    dismissOverlay();
  });

  for (const shortcut of HELPY_FOCUS_SHORTCUTS) {
    pi.registerShortcut(shortcut, {
      description: "Toggle HELPY overlay focus while leaving it open.",
      handler: async (_ctx) => {
        toggleOverlayFocus();
      },
    });
  }

  pi.registerCommand("helpy", {
    description: "Open the DotFiles Q&A modal. /helpy <question> starts a fresh thread and asks.",
    handler: async (args, ctx) => {
      await dispatchHelpyCommand("helpy", args, ctx);
    },
  });
}
