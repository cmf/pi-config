/**
 * Task Extension - Deterministic task workflow for jj workspaces
 *
 * Provides /task command that detects workspace type:
 * - Main workspace: handles merge/cleanup of completed task workspaces, task selection
 * - Task workspace: handles active task work
 */

// Workflow state graph is defined in state-machine.ts.
// .tasks/workflow.json remains the persisted source of truth for current state/tree.

import type {ExtensionAPI, ExtensionCommandContext, ExtensionContext} from "@mariozechner/pi-coding-agent";
import {getAgentDir, parseFrontmatter} from "@mariozechner/pi-coding-agent";
import {
    canReplayCompleteFromAssistantMessage,
    eventNeedsRootTicketMarkdown,
    isWorkflowState,
    stateAllowsActiveDepth,
    transition as runWorkflowTransition,
    type ActiveTaskTarget as MachineActiveTaskTarget,
    type TransitionDecision as MachineTransitionDecision,
    type WorkflowEffect as MachineWorkflowEffect,
    type WorkflowEvent as MachineWorkflowEvent,
    type WorkflowSnapshot as MachineWorkflowSnapshot,
    type WorkflowState as MachineWorkflowState,
} from "./state-machine.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const DEFAULT_AGENT_START_TIMEOUT_MS = 10000;
const WORKFLOW_SCHEMA_VERSION = 1;
const WORKFLOW_DIR_NAME = ".tasks";
const WORKFLOW_FILE_NAME = "workflow.json";
const UNBOUND_SESSION_LEAF_ID = "unbound";
const MANUAL_TEST_PASS_PHRASE = "MANUAL TESTS PASSED";
const MANUAL_TEST_PASS_REGEX = /\bMANUAL\s+TESTS?\s+PASSED\b/i;
const ENABLE_TRANSITION_DEBUG = true;

export function normalizeSessionFilePath(sessionFile: string | undefined): string | null {
    if (!sessionFile) return null;
    const trimmed = sessionFile.trim();
    return trimmed ? trimmed : null;
}

export function shouldNotifyPendingTransitionOutsideTaskLoop(params: {
    workflowState: MachineWorkflowState;
    latestAssistantMessageId: string | null;
    latestAssistantMessageText: string;
    lastConsumedAssistantId?: string | null;
    taskLoopActive: boolean;
}): boolean {
    if (params.taskLoopActive) return false;
    if (!params.latestAssistantMessageId) return false;
    if ((params.lastConsumedAssistantId ?? null) === params.latestAssistantMessageId) return false;
    return canReplayCompleteFromAssistantMessage(params.workflowState, params.latestAssistantMessageText);
}

export function completionReadyToMergeNotice(params: {
    changed: boolean;
    nextState: MachineWorkflowState;
}): string | null {
    if (!params.changed || params.nextState !== "complete") {
        return null;
    }

    return "Final commit succeeded. Task workspace is ready to merge.";
}

export function resolveEditorPrefillValue(
    input: string | undefined,
    defaultValue: string,
    options?: {singleLine?: boolean},
): string {
    const trimmed = typeof input === "string" ? input.trim() : "";
    if (!trimmed) {
        return defaultValue;
    }

    if (!options?.singleLine) {
        return trimmed;
    }

    const firstNonEmptyLine = trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);

    return firstNonEmptyLine ?? defaultValue;
}

type TaskNode = {
    task_id: string;
    title: string;
    subtasks: TaskNode[];
};

type PersistedWorkflow = TaskNode & {
    schema_version: number;
    state: MachineWorkflowState;
    active_task_id: string;
    active_path_ids: string[];
    session_leaf_id: string;
    session_file_path?: string | null;
    last_consumed_assistant_id?: string | null;
    version: number;
    updated_at: string;
    last_transition?: {
        event: string;
        from_state: MachineWorkflowState;
        to_state: MachineWorkflowState;
        from_active_task_id: string;
        to_active_task_id: string;
        at: string;
    };
};

type AvailableModel = ReturnType<ExtensionContext["modelRegistry"]["getAll"]>[number];

type AgentStartWaiter = {
    resolve: (started: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
};

let pendingAgentStart: AgentStartWaiter | null = null;
let activeTaskLoopCount = 0;

function isTaskLoopActive(): boolean {
    return activeTaskLoopCount > 0;
}

async function withTaskLoopGuard<T>(run: () => Promise<T>): Promise<T> {
    activeTaskLoopCount += 1;
    try {
        return await run();
    } finally {
        activeTaskLoopCount = Math.max(0, activeTaskLoopCount - 1);
    }
}

function resolveNextAgentStart(): void {
    if (!pendingAgentStart) return;
    const {resolve, timer} = pendingAgentStart;
    pendingAgentStart = null;
    clearTimeout(timer);
    resolve(true);
}

function waitForNextAgentStart(timeoutMs = DEFAULT_AGENT_START_TIMEOUT_MS): Promise<boolean> {
    if (pendingAgentStart) {
        throw new Error("Already waiting for agent_start");
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (!pendingAgentStart) return;
            pendingAgentStart = null;
            resolve(false);
        }, timeoutMs);
        pendingAgentStart = {resolve, timer};
    });
}

function getWorkflowPath(root: string): string {
    return path.join(root, WORKFLOW_DIR_NAME, WORKFLOW_FILE_NAME);
}

