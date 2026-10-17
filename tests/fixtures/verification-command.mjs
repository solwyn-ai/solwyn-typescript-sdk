import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

const scenario = JSON.parse(process.argv[2]);
const fired = [];
const pending = new Map();
const ready = new Set();

// A timer runs only after the scenario observes its prerequisite. No other grace period
// can interrupt startup or win a race against the event the scenario is exercising.
function schedule(timer) {
  if (!timer || timer.cleared || timer.scheduled || !ready.has(timer.label)) return;
  timer.scheduled = true;
  setImmediate(() => {
    if (timer.cleared) return;
    fired.push(timer.label);
    timer.callback();
  });
}
function release(label) {
  ready.add(label);
  schedule(pending.get(label));
}
const timers = {
  set(label, _ms, callback) {
    const timer = { label, callback, cleared: false, scheduled: false };
    pending.set(label, timer);
    schedule(timer);
    return timer;
  },
  clear(timer) {
    if (timer) timer.cleared = true;
  },
};

const spawn = cp.spawn;
let anchor;
let stdout = "";
let stderr = "";
let helperKills = 0;
const order = [];
const windows = scenario.mode.startsWith("windows-");
cp.spawn = (binary, args, options) => {
  if (windows && binary === "taskkill.exe") {
    const helper = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      unref() {},
      kill(signal) {
        helperKills++;
        helper.signalCode = signal;
        setImmediate(() => helper.emit("exit", null, signal));
        return true;
      },
    });
    assert.ok(anchor);
    if (scenario.mode === "windows-anchor-exit") {
      anchor.once("exit", () => {
        order.push("anchor-exit");
        setImmediate(() => {
          order.push("taskkill-exit");
          helper.exitCode = 0;
          helper.emit("exit", 0, null);
        });
      });
      anchor.kill("SIGKILL");
    } else {
      // The test sends another output chunk only after receiving this IPC handshake.
      process.send("taskkill-pending");
    }
    return helper;
  }
  const child = spawn(binary, args, options);
  if (!anchor) {
    anchor = child;
    const observed = () => {
      if (scenario.mode === "windows-pending") {
        if (stdout.length >= 16) release("taskkill-cleanup");
      } else if (
        stdout.includes("child-ready\n") &&
        stderr.includes("diagnostic\n") &&
        (scenario.mode === "ignored-signal" || /descendant-pid:\d+\n/.test(stdout))
      ) {
        release(scenario.mode === "ignored-signal" ? "deadline" : "pipe-cleanup");
      }
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      observed();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      observed();
    });
  }
  return child;
};
syncBuiltinESMExports();
if (windows) Object.defineProperty(process, "platform", { value: "win32" });
const { runBoundedCommand, classifyCommandFailure } = await import(
  "../../scripts/verification/process.mjs"
);

if (scenario.mode === "classify") {
  process.stdout.write(JSON.stringify(classifyCommandFailure(scenario.binary, scenario.result)));
} else {
  const chunks = [];
  const concat = Buffer.concat;
  if (scenario.mode === "windows-pending")
    Buffer.concat = (values, ...args) => {
      chunks.push(values.map((value) => value.length));
      return concat(values, ...args);
    };
  const result = await runBoundedCommand(scenario.binary, scenario.args, {
    cwd: scenario.cwd,
    timeout: 200,
    maxBuffer: scenario.maxBuffer ?? 1048576,
    timers,
  });
  Buffer.concat = concat;
  order.push("resolved");
  process.stdout.write(
    JSON.stringify({
      ...result,
      error: result.error?.code,
      failure: classifyCommandFailure(scenario.binary, result),
      fired,
      chunks,
      helperKills,
      order,
    }),
  );
}
