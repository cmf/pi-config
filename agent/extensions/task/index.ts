/**
 * Task Extension - Deterministic task workflow for jj workspaces
 *
 * Provides /task command that detects workspace type:
 * - Main workspace: handles merge/cleanup of completed task workspaces, task selection
 * - Task workspace: handles active task work
 */

// State machine overview (canonical source: .tasks/workflow.json)
//
// Workflow states:
// refine -> plan -> review-plan -> implement -> review -> (implement-review)* -> subtask-commit
// -> manual-test -> commit -> complete

import type {ExtensionAPI, ExtensionCommandContext, ExtensionContext} from "@mariozechner/pi-coding-agent";
import {getAgentDir, parseFrontmatter} from "@mariozechner/pi-coding-agent";
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

enum WorkflowState {
    REFINE = "refine",
    PLAN = "plan",
    REVIEW_PLAN = "review-plan",
    IMPLEMENT = "implement",
    REVIEW = "review",
    IMPLEMENT_REVIEW = "implement-review",
    SUBTASK_COMMIT = "subtask-commit",
    MANUAL_TEST = "manual-test",
    COMMIT = "commit",
    COMPLETE = "complete",
}

type TaskNode = {
    task_id: string;
    title: string;
    subtasks: TaskNode[];
};

type Workflow = TaskNode & {
    schema_version: number;
    state: WorkflowState;
    active_task_id: string;
    active_path_ids: string[];
    session_leaf_id: string;
    version: number;
    updated_at: string;
    last_transition?: {
        event: string;
        from_state: WorkflowState;
        to_state: WorkflowState;
        from_active_task_id: string;
        to_active_task_id: string;
        at: string;
    };
};

type AvailableModel = ReturnType<ExtensionContext["modelRegistry"]["getAll"]>[number];

type ParsedAssistantOutput = {
    text: string | null;
    requestedState: WorkflowState | null;
    reviewFindings: PlanSubtask[] | null;
    commitMessage: string | null;
};

type WorkflowEvent =
    | {type: "assistant-turn"; parsed: ParsedAssistantOutput}
    | {type: "force-lgtm"}
    | {type: "manual-test-passed"};

type TransitionOutcome = {
    changed: boolean;
    shouldContinue: boolean;
    workflow: Workflow;
};

