// The Claude Code dispatcher: routes one parsed hook event to the
// emission it calls for. observe_cli.mjs reads and parses stdin and
// hands the event here.

import { hostname as osHostname } from "node:os";

import { deriveAgentId } from "../agent_id.mjs";
import { boundedToken, MAX_MCP_IDENTITY_BYTES, MAX_SIGNAL_BYTES } from "../core/config.mjs";
import { postEvent, setDirectiveSink } from "../core/poster.mjs";
import {
  cacheSessionModel,
  clearGitCache,
  markerKeyFor,
  pruneStateDir,
  readCachedModel,
  recordModelSwitch,
  swapSessionCwd,
} from "../core/state.mjs";
import { clearSessionPolicyCache } from "../mcp_policy.mjs";
import { safeCollectContext } from "./context.mjs";
import { GATE_FLAG, finishControl, gateDecision, recordDirective, sendPendingControlEvents } from "./control.mjs";
import { CLAUDE_CODE_EVENTS } from "./events.mjs";
import { emitMCPToolCallEvent, resolveMcpToolIdentity } from "./mcp.mjs";
import {
  dispatchMcpPolicyPostToolUse,
  dispatchMcpPolicyPreToolUse,
  dispatchMcpPolicySessionStart,
} from "./mcp_policy_dispatch.mjs";
import { flushPostCallTurns, resolvePreCallModel, resolveSessionEndpoint } from "./post_call.mjs";
import { clearSessionCacheFiles, ensureSessionStarted, getSessionId, sessionHasEnded } from "./session.mjs";
import { SESSION_END_WORKER_DEADLINE_MS, spawnDetachedSessionEnd } from "./session_end.mjs";
import { SIGNAL_HOOKS, buildSignalEvent } from "./signals.mjs";
import { buildStopFailureEvent, failedTurnFor } from "./stop_failure.mjs";
import {
  _subagentChildSessionId,
  _subagentCorrelator,
  _subagentInteriorContext,
  emitSubagentEvent,
  ownSubagentTurns,
} from "./subagent.mjs";
import { buildToolErrorBlock, captureErrorText, hookDurationMs, sanitizeToolInput } from "./tools.mjs";
import { isRealModel, readTurns } from "./transcript.mjs";

/**
 * Handle one Claude Code hook event. ``input`` is the raw stdin the
 * event was parsed from (the SessionEnd hand-off passes it on to the
 * worker verbatim), ``sessionEndWorker`` is true inside the detached
 * SessionEnd worker, and ``entryScript`` is the path of the script the
 * worker re-invokes.
 */
// Set by the sensor's Claude Agent SDK interceptor in the environment of
// a CLI run it reports.
const SDK_OBSERVED_ENV = "FLIGHTDECK_SDK_OBSERVED";

