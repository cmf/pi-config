/**
 * Task Extension - Deterministic task workflow for jj workspaces
 *
 * Provides /task command that detects workspace type:
 * - Main workspace: handles merge/cleanup of completed task workspaces, task selection
 * - Task workspace: handles active task work
 */

// Overall ticket states
//
// refine - refine a simple task heading into a full description of the problem
//   - transition: agent is prompted to change task status to `plan` when done
//      - maybeAutoAdvanceTask sees `plan` status and restarts task processing
// plan - create a detailed implementation plan from the problem description
//   - transition: agent is prompted to change task status to `review-plan` when done
//      - maybeAutoAdvanceTask sees `review-plan` status and restarts task processing
// review-plan -
//   - transition: when review is complete, agent is prompted to return "LGTM"
//      - maybeAutoAdvanceTask sees `review-plan` status and "LGTM" in response
//      - writes out subtasks as child tickets, and sets task status to `implement-plan`
//   - otherwise no transition, so user can interact with review process

// Per-subtask states
// implement - agent implements subtask

import type {AgentEndEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext} from "@mariozechner/pi-coding-agent";
import {getAgentDir, parseFrontmatter} from "@mariozechner/pi-coding-agent";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event, ctx) => {
		// If the agent ended with an error/abort, don't auto-advance tasks (prevents loops).
		if (agentEndLooksLikeError(event)) {
			return;
		}
		await maybeAutoAdvanceTask(pi, ctx);
	});

	pi.registerCommand("task", {
		description: "Run the deterministic task workflow",
		handler: async (_args, ctx) => {
			// Check required commands
			for (const cmd of ["jj", "tk", "jq"]) {
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
				await runTaskWorkspace(pi, ctx, root);
			} else {
				await runMainWorkspace(pi, ctx, root);
			}
		},
	});
}

function agentEndLooksLikeError(event: AgentEndEvent): boolean {
	const msgs = event.messages;
	if (!Array.isArray(msgs) || msgs.length === 0) return false;

	const last = msgs[msgs.length - 1] as unknown;
	if (!last || typeof last !== "object") return false;

	const role = (last as { role?: unknown }).role;
	if (role === "assistant") {
		const stopReason = (last as { stopReason?: unknown }).stopReason;
		const errorMessage = (last as { errorMessage?: unknown }).errorMessage;
		return stopReason === "error" || stopReason === "aborted" || typeof errorMessage === "string";
	}

	if (role === "toolResult") {
		return (last as { isError?: unknown }).isError === true;
	}

	return false;
}

async function maybeAutoAdvanceTask(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const jjRootResult = await pi.exec("jj", ["root"], { cwd: ctx.cwd });
	if (jjRootResult.code !== 0) {
		return;
	}

	const root = jjRootResult.stdout.trim();
	if (!root || !isTaskWorkspace(root)) {
		return;
	}

	const agentDir = getAgentDir();
	const tkCurrentPath = path.join(agentDir, "skills", "tickets", "tk-current");
	if (!fs.existsSync(tkCurrentPath)) {
		return;
	}

	const currentResult = await pi.exec(tkCurrentPath, [], { cwd: root });
	if (currentResult.code !== 0) {
		return;
	}

	const ticketPath = currentResult.stdout.trim();
	if (!ticketPath) {
		return;
	}

	const ticketId = path.basename(ticketPath).replace(/\.md$/, "");
	if (!ticketId) {
		return;
	}

	const statusResult = await pi.exec("tk", ["header", ticketId, "task-status"], { cwd: root });
	if (statusResult.code !== 0) {
		return;
	}

	const status = statusResult.stdout.trim();
	const lastAssistantMessage = getLastAssistantMessageText(ctx);

	if (status === "review-plan" && lastAssistantMessage?.includes("LGTM")) {
		await writePlanTickets(ctx, ticketPath, pi, ticketId, root);
		const updated = await setTaskHeader(pi, ctx, root, ticketId, "task-status", "implement-plan");
		if (!updated) {
			return;
		}
		pi.sendUserMessage("/task");
	} else if (status === "plan" || status === "review-plan") {
		pi.sendUserMessage("/task");
	}
}