type AgentStartWaiter = {
    resolve: (started: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
};

let pendingAgentStart: AgentStartWaiter | null = null;

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

function isWorkflowState(value: string): value is WorkflowState {
    return Object.values(WorkflowState).includes(value as WorkflowState);
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

function cloneWorkflow(workflow: Workflow): Workflow {
    return {
        ...cloneTaskNode(workflow),
        schema_version: workflow.schema_version,
        state: workflow.state,
        active_task_id: workflow.active_task_id,
        active_path_ids: [...workflow.active_path_ids],
        session_leaf_id: workflow.session_leaf_id,
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

function isDepth0(pathIds: string[]): boolean {
    return pathIds.length === 1;
}

function isDepth1(pathIds: string[]): boolean {
    return pathIds.length === 2;
}

function isDepth2(pathIds: string[]): boolean {
    return pathIds.length === 3;
}

function stateAllowsDepth(state: WorkflowState, pathIds: string[]): boolean {
    if (
        state === WorkflowState.REFINE ||
        state === WorkflowState.PLAN ||
        state === WorkflowState.REVIEW_PLAN ||
        state === WorkflowState.MANUAL_TEST ||
        state === WorkflowState.COMMIT ||
        state === WorkflowState.COMPLETE
    ) {
        return isDepth0(pathIds);
    }

    if (state === WorkflowState.IMPLEMENT || state === WorkflowState.REVIEW || state === WorkflowState.SUBTASK_COMMIT) {
        return isDepth1(pathIds);
    }

    if (state === WorkflowState.IMPLEMENT_REVIEW) {
        return isDepth2(pathIds);
    }

    return false;
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

function validateWorkflow(workflow: Workflow): string | null {
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

    if (!stateAllowsDepth(workflow.state, workflow.active_path_ids)) {
        return `state ${workflow.state} is incompatible with active depth ${workflow.active_path_ids.length - 1}`;
    }

    return null;
}

function createInitialWorkflow(rootTaskId: string, rootTitle: string, sessionLeafId: string): Workflow {
    const normalizedTitle = rootTitle.trim() || rootTaskId;
    const now = new Date().toISOString();
    return {
        schema_version: WORKFLOW_SCHEMA_VERSION,
        task_id: rootTaskId,
        title: normalizedTitle,
        subtasks: [],
        state: WorkflowState.REFINE,
        active_task_id: rootTaskId,
        active_path_ids: [rootTaskId],
        session_leaf_id: sessionLeafId,
        version: 1,
        updated_at: now,
        last_transition: {
            event: "initialize",
            from_state: WorkflowState.REFINE,
            to_state: WorkflowState.REFINE,
            from_active_task_id: rootTaskId,
            to_active_task_id: rootTaskId,
            at: now,
        },
    };
}

function loadWorkflow(root: string): {workflow: Workflow} | {error: string} {
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

    const workflow = parsed as Workflow;
    const validationError = validateWorkflow(workflow);
    if (validationError) {
        return {
            error: `Invalid workflow schema/invariants in ${workflowPath}: ${validationError}. Manual cleanup required.`,
        };
    }

    return {workflow};
}

function saveWorkflowAtomic(root: string, workflow: Workflow): {ok: true} | {ok: false; error: string} {
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

function parseRequestedStateFromAssistantMessage(messageText: string): WorkflowState | null {
    // Prefer the LAST explicit transition tag in the message so earlier quoted/examples don't win.
    const explicitMatches = [...messageText.matchAll(/<transition>\s*([a-z-]+)\s*<\/transition>/gi)];
    for (let i = explicitMatches.length - 1; i >= 0; i--) {
        const raw = explicitMatches[i]?.[1];
        if (!raw) continue;
        const state = raw.trim().toLowerCase();
        if (isWorkflowState(state)) return state;
    }

    const tagValue = extractTaggedYamlBlock(messageText, "transition");
    if (tagValue) {
        const state = tagValue.trim().toLowerCase();
        if (isWorkflowState(state)) return state;
    }

    // Legacy fallback while prompts are migrated.
    if (/task-status\s+plan\b/i.test(messageText)) {
        return WorkflowState.PLAN;
    }
    if (/task-status\s+review-plan\b/i.test(messageText)) {
        return WorkflowState.REVIEW_PLAN;
    }

    return null;
}

function listTransitionTagsInMessage(messageText: string): string[] {
    return [...messageText.matchAll(/<transition>\s*([a-z-]+)\s*<\/transition>/gi)]
        .map((match) => (match[1] ?? "").trim().toLowerCase())
        .filter(Boolean);
}

function parseAssistantOutput(
    ctx: ExtensionContext,
    previousAssistantId: string | null,
    currentState: WorkflowState,
): {parsed: ParsedAssistantOutput} | {error: string} {
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
    const transitionTags = messageText ? listTransitionTagsInMessage(messageText) : [];
    const requestedState = messageText ? parseRequestedStateFromAssistantMessage(messageText) : null;

    let reviewFindings: PlanSubtask[] | null = null;
    if (currentState === WorkflowState.REVIEW) {
        const findingsParse = messageText ? parseReviewFindingsFromAssistantMessage(messageText) : null;
        if (findingsParse && "error" in findingsParse) {
            return {error: findingsParse.error};
        }
        reviewFindings = findingsParse && "findings" in findingsParse ? findingsParse.findings : null;
    } else if (ENABLE_TRANSITION_DEBUG && /<review-findings>/i.test(messageText)) {
        ctx.ui.notify(
            `transition-capture: ignoring <review-findings> block in state ${currentState}`,
            "warning",
        );
    }

    const commitMessage = messageText ? parseCommitMessageFromAssistantMessage(messageText) : null;

    if (ENABLE_TRANSITION_DEBUG) {
        const preview = messageText.replace(/\s+/g, " ").slice(0, 180);
        ctx.ui.notify(
            `transition-capture: previous=${previousAssistantId ?? "(none)"} latest=${latest.id ?? "(none)"} tags=[${transitionTags.join(", ") || "none"}] parsed=${requestedState ?? "none"} findings=${reviewFindings?.length ?? 0} commit=${commitMessage ? "yes" : "no"}`,
            "info",
        );
        ctx.ui.notify(`transition-capture: assistant-preview: ${preview}`, "info");
    }

    return {
        parsed: {
            text: messageText,
            requestedState,
            reviewFindings,
            commitMessage,
        },
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
        if (text.includes("## Ticket Metadata") && text.includes("## Workflow Transition Contract")) {
            continue;
        }

        return MANUAL_TEST_PASS_REGEX.test(text);
    }

    return false;
}

function buildTransitionedWorkflow(
    workflow: Workflow,
    params: {
        toState: WorkflowState;
        activeTaskId?: string;
        event: string;
        mutateTree?: (draft: Workflow) => void;
    },
): {workflow: Workflow} | {error: string} {
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

async function ensurePlanSubtasks(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    root: string,
    workflow: Workflow,
    subtasks: PlanSubtask[],
): Promise<{children: TaskNode[]} | {error: string}> {
    const existingByTitle = new Map(workflow.subtasks.map((node) => [node.title, node]));
    const children: TaskNode[] = [];

    for (const subtask of subtasks) {
        const existing = existingByTitle.get(subtask.title);
        if (existing) {
            children.push(cloneTaskNode(existing));
            continue;
        }

        const created = await createOrReuseChildTask(pi, root, workflow.task_id, subtask.title, subtask.description);
        if ("error" in created) {
            return created;
        }

        ctx.ui.notify(`review-plan: created/reused subtask ${created.id} (${subtask.title})`, "info");
        children.push({
            task_id: created.id,
            title: subtask.title,
            subtasks: [],
        });
    }

    return {children};
}

async function ensureReviewFindingTasks(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    root: string,
    workflow: Workflow,
    findings: PlanSubtask[],
): Promise<{children: TaskNode[]} | {error: string}> {
    const activeSubtask = findNodeById(workflow, workflow.active_task_id);
    if (!activeSubtask) {
        return {error: `Active subtask not found: ${workflow.active_task_id}`};
    }

    const existingByTitle = new Map(activeSubtask.subtasks.map((node) => [node.title, node]));
    const children: TaskNode[] = [];

    for (const finding of findings) {
        const existing = existingByTitle.get(finding.title);
        if (existing) {
            children.push(cloneTaskNode(existing));
            continue;
        }

        const created = await createOrReuseChildTask(pi, root, activeSubtask.task_id, finding.title, finding.description);
        if ("error" in created) {
            return created;
        }

        ctx.ui.notify(`review: created/reused finding ${created.id} (${finding.title})`, "info");
        children.push({
            task_id: created.id,
            title: finding.title,
            subtasks: [],
        });
    }

    return {children};
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

async function loadPlanSubtasksFromRootTicket(
    pi: ExtensionAPI,
    root: string,
    workflow: Workflow,
): Promise<{subtasks: PlanSubtask[]} | {error: string}> {
    const load = await loadTicketMarkdown(pi, root, workflow.task_id);
    if ("error" in load) {
        return load;
    }

    const parsed = parsePlanSubtasksFromTicketMarkdown(load.content);
    if ("error" in parsed) {
        return parsed;
    }

    if (parsed.subtasks.length === 0) {
        return {error: "No subtasks found in root ticket plan."};
    }

    return parsed;
}

function notifyTransition(ctx: ExtensionContext, before: Workflow, after: Workflow): void {
    const from = `${before.state}/${before.active_task_id}`;
    const to = `${after.state}/${after.active_task_id}`;
    const versionInfo = `v${before.version}→v${after.version}`;
    ctx.ui.notify(`workflow transition ${versionInfo}: ${from} -> ${to}`, "info");
}

async function dispatchWorkflowEvent(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    root: string,
    workflow: Workflow,
    event: WorkflowEvent,
): Promise<TransitionOutcome | {error: string}> {
    const transitionError = (message: string): {error: string} => ({
        error: `${message}. Manual cleanup required in ${getWorkflowPath(root)}.`,
    });

    const beforeError = validateWorkflow(workflow);
    if (beforeError) {
        return transitionError(`Workflow invariant failure before transition: ${beforeError}.`);
    }

    const saveTransition = (nextWorkflow: Workflow, shouldContinue: boolean): TransitionOutcome | {error: string} => {
        const saved = saveWorkflowAtomic(root, nextWorkflow);
        if (saved.ok === false) {
            return {error: saved.error};
        }

        notifyTransition(ctx, workflow, nextWorkflow);
        return {
            changed: true,
            shouldContinue,
            workflow: nextWorkflow,
        };
    };

    if (event.type === "manual-test-passed") {
        if (workflow.state !== WorkflowState.MANUAL_TEST) {
            return {changed: false, shouldContinue: false, workflow};
        }

        const transitioned = buildTransitionedWorkflow(workflow, {
            toState: WorkflowState.COMMIT,
            activeTaskId: workflow.task_id,
            event: "manual-test-passed",
        });
        if ("error" in transitioned) return transitionError(transitioned.error);
        return saveTransition(transitioned.workflow, true);
    }

    const isForceLgtm = event.type === "force-lgtm";
    const parsed = event.type === "assistant-turn"
        ? event.parsed
        : {
            text: null,
            requestedState: null,
            reviewFindings: null,
            commitMessage: null,
        };

    if (workflow.state === WorkflowState.REFINE) {
        if (parsed.requestedState !== WorkflowState.PLAN) {
            if (parsed.text && /<transition>/i.test(parsed.text)) {
                ctx.ui.notify("refine: saw <transition> tag but could not parse a valid target state", "warning");
            }
            return {changed: false, shouldContinue: false, workflow};
        }

        const transitioned = buildTransitionedWorkflow(workflow, {
            toState: WorkflowState.PLAN,
            activeTaskId: workflow.task_id,
            event: "refine-complete",
        });
        if ("error" in transitioned) return transitionError(transitioned.error);
        return saveTransition(transitioned.workflow, true);
    }

    if (workflow.state === WorkflowState.PLAN) {
        const requestedReviewPlan = parsed.requestedState === WorkflowState.REVIEW_PLAN;
        if (!requestedReviewPlan) {
            return {changed: false, shouldContinue: false, workflow};
        }

        const plan = await loadPlanSubtasksFromRootTicket(pi, root, workflow);
        if ("error" in plan) {
            return {error: `plan -> review-plan failed: ${plan.error}`};
        }

        const transitioned = buildTransitionedWorkflow(workflow, {
            toState: WorkflowState.REVIEW_PLAN,
            activeTaskId: workflow.task_id,
            event: "plan-complete",
        });
        if ("error" in transitioned) return transitionError(transitioned.error);
        return saveTransition(transitioned.workflow, true);
    }

    if (workflow.state === WorkflowState.REVIEW_PLAN) {
        if (!isForceLgtm && parsed.requestedState === WorkflowState.REVIEW_PLAN) {
            const plan = await loadPlanSubtasksFromRootTicket(pi, root, workflow);
            if ("error" in plan) {
                return {error: `review-plan re-review failed: ${plan.error}`};
            }

            const transitioned = buildTransitionedWorkflow(workflow, {
                toState: WorkflowState.REVIEW_PLAN,
                activeTaskId: workflow.task_id,
                event: "review-plan-rereview-transition",
            });
            if ("error" in transitioned) return transitionError(transitioned.error);
            return saveTransition(transitioned.workflow, true);
        }

        if (!isForceLgtm && parsed.requestedState !== WorkflowState.IMPLEMENT) {
            ctx.ui.notify("review-plan: waiting for <transition>implement</transition> (approve) or <transition>review-plan</transition> (re-review)", "warning");
            return {changed: false, shouldContinue: false, workflow};
        }

        const plan = await loadPlanSubtasksFromRootTicket(pi, root, workflow);
        if ("error" in plan) {
            return {error: `review-plan approval failed: ${plan.error}`};
        }

        const ensured = await ensurePlanSubtasks(pi, ctx, root, workflow, plan.subtasks);
        if ("error" in ensured) {
            return {error: ensured.error};
        }

        if (ensured.children.length === 0) {
            return {error: "review-plan approval produced zero subtasks"};
        }

        const transitioned = buildTransitionedWorkflow(workflow, {
            toState: WorkflowState.IMPLEMENT,
            activeTaskId: ensured.children[0].task_id,
            event: isForceLgtm ? "force-lgtm-review-plan" : "review-plan-approve-transition",
            mutateTree: (draft) => {
                draft.subtasks = ensured.children;
            },
        });
        if ("error" in transitioned) return transitionError(transitioned.error);
        return saveTransition(transitioned.workflow, true);
    }

    if (workflow.state === WorkflowState.IMPLEMENT) {
        const transitioned = buildTransitionedWorkflow(workflow, {
            toState: WorkflowState.REVIEW,
            event: "implement-done",
        });
        if ("error" in transitioned) return transitionError(transitioned.error);
        return saveTransition(transitioned.workflow, true);
    }

    if (workflow.state === WorkflowState.REVIEW) {
        if (isForceLgtm || parsed.requestedState === WorkflowState.SUBTASK_COMMIT) {
            const transitioned = buildTransitionedWorkflow(workflow, {
                toState: WorkflowState.SUBTASK_COMMIT,
                event: isForceLgtm ? "force-lgtm-review" : "review-approve-transition",
            });
            if ("error" in transitioned) return transitionError(transitioned.error);
            return saveTransition(transitioned.workflow, true);
        }

        if (parsed.reviewFindings && parsed.reviewFindings.length > 0) {
            if (parsed.requestedState !== WorkflowState.IMPLEMENT_REVIEW) {
                ctx.ui.notify("review: findings present; expected <transition>implement-review</transition>", "warning");
                return {changed: false, shouldContinue: false, workflow};
            }

            const ensured = await ensureReviewFindingTasks(pi, ctx, root, workflow, parsed.reviewFindings);
            if ("error" in ensured) {
                return {error: ensured.error};
            }

            const transitioned = buildTransitionedWorkflow(workflow, {
                toState: WorkflowState.IMPLEMENT_REVIEW,
                activeTaskId: ensured.children[0].task_id,
                event: "review-findings-transition",
                mutateTree: (draft) => {
                    const activeNode = findNodeById(draft, workflow.active_task_id);
                    if (!activeNode) {
                        throw new Error(`active node missing while applying review findings: ${workflow.active_task_id}`);
                    }
                    activeNode.subtasks = ensured.children;
                },
            });
            if ("error" in transitioned) return transitionError(transitioned.error);
            return saveTransition(transitioned.workflow, true);
        }

        if (parsed.requestedState === WorkflowState.IMPLEMENT_REVIEW) {
            ctx.ui.notify("review: got <transition>implement-review</transition> but no <review-findings> block", "warning");
            return {changed: false, shouldContinue: false, workflow};
        }

        ctx.ui.notify("review: waiting for <transition>subtask-commit</transition> or findings + <transition>implement-review</transition>", "warning");
        return {changed: false, shouldContinue: false, workflow};
    }

    if (workflow.state === WorkflowState.IMPLEMENT_REVIEW) {
        const activeFinding = findNodeById(workflow, workflow.active_task_id);
        if (!activeFinding) {
            return transitionError(`Active finding not found: ${workflow.active_task_id}`);
        }

        const closeFinding = await tkCloseTask(pi, root, activeFinding.task_id);
        if (closeFinding.ok === false) {
            return {error: `Failed to close review finding ${activeFinding.task_id}: ${closeFinding.error}`};
        }

        const sibling = nextSibling(workflow, activeFinding.task_id);
        if (sibling) {
            const transitioned = buildTransitionedWorkflow(workflow, {
                toState: WorkflowState.IMPLEMENT_REVIEW,
                activeTaskId: sibling.task_id,
                event: "implement-review-next-finding",
            });
            if ("error" in transitioned) return transitionError(transitioned.error);
            return saveTransition(transitioned.workflow, true);
        }

        const parent = findParentById(workflow, activeFinding.task_id);
        if (!parent) {
            return transitionError(`Parent subtask not found for finding ${activeFinding.task_id}`);
        }

        const transitioned = buildTransitionedWorkflow(workflow, {
            toState: WorkflowState.REVIEW,
            activeTaskId: parent.task_id,
            event: "implement-review-back-to-review",
        });
        if ("error" in transitioned) return transitionError(transitioned.error);
        return saveTransition(transitioned.workflow, true);
    }

    if (workflow.state === WorkflowState.SUBTASK_COMMIT) {
        if (!parsed.commitMessage) {
            ctx.ui.notify("subtask-commit: waiting for <commit-message>...</commit-message>", "warning");
            return {changed: false, shouldContinue: false, workflow};
        }

        const activeSubtask = findNodeById(workflow, workflow.active_task_id);
        if (!activeSubtask) {
            return transitionError(`Active subtask not found: ${workflow.active_task_id}`);
        }

        const commitSubject = parsed.commitMessage.split("\n")[0]?.trim() || "(empty subject)";
        ctx.ui.notify(`subtask-commit: commit message detected: ${commitSubject}`, "info");
        ctx.ui.notify(`subtask-commit: closing task ${activeSubtask.task_id}`, "info");

        const closeSubtask = await tkCloseTask(pi, root, activeSubtask.task_id);
        if (closeSubtask.ok === false) {
            return {error: `Failed to close subtask ${activeSubtask.task_id}: ${closeSubtask.error}`};
        }

        ctx.ui.notify("subtask-commit: running jj commit", "info");
        const committed = await runJjCommitWithCleanCheck(pi, root, parsed.commitMessage);
        if (committed.ok === false) {
            return {error: committed.error};
        }
        ctx.ui.notify(`subtask-commit: committed successfully (${commitSubject})`, "info");

        const sibling = nextSibling(workflow, activeSubtask.task_id);
        if (sibling) {
            const transitioned = buildTransitionedWorkflow(workflow, {
                toState: WorkflowState.IMPLEMENT,
                activeTaskId: sibling.task_id,
                event: "subtask-commit-next-subtask",
            });
            if ("error" in transitioned) return transitionError(transitioned.error);
            return saveTransition(transitioned.workflow, true);
        }

        const transitioned = buildTransitionedWorkflow(workflow, {
            toState: WorkflowState.MANUAL_TEST,
            activeTaskId: workflow.task_id,
            event: "subtask-commit-enter-manual-test",
        });
        if ("error" in transitioned) return transitionError(transitioned.error);
        return saveTransition(transitioned.workflow, true);
    }

    if (workflow.state === WorkflowState.MANUAL_TEST) {
        return {changed: false, shouldContinue: false, workflow};
    }

    if (workflow.state === WorkflowState.COMMIT) {
        if (!parsed.commitMessage) {
            ctx.ui.notify("commit: waiting for <commit-message>...</commit-message>", "warning");
            return {changed: false, shouldContinue: false, workflow};
        }

        const commitSubject = parsed.commitMessage.split("\n")[0]?.trim() || "(empty subject)";
        ctx.ui.notify(`commit: final commit message detected: ${commitSubject}`, "info");
        ctx.ui.notify(`commit: closing root task ${workflow.task_id}`, "info");

        const closeRoot = await tkCloseTask(pi, root, workflow.task_id);
        if (closeRoot.ok === false) {
            return {error: `Failed to close root task ${workflow.task_id}: ${closeRoot.error}`};
        }

        ctx.ui.notify("commit: running final jj commit", "info");
        const committed = await runJjCommitWithCleanCheck(pi, root, parsed.commitMessage);
        if (committed.ok === false) {
            return {error: committed.error};
        }
        ctx.ui.notify(`commit: final commit succeeded (${commitSubject})`, "info");

        const transitioned = buildTransitionedWorkflow(workflow, {
            toState: WorkflowState.COMPLETE,
            activeTaskId: workflow.task_id,
            event: "commit-complete",
        });
        if ("error" in transitioned) return transitionError(transitioned.error);
        return saveTransition(transitioned.workflow, false);
    }

    return {changed: false, shouldContinue: false, workflow};
}

function clearTaskUi(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("task", undefined);
}

async function updateTaskUiDisplay(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    workflow: Workflow,
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

export default function (pi: ExtensionAPI) {
    pi.on("agent_start", () => {
        resolveNextAgentStart();
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

                await runTaskWorkspace(pi, ctx, root);
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
 * Supported states:
 * - review-plan
 * - review
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
    if (workflow.state !== WorkflowState.REVIEW_PLAN && workflow.state !== WorkflowState.REVIEW) {
        ctx.ui.notify(
            `/task lgtm is only supported in review-plan or review (current: ${workflow.state}).`,
            "error",
        );
        return false;
    }

    const noteMessage = workflow.state === WorkflowState.REVIEW_PLAN
        ? "Forced LGTM via /task lgtm (skipping plan review findings)."
        : "Forced LGTM via /task lgtm (skipping review findings).";

    // Best effort note.
    await tkAddNoteBestEffort(pi, root, workflow.active_task_id, noteMessage);

    const result = await dispatchWorkflowEvent(pi, ctx, root, workflow, {type: "force-lgtm"});
    if ("error" in result) {
        ctx.ui.notify(result.error, "error");
        return false;
    }

    if (!result.changed) {
        ctx.ui.notify(`No workflow transition applied by /task lgtm from ${workflow.state}.`, "warning");
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

function getLastAssistantMessageText(ctx: ExtensionContext): string | null {
    const last = getLastAssistantMessage(ctx);
    return last ? last.text : null;
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
            && workflow.state === WorkflowState.REFINE
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

        await updateTaskUiDisplay(pi, ctx, workflow);

        if (workflow.state === WorkflowState.COMPLETE) {
            ctx.ui.notify("Workflow already complete. Workspace is ready to merge.", "info");
            return;
        }

        if (workflow.state === WorkflowState.MANUAL_TEST && userConfirmedManualTests(ctx)) {
            const manualGate = await dispatchWorkflowEvent(pi, ctx, root, workflow, {type: "manual-test-passed"});
            if ("error" in manualGate) {
                ctx.ui.notify(manualGate.error, "error");
                return;
            }
            if (manualGate.changed) {
                if (manualGate.shouldContinue) {
                    continue;
                }
                return;
            }
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
            "## Workflow Transition Contract",
            "- The workflow state is managed ONLY by .tasks/workflow.json.",
            "- Do NOT run `tk header ... task-status ...`.",
            "- To move refine -> plan, emit: <transition>plan</transition>",
            "- To move plan -> review-plan, emit: <transition>review-plan</transition>",
            "- In review-plan emit one of:",
            "  - <transition>implement</transition>   (approve and start implementation)",
            "  - <transition>review-plan</transition> (request another review pass)",
            "- In review, emit one of:",
            "  - <transition>subtask-commit</transition>  (approve)",
            "  - <review-findings>...</review-findings> + <transition>implement-review</transition>",
            `- To pass manual test gate, user must explicitly confirm: ${MANUAL_TEST_PASS_PHRASE} (also accepts: MANUAL TEST PASSED)`,
            "- Keep using these blocks when appropriate:",
            "  - <subtasks>...</subtasks>",
            "  - <review-findings>...</review-findings>",
            "  - <commit-message>...</commit-message>",
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

        const parsed = parseAssistantOutput(ctx, previousAssistantId, workflow.state);
        if ("error" in parsed) {
            ctx.ui.notify(parsed.error, "error");
            return;
        }

        const transition = await dispatchWorkflowEvent(
            pi,
            ctx,
            root,
            workflow,
            {
                type: "assistant-turn",
                parsed: parsed.parsed,
            },
        );

        if ("error" in transition) {
            ctx.ui.notify(transition.error, "error");
            return;
        }

        if (ENABLE_TRANSITION_DEBUG) {
            ctx.ui.notify(
                `transition-capture: dispatch result changed=${transition.changed ? "yes" : "no"} continue=${transition.shouldContinue ? "yes" : "no"}`,
                "info",
            );
        }

        if (!transition.shouldContinue) {
            if (workflow.state === WorkflowState.MANUAL_TEST) {
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

    const message = (await ctx.ui.input("Squash merge commit message:", defaultMessage)) || defaultMessage;

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

function parseTicketIdFromReadyLine(line: string): string {
    const match = line.match(/\b([a-z]+-[a-z0-9]+)\b/);
    return match ? match[1] : "";
}

type PlanSubtask = {
    title: string;
    description: string;
    tdd: boolean;
};

function normalizeNewlines(value: string): string {
    return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Extract the YAML payload inside a `<subtasks>...</subtasks>` block under the first `## Plan` header.
 *
 * We intentionally don't rely on markdown code fences here because subtask descriptions may contain
 * nested code blocks.
 */
function extractYamlPlanBlock(ticketMarkdown: string): string | null {
    const normalized = normalizeNewlines(ticketMarkdown);

    const planHeaderMatch = /^## Plan\s*$/m.exec(normalized);
    if (!planHeaderMatch) {
        return null;
    }

    const afterPlanHeader = normalized.slice(planHeaderMatch.index + planHeaderMatch[0].length);

    // Prefer tag-on-its-own-line parsing (more robust w/ YAML content)
    const startMatch = /^\s*<subtasks>\s*$/m.exec(afterPlanHeader);
    if (startMatch) {
        const afterStartLine = afterPlanHeader.slice(startMatch.index + startMatch[0].length);
        const firstNewline = afterStartLine.indexOf("\n");
        const body = firstNewline === -1 ? "" : afterStartLine.slice(firstNewline + 1);

        const endMatch = /^\s*<\/subtasks>\s*$/m.exec(body);
        if (!endMatch) {
            return null;
        }
        return body.slice(0, endMatch.index).trim();
    }

    // Fallback: allow inline tags (e.g. <subtasks>...yaml...</subtasks>)
    const startIdx = afterPlanHeader.indexOf("<subtasks>");
    if (startIdx === -1) return null;
    const endIdx = afterPlanHeader.indexOf("</subtasks>", startIdx + "<subtasks>".length);
    if (endIdx === -1) return null;
    return afterPlanHeader.slice(startIdx + "<subtasks>".length, endIdx).trim();
}

function parseYamlDocument(yamlString: string): unknown {
    const wrapped = `---\n${yamlString}\n---`;
    return parseFrontmatter(wrapped).frontmatter as unknown;
}

/**
 * Parse the plan subtasks YAML from a ticket markdown file.
 *
 * Expected format (see agent/task/plan.md):
 *
 * ## Plan
 * <subtasks>
 * - title: "..."
 *   description: |
 *     ...
 *   tdd: false
 * </subtasks>
 */
function parsePlanSubtasksFromTicketMarkdown(
    ticketMarkdown: string,
): { subtasks: PlanSubtask[] } | { error: string } {
    const yamlString = extractYamlPlanBlock(ticketMarkdown);
    if (!yamlString) {
        return {error: "Could not find a `## Plan` section with a <subtasks>...</subtasks> block."};
    }

    return parseYamlTicketList(yamlString, "Subtask");
}

function extractTaggedYamlBlock(text: string, tagName: string): string | null {
    const normalized = normalizeNewlines(text);

    // Prefer tag-on-its-own-line parsing.
    const startMatch = new RegExp(`^\\s*<${tagName}>\\s*$`, "m").exec(normalized);
    if (startMatch) {
        const afterStart = normalized.slice(startMatch.index + startMatch[0].length);
        const firstNewline = afterStart.indexOf("\n");
        const body = firstNewline === -1 ? "" : afterStart.slice(firstNewline + 1);

        const endMatch = new RegExp(`^\\s*</${tagName}>\\s*$`, "m").exec(body);
        if (!endMatch) return null;
        return body.slice(0, endMatch.index).trim();
    }

    // Fallback: allow inline tags.
    const startIdx = normalized.indexOf(`<${tagName}>`);
    if (startIdx === -1) return null;
    const endIdx = normalized.indexOf(`</${tagName}>`, startIdx + tagName.length + 2);
    if (endIdx === -1) return null;
    return normalized.slice(startIdx + tagName.length + 2, endIdx).trim();
}

function parseYamlTicketList(
    yamlString: string,
    label: string,
): { subtasks: PlanSubtask[] } | { error: string } {
    let parsed: unknown;
    try {
        parsed = parseYamlDocument(yamlString);
    } catch (e) {
        return {error: `Failed to parse ${label} YAML block: ${e}`};
    }

    if (!parsed) {
        return {subtasks: []};
    }

    if (!Array.isArray(parsed)) {
        return {error: `${label} YAML block must be a list (a YAML sequence).`};
    }

    const subtasks: PlanSubtask[] = [];
    for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        if (!item || typeof item !== "object") {
            return {error: `${label} ${i + 1} is not an object.`};
        }

        const title = typeof (item as { title?: unknown }).title === "string" ? (item as {
            title: string
        }).title.trim() : "";
        const description =
            typeof (item as { description?: unknown }).description === "string"
                ? (item as { description: string }).description
                : "";
        const tddValue = (item as { tdd?: unknown }).tdd;
        const tdd = typeof tddValue === "boolean" ? tddValue : true;

        if (!title) {
            return {error: `${label} ${i + 1} is missing a non-empty string 'title'.`};
        }

        subtasks.push({title, description, tdd});
    }

    return {subtasks};
}

function parseReviewFindingsFromAssistantMessage(
    messageText: string,
): { findings: PlanSubtask[] } | { error: string } | null {
    const yamlString = extractTaggedYamlBlock(messageText, "review-findings");
    if (!yamlString) return null;

    const parsed = parseYamlTicketList(yamlString, "Finding");
    if ("error" in parsed) return parsed;
    return {findings: parsed.subtasks};
}

function parseCommitMessageFromAssistantMessage(messageText: string): string | null {
    const raw = extractTaggedYamlBlock(messageText, "commit-message");
    if (!raw) return null;

    // Preserve multi-line messages (subject + body). Trim outer whitespace only.
    const normalized = normalizeNewlines(raw).trim();
    return normalized.length > 0 ? normalized : null;
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
    const slug = await ctx.ui.input(`Task slug (default: ${slugDefault}):`, slugDefault) || slugDefault;

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