function ensureWorkflowDirectory(root: string): void {
    fs.mkdirSync(path.join(root, WORKFLOW_DIR_NAME), {recursive: true});
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneTaskNode(node: TaskNode): TaskNode {
    return {
        task_id: node.task_id,
        title: node.title,
        subtasks: node.subtasks.map(cloneTaskNode),
    };
}

function cloneWorkflow(workflow: PersistedWorkflow): PersistedWorkflow {
    return {
        ...cloneTaskNode(workflow),
        schema_version: workflow.schema_version,
        state: workflow.state,
        active_task_id: workflow.active_task_id,
        active_path_ids: [...workflow.active_path_ids],
        session_leaf_id: workflow.session_leaf_id,
        session_file_path: workflow.session_file_path ?? null,
        last_consumed_assistant_id: workflow.last_consumed_assistant_id ?? null,
        version: workflow.version,
        updated_at: workflow.updated_at,
        last_transition: workflow.last_transition ? {...workflow.last_transition} : undefined,
    };
}

function findNodeById(root: TaskNode, taskId: string): TaskNode | null {
    if (root.task_id === taskId) return root;
    for (const child of root.subtasks) {
        const found = findNodeById(child, taskId);
        if (found) return found;
    }
    return null;
}

function findParentById(root: TaskNode, taskId: string): TaskNode | null {
    for (const child of root.subtasks) {
        if (child.task_id === taskId) return root;
        const found = findParentById(child, taskId);
        if (found) return found;
    }
    return null;
}

function computePathToId(root: TaskNode, taskId: string): string[] | null {
    if (root.task_id === taskId) return [root.task_id];
    for (const child of root.subtasks) {
        const childPath = computePathToId(child, taskId);
        if (childPath) {
            return [root.task_id, ...childPath];
        }
    }
    return null;
}

function listChildren(node: TaskNode): TaskNode[] {
    return node.subtasks;
}

function nextSibling(root: TaskNode, taskId: string): TaskNode | null {
    const parent = findParentById(root, taskId);
    if (!parent) return null;
    const siblings = listChildren(parent);
    const index = siblings.findIndex((item) => item.task_id === taskId);
    if (index === -1) return null;
    return siblings[index + 1] ?? null;
}

function validateTaskTreeNode(
    node: TaskNode,
    depth: number,
    seen: Set<string>,
): string | null {
    if (!node.task_id || typeof node.task_id !== "string") {
        return "workflow node is missing non-empty string task_id";
    }
    if (!node.title || typeof node.title !== "string") {
        return `workflow node ${node.task_id} is missing non-empty title`;
    }
    if (!Array.isArray(node.subtasks)) {
        return `workflow node ${node.task_id} has invalid subtasks`;
    }
    if (seen.has(node.task_id)) {
        return `duplicate task id in workflow tree: ${node.task_id}`;
    }
    seen.add(node.task_id);

    if (depth > 2) {
        return `workflow tree depth exceeds 2 at ${node.task_id}`;
    }

    for (const child of node.subtasks) {
        const err = validateTaskTreeNode(child, depth + 1, seen);
        if (err) return err;
    }

    return null;
}

function validateWorkflow(workflow: PersistedWorkflow): string | null {
    if (!Number.isInteger(workflow.schema_version)) {
        return "workflow.schema_version must be an integer";
    }
    if (workflow.schema_version !== WORKFLOW_SCHEMA_VERSION) {
        return `workflow schema mismatch (expected ${WORKFLOW_SCHEMA_VERSION}, found ${workflow.schema_version})`;
    }

    if (!Number.isInteger(workflow.version) || workflow.version < 1) {
        return "workflow.version must be an integer >= 1";
    }

    if (typeof workflow.session_leaf_id !== "string" || !workflow.session_leaf_id.trim()) {
        return "workflow.session_leaf_id must be a non-empty string";
    }

    if (
        workflow.session_file_path !== undefined
        && workflow.session_file_path !== null
        && (
            typeof workflow.session_file_path !== "string"
            || !workflow.session_file_path.trim()
        )
    ) {
        return "workflow.session_file_path must be null/undefined or a non-empty string";
    }

    if (
        workflow.last_consumed_assistant_id !== undefined
        && workflow.last_consumed_assistant_id !== null
        && (
            typeof workflow.last_consumed_assistant_id !== "string"
            || !workflow.last_consumed_assistant_id.trim()
        )
    ) {
        return "workflow.last_consumed_assistant_id must be null/undefined or a non-empty string";
    }

    if (!isWorkflowState(workflow.state)) {
        return `workflow.state is invalid: ${String(workflow.state)}`;
    }

    const treeError = validateTaskTreeNode(workflow, 0, new Set<string>());
    if (treeError) return treeError;

    const activeNode = findNodeById(workflow, workflow.active_task_id);
    if (!activeNode) {
        return `workflow.active_task_id not found in tree: ${workflow.active_task_id}`;
    }

    const expectedPath = computePathToId(workflow, workflow.active_task_id);
    if (!expectedPath) {
        return `failed computing path to active task: ${workflow.active_task_id}`;
    }

    if (workflow.active_path_ids.length !== expectedPath.length) {
        return `workflow.active_path_ids length mismatch for active task ${workflow.active_task_id}`;
    }

    for (let i = 0; i < expectedPath.length; i++) {
        if (workflow.active_path_ids[i] !== expectedPath[i]) {
            return `workflow.active_path_ids does not match root→active path for ${workflow.active_task_id}`;
        }
    }

    const activeDepth = workflow.active_path_ids.length - 1;
    if (!stateAllowsActiveDepth(workflow.state, activeDepth)) {
        return `state ${workflow.state} is incompatible with active depth ${activeDepth}`;
    }

    return null;
}

function createInitialWorkflow(rootTaskId: string, rootTitle: string, sessionLeafId: string): PersistedWorkflow {
    const normalizedTitle = rootTitle.trim() || rootTaskId;
    const now = new Date().toISOString();
    return {
        schema_version: WORKFLOW_SCHEMA_VERSION,
        task_id: rootTaskId,
        title: normalizedTitle,
        subtasks: [],
        state: "refine",
        active_task_id: rootTaskId,
        active_path_ids: [rootTaskId],
        session_leaf_id: sessionLeafId,
        session_file_path: null,
        last_consumed_assistant_id: null,
        version: 1,
        updated_at: now,
        last_transition: {
            event: "initialize",
            from_state: "refine",
            to_state: "refine",
            from_active_task_id: rootTaskId,
            to_active_task_id: rootTaskId,
            at: now,
        },
    };
}

function loadWorkflow(root: string): {workflow: PersistedWorkflow} | {error: string} {
    const workflowPath = getWorkflowPath(root);
    if (!fs.existsSync(workflowPath)) {
        return {
            error: `Missing workflow file: ${workflowPath}. Manual cleanup required: create a valid .tasks/workflow.json before running /task.`,
        };
    }

    let raw: string;
    try {
        raw = fs.readFileSync(workflowPath, "utf-8");
    } catch (error) {
        return {
            error: `Failed to read workflow file ${workflowPath}: ${error}. Manual cleanup required.`,
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return {
            error: `Invalid JSON in ${workflowPath}: ${error}. Manual cleanup required.`,
        };
    }

    if (!isObject(parsed)) {
        return {
            error: `Invalid workflow schema in ${workflowPath}: root must be an object. Manual cleanup required.`,
        };
    }

    const workflow = parsed as PersistedWorkflow;
    const validationError = validateWorkflow(workflow);
    if (validationError) {
        return {
            error: `Invalid workflow schema/invariants in ${workflowPath}: ${validationError}. Manual cleanup required.`,
        };
    }

    return {workflow};
}

function saveWorkflowAtomic(root: string, workflow: PersistedWorkflow): {ok: true} | {ok: false; error: string} {
    const validationError = validateWorkflow(workflow);
    if (validationError) {
        return {ok: false, error: `Refusing to save invalid workflow: ${validationError}`};
    }

    ensureWorkflowDirectory(root);

    const targetPath = getWorkflowPath(root);
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;

    try {
        const payload = `${JSON.stringify(workflow, null, 2)}\n`;
        fs.writeFileSync(tempPath, payload, "utf-8");
        fs.renameSync(tempPath, targetPath);
        return {ok: true};
    } catch (error) {
        try {
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
        } catch {
            // Ignore cleanup failures.
        }
        return {ok: false, error: `Failed to save workflow atomically: ${error}`};
    }
}

async function tkQueryObjects(
    pi: ExtensionAPI,
    cwd: string,
    expr?: string,
): Promise<{items: unknown[]} | {error: string}> {
    const args = expr ? ["query", expr] : ["query"];
    const result = await pi.exec("tk", args, {cwd});
    if (result.code !== 0) {
        return {error: result.stderr || "tk query failed"};
    }
    return {items: parseTkQueryObjects(result.stdout)};
}

async function tkCreateTask(
    pi: ExtensionAPI,
    cwd: string,
    title: string,
    description: string,
    parentId: string,
): Promise<{id: string} | {error: string}> {
    const result = await pi.exec("tk", ["create", title, "-d", description, "--parent", parentId], {cwd});
    if (result.code !== 0) {
        return {error: result.stderr || `Failed to create child task ${title}`};
    }
    const id = result.stdout.trim();
    if (!id) {
        return {error: `tk create returned empty task id for \"${title}\"`};
    }
    return {id};
}

async function tkCloseTask(
    pi: ExtensionAPI,
    cwd: string,
    taskId: string,
): Promise<{ok: true} | {ok: false; error: string}> {
    const result = await pi.exec("tk", ["close", taskId], {cwd});
    if (result.code !== 0) {
        return {ok: false, error: result.stderr || `Failed to close task ${taskId}`};
    }
    return {ok: true};
}

async function tkStartTask(
    pi: ExtensionAPI,
    cwd: string,
    taskId: string,
): Promise<{ok: true} | {ok: false; error: string}> {
    const result = await pi.exec("tk", ["start", taskId], {cwd});
    if (result.code !== 0) {
        return {ok: false, error: result.stderr || `Failed to start task ${taskId}`};
    }
    return {ok: true};
}

async function tkShowTask(
    pi: ExtensionAPI,
    cwd: string,
    taskId: string,
): Promise<{content: string} | {error: string}> {
    const result = await pi.exec("tk", ["show", taskId], {cwd});
    if (result.code !== 0) {
        return {error: result.stderr || `Failed to show task ${taskId}`};
    }
    return {content: result.stdout};
}

async function tkAddNoteBestEffort(
    pi: ExtensionAPI,
    cwd: string,
    taskId: string,
    note: string,
): Promise<void> {
    await pi.exec("tk", ["add-note", taskId, note], {cwd});
}

/**
 * Shell helper: capture the newest assistant turn text (with debug diagnostics).
 */
function captureAssistantTurnMessage(
    ctx: ExtensionContext,
    previousAssistantId: string | null,
): {assistantMessage: string; assistantMessageId: string | null} | {error: string} {
    const latest = getLastAssistantMessage(ctx);
    if (!latest) {
        if (ENABLE_TRANSITION_DEBUG) {
            ctx.ui.notify(
                `transition-capture: previous=${previousAssistantId ?? "(none)"} latest=(none)`,
                "warning",
            );
        }
        return {error: "No assistant message found after task prompt."};
    }

    if (previousAssistantId && latest.id === previousAssistantId) {
        if (ENABLE_TRANSITION_DEBUG) {
            ctx.ui.notify(
                `transition-capture: previous=${previousAssistantId} latest=${latest.id ?? "(none)"} (unchanged)`,
                "warning",
            );
        }
        return {error: "No new assistant message was recorded after task prompt."};
    }

    const messageText = latest.text;

    if (ENABLE_TRANSITION_DEBUG) {
        const preview = messageText.replace(/\s+/g, " ").slice(0, 180);
        ctx.ui.notify(
            `transition-capture: previous=${previousAssistantId ?? "(none)"} latest=${latest.id ?? "(none)"}`,
            "info",
        );
        ctx.ui.notify(`transition-capture: assistant-preview: ${preview}`, "info");
    }

    return {assistantMessage: messageText, assistantMessageId: latest.id};
}

function persistConsumedAssistantMessageId(
    root: string,
    workflow: PersistedWorkflow,
    assistantMessageId: string | null,
): {workflow: PersistedWorkflow} | {error: string} {
    if (!assistantMessageId || !assistantMessageId.trim()) {
        return {workflow};
    }

    if (workflow.last_consumed_assistant_id === assistantMessageId) {
        return {workflow};
    }

    const updated = cloneWorkflow(workflow);
    updated.last_consumed_assistant_id = assistantMessageId;
    updated.updated_at = new Date().toISOString();

    const saved = saveWorkflowAtomic(root, updated);
    if (saved.ok === false) {
        return {error: saved.error};
    }

    return {workflow: updated};
}

function persistSessionFilePath(
    root: string,
    workflow: PersistedWorkflow,
    sessionFilePath: string | undefined,
): {workflow: PersistedWorkflow} | {error: string} {
    const normalized = normalizeSessionFilePath(sessionFilePath);
    if ((workflow.session_file_path ?? null) === normalized) {
        return {workflow};
    }

    const updated = cloneWorkflow(workflow);
    updated.session_file_path = normalized;
    updated.updated_at = new Date().toISOString();

    const saved = saveWorkflowAtomic(root, updated);
    if (saved.ok === false) {
        return {error: saved.error};
    }

    return {workflow: updated};
}

async function replayPendingAssistantTransition(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    root: string,
    workflow: PersistedWorkflow,
): Promise<{changed: boolean; workflow: PersistedWorkflow} | {error: string}> {
    const latest = getLastAssistantMessage(ctx);
    if (!latest || !latest.id) {
        return {changed: false, workflow};
    }

    if (workflow.last_consumed_assistant_id === latest.id) {
        return {changed: false, workflow};
    }

    if (!canReplayCompleteFromAssistantMessage(workflow.state, latest.text)) {
        return {changed: false, workflow};
    }

    if (ENABLE_TRANSITION_DEBUG) {
        const preview = latest.text.replace(/\s+/g, " ").slice(0, 180);
        ctx.ui.notify(
            `transition-replay: attempting COMPLETE from assistant ${latest.id} in state ${workflow.state}`,
            "info",
        );
        ctx.ui.notify(`transition-replay: assistant-preview: ${preview}`, "info");
    }

    const transition = await dispatchWorkflowEvent(
        pi,
        ctx,
        root,
        workflow,
        {
            type: "COMPLETE",
            completedState: workflow.state,
            assistantMessage: latest.text,
            rootTicketMarkdown: "",
        },
    );

    if ("error" in transition) {
        return {error: transition.error};
    }

    const consumed = persistConsumedAssistantMessageId(root, transition.workflow, latest.id);
    if ("error" in consumed) {
        return {error: consumed.error};
    }

    const completionNotice = completionReadyToMergeNotice({
        changed: transition.changed,
        nextState: consumed.workflow.state,
    });
    if (completionNotice) {
        ctx.ui.notify(completionNotice, "info");
    }

    if (ENABLE_TRANSITION_DEBUG) {
        ctx.ui.notify(
            `transition-replay: result changed=${transition.changed ? "yes" : "no"}`,
            "info",
        );
    }

    return {
        changed: transition.changed,
        workflow: consumed.workflow,
    };
}

function userConfirmedManualTests(ctx: ExtensionContext): boolean {
    const branch = ctx.sessionManager.getBranch();

    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type !== "message") continue;
        const message = entry.message as {role?: string; content?: unknown};

        if (message.role !== "user") {
            continue;
        }

        const text = extractMessageText(message.content).trim();
        if (!text) continue;
        if (text.includes("## Ticket Metadata") && text.includes("## Ticket Contents")) {
            continue;
        }

        return MANUAL_TEST_PASS_REGEX.test(text);
    }

    return false;
}