export async function dispatchHookEvent({ cfg, hookEvent, input, sessionEndWorker, entryScript, argv = process.argv }) {
  const hookName = hookEvent.hook_event_name || hookEvent.event || "";
  // With enforcement on, a directive any response carries lands in the
  // session's control state; with it off the poster leaves response
  // bodies unread.
  setDirectiveSink(cfg.enforcement ? (sid, directive) => recordDirective(true, sid, directive) : null);

  // The enforcement gates (PreToolUse for non-MCP tools, the second
  // UserPromptSubmit): only a decision, no event.
  if (argv.includes(GATE_FLAG)) {
    const output = await gateDecision({ cfg, hookName, sessionIds: gateSessionIds(hookEvent) });
    if (output) process.stdout.write(JSON.stringify(output) + "\n");
    return;
  }
  const eventType = CLAUDE_CODE_EVENTS.eventTypeFor(hookName);
  // SubagentStart and SubagentStop are intentionally absent from
  // EVENT_MAP because they emit CHILD session_start / session_end
  // events (different session_id from the outer hook), not parent
  // events. Routed to a dedicated dispatch below.
  const isSubagentHook =
    hookName === "SubagentStart" || hookName === "SubagentStop";
  // PreToolUse fires for the MCP Protection Policy gate.
  // It has no entry in EVENT_MAP because PreToolUse itself doesn't
  // emit a wire event — it returns a hook decision (allow / deny /
  // ask) on stdout. The branch lives in dispatchMcpPolicyPreToolUse
  // below; let the hook through the early-return guard so it
  // reaches the dispatch site.
  const isMcpPolicyHook = hookName === "PreToolUse";
  if (!eventType && !isSubagentHook && !isMcpPolicyHook) {
    return;
  }

  // PreToolUse MCP Protection Policy gate. Runs before the
  // rest of the dispatch because it returns a Claude Code hook
  // decision on stdout; the hook's job here is to gate the call,
  // NOT to emit a wire event. (warn/block events emit at
  // SessionStart for fleet visibility; user-remembered events emit
  // from PostToolUse below.) Reads the per-session policy cache +
  // the remembered-decisions file fresh on every invocation so
  // concurrent Claude Code sessions on the same machine see each
  // other's approvals in real time.
  if (hookName === "PreToolUse") {
    // A stopped session's MCP calls are denied before the MCP policy.
    const stop = await gateDecision({ cfg, hookName, sessionIds: gateSessionIds(hookEvent), stopOnly: true });
    if (stop) {
      process.stdout.write(JSON.stringify(stop) + "\n");
      return;
    }
    const decided = dispatchMcpPolicyPreToolUse(cfg, hookEvent);
    if (decided) {
      // Decision written to stdout; nothing else to do for this
      // hook invocation.
      return;
    }
    // Non-MCP tool call (or no policy in scope). Fall through to
    // the early-return below — PreToolUse has no entry in
    // EVENT_MAP so the standard branch is a no-op.
    return;
  }

  // A run the sensor's Claude Agent SDK interceptor reports (it sets
  // FLIGHTDECK_SDK_OBSERVED in the CLI's environment): the plugin sends
  // nothing for it. Only the MCP policy gate above keeps running, so
  // SessionStart still fetches the policy it reads.
  if (process.env[SDK_OBSERVED_ENV] === "1") {
    const sid = getSessionId(hookEvent);
    if (hookName === "SessionStart") {
      await dispatchMcpPolicySessionStart({ cfg, hookEvent, sessionId: sid, basePayload: { flavor: "claude-code" }, emitEvents: false });
    } else if (hookName === "SessionEnd") {
      clearSessionPolicyCache(sid);
    }
    return;
  }

  // ``outerSessionId`` is what Claude Code passes on hookEvent —
  // ALWAYS the parent invocation's id, regardless of whether the
  // hook fires inside subagent context. ``sessionId`` is what we
  // EMIT under, which equals ``outerSessionId`` for parent events
  // and equals the deterministic child id for interior subagent
  // events (computed below). Keep both names — the parent linkage
  // on subagent children needs the outer, the dispatch downstream
  // needs the resolved.
  const outerSessionId = getSessionId(hookEvent);

  // SessionEnd runs under Claude Code's 1.5 s end-of-session budget
  // (SESSION_END_HOOK_BUDGET_MS). The hook process does only local work
  // here -- invalidate the session markers so the next Claude Code
  // invocation mints a fresh session, drop the per-session policy
  // cache -- and hands the transcript flush plus the session_end POST
  // to a detached worker that keeps running after Claude Code has
  // moved on. Clearing the markers before the hand-off keeps the
  // ordering the synchronous path had: a SessionStart that follows
  // immediately (/clear, a new `claude -p`) never sees the ended
  // session's marker. Without the hand-off, context collection plus
  // one slow POST already exceeded the budget and the session_end was
  // lost. The worker's stderr goes to
  // session-end-worker.log in the state directory.
  if (hookName === "SessionEnd" && !sessionEndWorker) {
    clearSessionCacheFiles(hookEvent, outerSessionId);
    clearSessionPolicyCache(outerSessionId);
    await spawnDetachedSessionEnd(input, outerSessionId, entryScript);
    return;
  }

  let sessionId = outerSessionId;
  // ``transcriptPath`` defaults to the parent's transcript path
  // from hookEvent. When the hook fires inside subagent context,
  // we swap to the subagent's per-execution transcript so the
  // assistant-turn token usage is captured correctly. See
  // _subagentTranscriptPath comment for the path derivation.
  let transcriptPath = hookEvent.transcript_path;

  // Base identity fields used by every event for this session.
  //
  // ``context`` is attached here so *every* event type (pre_call,
  // post_call, tool_call, session_end) carries it -- not only
  // session_start. The worker's lazy-create path and the
  // UpgradeSessionContext upgrade depend on seeing context on the first
  // event that actually reaches the server. A session whose
  // session_start POST failed (stack down at start, dead-TLS window,
  // ...) gets its row from whichever event lands first, and the
  // session_start is only re-sent by a later hook; with context on
  // every event the row has the right flavor and context meanwhile.
  // ``safeCollectContext`` returns null on throw or empty
  // result, in which case the field is omitted -- the worker's
  // COALESCE upgrade treats "missing" and "empty dict" identically.
  // A start or resume probes git afresh: the branch may have moved since
  // the cached probe, and every later hook of the session reuses this one.
  if (hookName === "SessionStart" && hookEvent.session_id) {
    clearGitCache(markerKeyFor(hookEvent.session_id));
  }
  const baseContext = safeCollectContext({
    claudeCodeSessionId: hookEvent.session_id,
  });

  // Agent identity. Plugin emits agent_type="coding" (the ingestion
  // vocabulary is locked to coding / production; the run-mode signals
  // that tell an interactive session from a headless, SDK, CI or
  // remote run ride in context -- see collectClaudeCodeSignals)
  // and client_type="claude_code"; agent_name defaults to
  // "{user}@{hostname}" and can be overridden via
  // FLIGHTDECK_AGENT_NAME env var. The user/hostname come from the
  // context collector (which itself honors FLIGHTDECK_HOSTNAME), so
  // an operator overriding hostname for k8s pod grouping gets
  // consistent agent_id / agent_name derivation and context.hostname.
  const identityUser = baseContext?.user || "unknown";
  const identityHostname =
    process.env.FLIGHTDECK_HOSTNAME ||
    baseContext?.hostname ||
    osHostname();
  const baseAgentName =
    process.env.FLIGHTDECK_AGENT_NAME || `${identityUser}@${identityHostname}`;
  const baseAgentId = deriveAgentId({
    agent_type: "coding",
    user: identityUser,
    hostname: identityHostname,
    client_type: "claude_code",
    agent_name: baseAgentName,
  });

  // Interior-event routing. When this hook fired inside a
  // subagent's execution, swap (sessionId, agentId, agentName) to
  // the CHILD identity so every downstream emission lands under
  // the right session — and stamp parent_session_id / agent_role
  // on basePayload so the worker writes the relationship through.
  // Returns null for parent-context hooks; resolved fields apply
  // unchanged for those.
  const interiorCtx = _subagentInteriorContext({
    hookEvent,
    hookName,
    parentSessionId: outerSessionId,
    parentAgentName: baseAgentName,
    identityUser,
    identityHostname,
  });
  let agentId = baseAgentId;
  let agentName = baseAgentName;
  if (interiorCtx) {
    sessionId = interiorCtx.sessionId;
    agentId = interiorCtx.agentId;
    agentName = interiorCtx.agentName;
    if (interiorCtx.subagentTranscriptPath) {
      transcriptPath = interiorCtx.subagentTranscriptPath;
    }
  }

  const basePayload = {
    session_id: sessionId,
    flavor: "claude-code",
    agent_type: "coding",
    // Agent identity on every event.
    agent_id: agentId,
    agent_name: agentName,
    client_type: "claude_code",
    user: identityUser,
    hostname: identityHostname,
    host: osHostname(),
    framework: "claude-code",
    // ``hookEvent.model`` may carry Claude Code's synthetic-turn
    // sentinel for orchestration hooks; gate via ``isRealModel`` so
    // it never leaks into the basePayload that downstream branches
    // (post_call resolvedModel fallback, MCP content stub, etc.)
    // read when their own primary model source is null.
    model: isRealModel(hookEvent.model) ? hookEvent.model : null,
    tokens_input: 0,
    tokens_output: 0,
    tokens_total: 0,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
    tokens_used_session: 0,
    token_limit_session: null,
    has_content: false,
    content: null,
    ...(interiorCtx
      ? {
          parent_session_id: interiorCtx.parentSessionId,
          agent_role: interiorCtx.agentRole,
        }
      : {}),
    ...(baseContext ? { context: baseContext } : {}),
  };

  // Read transcript lazily -- some hooks don't need it and the file
  // may not exist yet (first-hook SessionStart before the JSONL is
  // flushed).
  let cachedTurns = null;
  const getTurns = () => {
    if (cachedTurns !== null) return cachedTurns;
    cachedTurns = readTurns(transcriptPath);
    // Inside a fork subagent the transcript starts with a copy of the
    // parent's history; those turns are the parent's to report.
    if (interiorCtx) {
      cachedTurns = ownSubagentTurns(cachedTurns, {
        role: interiorCtx.agentRole,
        subagentTranscript: transcriptPath,
        parentTranscript: hookEvent.transcript_path,
      });
    }
    return cachedTurns;
  };
  const getLatestTurn = () => {
    const turns = getTurns();
    return turns.length > 0 ? turns.at(-1) : null;
  };

  // SubagentStart / SubagentStop. Emit a child session_start /
  // session_end whose session_id is distinct from the outer
  // (parent) session, with parent_session_id pointing back at the
  // outer one and agent_role labeling the subagent's type. SubagentStop
  // is the canonical end-of-life signal; PostToolUseFailure on a
  // Task tool keeps emitting the parent's tool_call event with the
  // structured error block and does NOT duplicate-emit a child
  // session_end (a delayed real SubagentStop would race a synthetic
  // one). Crashes that never reach a clean SubagentStop fall through
  // the worker's existing state-revival path (active → stale → lost).
  if (isSubagentHook) {
    // emitSubagentEvent derives the child's agent_id and display
    // name from the PARENT's agent_name (agent_role is the
    // conditional 6th input on top of the parent's 5-tuple).
    // Pass ``baseAgentName`` explicitly so the right value flows
    // even if a future change makes ``agentName`` carry the child's
    // composed form for some other reason.
    await emitSubagentEvent({
      cfg,
      hookName,
      hookEvent,
      outerSessionId,
      basePayload,
      agentName: baseAgentName,
      identityUser,
      identityHostname,
    });
    return;
  }

  // SessionStart: real first hook. Emit session_start with the model
  // and context, cache the model for subsequent UserPromptSubmit hooks,
  // and mark the dedup file so later hooks skip the backstop.
  if (hookName === "SessionStart") {
    const turn = getLatestTurn();
    const hookModel = isRealModel(hookEvent.model) ? hookEvent.model : null;
    const model = hookModel || (isRealModel(turn?.model) ? turn.model : null);
    cacheSessionModel(sessionId, model);
    // The directory the session starts in, which a later hook's cwd is
    // compared with to report a change.
    swapSessionCwd(sessionId, hookEvent.cwd);
    // Decide the billing mode and platform here, afresh on every start
    // or resume, so later hooks read them from the cache.
    resolveSessionEndpoint(sessionId, { refresh: true });
    await ensureSessionStarted(cfg.server, cfg.token, sessionId, basePayload, {
      model,
      claudeCodeVersion: turn?.claudeCodeVersion || hookEvent.version || null,
      capturePrompts: cfg.capturePrompts,
      claudeCodeSessionId: hookEvent.session_id,
      // startup / resume / clear / compact / fork -- how this Claude
      // Code session came to be. A resumed or forked session is
      // otherwise indistinguishable from a fresh one.
      sessionSource: typeof hookEvent.source === "string" ? hookEvent.source : null,
    });
    // Fetch + cache the MCP Protection Policy and emit
    // policy_mcp_warn / policy_mcp_block events for any non-allow
    // decisions per declared MCP server. Best-effort; failures
    // fail-open per Rule 28.
    await dispatchMcpPolicySessionStart({
      cfg,
      hookEvent,
      sessionId,
      basePayload,
    });
    // Keep the state directory bounded; runs at most once a day, after
    // the session's events are sent.
    pruneStateDir();
    return;
  }

  // SessionEnd: real session teardown, running in the detached worker
  // (the hook process handed off above after clearing the on-disk
  // markers). Before emitting session_end, flush any LLM turns not yet
  // emitted by Stop or PostToolUse -- in `claude -p` mode Claude Code
  // fires Stop once before the final tool-loop turn is flushed to the
  // transcript, so a post_call for the final turn can still be missing
  // when SessionEnd arrives. Dedup via the per-messageId marker keeps
  // this idempotent with Stop and PostToolUse. The worker must not
  // touch the session markers: a new Claude Code session may own them
  // by now.
  if (hookName === "SessionEnd") {
    await flushPostCallTurns({
      cfg,
      sessionId,
      basePayload,
      turns: getTurns(),
      capturePrompts: cfg.capturePrompts,
      deadline: Date.now() + SESSION_END_WORKER_DEADLINE_MS,
      // The last process for the session: it sends the turns a killed
      // async hook had claimed but not sent.
      reclaimOrphaned: true,
    });
    // A session a directive stopped already ends with its own
    // session_end (close_reason directive_shutdown).
    if (await finishControl({ cfg, sessionId, basePayload })) return;
    const payload = {
      ...basePayload,
      event_type: "session_end",
      tool_name: null,
      tool_input: null,
      is_subagent_call: false,
      latency_ms: null,
      timestamp: new Date().toISOString(),
      // Plugin-driven SessionEnd is always a normal exit from the
      // operator's perspective (the user typed /exit, /clear, or the
      // `claude -p` command completed cleanly). The worker reaper
      // fills "orphan_timeout" on lost sessions; "sigkill_detected"
      // is reserved for future signal-handling. Stamping explicitly
      // here keeps the dashboard's Close Reason facet populated for
      // every clean exit instead of falling through to the worker's
      // unknown-default path.
      close_reason: "normal_exit",
    };
    // Claude Code's own exit reason (clear, resume, logout,
    // prompt_input_exit, other) rides alongside the enum so the specific
    // trigger is not lost to the coarse close_reason bucket. Every one
    // of them is a clean exit from the operator's perspective, so
    // close_reason stays normal_exit.
    const endReason = boundedToken(hookEvent.reason, MAX_SIGNAL_BYTES);
    if (endReason) payload.end_reason = endReason;
    await postEvent(cfg.server, cfg.token, sessionId, payload);
    return;
  }

  // Every other event type goes through the common session_start
  // backstop so an initial hook that is NOT SessionStart still produces
  // a session row -- except a hook that started after this run's
  // SessionEnd, whose session_start would reopen the ended session.
  const ended = sessionHasEnded(hookEvent, outerSessionId);
  if (!ended) {
    await ensureSessionStarted(cfg.server, cfg.token, sessionId, basePayload, {
      model: isRealModel(hookEvent.model) ? hookEvent.model : null,
      claudeCodeVersion: hookEvent.version || null,
      capturePrompts: cfg.capturePrompts,
      claudeCodeSessionId: hookEvent.session_id,
    });
  }
  // The events directives recorded for this session still owe (a
  // directive_result, a policy event, a stopped session's session_end).
  await sendPendingControlEvents({ cfg, sessionId, basePayload });

  // A change of working directory. Claude Code runs a plugin's
  // CwdChanged hook only when the user's settings register one too, so
  // each hook from here on compares the cwd it runs in with the last one
  // recorded and reports a difference as cwd_changed. The CwdChanged
  // hook, when it does run, records through the same file, so a change
  // is reported once, by whichever hook records it first. An ended
  // session records nothing: SessionEnd removed its file. The record is
  // written before the POST, so a change whose POST fails is not
  // reported again.
  const currentCwd = hookName === "CwdChanged" ? hookEvent.new_cwd : hookEvent.cwd;
  if (hookName === "CwdChanged" && (typeof currentCwd !== "string" || currentCwd === "")) return;
  if (!ended) {
    const { changed, previous } = swapSessionCwd(sessionId, currentCwd);
    if (hookName === "CwdChanged") {
      // A hook in the new directory already reported this change.
      if (!changed) return;
    } else if (changed && previous !== null) {
      const payload = buildSignalEvent({
        hookName: "CwdChanged",
        hookEvent: { old_cwd: previous, new_cwd: currentCwd },
        basePayload,
        capturePrompts: cfg.capturePrompts,
      });
      await postEvent(cfg.server, cfg.token, sessionId, payload);
    }
  }

  // Stop: every un-emitted LLM turn in the transcript becomes a
  // post_call. Multi-turn tool-use conversations produce multiple
  // assistant message.ids and Stop only fires once at the end, so we
  // must iterate every group and dedup via the per-messageId marker
  // file. PostToolUse flushes most of these mid-turn; Stop acts as the
  // final backstop for the last assistant turn (no tool follow-up).
  // cacheSessionModel inside the helper keeps pre_call labelling right
  // for subsequent UserPromptSubmit hooks on older Claude Code versions
  // that do not carry model on SessionStart.
  if (hookName === "Stop") {
    await flushPostCallTurns({
      cfg,
      sessionId,
      basePayload,
      turns: getTurns(),
      capturePrompts: cfg.capturePrompts,
    });
    // The per-session MCP policy cache deliberately survives Stop:
    // Stop fires after every assistant turn, and PreToolUse reads the
    // cache on every MCP tool call for the life of the session. It is
    // removed on SessionEnd below.
    return;
  }

  // StopFailure: the turn ended on an API error and Claude Code fires
  // this instead of Stop. Flush the calls that completed before the
  // failure, then report the failure as an llm_error.
  if (hookName === "StopFailure") {
    await flushPostCallTurns({
      cfg,
      sessionId,
      basePayload,
      turns: getTurns(),
      capturePrompts: cfg.capturePrompts,
    });
    const failedTurn = failedTurnFor(getTurns(), hookEvent);
    await postEvent(
      cfg.server,
      cfg.token,
      sessionId,
      buildStopFailureEvent({
        basePayload,
        hookEvent,
        model: resolvePreCallModel(sessionId, hookEvent, transcriptPath),
        failedTurn,
        capturePrompts: cfg.capturePrompts,
      }),
    );
    return;
  }

  // UserPromptSubmit: user hit enter on a prompt. Emit pre_call for
  // the upcoming LLM turn, but only when we can resolve a concrete
  // model. Resolution order: (1) most recent assistant in the
  // transcript, (2) cached model from a prior post_call this session,
  // (3) hook payload. If all three are empty the dashboard would
  // render the pre_call as "unknown", so we skip the emission entirely
  // and rely on the Stop-emitted post_call (which always has a model
  // because it reads usage directly from the transcript). First-turn
  // prompts in a brand-new session thus have no pre_call; second and
  // subsequent prompts are labelled correctly.
  if (hookName === "UserPromptSubmit") {
    const model = resolvePreCallModel(sessionId, hookEvent, transcriptPath);
    if (!model) return;
    const hasContent = cfg.capturePrompts && typeof hookEvent.prompt === "string";
    const content = hasContent
      ? {
          provider: "anthropic",
          model,
          system: null,
          messages: [{ role: "user", content: hookEvent.prompt }],
          tools: [],
          response: [],
        }
      : null;
    const payload = {
      ...basePayload,
      event_type: "pre_call",
      model,
      tool_name: null,
      tool_input: null,
      is_subagent_call: false,
      latency_ms: null,
      timestamp: new Date().toISOString(),
      has_content: hasContent,
      content,
    };
    await postEvent(cfg.server, cfg.token, sessionId, payload);
    return;
  }

  // PreCompact, PostCompact, PostModelSwitch, Notification,
  // PermissionRequest, PermissionDenied, UserPromptExpansion,
  // TaskCreated, TaskCompleted, TeammateIdle, CwdChanged, ConfigChange,
  // Elicitation, ElicitationResult: a change in the session, reported
  // as a session_signal. A model switch also
  // becomes the model later pre_call events are labelled with.
  if (SIGNAL_HOOKS.includes(hookName)) {
    const payload = buildSignalEvent({
      hookName,
      hookEvent,
      basePayload,
      capturePrompts: cfg.capturePrompts,
      captureToolInputs: cfg.captureToolInputs,
    });
    if (isRealModel(payload.model)) {
      cacheSessionModel(sessionId, payload.model);
      recordModelSwitch(sessionId, payload.model, payload.timestamp);
    }
    await postEvent(cfg.server, cfg.token, sessionId, payload);
    return;
  }

  // PostToolUse and PostToolUseFailure: flush any un-emitted LLM turns
  // from the transcript before emitting the tool_call. The assistant
  // record that triggered this tool invocation is already in the
  // transcript by the time either hook fires, so its post_call becomes visible in the
  // dashboard in real time rather than batching at Stop. Ordering:
  // post_call (LLM decision) precedes tool_call (tool execution),
  // matching transcript order. markEmittedTurn dedup keeps Stop and
  // SessionEnd idempotent. Wrapped in try/catch so a transcript read
  // failure cannot block the tool_call emission -- readTurns already
  // returns [] on read errors, but belt-and-suspenders.
  if (hookName === "PostToolUse" || hookName === "PostToolUseFailure") {
    try {
      await flushPostCallTurns({
        cfg,
        sessionId,
        basePayload,
        turns: getTurns(),
        capturePrompts: cfg.capturePrompts,
      });
    } catch (err) {
      process.stderr.write(
        `flightdeck: post_call flush on ${hookName} failed: ${err?.message || err}\n`,
      );
    }
  }
  if (hookName === "PostToolUse") {
    // Reactive de-facto-approval write. When an
    // mcp__<server>__<tool> call succeeded AND the server was
    // unknown-allowlist on this session AND no remembered
    // decision exists yet for the active token: write the
    // remembered file AND emit mcp_policy_user_remembered.
    // Wrapped to never crash the standard PostToolUse path.
    try {
      const toolNameForPolicy =
        hookEvent.tool_name
        || hookEvent.tool_use?.name
        || hookEvent.tool
        || null;
      await dispatchMcpPolicyPostToolUse({
        cfg,
        hookEvent,
        sessionId: outerSessionId,
        basePayload,
        toolName: toolNameForPolicy,
      });
    } catch (err) {
      process.stderr.write(
        `flightdeck: mcp policy PostToolUse failed: ${err?.message || err}\n`,
      );
    }
  }

  // PreToolUse / PostToolUse: tool-lifecycle events. Same
  // sanitised-whitelist capture semantics as every other tool event.
  const toolName =
    hookEvent.tool_name ||
    hookEvent.tool_use?.name ||
    hookEvent.tool ||
    null;

  // MCP tool calls are namespaced as ``mcp__<server>__<tool>``
  // by Claude Code. Detect via prefix and route to the dedicated MCP
  // emit branch BEFORE the standard tool sanitiser runs. The
  // whitelist sanitiser is BYPASSED for MCP tools — its keep-
  // list (file_path / command / query / pattern / prompt) drops every
  // MCP-specific argument shape and would render the plugin-sourced
  // MCP_TOOL_CALL payload empty. The MCP path captures the raw
  // arguments verbatim under the existing ``captureToolInputs`` knob.
  const mcpIdentity = resolveMcpToolIdentity(hookEvent, toolName);
  if (mcpIdentity) {
    if (!mcpIdentity.parsed) {
      process.stderr.write(
        `flightdeck: ambiguous MCP tool name "${toolName}"; ` +
          `server attribution falling back to null. See plugin README.\n`,
      );
    }
    await emitMCPToolCallEvent({
      cfg,
      sessionId,
      basePayload,
      hookEvent,
      hookName,
      mcpIdentity,
    });
    return;
  }

  // Every remaining hook name maps to an event type (EVENT_MAP); the
  // guard keeps a future unmapped hook from POSTing event_type=undefined.
  if (!eventType) return;

  const sanitizedInput =
    cfg.captureToolInputs && hookEvent.tool_input
      ? sanitizeToolInput(hookEvent.tool_input)
      : null;
  const toolInputJson = sanitizedInput ? JSON.stringify(sanitizedInput) : null;

  const isSubagentCall = toolName === "Task";
  const toolDurationMs = hookDurationMs(hookEvent);

  // Build event_content payload so the drawer's Prompts tab can show
  // real tool input + output (previously tool_call events always had
  // has_content=false, so the drawer rendered shallow metadata only).
  // Privacy tiers: input is gated on captureToolInputs (default ON);
  // output is gated on capturePrompts (default ON for the plugin,
  // OFF for the Python sensor -- see resolveConfig rationale).
  let content = null;
  let hasContent = false;
  if (cfg.captureToolInputs && toolName && sanitizedInput) {
    const tools = [{ type: "tool_use", name: toolName, input: sanitizedInput }];
    const response = [];
    if (cfg.capturePrompts && hookEvent.tool_response != null) {
      const out =
        typeof hookEvent.tool_response === "string"
          ? hookEvent.tool_response
          : JSON.stringify(hookEvent.tool_response);
      response.push({
        type: "tool_result",
        content: out.length > 2000 ? out.slice(0, 2000) + "\u2026" : out,
      });
    }
    content = {
      provider: "anthropic",
      model: readCachedModel(sessionId) || basePayload.model || "",
      system: null,
      messages: [],
      tools,
      response,
    };
    hasContent = true;
  }

  // Preserve basePayload's parent_session_id when interior
  // subagent context set it (the modern Agent tool path). Fall back
  // to the legacy ``isSubagentCall ? sessionId : null`` shape for
  // the deprecated Task-tool informational hint (retained as
  // forward-compat on the parent's tool_call event for any consumer
  // still reading it). The two paths are mutually exclusive — when
  // interior context is active, basePayload.parent_session_id is
  // the OUTER session id; when it isn't, the legacy line applies.
  const payload = {
    ...basePayload,
    event_type: eventType,
    tool_name: toolName,
    tool_input: toolInputJson,
    tool_result: null,
    is_subagent_call: isSubagentCall,
    parent_session_id:
      basePayload.parent_session_id ??
      (isSubagentCall ? sessionId : null),
    // Real tool wall time from Claude Code on PostToolUse /
    // PostToolUseFailure, null when the hook does not carry it. The
    // same value lands as duration_ms so tool_call and mcp_tool_call
    // report the tool's duration under one name.
    latency_ms: toolDurationMs,
    duration_ms: toolDurationMs,
    timestamp: new Date().toISOString(),
    has_content: hasContent,
    content,
  };
  const toolUseId = boundedToken(hookEvent.tool_use_id, MAX_MCP_IDENTITY_BYTES);
  if (toolUseId) payload.tool_use_id = toolUseId;
  if (hookName === "PostToolUseFailure") {
    payload.error = buildToolErrorBlock(hookEvent, captureErrorText(cfg));
  }
  await postEvent(cfg.server, cfg.token, sessionId, payload);
}

/**
 * The sessions whose control state gates a hook: the session, and for a
 * hook inside a subagent also the subagent's child session, so stopping
 * either stops the subagent.
 */
function gateSessionIds(hookEvent) {
  const outer = getSessionId(hookEvent);
  const correlator = hookEvent.agent_id ? _subagentCorrelator(hookEvent) : null;
  return correlator ? [outer, _subagentChildSessionId(outer, correlator)] : [outer];
}
