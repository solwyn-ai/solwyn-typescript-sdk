import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnCommandSupervisor, terminateCommandSupervisor } from "./process.mjs";
import {
  assertEdgeResult,
  commandResult,
  consumerEnv,
  environmentError,
  runProbe,
} from "./runtime-support.mjs";
import {
  assertReport,
  cleanupTemporaryRoot,
  createTemporaryRoot,
  sha256,
  writeReport,
} from "./support.mjs";

export function assertBrowserChecks(checks) {
  assert.match(checks.bundleSha256, /^[a-f0-9]{64}$/);
  assertEdgeResult(checks.result);
  assert.ok(path.isAbsolute(checks.execution.browser));
  assert.deepEqual(checks.execution.exit, { code: 0, signal: null });
  const cleanup = checks.supervisorCleanup;
  assert.ok(["owned-supervisor-group", "taskkill-supervisor-tree"].includes(cleanup.method));
  assert.equal(cleanup.attempted, true);
  assert.equal(cleanup.completed, cleanup.method === "taskkill-supervisor-tree" ? true : null);
  assert.equal(cleanup.cleanupTimedOut, false);
  assert.equal(cleanup.error, null);
  assert.equal(cleanup.detached, false);
  assert.equal(checks.stderr.limitBytes, 1048576);
  for (const field of ["receivedBytes", "retainedBytes"]) {
    assert.ok(Number.isSafeInteger(checks.stderr[field]) && checks.stderr[field] >= 0);
    assert.ok(checks.stderr[field] <= checks.stderr.limitBytes);
  }
  assert.equal(checks.stderr.receivedBytes, checks.stderr.retainedBytes);
  assert.equal(checks.stderr.truncated, false);
}