function buildTransitionedWorkflow(
    workflow: PersistedWorkflow,
    params: {
        toState: MachineWorkflowState;
        activeTaskId?: string;
        event: string;
        mutateTree?: (draft: PersistedWorkflow) => void;
    },
): {workflow: PersistedWorkflow} | {error: string} {
    const draft = cloneWorkflow(workflow);

    if (params.mutateTree) {
        try {
            params.mutateTree(draft);
        } catch (error) {
            return {error: `Failed to apply tree mutation: ${error}`};
        }
    }

    const nextActiveTaskId = params.activeTaskId ?? draft.active_task_id;
    const nextPath = computePathToId(draft, nextActiveTaskId);
    if (!nextPath) {
        return {error: `Transition produced invalid active task id: ${nextActiveTaskId}`};
    }

    draft.state = params.toState;
    draft.active_task_id = nextActiveTaskId;
    draft.active_path_ids = nextPath;
    draft.version = workflow.version + 1;
    draft.updated_at = new Date().toISOString();
    draft.last_transition = {
        event: params.event,
        from_state: workflow.state,
        to_state: draft.state,
        from_active_task_id: workflow.active_task_id,
        to_active_task_id: draft.active_task_id,
        at: draft.updated_at,
    };

    if (draft.version !== workflow.version + 1) {
        return {error: "workflow version must increment exactly once per transition"};
    }

    const error = validateWorkflow(draft);
    if (error) {
        return {error: `Transition violates workflow invariants: ${error}`};
    }

    return {workflow: draft};
}

async function createOrReuseChildTask(
    pi: ExtensionAPI,
    root: string,
    parentId: string,
    title: string,
    description: string,
): Promise<{id: string} | {error: string}> {
    const escapedParent = JSON.stringify(parentId);
    const escapedTitle = JSON.stringify(title);
    const lookupExpr = `select(.parent == ${escapedParent} and .title == ${escapedTitle})`;

    const existingResult = await tkQueryObjects(pi, root, lookupExpr);
    if (!("error" in existingResult)) {
        const existing = existingResult.items
            .map((item) => {
                if (!item || typeof item !== "object") return null;
                const id = typeof (item as {id?: unknown}).id === "string" ? (item as {id: string}).id.trim() : "";
                const created = typeof (item as {created?: unknown}).created === "string"
                    ? (item as {created: string}).created.trim()
                    : "";
                const status = typeof (item as {status?: unknown}).status === "string"
                    ? (item as {status: string}).status.trim()
                    : "";
                return id ? {id, created, status} : null;
            })
            .filter((item): item is {id: string; created: string; status: string} => Boolean(item));

        if (existing.length > 0) {
            const statusRank = (status: string): number => {
                if (status === "in_progress") return 0;
                if (status === "open") return 1;
                if (status === "closed") return 2;
                return 3;
            };

            existing.sort((a, b) => {
                const rankDiff = statusRank(a.status) - statusRank(b.status);
                if (rankDiff !== 0) return rankDiff;

                const aCreated = parseCreatedTimestamp(a.created);
                const bCreated = parseCreatedTimestamp(b.created);
                if (aCreated !== bCreated) return aCreated - bCreated;
                return a.id.localeCompare(b.id);
            });
            return {id: existing[0].id};
        }
    }

    const created = await tkCreateTask(pi, root, title, description, parentId);
    if ("error" in created) {
        return {error: `Failed to create child task \"${title}\": ${created.error}`};
    }

    return {id: created.id};
}

async function runJjCommitWithCleanCheck(
    pi: ExtensionAPI,
    root: string,
    commitMessage: string,
): Promise<{ok: true} | {ok: false; error: string}> {
    const commit = await pi.exec("jj", ["commit", "-m", commitMessage], {cwd: root});
    if (commit.code !== 0) {
        return {ok: false, error: `jj commit failed: ${commit.stderr}`};
    }

    const diffAfter = await pi.exec("jj", ["diff"], {cwd: root});
    if (diffAfter.code !== 0) {
        return {ok: false, error: `Failed to check working copy diff: ${diffAfter.stderr}`};
    }

    if (diffAfter.stdout.trim().length > 0) {
        return {ok: false, error: "Working copy still has uncommitted changes after commit."};
    }

    return {ok: true};
}

function notifyTransition(ctx: ExtensionContext, before: PersistedWorkflow, after: PersistedWorkflow): void {
    const from = `${before.state}/${before.active_task_id}`;
    const to = `${after.state}/${after.active_task_id}`;
    const versionInfo = `v${before.version}→v${after.version}`;
    ctx.ui.notify(`workflow transition ${versionInfo}: ${from} -> ${to}`, "info");
}

// ---------------------------------------------------------------------------
// Functional core / imperative shell boundary
// ---------------------------------------------------------------------------

/**
 * Functional-core adapter: map persisted workflow state into the pure machine snapshot.
 */
function buildMachineSnapshot(workflow: PersistedWorkflow): MachineWorkflowSnapshot {
    const parent = findParentById(workflow, workflow.active_task_id);
    const sibling = nextSibling(workflow, workflow.active_task_id);

    return {
        state: workflow.state,
        rootTaskId: workflow.task_id,
        activeTaskId: workflow.active_task_id,
        activeTaskParentId: parent ? parent.task_id : null,
        activeTaskNextSiblingId: sibling ? sibling.task_id : null,
    };
}

/**
 * Enrich machine events with root ticket markdown when required by the pure transition logic.
 */
async function withRequiredRootTicketMarkdown(
    pi: ExtensionAPI,
    root: string,
    workflow: PersistedWorkflow,
    snapshot: MachineWorkflowSnapshot,
    event: MachineWorkflowEvent,
): Promise<{event: MachineWorkflowEvent} | {error: string}> {
    if (!eventNeedsRootTicketMarkdown(snapshot, event)) {
        return {event};
    }

    if (event.type === "COMPLETE" && event.rootTicketMarkdown.trim()) {
        return {event};
    }

    if (event.type === "FORCE_LGTM" && event.rootTicketMarkdown?.trim()) {
        return {event};
    }

    const loaded = await loadTicketMarkdown(pi, root, workflow.task_id);
    if ("error" in loaded) {
        return {error: loaded.error};
    }

    if (event.type === "COMPLETE") {
        return {
            event: {
                ...event,
                rootTicketMarkdown: loaded.content,
            },
        };
    }

    if (event.type === "FORCE_LGTM") {
        return {
            event: {
                ...event,
                rootTicketMarkdown: loaded.content,
            },
        };
    }

    return {event};
}

function applyCreatedChildrenToTree(workflow: PersistedWorkflow, createdChildrenByParent: Map<string, TaskNode[]>): void {
    for (const [parentTaskId, children] of createdChildrenByParent.entries()) {
        const parentNode = findNodeById(workflow, parentTaskId);
        if (!parentNode) {
            throw new Error(`Parent task not found while applying CREATE_TICKET effects: ${parentTaskId}`);
        }
        parentNode.subtasks = children.map(cloneTaskNode);
    }
}

type InterpretedMachineEffectsResult = {
    createdChildrenByParent: Map<string, TaskNode[]>;
};

/**
 * Imperative shell: execute machine-emitted effects against tk/jj.
 */
async function interpretMachineEffects(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    root: string,
    effects: MachineWorkflowEffect[],
): Promise<InterpretedMachineEffectsResult | {error: string}> {
    const createdChildrenByParent = new Map<string, TaskNode[]>();

    for (const effect of effects) {
        if (effect.type === "CREATE_TICKET") {
            const created = await createOrReuseChildTask(
                pi,
                root,
                effect.parentTaskId,
                effect.title,
                effect.description,
            );
            if ("error" in created) {
                return {error: created.error};
            }

            const existing = createdChildrenByParent.get(effect.parentTaskId) ?? [];
            existing.push({
                task_id: created.id,
                title: effect.title,
                subtasks: [],
            });
            createdChildrenByParent.set(effect.parentTaskId, existing);
            ctx.ui.notify(`workflow effect: created/reused task ${created.id} (${effect.title})`, "info");
            continue;
        }

        if (effect.type === "ADD_NOTE") {
            await tkAddNoteBestEffort(pi, root, effect.taskId, effect.note);
            continue;
        }

        if (effect.type === "CLOSE_TICKET") {
            const closed = await tkCloseTask(pi, root, effect.taskId);
            if (closed.ok === false) {
                return {error: `Failed to close task ${effect.taskId}: ${closed.error}`};
            }
            continue;
        }

        if (effect.type === "RUN_JJ_COMMIT") {
            const commitSubject = effect.message.split("\n")[0]?.trim() || "(empty subject)";
            ctx.ui.notify(`workflow effect: running jj commit (${commitSubject})`, "info");
            const committed = await runJjCommitWithCleanCheck(pi, root, effect.message);
            if (committed.ok === false) {
                return {error: committed.error};
            }
            ctx.ui.notify(`workflow effect: jj commit succeeded (${commitSubject})`, "info");
            continue;
        }
    }

    return {createdChildrenByParent};
}

