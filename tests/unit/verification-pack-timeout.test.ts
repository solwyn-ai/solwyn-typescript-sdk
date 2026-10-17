import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const caller = fileURLToPath(new URL("../fixtures/verification-command.mjs", import.meta.url));
const temporary: string[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratchDirectory() {
  const scratch = mkdtempSync(path.join(tmpdir(), "verification-pack-timeout-"));
  temporary.push(scratch);
  return scratch;
}

/** Keep the test event loop free so its timeout can guard a hung caller. */
function runCaller(scenario: object) {
  const child = spawn(process.execPath, [caller, JSON.stringify(scenario)], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  assert.ok(child.stdout);
  assert.ok(child.stderr);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const taskkillPending = new Promise<void>((resolve) => {
    child.on("message", (message) => {
      if (message === "taskkill-pending") resolve();
    });
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  });
  return {
    taskkillPending,
    async result() {
      expect(await closed, stderr).toBe(0);
      return JSON.parse(stdout);
    },
  };
}

/** The subject keeps this socket open; its kernel-closed connection proves termination. */
async function livenessServer(scratch: string) {
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\solwyn-${randomUUID()}`
      : path.join(scratch, "liveness.sock");
  const server = createServer();
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const connected = new Promise<{ socket: Socket; pid: number; closed: Promise<void> }>(
    (resolve, reject) => {
      server.once("connection", (socket) => {
        let alive = true;
        let pid: number | undefined;
        const closed = new Promise<void>((done) => {
          socket.once("close", () => {
            alive = false;
            done();
          });
        });
        socket.on("error", () => {});
        cleanups.push(async () => {
          if (alive && pid) {
            try {
              process.kill(pid, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            }
          }
          socket.destroy();
          await closed;
        });
        let handshake = "";
        const receivePid = (data: Buffer) => {
          handshake += data;
          if (!handshake.includes("\n")) return;
          socket.off("data", receivePid);
          pid = Number(handshake.trim());
          if (!Number.isSafeInteger(pid) || pid <= 0) {
            reject(new Error(`Invalid subject PID: ${handshake}`));
            return;
          }
          resolve({ socket, pid, closed });
        };
        socket.on("data", receivePid);
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, resolve);
  });
  return { address, connected };
}

function writeSubject(scratch: string, address: string, windows = false) {
  const subject = path.join(scratch, "subject.cjs");
  writeFileSync(
    subject,
    `
      process.on('SIGTERM', () => {});
      const socket = require('node:net').connect(${JSON.stringify(address)}, () => {
        socket.write(String(process.pid) + '\\n');
        let input = '';
        socket.on('data', (chunk) => {
          input += chunk;
          while (input.includes('\\n')) {
            input = input.slice(input.indexOf('\\n') + 1);
            ${windows ? "process.stdout.write('xxxxxxxx');" : "socket.write('pong\\n');"}
          }
        });
        ${
          windows
            ? "process.stdout.write('xxxxxxxx');"
            : `if (process.send) {
                process.stdout.write('descendant-pid:' + process.pid + '\\n', () => {
                  process.send('ready', () => process.disconnect());
                });
              } else {
                process.stdout.write('child-ready\\n');
                process.stderr.write('diagnostic\\n');
              }`
        }
      });
    `,
  );
  return subject;
}

it("stops collecting output while simulated Windows taskkill is pending", async () => {
  const scratch = scratchDirectory();
  const liveness = await livenessServer(scratch);
  const subject = writeSubject(scratch, liveness.address, true);
  const caller = runCaller({
    mode: "windows-pending",
    binary: process.execPath,
    args: [subject],
    maxBuffer: 1,
  });
  const [{ socket, pid, closed }] = await Promise.all([liveness.connected, caller.taskkillPending]);
  // The next chunk is guaranteed to reach the supervisor while taskkill is pending.
  socket.write("more\n");
  const result = await caller.result();
  expect(result.error).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  expect(result.stdout).toBe("x");
  expect(result.termination.method).toBe("taskkill-supervisor-tree");
  expect(result.termination.cleanupTimedOut).toBe(true);
  expect(result.fired).toEqual(["taskkill-cleanup"]);
  expect(result.helperKills).toBe(1);
  expect(result.chunks).toEqual([[1], []]);
  process.kill(pid, "SIGKILL");
  await closed;
}, 30_000);

it("lets Windows taskkill finish walking descendants after the anchor exits", async () => {
  const scratch = scratchDirectory();
  const liveness = await livenessServer(scratch);
  const subject = writeSubject(scratch, liveness.address, true);
  const result = await runCaller({
    mode: "windows-anchor-exit",
    binary: process.execPath,
    args: [subject],
    maxBuffer: 1,
  }).result();
  expect(result.error).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  expect(result.order).toEqual(["anchor-exit", "taskkill-exit", "resolved"]);
  expect(result.supervisorExit.signal).toBe("SIGKILL");
  expect(result.helperKills).toBe(0);
  expect(result.fired).toEqual([]);
  expect(result.termination).toMatchObject({ status: 0, completed: true });
  const { pid, closed } = await liveness.connected;
  process.kill(pid, "SIGKILL");
  await closed;
}, 30_000);

it("bounds sustained high-volume output with a shared stdout/stderr cap", async () => {
  const result = await runCaller({
    mode: "flood",
    binary: process.execPath,
    args: [
      "-e",
      `
      const chunk = Buffer.alloc(65536, 120);
      function flood() {
        const out = process.stdout.write(chunk);
        const err = process.stderr.write(chunk);
        if (!out) process.stdout.once('drain', flood);
        else if (!err) process.stderr.once('drain', flood);
        else setImmediate(flood);
      }
      flood();
    `,
    ],
    maxBuffer: 131072,
  }).result();
  expect(result.error).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
  expect(result.fired).toEqual([]);
  expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(131072);
  expect(result.termination.targetPid).toBe(result.supervisorPid);
}, 30_000);

it.each([
  [
    "tar",
    { status: null, error: { code: "ENOENT" } },
    {
      phase: "prerequisite",
      kind: "command-failure",
      retryable: false,
      artifactFailure: false,
      errorCode: "ENOENT",
    },
  ],
  [
    "tar",
    { status: null, error: { code: "EACCES" } },
    {
      phase: "prerequisite",
      kind: "command-failure",
      retryable: false,
      artifactFailure: false,
      errorCode: "EACCES",
    },
  ],
  [
    "tar",
    { status: 2, stderr: "tar: Error opening archive: Unrecognized archive format" },
    {
      phase: "verification",
      kind: "command-failure",
      retryable: false,
      artifactFailure: true,
      errorCode: null,
    },
  ],
  [
    "npm",
    { status: null, timedOut: true, error: { code: "ETIMEDOUT" } },
    {
      phase: "dependency-setup",
      kind: "timeout",
      retryable: true,
      artifactFailure: false,
      errorCode: "ETIMEDOUT",
    },
  ],
  [
    "npm",
    { status: 1, timedOut: false, stderr: "npm error code ECONNRESET" },
    {
      phase: "dependency-setup",
      kind: "network",
      retryable: true,
      artifactFailure: false,
      errorCode: "ECONNRESET",
    },
  ],
  [
    "npm",
    { status: 1, timedOut: false, stderr: "npm error code ENOTFOUND" },
    {
      phase: "dependency-setup",
      kind: "network",
      retryable: true,
      artifactFailure: false,
      errorCode: "ENOTFOUND",
    },
  ],
  [
    "npm",
    { status: 1, timedOut: false, stderr: "npm error code ERESOLVE" },
    {
      phase: "dependency-setup",
      kind: "command-failure",
      retryable: false,
      artifactFailure: false,
      errorCode: "ERESOLVE",
    },
  ],
  [
    "node",
    { status: 1, timedOut: false, stderr: "AssertionError: missing export" },
    {
      phase: "verification",
      kind: "command-failure",
      retryable: false,
      artifactFailure: true,
      errorCode: null,
    },
  ],
  [
    "npm",
    { status: null, error: { code: "ENOENT" } },
    {
      phase: "dependency-setup",
      kind: "command-failure",
      retryable: false,
      artifactFailure: false,
      errorCode: "ENOENT",
    },
  ],
  [
    "npm",
    { status: 1, stderr: "npm ERR! code ERESOLVE" },
    {
      phase: "dependency-setup",
      kind: "command-failure",
      retryable: false,
      artifactFailure: false,
      errorCode: "ERESOLVE",
    },
  ],
  [
    "npm",
    { status: 1, errorCode: "EAI_AGAIN", stderr: "resolver unavailable" },
    {
      phase: "dependency-setup",
      kind: "network",
      retryable: true,
      artifactFailure: false,
      errorCode: "EAI_AGAIN",
    },
  ],
])(
  "classifies command evidence for %s",
  async (binary, result, expected) => {
    expect(await runCaller({ mode: "classify", binary, result }).result()).toEqual(expected);
  },
  30_000,
);

it("classifies an actually missing tar executable as a prerequisite failure", async () => {
  const scratch = scratchDirectory();
  const binary = path.join(scratch, "missing", process.platform === "win32" ? "tar.exe" : "tar");
  const result = await runCaller({
    mode: "missing-tar",
    binary,
    args: ["-tzf", "unused.tgz"],
  }).result();
  expect(result.error).toBe("ENOENT");
  expect(result.fired).toEqual([]);
  expect(result.status).toBeNull();
  expect(result.failure).toMatchObject({
    phase: "prerequisite",
    artifactFailure: false,
    retryable: false,
    errorCode: "ENOENT",
  });
}, 30_000);

it.each([
  "ignored-signal",
  "inherited-pipe",
  "escaped-session",
] as const)("bounds the caller despite %s", async (mode) => {
  const scratch = scratchDirectory();
  const liveness = await livenessServer(scratch);
  const subject = writeSubject(scratch, liveness.address);
  const child = path.join(scratch, "unresponsive.cjs");
  writeFileSync(
    child,
    mode === "ignored-signal"
      ? `require(${JSON.stringify(subject)});`
      : `
          const descendant = require('node:child_process').spawn(
            process.execPath, [${JSON.stringify(subject)}],
            { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], detached: ${mode === "escaped-session"} }
          );
          descendant.once('message', () => {
            process.stdout.write('child-ready\\n', () => {
              process.stderr.write('diagnostic\\n', () => process.exit(0));
            });
          });
        `,
  );
  // The subject never exits by itself: returning is the proof of boundedness.
  const evidence = await runCaller({
    mode,
    binary: process.execPath,
    args: [child],
    cwd: scratch,
  }).result();
  const trigger = mode === "ignored-signal" ? "deadline" : "pipe-cleanup";
  expect(evidence.fired).toEqual([trigger]);
  expect(evidence.error).toBe(
    mode === "ignored-signal" ? "ETIMEDOUT" : "ERR_CHILD_PROCESS_PIPE_CLEANUP_TIMEOUT",
  );
  expect(evidence.timedOut).toBe(true);
  expect(evidence.stdout).toContain("child-ready");
  expect(evidence.stderr).toContain("diagnostic");
  const { socket, pid, closed } = await liveness.connected;
  expect(pid).toBeGreaterThan(0);
  if (mode !== "ignored-signal") {
    expect(Number(/descendant-pid:(\d+)/.exec(evidence.stdout)?.[1])).toBe(pid);
  }
  if (process.platform === "win32") return;
  expect(evidence.termination.attempted).toBe(true);
  if (mode === "escaped-session") {
    expect(evidence.termination.scope).toContain("escaped sessions are not contained");
    // Answering after the caller returns proves the new session escaped the owned group.
    const pong = new Promise<string>((resolve) => {
      let answer = "";
      const receivePong = (data: Buffer) => {
        answer += data;
        if (!answer.includes("\n")) return;
        socket.off("data", receivePong);
        resolve(answer.trim());
      };
      socket.on("data", receivePong);
    });
    socket.write("ping\n");
    expect(await pong).toBe("pong");
    process.kill(pid, "SIGKILL");
  }
  await closed;
}, 30_000);