async function browserProof({ tarball, out }, report, evidence) {
  let fatalError;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  report.details.timingMs = {};
  const bundle = path.join(out, "edge-browser-bundle.js");
  const bundleReport = JSON.parse(fs.readFileSync(path.join(out, "bundle-proofs.json"), "utf8"));
  assertReport(bundleReport, { probe: "bundle-proofs" });
  assert.equal(bundleReport.status, "pass", "Browser proof requires successful bundle proofs");
  assert.equal(bundleReport.artifact.sha256, sha256(tarball), "Bundle must use this exact tarball");
  assert.equal(
    bundleReport.checks.bundleSha256,
    sha256(bundle),
    "Browser must use the exact verified bundle",
  );
  const candidates = process.env.SOLWYN_VERIFICATION_BROWSER
    ? [process.env.SOLWYN_VERIFICATION_BROWSER]
    : [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        ...["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].flatMap((name) =>
          process.env[name]
            ? [
                path.join(process.env[name], "Google/Chrome/Application/chrome.exe"),
                path.join(process.env[name], "Microsoft/Edge/Application/msedge.exe"),
              ]
            : [],
        ),
        ...(process.env.PATH ?? "")
          .split(path.delimiter)
          .flatMap((directory) =>
            [
              "chromium",
              "chromium-browser",
              "google-chrome",
              "google-chrome-stable",
              "chrome.exe",
              "msedge.exe",
            ].map((name) => path.join(directory, name)),
          ),
      ];
  const browser = candidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!browser)
    throw environmentError(
      "No Chromium browser found; set SOLWYN_VERIFICATION_BROWSER to an executable",
    );
  let version;
  try {
    version = await commandResult(browser, ["--version"], out, 10000, evidence, {
      prerequisite: true,
    });
  } catch (error) {
    throw environmentError("Browser version command failed", error);
  }
  report.versions.browser = version.stdout.trim();
  if (typeof WebSocket !== "function")
    throw environmentError(
      "Browser driver requires a Node runtime with global WebSocket (Node 22+)",
    );
  const profile = createTemporaryRoot("solwyn-consumer-browser-", report);
  const keepProfile = process.env.SMOKE_KEEP === "1";
  report.details.profile = profile;
  report.details.profileRetention = keepProfile ? "SMOKE_KEEP=1" : "remove-after-cleanup";
  report.checks.bundleSha256 = sha256(bundle);
  try {
    // Register exact profile ownership before the browser starts so the parent
    // runner can reclaim it if an aggregate watchdog terminates this probe.
    writeReport(path.join(out, "browser-proof.json"), report);
    fs.writeFileSync(
      path.join(out, "edge.html"),
      '<!doctype html><meta charset="utf-8"><title>SDK edge verification</title><body>pending<script src="./edge-browser-bundle.js"></script>',
    );
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-breakpad",
      "--metrics-recording-only",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "about:blank",
    ];
    const stderrFd = fs.openSync(path.join(out, "browser-stderr.log"), "w");
    const child = spawnCommandSupervisor(browser, args, {
      cwd: profile,
      env: consumerEnv,
    });
    let spawnError;
    child.once("error", (error) => {
      spawnError = error;
    });
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let socket;
    let id = 0;
    const pending = new Map();
    let rejectFatal;
    let closingBrowser = false;
    let cleaningUp = false;
    const fatal = new Promise((_, reject) => {
      rejectFatal = reject;
    });
    // A callback can fail between awaited commands. Retain the rejection until
    // the next race without allowing an unhandled rejection to escape cleanup.
    void fatal.catch(() => {});
    const failBrowser = (error) => {
      if (fatalError) return;
      fatalError = error instanceof Error ? error : new Error("Browser transport failed");
      report.details.transportFailure = fatalError.message;
      for (const task of pending.values()) {
        clearTimeout(task.timer);
        task.reject(fatalError);
      }
      pending.clear();
      rejectFatal(fatalError);
    };
    const guarded = (promise) => Promise.race([promise, fatal]);
    const stderr = {
      limitBytes: 1024 * 1024,
      receivedBytes: 0,
      retainedBytes: 0,
      truncated: false,
    };
    report.details.stderr = stderr;
    const onStderr = (chunk) => {
      try {
        stderr.receivedBytes += chunk.length;
        const retain = Math.min(chunk.length, stderr.limitBytes - stderr.retainedBytes);
        if (retain > 0) stderr.retainedBytes += fs.writeSync(stderrFd, chunk, 0, retain);
        if (stderr.receivedBytes > stderr.limitBytes) {
          stderr.truncated = true;
          failBrowser(new Error("Browser stderr exceeded the 1 MiB limit"));
        }
      } catch (error) {
        failBrowser(error);
      }
    };
    child.stderr?.on("data", onStderr);
    child.stderr?.on("error", failBrowser);
    let actualExit = null;
    let resolveActualExit;
    const closed = new Promise((resolve) => {
      resolveActualExit = resolve;
    });
    child.on("message", (message) => {
      if (message.type === "started") report.details.browserPid = message.pid;
      if (message.type === "spawn-error") failBrowser(new Error(message.message));
      if (message.type === "exit") {
        actualExit = { code: message.status, signal: message.signal };
        resolveActualExit(actualExit);
      }
    });
    child.stdout?.resume();
    const anchorExited = new Promise((resolve) =>
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
        if (!cleaningUp) failBrowser(new Error("Browser supervisor exited unexpectedly"));
      }),
    );
    const reaped = new Promise((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    const waitFor = async (promise, timeoutMs) => {
      let timer;
      try {
        return await Promise.race([
          promise,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const waitForExit = (timeoutMs) => waitFor(closed, timeoutMs);
    const portFile = path.join(profile, "DevToolsActivePort");
    try {
      for (let i = 0; !fs.existsSync(portFile) && i < 150; i++) {
        if (spawnError) throw spawnError;
        assert.equal(actualExit, null, "Browser exited before exposing DevTools");
        await guarded(delay(100));
      }
      assert.ok(fs.existsSync(portFile), "Chrome did not expose the local DevTools port");
      const [port] = fs.readFileSync(portFile, "utf8").split("\n");
      const httpController = new AbortController();
      const httpDeadline = setTimeout(() => {
        httpController.abort(new Error("DevTools HTTP startup timed out"));
      }, 10000);
      let tabs;
      try {
        const response = await guarded(
          fetch(`http://127.0.0.1:${port}/json/list`, {
            signal: httpController.signal,
          }),
        );
        assert.ok(response.ok, "DevTools HTTP startup failed");
        tabs = await guarded(response.json());
      } finally {
        clearTimeout(httpDeadline);
      }
      socket = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl);
      await guarded(
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("DevTools WebSocket startup timed out")),
            10000,
          );
          socket.addEventListener(
            "open",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
          socket.addEventListener(
            "error",
            (error) => {
              clearTimeout(timer);
              reject(error);
            },
            { once: true },
          );
        }),
      );
      socket.addEventListener("message", (event) => {
        try {
          assert.equal(typeof event.data, "string");
          const message = JSON.parse(event.data);
          assert.ok(message !== null && typeof message === "object" && !Array.isArray(message));
          if (message.error) assert.equal(typeof message.error.message, "string");
          const task = pending.get(message.id);
          if (task) {
            pending.delete(message.id);
            clearTimeout(task.timer);
            if (message.error) task.reject(new Error(message.error.message));
            else task.resolve(message.result);
          }
        } catch (error) {
          failBrowser(new Error("Invalid DevTools message", { cause: error }));
        }
      });
      socket.addEventListener("error", () => {
        if (cleaningUp) return;
        // After Browser.close, EOF can surface as an error event. The bounded
        // process-exit check still requires code 0; a disconnect cannot pass it.
        if (closingBrowser) report.details.browserCloseTransportError = true;
        else failBrowser(new Error("DevTools transport failed"));
      });
      socket.addEventListener("close", () => {
        if (!closingBrowser && !cleaningUp)
          failBrowser(new Error("DevTools transport closed unexpectedly"));
      });
      const send = (method, params = {}) =>
        guarded(
          new Promise((resolve, reject) => {
            if (fatalError) {
              reject(fatalError);
              return;
            }
            const requestId = ++id;
            const timer = setTimeout(() => {
              pending.delete(requestId);
              reject(new Error(`DevTools timed out: ${method}`));
            }, 30000);
            pending.set(requestId, { resolve, reject, timer });
            try {
              socket.send(JSON.stringify({ id: requestId, method, params }));
            } catch (error) {
              failBrowser(error);
            }
          }),
        );
      await send("Page.enable");
      await send("Runtime.enable");
      await send("Page.navigate", { url: pathToFileURL(path.join(out, "edge.html")).href });
      let ready = false;
      for (let i = 0; i < 150; i++) {
        const status = await send("Runtime.evaluate", {
          expression: "Boolean(globalThis.reviewDone)",
          returnByValue: true,
        });
        if (status.result.value === true) {
          ready = true;
          break;
        }
        await guarded(delay(100));
      }
      assert.ok(ready, "Browser bundle did not initialize");
      const evaluation = await send("Runtime.evaluate", {
        expression: "globalThis.reviewDone",
        awaitPromise: true,
        returnByValue: true,
      });
      assert.equal(evaluation.exceptionDetails, undefined, "Browser proof rejected");
      const result = evaluation.result.value;
      fs.writeFileSync(
        path.join(out, "browser-result.json"),
        JSON.stringify({ status: 0, result }, null, 2),
      );
      report.checks.result = result;
      assert.equal(result.ok, true);
      assert.equal(result.ingested, 4);
      assert.equal(result.legacyDedupCollisions, 0);
      const dom = await send("Runtime.evaluate", {
        expression: "document.documentElement.outerHTML",
        returnByValue: true,
      });
      fs.writeFileSync(path.join(out, "browser-dom.html"), dom.result.value);
      report.details.timingMs.proofComplete = elapsed();
      // Exit is the shutdown authority. Chrome may close CDP before replying, so
      // do not postpone the exit deadline while waiting for a protocol reply.
      closingBrowser = true;
      void send("Browser.close").catch((error) => {
        report.details.browserCloseError = error.message;
      });
      const exit = await guarded(waitForExit(5000));
      report.details.timingMs.gracefulExit = elapsed();
      fs.writeFileSync(
        path.join(out, "browser-execution.json"),
        JSON.stringify(
          {
            browser,
            args,
            exit,
            network: "only localhost DevTools; external host resolution blocked",
          },
          null,
          2,
        ),
      );
      report.details.execution = {
        browser,
        args,
        exit,
        network: "only localhost DevTools; external host resolution blocked",
      };
      report.checks.execution = { browser: path.resolve(browser), exit };
      assert.ok(exit, "Browser did not exit within the shutdown deadline");
      assert.equal(exit.code, 0, "Browser must exit successfully");
      assert.equal(exit.signal, null, "Browser must exit without a signal");
      process.stdout.write(`${JSON.stringify({ result, exit })}\n`);
    } finally {
      cleaningUp = true;
      const cleanup = { exit: actualExit, anchorExit: null, closed: null, detached: false };
      report.details.cleanup = cleanup;
      for (const task of pending.values()) clearTimeout(task.timer);
      pending.clear();
      try {
        socket?.close();
      } catch (error) {
        cleanup.socketCloseError = error.message;
      }
      try {
        // Chrome exit is separate from ownership-anchor exit. The anchor stays
        // live so its group is still ours when reclaiming ordinary helpers,
        // including after Chrome exits or the outer probe is terminated.
        cleanup.termination = await terminateCommandSupervisor(child);
        cleanup.anchorExit = await waitFor(anchorExited, 1000);
        cleanup.exit ??= actualExit;
        child.stdout?.destroy();
        child.stderr?.destroy();
        cleanup.closed = await waitFor(reaped, 1000);
        cleanup.detached = cleanup.anchorExit === null || cleanup.closed === null;
      } finally {
        child.unref();
        child.channel?.unref();
        child.stdout?.destroy();
        child.stderr?.removeListener("data", onStderr);
        child.stderr?.destroy();
        fs.closeSync(stderrFd);
      }
    }
  } finally {
    try {
      cleanupTemporaryRoot(profile);
    } finally {
      report.details.profileRetained = fs.existsSync(profile);
      report.details.timingMs.cleanupComplete = elapsed();
    }
  }
  if (fatalError) throw fatalError;
  assert.equal(report.details.cleanup.detached, false, "Browser supervisor survived cleanup");
  assert.equal(
    report.details.cleanup.termination.attempted,
    true,
    "Browser ownership anchor was lost before cleanup",
  );
  assert.equal(report.details.cleanup.termination.error, undefined, "Browser tree cleanup failed");
  if (report.details.cleanup.termination.method === "taskkill-supervisor-tree") {
    assert.notEqual(
      report.details.cleanup.termination.cleanupTimedOut,
      true,
      "Browser Windows tree cleanup timed out",
    );
    assert.equal(
      report.details.cleanup.termination.completed,
      true,
      "Browser Windows tree cleanup was not confirmed",
    );
  }
  report.checks.stderr = report.details.stderr;
  const cleanup = report.details.cleanup;
  report.checks.supervisorCleanup = {
    method: cleanup.termination.method,
    attempted: cleanup.termination.attempted,
    completed: cleanup.termination.completed ?? null,
    cleanupTimedOut: cleanup.termination.cleanupTimedOut ?? false,
    error: cleanup.termination.error ?? null,
    detached: cleanup.detached,
  };
  assertBrowserChecks(report.checks);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runProbe("browser-proof", browserProof);

  // Native WebSocket.close() is a graceful handshake with no force-destroy API.
  // After a failed proof and bounded process cleanup, persist the report (above),
  // flush diagnostics, and terminate this standalone CLI so a stuck transport
  // cannot extend failure until the aggregate watchdog. Never turn failure to pass.
  if (process.exitCode) {
    const code = process.exitCode;
    setTimeout(() => process.exit(code), 1000).unref();
    process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
  }
}
