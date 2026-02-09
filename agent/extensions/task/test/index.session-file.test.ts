import test from "node:test";
import assert from "node:assert/strict";

import {
    completionReadyToMergeNotice,
    normalizeSessionFilePath,
    resolveEditorPrefillValue,
    shouldNotifyPendingTransitionOutsideTaskLoop,
} from "../index.js";

test("normalizeSessionFilePath returns null for undefined", () => {
    assert.equal(normalizeSessionFilePath(undefined), null);
});

test("normalizeSessionFilePath returns null for blank input", () => {
    assert.equal(normalizeSessionFilePath("   \n\t  "), null);
});

test("normalizeSessionFilePath trims and preserves non-empty absolute paths", () => {
    assert.equal(
        normalizeSessionFilePath("  /Users/colin/.pi/agent/sessions/foo.jsonl  "),
        "/Users/colin/.pi/agent/sessions/foo.jsonl",
    );
});

test("shouldNotifyPendingTransitionOutsideTaskLoop returns true for replayable unconsumed transition", () => {
    assert.equal(
        shouldNotifyPendingTransitionOutsideTaskLoop({
            workflowState: "refine",
            latestAssistantMessageId: "a1",
            latestAssistantMessageText: "<transition>plan</transition>",
            lastConsumedAssistantId: null,
            taskLoopActive: false,
        }),
        true,
    );
});

test("shouldNotifyPendingTransitionOutsideTaskLoop returns false while task loop is active", () => {
    assert.equal(
        shouldNotifyPendingTransitionOutsideTaskLoop({
            workflowState: "refine",
            latestAssistantMessageId: "a1",
            latestAssistantMessageText: "<transition>plan</transition>",
            lastConsumedAssistantId: null,
            taskLoopActive: true,
        }),
        false,
    );
});

test("shouldNotifyPendingTransitionOutsideTaskLoop returns false when assistant message already consumed", () => {
    assert.equal(
        shouldNotifyPendingTransitionOutsideTaskLoop({
            workflowState: "refine",
            latestAssistantMessageId: "a1",
            latestAssistantMessageText: "<transition>plan</transition>",
            lastConsumedAssistantId: "a1",
            taskLoopActive: false,
        }),
        false,
    );
});

test("shouldNotifyPendingTransitionOutsideTaskLoop returns false for non-replayable output", () => {
    assert.equal(
        shouldNotifyPendingTransitionOutsideTaskLoop({
            workflowState: "refine",
            latestAssistantMessageId: "a1",
            latestAssistantMessageText: "still refining",
            lastConsumedAssistantId: null,
            taskLoopActive: false,
        }),
        false,
    );
});

test("shouldNotifyPendingTransitionOutsideTaskLoop returns false when there is no assistant id", () => {
    assert.equal(
        shouldNotifyPendingTransitionOutsideTaskLoop({
            workflowState: "refine",
            latestAssistantMessageId: null,
            latestAssistantMessageText: "<transition>plan</transition>",
            lastConsumedAssistantId: null,
            taskLoopActive: false,
        }),
        false,
    );
});

test("completionReadyToMergeNotice returns message when transition changed to complete", () => {
    assert.equal(
        completionReadyToMergeNotice({changed: true, nextState: "complete"}),
        "Final commit succeeded. Task workspace is ready to merge.",
    );
});

test("completionReadyToMergeNotice returns null when transition did not change", () => {
    assert.equal(
        completionReadyToMergeNotice({changed: false, nextState: "complete"}),
        null,
    );
});

test("completionReadyToMergeNotice returns null when next state is not complete", () => {
    assert.equal(
        completionReadyToMergeNotice({changed: true, nextState: "commit"}),
        null,
    );
});

test("resolveEditorPrefillValue falls back to default on undefined", () => {
    assert.equal(
        resolveEditorPrefillValue(undefined, "default-value"),
        "default-value",
    );
});

test("resolveEditorPrefillValue falls back to default on blank input", () => {
    assert.equal(
        resolveEditorPrefillValue("   \n\t  ", "default-value"),
        "default-value",
    );
});

test("resolveEditorPrefillValue trims surrounding whitespace", () => {
    assert.equal(
        resolveEditorPrefillValue("   custom value   ", "default-value"),
        "custom value",
    );
});

test("resolveEditorPrefillValue singleLine mode uses first non-empty line", () => {
    assert.equal(
        resolveEditorPrefillValue("\n\n first-line \n second-line", "default-value", {singleLine: true}),
        "first-line",
    );
});