/**
 * Resolve machine-selected active task target against the (possibly mutated) workflow tree.
 */
function resolveNextActiveTaskId(
    workflow: PersistedWorkflow,
    currentActiveTaskId: string,
    target: MachineActiveTaskTarget,
): {activeTaskId: string} | {error: string} {
    if (target.type === "current") {
        return {activeTaskId: currentActiveTaskId};
    }

    if (target.type === "root") {
        return {activeTaskId: workflow.task_id};
    }

    if (target.type === "parent") {
        const parent = findParentById(workflow, currentActiveTaskId);
        if (!parent) {
            return {error: `No parent found for active task ${currentActiveTaskId}`};
        }
        return {activeTaskId: parent.task_id};
    }

    if (target.type === "next-sibling") {
        const sibling = nextSibling(workflow, currentActiveTaskId);
        if (!sibling) {
            return {error: `No next sibling found for active task ${currentActiveTaskId}`};
        }
        return {activeTaskId: sibling.task_id};
    }

    const parentNode = findNodeById(workflow, target.parentTaskId);
    if (!parentNode) {
        return {error: `Parent task not found for first-created-child target: ${target.parentTaskId}`};
    }

    const firstChild = parentNode.subtasks[0];
    if (!firstChild) {
        return {error: `No children found under parent ${target.parentTaskId} for first-created-child target`};
    }

    return {activeTaskId: firstChild.task_id};
}

function machineEventAuditLabel(event: MachineWorkflowEvent): string {
    if (event.type === "COMPLETE") {
        return `machine:complete:${event.completedState}`;
    }
    if (event.type === "FORCE_LGTM") {
        return `machine:force-lgtm:${event.completedState}`;
    }
    return "machine:manual-tests-passed";
}

async function dispatchWorkflowEvent(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    root: string,
    workflow: PersistedWorkflow,
    event: MachineWorkflowEvent,
): Promise<{changed: boolean; workflow: PersistedWorkflow} | {error: string}> {
    const transitionError = (message: string): {error: string} => ({
        error: `${message}. Manual cleanup required in ${getWorkflowPath(root)}.`,
    });

    const beforeError = validateWorkflow(workflow);
    if (beforeError) {
        return transitionError(`Workflow invariant failure before transition: ${beforeError}.`);
    }

    // 1) Build pure-machine inputs.
    const snapshot = buildMachineSnapshot(workflow);
    const enriched = await withRequiredRootTicketMarkdown(pi, root, workflow, snapshot, event);
    if ("error" in enriched) {
        return {error: enriched.error};
    }

    const machineEvent = enriched.event;

    // 2) Run pure transition logic.
    const decision: MachineTransitionDecision = runWorkflowTransition(snapshot, machineEvent);

    if (decision.kind === "ignored") {
        if (ENABLE_TRANSITION_DEBUG && decision.reason) {
            ctx.ui.notify(`workflow transition ignored: ${decision.reason}`, "info");
        }
        return {changed: false, workflow};
    }

    if (decision.kind === "rejected") {
        ctx.ui.notify(`workflow transition rejected: ${decision.reason}`, "warning");
        return {changed: false, workflow};
    }

    // 3) Interpret side effects.
    const interpreted = await interpretMachineEffects(pi, ctx, root, decision.effects);
    if ("error" in interpreted) {
        return {error: interpreted.error};
    }

    const mutateTree = interpreted.createdChildrenByParent.size > 0
        ? (draft: PersistedWorkflow) => applyCreatedChildrenToTree(draft, interpreted.createdChildrenByParent)
        : undefined;

    const preview = cloneWorkflow(workflow);
    if (mutateTree) {
        try {
            mutateTree(preview);
        } catch (error) {
            return transitionError(`Failed to apply tree mutation preview: ${error}`);
        }
    }

    const resolvedTarget = resolveNextActiveTaskId(
        preview,
        workflow.active_task_id,
        decision.activeTaskTarget,
    );
    if ("error" in resolvedTarget) {
        return transitionError(resolvedTarget.error);
    }

    // 4) Persist new workflow state with validated invariants.
    const transitioned = buildTransitionedWorkflow(workflow, {
        toState: decision.state,
        activeTaskId: resolvedTarget.activeTaskId,
        event: machineEventAuditLabel(machineEvent),
        mutateTree,
    });
    if ("error" in transitioned) {
        return transitionError(transitioned.error);
    }

    const saved = saveWorkflowAtomic(root, transitioned.workflow);
    if (saved.ok === false) {
        return {error: saved.error};
    }

    notifyTransition(ctx, workflow, transitioned.workflow);
    return {
        changed: true,
        workflow: transitioned.workflow,
    };
}

function clearTaskUi(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("task", undefined);
}

async function updateTaskUiDisplay(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    workflow: PersistedWorkflow,
): Promise<void> {
    const rootBase = `${workflow.task_id} - ${workflow.title}`;
    const activeNode = findNodeById(workflow, workflow.active_task_id);
    const activeTitle = activeNode?.title ?? workflow.active_task_id;

    if (ctx.hasUI) {
        const footerLine = workflow.active_task_id === workflow.task_id
            ? `${rootBase} (${workflow.state})`
            : `${rootBase} | ${workflow.active_task_id} - ${activeTitle} (${workflow.state})`;
        ctx.ui.setStatus("task", footerLine);
    }

    const desiredSessionName = `${workflow.task_id} - ${workflow.title}`;
    const currentSessionName = pi.getSessionName()?.trim() ?? "";
    if (desiredSessionName.trim() && desiredSessionName.trim() !== currentSessionName) {
        pi.setSessionName(desiredSessionName);
    }
}

async function maybeNotifyPendingTransitionOutsideTaskLoop(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
): Promise<void> {
    if (isTaskLoopActive()) {
        return;
    }

    const cwd = ctx.sessionManager.getCwd();
    const jjRootResult = await pi.exec("jj", ["root"], {cwd});
    if (jjRootResult.code !== 0) {
        return;
    }

    const root = jjRootResult.stdout.trim();
    if (!root || !isTaskWorkspace(root)) {
        return;
    }

    const loaded = loadWorkflow(root);
    if ("error" in loaded) {
        return;
    }

    const workflow = loaded.workflow;
    const latest = getLastAssistantMessage(ctx);

    const shouldNotify = shouldNotifyPendingTransitionOutsideTaskLoop({
        workflowState: workflow.state,
        latestAssistantMessageId: latest?.id ?? null,
        latestAssistantMessageText: latest?.text ?? "",
        lastConsumedAssistantId: workflow.last_consumed_assistant_id ?? null,
        taskLoopActive: isTaskLoopActive(),
    });

    if (!shouldNotify) {
        return;
    }

    ctx.ui.notify(
        "The agent has requested a transition outside the tool loop, please run /task to continue.",
        "warning",
    );
}

export default function (pi: ExtensionAPI) {
    pi.on("agent_start", () => {
        resolveNextAgentStart();
    });

    pi.on("agent_end", async (_event, ctx) => {
        await maybeNotifyPendingTransitionOutsideTaskLoop(pi, ctx);
    });

    pi.registerCommand("task", {
        description: "Run the deterministic task workflow",
        handler: async (args, ctx) => {
            const trimmedArgs = (args ?? "").trim();
            const subcommand = trimmedArgs.split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "";

            // Check required commands
            for (const cmd of ["jj", "tk"]) {
                const result = await pi.exec("which", [cmd]);
                if (result.code !== 0) {
                    ctx.ui.notify(`Missing required command: ${cmd}`, "error");
                    return;
                }
            }

            // Check if we're in a jj workspace
            const jjRootResult = await pi.exec("jj", ["root"]);
            if (jjRootResult.code !== 0) {
                ctx.ui.notify("Not in a jj workspace (jj root failed)", "error");
                return;
            }
            const root = jjRootResult.stdout.trim();

            // Determine workspace type and run appropriate flow
            if (isTaskWorkspace(root)) {
                if (subcommand === "lgtm") {
                    const forced = await forceLGTM(pi, ctx, root);
                    if (!forced) {
                        return;
                    }
                } else if (subcommand === "delete") {
                    ctx.ui.notify("/task delete can only be used from the main workspace.", "error");
                    return;
                } else if (subcommand) {
                    ctx.ui.notify(`Unknown /task subcommand: ${subcommand}. Supported: lgtm`, "error");
                    return;
                }

                await withTaskLoopGuard(() => runTaskWorkspace(pi, ctx, root));
            } else {
                if (subcommand === "lgtm") {
                    ctx.ui.notify("/task lgtm can only be used inside a per-task workspace (~/.workspaces/<task-id>/<repo>).", "error");
                    return;
                }
                if (subcommand === "delete") {
                    await deleteTaskWorkspaceFromMain(pi, ctx, root);
                    return;
                }
                if (subcommand) {
                    ctx.ui.notify(`Unknown /task subcommand: ${subcommand}. Supported: delete`, "error");
                    return;
                }
                await runMainWorkspace(pi, ctx, root);
            }
        },
    });
}

function agentEndLooksLikeErrorFromSession(ctx: ExtensionContext): boolean {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        if (entry.type !== "message") continue;
        const message = entry.message as {
            role?: unknown;
            stopReason?: unknown;
            errorMessage?: unknown;
            isError?: unknown;
        };

        if (message.role === "assistant") {
            return (
                message.stopReason === "error" ||
                message.stopReason === "aborted" ||
                typeof message.errorMessage === "string"
            );
        }

        if (message.role === "toolResult") {
            return message.isError === true;
        }

        return false;
    }

    return false;
}

/**
 * Manual escape hatch for when a review loop is being too strict.
 *
 * Usage: /task lgtm
 *
 * Validity is enforced by the state machine (currently review-plan/review only).
 */