async function writePlanTickets(ctx, ticketPath: string, pi, ticketId, root: string) {
	ctx.ui.notify(`Writing plan subtasks as child tickets`, "info");

	let ticketMarkdown: string;
	try {
		ticketMarkdown = fs.readFileSync(ticketPath, "utf-8");
	} catch (e) {
		ctx.ui.notify(`Failed to read ticket file ${ticketPath}: ${e}`, "error");
		return;
	}

	const parsed = parsePlanSubtasksFromTicketMarkdown(ticketMarkdown);
	if ("error" in parsed) {
		ctx.ui.notify(parsed.error, "error");
		return;
	}

	if (parsed.subtasks.length === 0) {
		ctx.ui.notify("No subtasks found in plan (<subtasks> block was empty)", "error");
		return;
	}

	var firstChild: boolean = true;
	const created: string[] = [];
	for (const subtask of parsed.subtasks) {
		const createResult = await pi.exec(
			"tk",
			["create", subtask.title, "-d", subtask.description, "--parent", ticketId],
			{cwd: root},
		);
		if (createResult.code !== 0) {
			ctx.ui.notify(`Failed to create subtask ticket "${subtask.title}": ${createResult.stderr}`, "error");
			return;
		}

		const newId = createResult.stdout.trim();
		if (!newId) {
			ctx.ui.notify(`tk create did not return a ticket id for "${subtask.title}"`, "error");
			return;
		}

		created.push(newId);

		const headerResult = await pi.exec("tk", ["header", newId, "task-status", "implement"], {cwd: root});
		if (headerResult.code !== 0) {
			ctx.ui.notify(`Failed to set task-status=implement for ${newId}: ${headerResult.stderr}`, "error");
			return;
		}

		if (firstChild) {
			const startResult = await pi.exec("tk", ["start", newId], {cwd: root});
			if (startResult.code !== 0) {
				ctx.ui.notify(`Failed to start ${newId}: ${startResult.stderr}`, "error");
				return;
			}
		}
		firstChild = false;
	}

	ctx.ui.notify(`Created ${created.length} child tickets: ${created.join(", ")}`, "success");
	return;
}

function getLastAssistantMessageText(ctx: ExtensionContext): string | null {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };
		if (message.role !== "assistant") continue;
		return extractMessageText(message.content);
	}
	return null;
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && "text" in part) {
					return String((part as { text?: unknown }).text ?? "");
				}
				return "";
			})
			.join("");
	}
	return "";
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
	// Loop: merge completed workspaces
	while (await maybeMergeCompletedWorkspace(pi, ctx, root)) {
		// Continue merging until none left or user skips
	}

	// Select and start a new task
	await selectAndStartTask(pi, ctx, root);
}

/**
 * Task workspace flow
 */
