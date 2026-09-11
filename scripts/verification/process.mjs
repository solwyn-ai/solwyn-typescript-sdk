/** Leaf process ownership and bounded command execution for verification scripts. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const liveSupervisors = new Set();
let shuttingDown = false;

/** Windows .cmd shims require a shell; invoke their installed JavaScript CLI via Node instead. */
export function resolvePackageManagerCommand(
  binary,
  args,
  { platform = process.platform, env: commandEnv = process.env, execPath = process.execPath } = {},
) {
  if (platform !== "win32") return { binary, args };
  const manager = path.win32
    .basename(binary)
    .toLowerCase()
    .replace(/\.cmd$/, "");
  if (manager !== "npm" && manager !== "pnpm") return { binary, args };
  const value = (name) =>
    Object.entries(commandEnv).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
  const cliPattern =
    manager === "npm" ? /^(?:npm-cli|npm)\.(?:js|cjs)$/i : /^(?:pnpm-cli|pnpm)\.(?:js|cjs)$/i;
  const inheritedCli = value("npm_execpath");
  const directories = [path.dirname(execPath), ...(value("PATH") ?? "").split(";").filter(Boolean)];
  if (path.isAbsolute(binary) || path.win32.isAbsolute(binary))
    directories.unshift(path.dirname(binary));
  const candidates = [
    ...(inheritedCli && cliPattern.test(path.win32.basename(inheritedCli)) ? [inheritedCli] : []),
    ...directories.flatMap((directory) => [
      path.join(
        directory,
        "node_modules",
        manager,
        "bin",
        manager === "npm" ? "npm-cli.js" : "pnpm.cjs",
      ),
      path.join(directory, "node_modules", "corepack", "dist", `${manager}.js`),
    ]),
  ];
  const isFile = (file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  const cli = candidates.find(isFile);
  if (cli) return { binary: execPath, args: [cli, ...args] };
  const executable = directories
    .map((directory) => path.join(directory, `${manager}.exe`))
    .find(isFile);
  if (executable) return { binary: executable, args };
  throw Object.assign(
    new Error(
      `Cannot locate the installed ${manager} JavaScript CLI or executable on Windows; install it alongside Node or expose its installation on PATH`,
    ),
    { code: "ENOENT" },
  );
}

/** Bound the caller independently of child signal handling or inherited pipe lifetime. */
// Serialized into a dedicated Node child. It owns the process group until the parent finishes
// collecting the real command's pipes; actual command exit never relinquishes that group ID.
async function commandSupervisor() {
  const { spawn } = await import("node:child_process");
  const command = JSON.parse(process.argv[1]);
  let finishing = false;
  let cleanup;
  let exitMessage = Promise.resolve();
  const keepAlive = setInterval(() => {}, 60_000);
  function disconnected() {
    if (finishing) return;
    finishing = true;
    if (process.platform !== "win32") {
      try {
        process.kill(-process.pid, "SIGKILL");
      } catch {
        process.exit(1);
      }
    } else {
      cleanup = spawn("taskkill.exe", ["/pid", String(process.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      cleanup.once("error", () => process.exit(1));
      cleanup.once("exit", () => process.exit(1));
      setTimeout(() => {
        if (cleanup.exitCode === null && cleanup.signalCode === null) cleanup.kill("SIGKILL");
        process.exit(1);
      }, 500);
    }
  }
  function send(message) {
    return new Promise((resolve) => {
      try {
        if (process.connected)
          process.send(message, (error) => {
            if (error) disconnected();
            resolve();
          });
        else {
          disconnected();
          resolve();
        }
      } catch {
        disconnected();
        resolve();
      }
    });
  }
  process.stdout.on("error", disconnected);
  process.stderr.on("error", disconnected);
  process.on("disconnect", disconnected);
  process.on("message", (message) => {
    if (message?.type !== "finish" || finishing) return;
    finishing = true;
    clearInterval(keepAlive);
    process.stdout.write("", () => process.stderr.write("", () => process.exit(0)));
  });
  try {
    const child = spawn(command.binary, command.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    send({ type: "started", pid: child.pid });
    child.stdout.on("error", disconnected);
    child.stderr.on("error", disconnected);
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.once("error", (error) =>
      send({ type: "spawn-error", message: error.message, code: error.code }),
    );
    child.once("exit", (status, signal) => {
      exitMessage = send({ type: "exit", pid: child.pid, status, signal });
    });
    child.once("close", () => {
      void exitMessage.then(() => send({ type: "closed" }));
    });
  } catch (error) {
    send({ type: "spawn-error", message: error.message, code: error.code });
    send({ type: "closed" });
  }
}

/** A live ownership anchor. Command exit is an IPC message; anchor exit is a separate event. */
export function spawnCommandSupervisor(binary, args, { cwd, env: childEnv = process.env } = {}) {
  assert.ok(!shuttingDown, "Verification process lifecycle is shutting down");
  const command = resolvePackageManagerCommand(binary, args, { env: childEnv });
  const supervisor = spawn(
    process.execPath,
    ["-e", `(${commandSupervisor.toString()})()`, JSON.stringify(command)],
    {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: process.platform !== "win32",
      windowsHide: true,
    },
  );
  supervisor.resolvedCommand = command;
  liveSupervisors.add(supervisor);
  supervisor.once("exit", () => liveSupervisors.delete(supervisor));
  supervisor.once("error", () => liveSupervisors.delete(supervisor));
  return supervisor;
}

/** Signal lifecycle only: stop every owned live anchor and reject any subsequent starts. */
export async function shutdownSupervisors() {
  shuttingDown = true;
  await Promise.all(
    [...liveSupervisors].map(async (supervisor) => {
      await terminateCommandSupervisor(supervisor);
      if (supervisor.exitCode !== null || supervisor.signalCode !== null) return;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 500);
        supervisor.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }),
  );
}

function disconnectFailedSupervisor(supervisor, diagnostics) {
  if (supervisor.connected) {
    diagnostics.disconnectAttempted = true;
    try {
      supervisor.disconnect();
    } catch (error) {
      diagnostics.disconnectError = error.message;
    }
  }
  supervisor.channel?.unref();
  supervisor.unref();
}

/** Stop only a still-live anchor; ordinary descendants share its owned group/tree. */
export async function terminateCommandSupervisor(supervisor) {
  const live = () =>
    supervisor?.pid && supervisor.exitCode === null && supervisor.signalCode === null;
  const result = {
    method: "none",
    attempted: false,
    targetPid: supervisor?.pid,
    scope: "live owned supervisor group; escaped sessions are not contained",
  };
  if (!live()) {
    result.scope =
      "supervisor exited; no former identifiers signaled; descendant containment unknown";
    return result;
  }
  if (process.platform !== "win32") {
    result.method = "owned-supervisor-group";
    try {
      process.kill(-supervisor.pid, "SIGKILL");
      result.attempted = true;
    } catch (error) {
      result.error = error.message;
      disconnectFailedSupervisor(supervisor, result);
    }
    return result;
  }
  result.method = "taskkill-supervisor-tree";
  return new Promise((resolve) => {
    let killer;
    let timer;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (live()) supervisor.kill("SIGKILL");
      resolve(result);
    };
    try {
      killer = spawn("taskkill.exe", ["/pid", String(supervisor.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      result.attempted = true;
      killer.unref();
      killer.once("error", (error) => {
        result.error = error.message;
        finish();
      });
      killer.once("exit", (status) => {
        result.status = status;
        result.completed = status === 0;
        finish();
      });
      timer = setTimeout(() => {
        result.cleanupTimedOut = true;
        if (killer.exitCode === null && killer.signalCode === null) killer.kill("SIGKILL");
        finish();
      }, 500);
    } catch (error) {
      result.error = error.message;
      finish();
    }
  });
}

export function runBoundedCommand(
  binary,
  args,
  { cwd, env: childEnv = process.env, timeout = 180_000, maxBuffer = 10 * 1024 * 1024 } = {},
) {
  assert.ok(Number.isFinite(timeout) && timeout > 0, "Command timeout must be positive");
  const started = Date.now();
  return new Promise((resolve) => {
    let supervisor;
    let supervisorExited = false;
    let commandClosed = false;
    let deadline;
    let pipeTimer;
    let cleanupTimer;
    let killer;
    let stopping = false;
    let settled = false;
    let outputBytes = 0;
    const output = { stdout: [], stderr: [] };
    const result = {
      status: null,
      signal: null,
      error: undefined,
      timedOut: false,
      elapsedMs: 0,
      timeoutMs: timeout,
      termination: null,
      stdout: "",
      stderr: "",
    };
    const commandStatus = () => (result.rootExit ? result.rootExit.status : null);
    const commandSignal = () => (result.rootExit ? result.rootExit.signal : null);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(pipeTimer);
      clearTimeout(cleanupTimer);
      supervisor?.stdout?.destroy();
      supervisor?.stderr?.destroy();
      supervisor?.channel?.unref();
      supervisor?.unref();
      result.status =
        result.error?.code === "ERR_VERIFICATION_SUPERVISOR_EXIT" ? null : commandStatus();
      result.signal =
        result.error?.code === "ERR_VERIFICATION_SUPERVISOR_EXIT" ? null : commandSignal();
      result.stdout = Buffer.concat(output.stdout).toString("utf8");
      result.stderr = Buffer.concat(output.stderr).toString("utf8");
      result.elapsedMs = Date.now() - started;
      resolve(result);
    }
    function liveSupervisor() {
      return (
        supervisor?.pid &&
        !supervisorExited &&
        supervisor.exitCode === null &&
        supervisor.signalCode === null
      );
    }
    function stop(code, message) {
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(deadline);
      clearTimeout(pipeTimer);
      result.error = Object.assign(new Error(message), { code });
      result.timedOut = code === "ETIMEDOUT" || code.includes("TIMEOUT");
      result.termination = {
        method: "none",
        attempted: false,
        targetPid: supervisor?.pid,
        scope: "live owned supervisor group; escaped sessions are not contained",
      };
      if (!liveSupervisor()) {
        result.termination.scope =
          "supervisor exited; no former identifiers signaled; descendant containment unknown";
        finish();
        return;
      }
      if (process.platform !== "win32") {
        result.termination.method = "owned-supervisor-group";
        try {
          process.kill(-supervisor.pid, "SIGKILL");
          result.termination.attempted = true;
        } catch (error) {
          result.termination.error = error.message;
          disconnectFailedSupervisor(supervisor, result.termination);
        }
        finish();
      } else {
        result.termination.method = "taskkill-supervisor-tree";
        const conclude = () => {
          if (settled) return;
          if (liveSupervisor()) supervisor.kill("SIGKILL");
          finish();
        };
        try {
          killer = spawn("taskkill.exe", ["/pid", String(supervisor.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          result.termination.attempted = true;
          killer.unref();
          killer.once("error", (error) => {
            result.termination.error = error.message;
            conclude();
          });
          killer.once("exit", (status) => {
            result.termination.status = status;
            result.termination.completed = status === 0;
            conclude();
          });
          cleanupTimer = setTimeout(() => {
            result.termination.cleanupTimedOut = true;
            if (killer.exitCode === null && killer.signalCode === null) killer.kill("SIGKILL");
            conclude();
          }, 500);
        } catch (error) {
          result.termination.error = error.message;
          conclude();
        }
      }
    }
    try {
      supervisor = spawnCommandSupervisor(binary, args, { cwd, env: childEnv });
      result.resolvedCommand = supervisor.resolvedCommand;
      result.supervisorPid = supervisor.pid;
    } catch (error) {
      result.error = error;
      finish();
      return;
    }
    for (const stream of ["stdout", "stderr"])
      supervisor[stream].on("data", (chunk) => {
        if (settled || stopping) return;
        const available = Math.max(0, maxBuffer - outputBytes);
        output[stream].push(chunk.subarray(0, available));
        outputBytes += chunk.length;
        if (outputBytes > maxBuffer)
          stop("ERR_CHILD_PROCESS_STDIO_MAXBUFFER", `Command exceeded ${maxBuffer} output bytes`);
      });
    supervisor.on("message", (message) => {
      if (settled) return;
      if (message.type === "started") result.commandPid = message.pid;
      else if (message.type === "spawn-error")
        result.error = Object.assign(new Error(message.message), { code: message.code });
      else if (message.type === "exit") {
        result.rootExit = {
          pid: message.pid,
          status: message.status,
          signal: message.signal,
          elapsedMs: Date.now() - started,
        };
        clearTimeout(deadline);
        if (!stopping)
          pipeTimer = setTimeout(() => {
            result.pipeCleanupTimedOut = true;
            result.timeoutPhase = "pipe-cleanup";
            stop(
              "ERR_CHILD_PROCESS_PIPE_CLEANUP_TIMEOUT",
              "Command exited but inherited pipes did not close within 500 ms",
            );
          }, 500);
      } else if (message.type === "closed" && !stopping) {
        commandClosed = true;
        clearTimeout(deadline);
        clearTimeout(pipeTimer);
        try {
          supervisor.send({ type: "finish" }, (error) => {
            if (error && !settled)
              stop(
                "ERR_VERIFICATION_SUPERVISOR_CHANNEL",
                `Supervisor control channel failed: ${error.message}`,
              );
          });
        } catch (error) {
          stop(
            "ERR_VERIFICATION_SUPERVISOR_CHANNEL",
            `Supervisor control channel failed: ${error.message}`,
          );
        }
        if (stopping || settled) return;
        cleanupTimer = setTimeout(
          () =>
            stop(
              "ERR_VERIFICATION_SUPERVISOR_SHUTDOWN_TIMEOUT",
              "Supervisor did not finish within 500 ms",
            ),
          500,
        );
      }
    });
    supervisor.once("error", (error) => {
      result.error = error;
      finish();
    });
    supervisor.once("exit", (status, signal) => {
      supervisorExited = true;
      result.supervisorExit = { status, signal, elapsedMs: Date.now() - started };
      clearTimeout(deadline);
      clearTimeout(pipeTimer);
      // taskkill may terminate the anchor before it finishes traversing descendants.
      // Its own completion/deadline remains authoritative even after anchor exit/close.
      if (stopping && process.platform === "win32" && killer) return;
      clearTimeout(cleanupTimer);
      if (killer?.exitCode === null && killer.signalCode === null) killer.kill("SIGKILL");
      if (stopping) {
        finish();
        return;
      }
      if (!commandClosed)
        result.error ??= Object.assign(new Error("Supervisor exited before command completion"), {
          code: "ERR_VERIFICATION_SUPERVISOR_EXIT",
        });
      // The group leader is gone: only drain/close pipes, never signal its former identifier.
      cleanupTimer = setTimeout(() => {
        result.error ??= Object.assign(new Error("Exited supervisor pipes did not close"), {
          code: "ERR_VERIFICATION_SUPERVISOR_PIPE_TIMEOUT",
        });
        result.timedOut = true;
        result.termination = {
          method: "none",
          attempted: false,
          scope:
            "supervisor exited; no former identifiers signaled; descendant containment unknown",
        };
        finish();
      }, 500);
    });
    supervisor.once("close", () => {
      if (stopping && process.platform === "win32" && killer && !settled) return;
      finish();
    });
    deadline = setTimeout(
      () => stop("ETIMEDOUT", `Command exceeded ${timeout} ms wall deadline`),
      timeout,
    );
  });
}

export function classifyCommandFailure(binary, result) {
  if (!result.error && result.status === 0) return null;
  const setup = /^(?:npm|pnpm)(?:\.cmd|\.exe)?$/.test(path.basename(binary));
  const errorCode =
    result.error?.code ??
    result.errorCode ??
    /\bnpm\s+(?:error|ERR!)\s+code\s+([A-Z][A-Z0-9_]+)/i
      .exec(result.stderr ?? "")?.[1]
      ?.toUpperCase() ??
    null;
  const network =
    /^(?:ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|ECONNRESET|ECONNREFUSED|ERR_SOCKET_TIMEOUT)$/.test(
      errorCode ?? "",
    );
  // A tool which could not start says nothing about the supplied artifact's validity.
  const prerequisite =
    result.status === null &&
    /^(?:ENOENT|EACCES|EPERM|ENOEXEC|E2BIG|ENOMEM|EMFILE|ENFILE)$/.test(errorCode ?? "");
  return {
    phase: setup ? "dependency-setup" : prerequisite ? "prerequisite" : "verification",
    kind: result.timedOut ? "timeout" : setup && network ? "network" : "command-failure",
    retryable: setup && (result.timedOut || network),
    artifactFailure: !setup && !prerequisite && !result.timedOut,
    errorCode,
  };
}