async function forceLGTM(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string,
): Promise<boolean> {
    if (!isTaskWorkspace(root)) {
        ctx.ui.notify("/task lgtm is only supported in a task workspace.", "error");
        return false;
    }

    const loaded = loadWorkflow(root);
    if ("error" in loaded) {
        ctx.ui.notify(loaded.error, "error");
        return false;
    }

    const workflow = loaded.workflow;

    const result = await dispatchWorkflowEvent(pi, ctx, root, workflow, {
        type: "FORCE_LGTM",
        completedState: workflow.state,
    });
    if ("error" in result) {
        ctx.ui.notify(result.error, "error");
        return false;
    }

    if (!result.changed) {
        return false;
    }

    ctx.ui.notify(`/task lgtm applied in ${workflow.state}.`, "info");
    return true;
}

function getLastAssistantMessage(ctx: ExtensionContext): {id: string | null; text: string} | null {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i] as {type?: string; id?: unknown; message?: unknown};
        if (entry.type !== "message") continue;
        const message = entry.message as { role?: string; content?: unknown };
        if (message.role !== "assistant") continue;

        const id = typeof entry.id === "string" ? entry.id : null;
        return {id, text: extractMessageText(message.content)};
    }
    return null;
}

async function waitForNewAssistantMessage(
    ctx: ExtensionContext,
    previousAssistantId: string | null,
    timeoutMs = 1500,
    pollMs = 50,
): Promise<void> {
    if (!previousAssistantId) {
        if (ENABLE_TRANSITION_DEBUG) {
            ctx.ui.notify("transition-capture: no previous assistant id; skipping new-message wait", "info");
        }
        return;
    }

    if (ENABLE_TRANSITION_DEBUG) {
        ctx.ui.notify(`transition-capture: waiting for new assistant message after ${previousAssistantId}`, "info");
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const latest = getLastAssistantMessage(ctx);
        if (latest && latest.id && latest.id !== previousAssistantId) {
            if (ENABLE_TRANSITION_DEBUG) {
                ctx.ui.notify(`transition-capture: detected new assistant message ${latest.id}`, "info");
            }
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    if (ENABLE_TRANSITION_DEBUG) {
        const latest = getLastAssistantMessage(ctx);
        ctx.ui.notify(
            `transition-capture: timed out waiting for new assistant message; latest=${latest?.id ?? "(none)"}`,
            "warning",
        );
    }
}

function extractMessageText(content: unknown): string {
    const seen = new Set<unknown>();

    const walk = (value: unknown): string[] => {
        if (typeof value === "string") {
            return [value];
        }

        if (!value || typeof value !== "object") {
            return [];
        }

        if (seen.has(value)) {
            return [];
        }
        seen.add(value);

        if (Array.isArray(value)) {
            return value.flatMap((item) => walk(item));
        }

        const obj = value as Record<string, unknown>;
        const parts: string[] = [];

        if (typeof obj.text === "string") {
            parts.push(obj.text);
        }

        for (const key of ["content", "parts", "messages", "items", "output", "result"]) {
            if (key in obj) {
                parts.push(...walk(obj[key]));
            }
        }

        return parts;
    };

    return walk(content).join("");
}

/**
 * Main workspace flow:
 * 1. Check for completed task workspaces and offer to merge
 * 2. Select a task from `tk ready`
 * 3. Create task workspace
 */
async function runMainWorkspace(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string
): Promise<void> {
    clearTaskUi(ctx);

    // Loop: merge completed workspaces
    while (await maybeMergeCompletedWorkspace(pi, ctx, root)) {
        // Continue merging until none left or user skips
    }

    // Select and start a new task
    await selectAndStartTask(pi, ctx, root);
}

async function deleteTaskWorkspaceFromMain(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string,
): Promise<void> {
    clearTaskUi(ctx);

    const workspaceNames = await listWorkspaceNames(pi, ctx);
    if (workspaceNames.length === 0) {
        ctx.ui.notify("No task workspaces found.", "info");
        return;
    }

    const repo = path.basename(root);
    const taskWorkspaces: Array<{ name: string; wsPath: string }> = [];

    for (const name of workspaceNames) {
        if (name === "default") {
            continue;
        }

        const wsPath = path.join(os.homedir(), ".workspaces", name, repo);
        if (!fs.existsSync(wsPath)) {
            continue;
        }

        taskWorkspaces.push({name, wsPath});
    }

    if (taskWorkspaces.length === 0) {
        ctx.ui.notify("No task workspaces found for this repository.", "info");
        return;
    }

    taskWorkspaces.sort((a, b) => a.name.localeCompare(b.name));

    const choices = taskWorkspaces.map((workspace) => workspace.name);
    choices.push("Cancel");

    const selection = await ctx.ui.select("Select a task workspace to delete:", choices);
    if (!selection || selection === "Cancel") {
        return;
    }

    const selected = taskWorkspaces.find((workspace) => workspace.name === selection);
    if (!selected) {
        ctx.ui.notify(`Workspace not found: ${selection}`, "error");
        return;
    }

    const confirmDelete = await ctx.ui.confirm(
        "Delete workspace?",
        `Delete jj workspace "${selected.name}" and remove ${path.dirname(selected.wsPath)}?`,
    );
    if (!confirmDelete) {
        return;
    }

    const deleted = await deleteTaskWorkspace(pi, ctx, root, selected.name, selected.wsPath);
    if (!deleted) {
        return;
    }

    ctx.ui.notify(`Deleted workspace: ${selected.name}`, "info");
}

/**
 * Task workspace flow
 */
async function runTaskWorkspace(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string,
): Promise<void> {
    const agentDir = getAgentDir();

    while (true) {
        if (!ctx.isIdle()) {
            await ctx.waitForIdle();
        }

        const loaded = loadWorkflow(root);
        if ("error" in loaded) {
            ctx.ui.notify(loaded.error, "error");
            return;
        }

        let workflow = loaded.workflow;

        const leafId = ctx.sessionManager.getLeafId();
        if (!leafId) {
            ctx.ui.notify("No session leaf ID available", "error");
            return;
        }

        if (workflow.session_leaf_id === UNBOUND_SESSION_LEAF_ID) {
            const updated = cloneWorkflow(workflow);
            updated.session_leaf_id = leafId;
            updated.updated_at = new Date().toISOString();
            const saved = saveWorkflowAtomic(root, updated);
            if (saved.ok === false) {
                ctx.ui.notify(`Failed to bind workflow session leaf id: ${saved.error}`, "error");
                return;
            }
            workflow = updated;
            ctx.ui.notify(`workflow: bound session_leaf_id to current session leaf ${leafId}`, "info");
        } else if (
            workflow.session_leaf_id !== leafId
            && workflow.version === 1
            && workflow.state === "refine"
            && workflow.active_task_id === workflow.task_id
            && workflow.last_transition?.event === "initialize"
        ) {
            // Compatibility path for workspaces initialized before session_leaf_id was set to "unbound".
            const updated = cloneWorkflow(workflow);
            updated.session_leaf_id = leafId;
            updated.updated_at = new Date().toISOString();
            const saved = saveWorkflowAtomic(root, updated);
            if (saved.ok === false) {
                ctx.ui.notify(`Failed to rebind initial workflow session leaf id: ${saved.error}`, "error");
                return;
            }
            workflow = updated;
            ctx.ui.notify(`workflow: rebound initial session_leaf_id to current session leaf ${leafId}`, "info");
        } else if (workflow.session_leaf_id !== leafId) {
            ctx.ui.notify(
                `workflow: current session leaf is ${leafId}; resuming from stored workflow leaf ${workflow.session_leaf_id}`,
                "info",
            );
        }

        const withSessionFile = persistSessionFilePath(root, workflow, ctx.sessionManager.getSessionFile());
        if ("error" in withSessionFile) {
            ctx.ui.notify(`Failed to update workflow session file path: ${withSessionFile.error}`, "error");
            return;
        }
        workflow = withSessionFile.workflow;

        await updateTaskUiDisplay(pi, ctx, workflow);

        if (workflow.state === "complete") {
            ctx.ui.notify("Workflow already complete. Workspace is ready to merge.", "info");
            return;
        }

        if (workflow.state === "manual-test" && userConfirmedManualTests(ctx)) {
            const manualGate = await dispatchWorkflowEvent(pi, ctx, root, workflow, {type: "MANUAL_TESTS_PASSED"});
            if ("error" in manualGate) {
                ctx.ui.notify(manualGate.error, "error");
                return;
            }
            if (manualGate.changed) {
                continue;
            }
        }

        const replayed = await replayPendingAssistantTransition(pi, ctx, root, workflow);
        if ("error" in replayed) {
            ctx.ui.notify(replayed.error, "error");
            return;
        }
        workflow = replayed.workflow;
        if (replayed.changed) {
            continue;
        }

        const taskLoad = loadTask(workflow.state, root, agentDir);
        if ("error" in taskLoad) {
            ctx.ui.notify(`${taskLoad.error}\nSearched:\n${taskLoad.searched.join("\n")}`, "error");
            return;
        }

        const {frontmatter, body} = parseFrontmatter<Record<string, string>>(taskLoad.content);
        const trimmedBody = body.trim();
        if (!trimmedBody) {
            ctx.ui.notify(`Task prompt ${taskLoad.path} is empty`, "error");
            return;
        }

        await applyTaskFrontmatter(pi, ctx, frontmatter, taskLoad.path);

        let navigation;
        try {
            navigation = await ctx.navigateTree(workflow.session_leaf_id, {summarize: false});
        } catch (error) {
            const currentLeafId = ctx.sessionManager.getLeafId();
            if (currentLeafId && currentLeafId !== workflow.session_leaf_id) {
                const confirm = await ctx.ui.confirm(
                    "Update workflow leaf ID?",
                    `Failed to navigate to stored workflow leaf ${workflow.session_leaf_id}.\n\nThis usually means the workflow was resumed in a different Pi session.\n\nUpdate workflow.session_leaf_id to current session leaf ${currentLeafId} so the workflow can continue?`,
                );

                if (confirm) {
                    const updated = cloneWorkflow(workflow);
                    updated.session_leaf_id = currentLeafId;
                    updated.updated_at = new Date().toISOString();
                    const saved = saveWorkflowAtomic(root, updated);
                    if (saved.ok === false) {
                        ctx.ui.notify(`Failed to update workflow session leaf id: ${saved.error}`, "error");
                        return;
                    }
                    ctx.ui.notify(
                        `workflow: updated session_leaf_id ${workflow.session_leaf_id} -> ${currentLeafId}`,
                        "info",
                    );
                    continue;
                }
            }

            ctx.ui.notify(`Failed to navigate to workflow leaf ${workflow.session_leaf_id}: ${error}`, "error");
            return;
        }

        if (navigation.cancelled) {
            return;
        }

        const ticketContext = await buildTicketContextMarkdownFromIds(pi, ctx, root, workflow.active_path_ids);
        if (ticketContext === null) {
            return;
        }

        const headerLines = [
            "## Ticket Metadata",
            `- Workflow Version: ${workflow.version}`,
            `- Workflow State: ${workflow.state}`,
            `- Active Ticket ID: ${workflow.active_task_id}`,
            `- Active Path: ${workflow.active_path_ids.join(" -> ")}`,
            "",
            "## Ticket Handling Rules (critical)",
            "- Do NOT manually edit YAML frontmatter in ticket files (`--- ... ---`).",
            "- Do NOT change `status` (open/in_progress/closed) manually.",
            "",
            "## Ticket Contents",
            "The following is the current contents of the ticket file chain (root -> ... -> active):",
        ];

        const header = headerLines.join("\n");
        const fullMessage = `${header}\n\n${ticketContext}\n\n---\n\n${trimmedBody}`;

        const previousAssistantId = getLastAssistantMessage(ctx)?.id ?? null;
        if (ENABLE_TRANSITION_DEBUG) {
            ctx.ui.notify(
                `transition-capture: state=${workflow.state} version=${workflow.version} previous-assistant=${previousAssistantId ?? "(none)"}`,
                "info",
            );
        }

        const ran = await runTaskPrompt(pi, ctx, fullMessage);
        if (!ran) {
            return;
        }

        await waitForNewAssistantMessage(ctx, previousAssistantId);

        if (agentEndLooksLikeErrorFromSession(ctx)) {
            return;
        }

        const captured = captureAssistantTurnMessage(ctx, previousAssistantId);
        if ("error" in captured) {
            ctx.ui.notify(captured.error, "error");
            return;
        }

        const transition = await dispatchWorkflowEvent(
            pi,
            ctx,
            root,
            workflow,
            {
                type: "COMPLETE",
                completedState: workflow.state,
                assistantMessage: captured.assistantMessage,
                rootTicketMarkdown: "",
            },
        );

        if ("error" in transition) {
            ctx.ui.notify(transition.error, "error");
            return;
        }

        const consumed = persistConsumedAssistantMessageId(root, transition.workflow, captured.assistantMessageId);
        if ("error" in consumed) {
            ctx.ui.notify(consumed.error, "error");
            return;
        }

        const completionNotice = completionReadyToMergeNotice({
            changed: transition.changed,
            nextState: consumed.workflow.state,
        });
        if (completionNotice) {
            ctx.ui.notify(completionNotice, "info");
        }

        const shouldContinue = transition.changed && consumed.workflow.state !== "complete";

        if (ENABLE_TRANSITION_DEBUG) {
            ctx.ui.notify(
                `transition-capture: dispatch result changed=${transition.changed ? "yes" : "no"} continue=${shouldContinue ? "yes" : "no"}`,
                "info",
            );
        }

        if (!shouldContinue) {
            if (consumed.workflow.state === "manual-test") {
                ctx.ui.notify(`Waiting for explicit user confirmation: ${MANUAL_TEST_PASS_PHRASE} (or MANUAL TEST PASSED). Then run /task again.`, "info");
            }
            return;
        }
    }
}

async function runTaskPrompt(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    fullMessage: string
): Promise<boolean> {
    let startPromise: Promise<boolean>;
    try {
        startPromise = waitForNextAgentStart();
    } catch (error) {
        ctx.ui.notify(`Failed to wait for agent_start: ${error}`, "error");
        return false;
    }

    pi.sendUserMessage(fullMessage);

    const started = await startPromise;
    if (!started) {
        ctx.ui.notify("Timed out waiting for agent_start", "error");
        return false;
    }

    await ctx.waitForIdle();
    return true;
}

/**
 * Check for completed task workspaces and offer to merge one
 * Returns true if a merge happened (so caller can loop)
 */
async function maybeMergeCompletedWorkspace(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string
): Promise<boolean> {
    const workspaceNames = await listWorkspaceNames(pi, ctx);
    if (workspaceNames.length === 0) {
        return false;
    }

    const repo = path.basename(root);
    const mainCommitId = await getMainWorkspaceCommitId(pi, ctx);
    if (!mainCommitId) {
        return false;
    }

    const mergeableWorkspaces: Array<{ name: string; wsPath: string }> = [];
    for (const name of workspaceNames) {
        if (name === "default") {
            continue;
        }

        const wsPath = path.join(os.homedir(), ".workspaces", name, repo);
        if (!fs.existsSync(wsPath)) {
            continue;
        }

        const inProgress = await listInProgressRootTaskIds(pi, wsPath);
        if (inProgress.size > 0) {
            continue;
        }

        const hasUnmerged = await workspaceHasUnmergedCommits(pi, ctx, wsPath, mainCommitId);
        if (!hasUnmerged) {
            continue;
        }

        mergeableWorkspaces.push({name, wsPath});
    }

    if (mergeableWorkspaces.length === 0) {
        return false;
    }

    const choices = mergeableWorkspaces.map((ws) => ws.name);
    choices.push("Skip merge");

    const selection = await ctx.ui.select(
        "Task workspaces ready to merge:",
        choices
    );

    if (!selection || selection === "Skip merge") {
        return false;
    }

    const selected = mergeableWorkspaces.find((ws) => ws.name === selection);
    if (!selected) {
        return false;
    }

    const confirmMerge = await ctx.ui.confirm(
        "Merge workspace?",
        `Merge "${selected.name}" into main?`
    );

    if (!confirmMerge) {
        return false;
    }

    const mergeSuccess = await mergeDoneTaskWorkspace(pi, ctx, root, selected.name, selected.wsPath);
    if (!mergeSuccess) {
        return false;
    }

    ctx.ui.notify(`Merged workspace: ${selected.name}`, "info");

    const confirmDelete = await ctx.ui.confirm(
        "Delete workspace?",
        `Delete jj workspace "${selected.name}"?`
    );

    if (confirmDelete) {
        const deleted = await deleteTaskWorkspace(pi, ctx, root, selected.name, selected.wsPath);
        if (deleted) {
            ctx.ui.notify(`Deleted workspace: ${selected.name}`, "info");
        }
    }

    return true;
}

/**
 * Merge a completed task workspace into main
 */
async function mergeDoneTaskWorkspace(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string,
    name: string,
    wsPath: string
): Promise<boolean> {
    // Refuse to merge if the main workspace has pending changes.
    const mainDiff = await pi.exec("jj", ["diff"], {cwd: root});
    if (mainDiff.code !== 0) {
        ctx.ui.notify(`Failed to check main workspace diff: ${mainDiff.stderr}`, "error");
        return false;
    }
    if (mainDiff.stdout.trim().length > 0) {
        ctx.ui.notify("Main workspace has uncommitted changes; commit or discard them before merging a task workspace.", "error");
        return false;
    }

    // Find the latest non-empty commit in the task workspace.
    const taskHeadResult = await pi.exec(
        "jj",
        [
            "log",
            "-R",
            wsPath,
            "--ignore-working-copy",
            "-r",
            "latest(::@ & ~empty(), 1)",
            "-T",
            "change_id",
            "--no-graph",
            "--limit",
            "1",
        ],
        {cwd: root},
    );

    const taskHeadChangeId = taskHeadResult.stdout.trim();
    if (taskHeadResult.code !== 0 || !taskHeadChangeId) {
        ctx.ui.notify(`Failed to find task head commit for ${name}`, "error");
        return false;
    }

    // Revset of all non-empty commits that are part of the task branch relative to current main @-.
    const taskBranchRevset = `(::change_id(${taskHeadChangeId}) ~ ::fork_point(change_id(${taskHeadChangeId}) | @-)) & ~empty()`;

    const hasTaskCommits = await pi.exec(
        "jj",
        ["log", "-r", taskBranchRevset, "-T", "change_id", "--no-graph", "--limit", "1"],
        {cwd: root},
    );
    if (hasTaskCommits.code !== 0) {
        ctx.ui.notify(`Failed to inspect task commits for ${name}: ${hasTaskCommits.stderr}`, "error");
        return false;
    }
    if (!hasTaskCommits.stdout.trim()) {
        ctx.ui.notify(`No non-empty task commits found to merge for ${name}`, "warning");
        return false;
    }

    // Default squash message to the description of the latest non-empty task commit.
    let defaultMessage = `Merge ${name}`;

    const descResult = await pi.exec(
        "jj",
        [
            "log",
            "-R",
            wsPath,
            "--ignore-working-copy",
            "-r",
            `change_id(${taskHeadChangeId})`,
            "-T",
            "description",
            "--no-graph",
            "--limit",
            "1",
        ],
        {cwd: root},
    );

    if (descResult.code === 0) {
        const desc = descResult.stdout.trimEnd();
        if (desc.trim().length > 0) {
            defaultMessage = desc;
        }
    }

    const messageInput = await ctx.ui.editor("Squash merge commit message:", defaultMessage);
    const message = resolveEditorPrefillValue(messageInput, defaultMessage);

    // Create a single squashed commit after @- containing all task changes.
    // `-A @-` also rebases children of @- (including @) onto the new squashed commit,
    // so we don't need a separate rebase step.
    ctx.ui.notify("squash-merge: creating squashed commit on main (insert-after @-)", "info");
    const squashResult = await pi.exec(
        "jj",
        ["squash", "-A", "@-", "-m", message, "--from", taskBranchRevset],
        {cwd: root},
    );
    if (squashResult.code !== 0) {
        ctx.ui.notify(`Squash merge failed: ${squashResult.stderr}`, "error");
        return false;
    }

    return true;
}

async function listWorkspaceNames(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext
): Promise<string[]> {
    const wsListResult = await pi.exec("jj", ["workspace", "list"]);
    if (wsListResult.code !== 0) {
        ctx.ui.notify("Failed to list workspaces", "error");
        return [];
    }

    return wsListResult.stdout
        .split("\n")
        .map((line) => line.replace(/:.*$/, "").trim())
        .filter((name) => name.length > 0);
}

async function getMainWorkspaceCommitId(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext
): Promise<string> {
    const result = await pi.exec("jj", [
        "log",
        "-r",
        "@-",
        "-T",
        "commit_id",
        "--no-graph",
        "--limit",
        "1",
    ]);
    if (result.code !== 0 || !result.stdout.trim()) {
        ctx.ui.notify("Failed to read main workspace head", "error");
        return "";
    }

    return result.stdout.trim();
}

async function workspaceHasUnmergedCommits(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    wsPath: string,
    mainCommitId: string
): Promise<boolean> {
    // Look for any non-empty commits in the task workspace that are not ancestors of the main head.
    // We inspect the whole ancestry of @ because @ itself is often an empty post-commit change.
    const revset = `::@ & ~ancestors(${mainCommitId}) & ~empty()`;
    const result = await pi.exec("jj", [
        "log",
        "-R",
        wsPath,
        "--ignore-working-copy",
        "-r",
        revset,
        "-T",
        "change_id",
        "--no-graph",
        "--limit",
        "1",
    ]);

    if (result.code !== 0) {
        ctx.ui.notify(`Failed to check workspace commits: ${wsPath}`, "error");
        return false;
    }

    return result.stdout.trim().length > 0;
}

async function listInProgressTickets(
    pi: ExtensionAPI,
    wsPath: string
): Promise<Array<{ id: string; parent?: string | null }>> {
    const tkResult = await tkQueryObjects(pi, wsPath, "select(.status == \"in_progress\")");
    if ("error" in tkResult) {
        return [];
    }

    return tkResult.items
        .map((item) => {
            if (!item || typeof item !== "object") return null;
            const id = typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : "";
            const parentValue = (item as { parent?: unknown }).parent;
            const parent = typeof parentValue === "string" && parentValue.trim() ? parentValue : null;
            return id ? {id, parent} : null;
        })
        .filter(Boolean) as Array<{ id: string; parent?: string | null }>;
}

async function listInProgressRootTaskIds(
    pi: ExtensionAPI,
    wsPath: string
): Promise<Set<string>> {
    const tickets = await listInProgressTickets(pi, wsPath);
    return new Set(tickets.filter((ticket) => !ticket.parent).map((ticket) => ticket.id));
}

async function listInProgressRootTaskIdsAcrossWorkspaces(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string
): Promise<Set<string>> {
    const workspaceNames = await listWorkspaceNames(pi, ctx);
    const repo = path.basename(root);
    const ids = new Set<string>();

    // Workspaces created by /task live under: ~/.workspaces/<workspace-name>/<repo>
    // We *also* persist the selected root ticket id in ~/.workspaces/<workspace-name>/.root-ticket-id.
    //
    // In practice, there are cases where the ticket itself is still "open" (e.g. someone created a
    // workspace but never ran `tk start`, or ticket state isn’t shared/updated the way we expect).
    // In those cases, filtering purely by `status == in_progress` misses the “already being worked on”
    // scenario. Reading the marker file makes this deterministic.
    const baseDir = path.join(os.homedir(), ".workspaces");

    for (const name of workspaceNames) {
        if (name === "default") {
            continue;
        }

        const taskDir = path.join(baseDir, name);
        const wsPath = path.join(taskDir, repo);
        if (!fs.existsSync(wsPath)) {
            continue;
        }

        // First: include any explicitly recorded root ticket id for this workspace.
        const rootTicketPath = path.join(taskDir, ".root-ticket-id");
        if (fs.existsSync(rootTicketPath)) {
            try {
                const markerId = fs.readFileSync(rootTicketPath, "utf-8").trim();
                if (markerId) {
                    ids.add(markerId);
                }
            } catch (err) {
                ctx.ui.notify(`Warning: failed to read ${rootTicketPath}: ${err}`, "warning");
            }
        }

        // Second: include any root tickets that are actually marked in_progress in this workspace.
        const workspaceIds = await listInProgressRootTaskIds(pi, wsPath);
        for (const id of workspaceIds) {
            ids.add(id);
        }
    }

    return ids;
}

function parseTkQueryObjects(output: string): unknown[] {
    const trimmed = output.trim();
    if (!trimmed) {
        return [];
    }

    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
            return parsed;
        }
        if (parsed && typeof parsed === "object") {
            return [parsed];
        }
    } catch {
        // Fall through to line-based parsing.
    }

    return trimmed
        .split("\n")
        .map((line) => {
            try {
                return JSON.parse(line) as unknown;
            } catch {
                return null;
            }
        })
        .filter((item) => item !== null);
}