async function runTaskWorkspace(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	root: string
): Promise<void> {
	const leafId = ctx.sessionManager.getLeafId();
	if (!leafId) {
		ctx.ui.notify("No session leaf ID available", "error");
		return;
	}

	const currentTask = await resolveCurrentTaskId(pi, ctx, root);
	if (!currentTask) {
		return;
	}

	const taskStatus = await getTaskHeader(pi, ctx, root, currentTask, "task-status");
	if (taskStatus === undefined) {
		return;
	}
	if (!taskStatus) {
		const setStatus = await setTaskHeader(pi, ctx, root, currentTask, "task-status", "refine");
		if (!setStatus) return;
		const setLeaf = await setTaskHeader(pi, ctx, root, currentTask, "task-leaf-id", leafId);
		if (!setLeaf) return;
	}

	const effectiveStatus = taskStatus || "refine";
	const taskLeafId = await getTaskHeader(pi, ctx, root, currentTask, "task-leaf-id");
	if (taskLeafId === undefined) {
		return;
	}
	if (!taskLeafId) {
		ctx.ui.notify(`Missing task-leaf-id for ${currentTask}; manual cleanup required`, "error");
		return;
	}

	const agentDir = getAgentDir();
	const taskLoad = loadTask(effectiveStatus, root, agentDir);
	if ("error" in taskLoad) {
		ctx.ui.notify(`${taskLoad.error}\nSearched:\n${taskLoad.searched.join("\n")}`, "error");
		return;
	}

	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(taskLoad.content);
	const trimmedBody = body.trim();
	if (!trimmedBody) {
		ctx.ui.notify(`Task prompt ${taskLoad.path} is empty`, "error");
		return;
	}

	await applyTaskFrontmatter(pi, ctx, frontmatter, taskLoad.path);

	let navigation;
	try {
		navigation = await ctx.navigateTree(taskLeafId, { summarize: false });
	} catch (error) {
		ctx.ui.notify(`Failed to navigate to leaf ${taskLeafId}: ${error}`, "error");
		return;
	}

	if (navigation.cancelled) {
		return;
	}

	const ticketContext = await buildTicketContextMarkdown(pi, ctx, root, currentTask);
	const header = `## Current ticket id: ${currentTask}`;
	const fullMessage = ticketContext
		? `${header}\n\n${ticketContext}\n\n---\n\n${trimmedBody}`
		: `${header}\n\n${trimmedBody}`;

	pi.sendUserMessage(fullMessage);
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

		mergeableWorkspaces.push({ name, wsPath });
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
		await deleteTaskWorkspace(pi, ctx, root, selected.name, selected.wsPath);
		ctx.ui.notify(`Deleted workspace: ${selected.name}`, "info");
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
	// Get the change ID from the task workspace (the actual work commit in the working copy)
	const changeIdResult = await pi.exec("jj", [
		"log",
		"-R", wsPath,
		"--ignore-working-copy",
		"-r", "@",
		"-T", "change_id",
		"--no-graph",
	]);

	if (changeIdResult.code !== 0 || !changeIdResult.stdout.trim()) {
		ctx.ui.notify(`Failed to get change ID for ${name}`, "error");
		return false;
	}

	const taskChangeId = changeIdResult.stdout.trim();

	// Rebase the task work commit onto the current working copy parent
	const rebase1 = await pi.exec("jj", ["rebase", "-s", taskChangeId, "-d", "@-"]);
	if (rebase1.code !== 0) {
		ctx.ui.notify(`Rebase failed: ${rebase1.stderr}`, "error");
		return false;
	}

	// Rebase working copy on top of the merged changes
	const rebase2 = await pi.exec("jj", ["rebase", "-s", "@", "-d", taskChangeId]);
	if (rebase2.code !== 0) {
		ctx.ui.notify(`Rebase working copy failed: ${rebase2.stderr}`, "error");
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
	const revset = `@ & ~ancestors(${mainCommitId})`;
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
	const tkResult = await pi.exec("tk", ["query", "select(.status == \"in_progress\")"], {
		cwd: wsPath,
	});

	if (tkResult.code !== 0) {
		return [];
	}

	return parseTkQueryObjects(tkResult.stdout)
		.map((item) => {
			if (!item || typeof item !== "object") return null;
			const id = typeof (item as { id?: unknown }).id === "string" ? (item as { id: string }).id : "";
			const parentValue = (item as { parent?: unknown }).parent;
			const parent = typeof parentValue === "string" && parentValue.trim() ? parentValue : null;
			return id ? { id, parent } : null;
		})
		.filter((item): item is { id: string; parent?: string | null } => Boolean(item));
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

	for (const name of workspaceNames) {
		if (name === "default") {
			continue;
		}

		const wsPath = path.join(os.homedir(), ".workspaces", name, repo);
		if (!fs.existsSync(wsPath)) {
			continue;
		}

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

function parseTkQueryIds(output: string): string[] {
	return parseTkQueryObjects(output)
		.map((item) => (item && typeof item === "object" ? (item as { id?: string }).id : ""))
		.filter((id): id is string => typeof id === "string" && id.length > 0);
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
		return { error: "Could not find a `## Plan` section with a <subtasks>...</subtasks> block." };
	}

	let parsed: unknown;
	try {
		parsed = parseYamlDocument(yamlString);
	} catch (e) {
		return { error: `Failed to parse plan YAML block: ${e}` };
	}

	if (!parsed) {
		return { subtasks: [] };
	}

	if (!Array.isArray(parsed)) {
		return { error: "Plan YAML block must be a list of subtasks (a YAML sequence)." };
	}

	const subtasks: PlanSubtask[] = [];
	for (let i = 0; i < parsed.length; i++) {
		const item = parsed[i];
		if (!item || typeof item !== "object") {
			return { error: `Subtask ${i + 1} is not an object.` };
		}

		const title = typeof (item as { title?: unknown }).title === "string" ? (item as { title: string }).title.trim() : "";
		const description =
			typeof (item as { description?: unknown }).description === "string"
				? (item as { description: string }).description
				: "";
		const tddValue = (item as { tdd?: unknown }).tdd;
		const tdd = typeof tddValue === "boolean" ? tddValue : true;

		if (!title) {
			return { error: `Subtask ${i + 1} is missing a non-empty string 'title'.` };
		}

		subtasks.push({ title, description, tdd });
	}

	return { subtasks };
}

type TicketChainItem = {
	id: string;
	content: string;
	parent: string | null;
};

async function loadTicketMarkdown(pi: ExtensionAPI, cwd: string, id: string): Promise<{ content: string } | { error: string }> {
	const showResult = await pi.exec("tk", ["show", id], { cwd });
	if (showResult.code !== 0) {
		return { error: `Failed to read ticket ${id}: ${showResult.stderr}` };
	}
	return { content: showResult.stdout };
}

function parseTicketParentId(ticketMarkdown: string): string | null {
	const { frontmatter } = parseFrontmatter<Record<string, unknown>>(ticketMarkdown);
	const parentValue = (frontmatter as { parent?: unknown }).parent;
	if (typeof parentValue !== "string") return null;
	const parent = parentValue.trim();
	return parent.length > 0 ? parent : null;
}

async function buildTicketContextMarkdown(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cwd: string,
	currentTicketId: string,
): Promise<string | null> {
	const chain: TicketChainItem[] = [];
	const seen = new Set<string>();

	let id: string | null = currentTicketId;
	while (id) {
		if (seen.has(id)) {
			ctx.ui.notify(`Detected parent cycle while walking ticket parents at ${id}`, "error");
			return null;
		}
		seen.add(id);

		const load = await loadTicketMarkdown(pi, cwd, id);
		if ("error" in load) {
			ctx.ui.notify(load.error, "warning");
			return null;
		}

		const parent = parseTicketParentId(load.content);
		chain.push({ id, content: load.content.trim(), parent });
		id = parent;
	}

	// Present root -> ... -> current
	chain.reverse();

	// Plain concatenation, but keep it readable.
	return chain.map((t) => t.content).join("\n\n---\n\n");
}

async function resolveCurrentTaskId(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cwd: string
): Promise<string | null> {
	const tickets = await listInProgressTickets(pi, cwd);
	if (tickets.length === 0) {
		ctx.ui.notify("No in_progress tickets found in this workspace", "error");
		return null;
	}

	const rootTickets = tickets.filter((ticket) => !ticket.parent);
	if (rootTickets.length !== 1) {
		const ids = rootTickets.map((ticket) => ticket.id).join(", ") || "(none)";
		ctx.ui.notify(
			`Expected exactly one in_progress root ticket; found ${rootTickets.length}: ${ids}`,
			"error",
		);
		return null;
	}

	let current = rootTickets[0];
	while (true) {
		const children = tickets.filter((ticket) => ticket.parent === current.id);
		if (children.length === 0) {
			break;
		}
		if (children.length > 1) {
			const ids = children.map((ticket) => ticket.id).join(", ");
			ctx.ui.notify(`Multiple in_progress child tickets for ${current.id}: ${ids}`, "error");
			return null;
		}
		current = children[0];
	}

	return current.id;
}

async function getTaskHeader(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cwd: string,
	id: string,
	field: string
): Promise<string | null | undefined> {
	const result = await pi.exec("tk", ["header", id, field], { cwd });
	if (result.code !== 0) {
		ctx.ui.notify(`Failed to read ${field} for ${id}: ${result.stderr}`, "error");
		return undefined;
	}

	const value = result.stdout.trim();
	return value.length > 0 ? value : null;
}

async function setTaskHeader(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cwd: string,
	id: string,
	field: string,
	value: string
): Promise<boolean> {
	const result = await pi.exec("tk", ["header", id, field, value], { cwd });
	if (result.code !== 0) {
		ctx.ui.notify(`Failed to set ${field} for ${id}: ${result.stderr}`, "error");
		return false;
	}
	return true;
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

function resolveModelPattern(modelName: string, models: Array<{ id: string; name?: string; provider: string }>) {
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
): Promise<void> {
	// Forget the workspace in jj
	await pi.exec("jj", ["workspace", "forget", name]);

	// Safety check: ensure wsPath is under ~/.workspaces/<task-id>/<repo>
	const repo = path.basename(root);
	const normalizedPath = stripPrivatePrefix(wsPath);
	const normalizedHome = stripPrivatePrefix(os.homedir());
	const base = path.join(normalizedHome, ".workspaces");
	const rel = path.relative(base, normalizedPath);
	const parts = rel.split(path.sep).filter(Boolean);

	if (rel.startsWith("..") || path.isAbsolute(rel) || parts.length !== 2 || parts[1] !== repo) {
		ctx.ui.notify(`Refusing to delete non-workspace path: ${wsPath}`, "error");
		return;
	}

	// Delete the task ID directory (parent of wsPath)
	const taskIdDir = path.dirname(wsPath);
	if (fs.existsSync(taskIdDir)) {
		fs.rmSync(taskIdDir, { recursive: true, force: true });
	}
}

/**
 * Select a task from `tk ready` and create a workspace for it
 */
async function selectAndStartTask(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	root: string
): Promise<void> {
	// Get ready tasks (open only, not in_progress)
	const tkResult = await pi.exec("tk", ["ready"]);
	if (tkResult.code !== 0) {
		ctx.ui.notify("Failed to get ready tasks", "error");
		return;
	}

	const inProgressTaskIds = await listInProgressRootTaskIdsAcrossWorkspaces(pi, ctx, root);

	// Filter out in_progress tasks - only show open ones for selection
	const readyLines = tkResult.stdout
		.trim()
		.split("\n")
		.filter((line) => line && line.includes("[open]"))
		.filter((line) => {
			const id = parseTicketIdFromReadyLine(line);
			return !id || !inProgressTaskIds.has(id);
		});
	if (readyLines.length === 0) {
		ctx.ui.notify("No open tasks found. Create tickets with `tk create`", "info");
		return;
	}

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
	fs.mkdirSync(path.dirname(wsPath), { recursive: true });

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

	// Set the ticket to in_progress in the task workspace
	const startResult = await pi.exec("tk", ["start", ticketId], { cwd: wsPath });
	if (startResult.code !== 0) {
		ctx.ui.notify(`Failed to set ticket to in_progress: ${startResult.stderr}`, "error");
		return;
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
		{ path: path.join(cwd, ".pi", "task", filename), source: "project" as const },
		{ path: path.join(agentDir, "task", filename), source: "user" as const },
	];

	const searched: string[] = [];

	for (const loc of locations) {
		searched.push(loc.path);
		if (fs.existsSync(loc.path)) {
			try {
				const content = fs.readFileSync(loc.path, "utf-8");
				return { content, path: loc.path, source: loc.source };
			} catch (e) {
				return { error: `Failed to read ${loc.path}: ${e}`, searched };
			}
		}
	}

	return { error: `Task "${name}" not found`, searched };
}