type ReadyTicket = {
    id: string;
    status: string;
    title: string;
    deps: string[];
    created?: string;
};

async function listReadyTickets(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string
): Promise<ReadyTicket[] | null> {
    const tkResult = await tkQueryObjects(pi, root);
    if ("error" in tkResult) {
        ctx.ui.notify(`Failed to get ready tasks: ${tkResult.error}`, "error");
        return null;
    }

    const tickets = tkResult.items
        .map((item) => normalizeReadyTicket(item))
        .filter((item): item is ReadyTicket => Boolean(item));
    if (tickets.length === 0) {
        return [];
    }

    const statusById = new Map(tickets.map((ticket) => [ticket.id, ticket.status]));

    return tickets.filter((ticket) => {
        if (ticket.status !== "open" && ticket.status !== "in_progress") {
            return false;
        }
        if (ticket.deps.length === 0) {
            return true;
        }
        return ticket.deps.every((dep) => statusById.get(dep) === "closed");
    });
}

function normalizeReadyTicket(item: unknown): ReadyTicket | null {
    if (!item || typeof item !== "object") return null;
    const record = item as {
        id?: unknown;
        status?: unknown;
        title?: unknown;
        deps?: unknown;
        created?: unknown;
    };

    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) return null;
    const status = typeof record.status === "string" ? record.status.trim() : "";
    const titleValue = typeof record.title === "string" ? record.title.trim() : "";
    const deps = Array.isArray(record.deps)
        ? record.deps
            .filter((dep) => typeof dep === "string")
            .map((dep) => dep.trim())
            .filter((dep) => dep.length > 0)
        : [];
    const created = typeof record.created === "string" ? record.created.trim() : undefined;

    return {
        id,
        status,
        title: titleValue || id,
        deps,
        created,
    };
}

function parseCreatedTimestamp(created?: string): number {
    if (!created) return 0;
    const parsed = Date.parse(created);
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatReadyTicketLine(ticket: ReadyTicket): string {
    const paddedId = ticket.id.padEnd(8, " ");
    return `${paddedId} [${ticket.status}] - ${ticket.title}`;
}

async function loadTicketMarkdown(pi: ExtensionAPI, cwd: string, id: string): Promise<{ content: string } | {
    error: string
}> {
    const showResult = await tkShowTask(pi, cwd, id);
    if ("error" in showResult) {
        return {error: `Failed to read ticket ${id}: ${showResult.error}`};
    }
    return {content: showResult.content};
}

async function buildTicketContextMarkdownFromIds(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    cwd: string,
    pathIds: string[],
): Promise<string | null> {
    if (pathIds.length === 0) {
        ctx.ui.notify("Workflow active path is empty", "error");
        return null;
    }

    const chunks: string[] = [];
    for (const id of pathIds) {
        const load = await loadTicketMarkdown(pi, cwd, id);
        if ("error" in load) {
            ctx.ui.notify(load.error, "warning");
            return null;
        }
        chunks.push(load.content.trim());
    }

    return chunks.join("\n\n---\n\n");
}

async function applyTaskFrontmatter(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    frontmatter: Record<string, string>,
    sourcePath: string
): Promise<void> {
    const modelName = frontmatter.model;
    if (modelName) {
        const resolved = resolveModelPattern(modelName, ctx.modelRegistry.getAll());
        if (!resolved) {
            ctx.ui.notify(`Unknown model "${modelName}" in ${sourcePath}`, "error");
        } else {
            const success = await pi.setModel(resolved);
            if (!success) {
                ctx.ui.notify(`No API key available for model "${modelName}"`, "error");
            }
        }
    }

    const thinking = frontmatter.thinking;
    if (thinking) {
        const normalized = thinking.trim().toLowerCase();
        const allowed = new Set(["off", "minimal", "low", "medium", "high"]);
        if (!allowed.has(normalized)) {
            ctx.ui.notify(`Invalid thinking level "${thinking}" in ${sourcePath}`, "error");
        } else {
            pi.setThinkingLevel(normalized as "off" | "minimal" | "low" | "medium" | "high");
        }
    }
}

function resolveModelPattern(modelName: string, models: AvailableModel[]): AvailableModel | undefined {
    const normalized = modelName.trim();
    if (!normalized) return undefined;

    const slashIndex = normalized.indexOf("/");
    if (slashIndex !== -1) {
        const provider = normalized.slice(0, slashIndex).toLowerCase();
        const modelId = normalized.slice(slashIndex + 1).toLowerCase();
        const match = models.find(
            (model) => model.provider.toLowerCase() === provider && model.id.toLowerCase() === modelId,
        );
        if (match) return match;
    }

    const exact = models.find((model) => model.id.toLowerCase() === normalized.toLowerCase());
    if (exact) return exact;

    const matches = models.filter(
        (model) =>
            model.id.toLowerCase().includes(normalized.toLowerCase()) ||
            (model.name && model.name.toLowerCase().includes(normalized.toLowerCase())),
    );
    if (matches.length === 0) return undefined;

    const isAlias = (id: string) => id.endsWith("-latest") || !/-\d{8}$/.test(id);
    const aliases = matches.filter((model) => isAlias(model.id));
    if (aliases.length > 0) {
        return aliases.sort((a, b) => b.id.localeCompare(a.id))[0];
    }

    return matches.sort((a, b) => b.id.localeCompare(a.id))[0];
}

/**
 * Delete a task workspace (jj forget + rm directory)
 */
async function deleteTaskWorkspace(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string,
    name: string,
    wsPath: string
): Promise<boolean> {
    // Forget the workspace in jj
    const forgetResult = await pi.exec("jj", ["workspace", "forget", name]);
    if (forgetResult.code !== 0) {
        ctx.ui.notify(`Failed to forget workspace ${name}: ${forgetResult.stderr}`, "error");
        return false;
    }

    // Safety check: ensure wsPath is under ~/.workspaces/<task-id>/<repo>
    const repo = path.basename(root);
    const normalizedPath = stripPrivatePrefix(wsPath);
    const normalizedHome = stripPrivatePrefix(os.homedir());
    const base = path.join(normalizedHome, ".workspaces");
    const rel = path.relative(base, normalizedPath);
    const parts = rel.split(path.sep).filter(Boolean);

    if (rel.startsWith("..") || path.isAbsolute(rel) || parts.length !== 2 || parts[1] !== repo) {
        ctx.ui.notify(`Refusing to delete non-workspace path: ${wsPath}`, "error");
        return false;
    }

    // Delete the task ID directory (parent of wsPath)
    const taskIdDir = path.dirname(wsPath);
    if (fs.existsSync(taskIdDir)) {
        fs.rmSync(taskIdDir, {recursive: true, force: true});
    }

    return true;
}

/**
 * Select a task from `tk ready` and create a workspace for it
 */
async function selectAndStartTask(
    pi: ExtensionAPI,
    ctx: ExtensionCommandContext,
    root: string
): Promise<void> {
    const readyTickets = await listReadyTickets(pi, ctx, root);
    if (!readyTickets) {
        return;
    }

    const openReadyTickets = readyTickets.filter((ticket) => ticket.status === "open");
    if (openReadyTickets.length === 0) {
        ctx.ui.notify("No open tasks found. Create tickets with `tk create`", "info");
        return;
    }

    const inProgressTaskIds = await listInProgressRootTaskIdsAcrossWorkspaces(pi, ctx, root);

    const selectableTickets = openReadyTickets.filter((ticket) => !inProgressTaskIds.has(ticket.id));
    if (selectableTickets.length === 0) {
        ctx.ui.notify("No open tasks found. Create tickets with `tk create`", "info");
        return;
    }

    selectableTickets.sort((a, b) => {
        const aCreated = parseCreatedTimestamp(a.created);
        const bCreated = parseCreatedTimestamp(b.created);
        if (aCreated !== bCreated) {
            return bCreated - aCreated;
        }
        return a.id.localeCompare(b.id);
    });

    const readyLines = selectableTickets.map((ticket) => formatReadyTicketLine(ticket));

    // Let user select a task
    const selection = await ctx.ui.select("Select a task to start:", readyLines);
    if (!selection) {
        return;
    }

    // Parse the ticket ID and title from the selection (format: "tp-xxxx  [P2][open] - Title")
    const ticketId = selection.split(/\s+/)[0];
    if (!ticketId) {
        ctx.ui.notify("Failed to parse ticket ID", "error");
        return;
    }

    // Extract title from the selection line (after " - ")
    const titleMatch = selection.match(/ - (.+)$/);
    const ticketTitle = titleMatch ? titleMatch[1] : ticketId;

    // Create slug from title
    const slugDefault = slugify(ticketTitle);
    const slugInput = await ctx.ui.editor("Task slug:", slugDefault);
    const slug = resolveEditorPrefillValue(slugInput, slugDefault, {singleLine: true});

    // Create task ID with timestamp (needed for commit message)
    const taskId = `${formatTaskIdTimestamp(new Date())}-${slug}`;

    // Create workspace path
    const repo = path.basename(root);
    const wsPath = path.join(os.homedir(), ".workspaces", taskId, repo);

    // Create parent directory
    fs.mkdirSync(path.dirname(wsPath), {recursive: true});

    // Create jj workspace from the current working copy commit
    // (using @ instead of @- so that newly created tickets are included)
    const wsAddResult = await pi.exec("jj", [
        "workspace", "add",
        "--name", taskId,
        "-r", "@",
        wsPath,
    ]);

    if (wsAddResult.code !== 0) {
        ctx.ui.notify(`Failed to create workspace: ${wsAddResult.stderr}`, "error");
        return;
    }

    // Symlink .reference directory if it exists in the main workspace
    const referenceDir = path.join(root, ".reference");
    if (fs.existsSync(referenceDir)) {
        const targetLink = path.join(wsPath, ".reference");
        try {
            fs.symlinkSync(referenceDir, targetLink);
        } catch (err) {
            ctx.ui.notify(`Warning: Failed to symlink .reference: ${err}`, "warning");
        }
    }

    // Symlink .issues directory if it exists in the main workspace
    const issuesDir = path.join(root, ".issues");
    if (fs.existsSync(issuesDir)) {
        const targetLink = path.join(wsPath, ".issues");
        try {
            fs.symlinkSync(issuesDir, targetLink);
        } catch (err) {
            ctx.ui.notify(`Warning: Failed to symlink .issues: ${err}`, "warning");
        }
    }

    // Symlink sdks directory if it exists in the main workspace (often itself a symlink to ~/.sdks)
    const sdksDir = path.join(root, "sdks");
    if (fs.existsSync(sdksDir)) {
        const targetLink = path.join(wsPath, "sdks");
        try {
            fs.symlinkSync(sdksDir, targetLink);
        } catch (err) {
            ctx.ui.notify(`Warning: Failed to symlink sdks: ${err}`, "warning");
        }
    }

    // Set the ticket to in_progress in the task workspace
    const startResult = await tkStartTask(pi, wsPath, ticketId);
    if (startResult.ok === false) {
        ctx.ui.notify(`Failed to set ticket to in_progress: ${startResult.error}`, "error");
        return;
    }

    const initialWorkflow = createInitialWorkflow(
        ticketId,
        ticketTitle,
        UNBOUND_SESSION_LEAF_ID,
    );
    const savedWorkflow = saveWorkflowAtomic(wsPath, initialWorkflow);
    if (savedWorkflow.ok === false) {
        ctx.ui.notify(`Failed to initialize workflow file: ${savedWorkflow.error}`, "error");
        return;
    }
    ctx.ui.notify(`Initialized workflow file: ${getWorkflowPath(wsPath)}`, "info");

    // Persist root ticket id alongside the workspace (used for merge commit message defaults).
    try {
        fs.writeFileSync(path.join(path.dirname(wsPath), ".root-ticket-id"), `${ticketId}\n`, "utf-8");
    } catch (err) {
        ctx.ui.notify(`Warning: failed to write .root-ticket-id: ${err}`, "warning");
    }

    // Display success message
    ctx.ui.notify(`Task workspace created: ${wsPath}`, "info");

    // If we're in tmux, create a new window and run pi there
    if (process.env.TMUX) {
        await pi.exec("tmux", ["new-window", "-n", slug, "-c", wsPath]);
        await pi.exec("tmux", ["send-keys", "pi", "Enter"]);
        ctx.ui.notify(`Opened tmux window: ${slug}`, "info");
    } else {
        ctx.ui.notify(`Next: cd ${wsPath} && pi`, "info");
    }
}

/**
 * Check if we're in a task workspace (under ~/.workspaces/<task-id>/<repo-name>)
 */
function isTaskWorkspace(root: string): boolean {
    const repo = path.basename(root);
    const normalizedRoot = stripPrivatePrefix(path.resolve(root));
    const normalizedHome = stripPrivatePrefix(os.homedir());
    const base = path.join(normalizedHome, ".workspaces");
    const rel = path.relative(base, normalizedRoot);

    // If rel starts with ".." or is absolute, we're not under .workspaces
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return false;
    }

    // Check structure: should be <task-id>/<repo-name>
    const parts = rel.split(path.sep).filter(Boolean);
    return parts.length === 2 && parts[1] === repo;
}

/**
 * Strip /private prefix (macOS symlink resolution)
 */
function stripPrivatePrefix(value: string): string {
    if (value.startsWith("/private")) {
        return value.slice("/private".length) || "/";
    }
    return value;
}

/**
 * Create a URL-friendly slug from a title
 */
function slugify(title: string): string {
    let value = title.toLowerCase();
    value = value.replace(/[^a-z0-9]+/g, "-");
    value = value.replace(/^-+|-+$/g, "");
    value = value.replace(/-+/g, "-");
    return value || "task";
}

/**
 * Format a date as YYYYMMDD-HHMMSS for task IDs
 */
function formatTaskIdTimestamp(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());
    return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

interface TaskLoadResult {
    content: string;
    path: string;
    source: "project" | "user";
}

interface TaskLoadError {
    error: string;
    searched: string[];
}

function loadTask(
    name: string,
    cwd: string,
    agentDir: string
): TaskLoadResult | TaskLoadError {
    const filename = name.endsWith(".md") ? name : `${name}.md`;

    const locations = [
        {path: path.join(cwd, ".pi", "task", filename), source: "project" as const},
        {path: path.join(agentDir, "task", filename), source: "user" as const},
    ];

    const searched: string[] = [];

    for (const loc of locations) {
        searched.push(loc.path);
        if (fs.existsSync(loc.path)) {
            try {
                const content = fs.readFileSync(loc.path, "utf-8");
                return {content, path: loc.path, source: loc.source};
            } catch (e) {
                return {error: `Failed to read ${loc.path}: ${e}`, searched};
            }
        }
    }

    return {error: `Task "${name}" not found`, searched};
}
