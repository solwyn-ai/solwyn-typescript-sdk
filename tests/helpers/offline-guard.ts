import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

export class OfflineViolationError extends Error {
  constructor() {
    super("network access denied during provider surface capture");
    this.name = "OfflineViolationError";
  }
}

export class OfflineGuardInstallationError extends Error {
  readonly entryPoint: string;

  constructor(entryPoint: string) {
    super(`offline guard could not replace network entry point: ${entryPoint}`);
    this.name = "OfflineGuardInstallationError";
    this.entryPoint = entryPoint;
  }
}

export interface OfflineGuardHandle {
  socketAttempts(): number;
}

let socketAttemptCount = 0;
let installed = false;

const guardHandle: OfflineGuardHandle = Object.freeze({
  socketAttempts: () => socketAttemptCount,
});

function denyNetworkAccess(..._arguments: unknown[]): never {
  socketAttemptCount += 1;
  throw new OfflineViolationError();
}

interface PatchedEntryPoint {
  readonly target: object;
  readonly key: string;
  readonly label: string;
}

function installationFailure(label: string): never {
  throw new OfflineGuardInstallationError(label);
}

function currentValue(target: object, key: string, label: string): unknown {
  try {
    return Reflect.get(target, key);
  } catch {
    return installationFailure(label);
  }
}

function verifyPatched(entryPoint: PatchedEntryPoint): void {
  if (currentValue(entryPoint.target, entryPoint.key, entryPoint.label) !== denyNetworkAccess) {
    installationFailure(entryPoint.label);
  }
}

function patchFunction(
  target: object,
  key: string,
  label: string,
  required = true,
): PatchedEntryPoint | undefined {
  const current = currentValue(target, key, label);
  if (typeof current !== "function") {
    if (required) {
      installationFailure(label);
    }
    return undefined;
  }

  const entryPoint = { target, key, label } satisfies PatchedEntryPoint;
  if (current === denyNetworkAccess) {
    return entryPoint;
  }

  let patched = false;
  try {
    patched = Reflect.set(target, key, denyNetworkAccess);
    if (!patched) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (descriptor?.configurable === true) {
        const replacement: PropertyDescriptor =
          "value" in descriptor
            ? { ...descriptor, value: denyNetworkAccess }
            : {
                configurable: descriptor.configurable,
                enumerable: descriptor.enumerable,
                value: denyNetworkAccess,
                writable: true,
              };
        patched = Reflect.defineProperty(target, key, replacement);
      }
    }
  } catch {
    patched = false;
  }

  if (!patched) {
    installationFailure(label);
  }
  verifyPatched(entryPoint);
  return entryPoint;
}

function patchConnectAsync(
  target: object | undefined,
  label: string,
): PatchedEntryPoint | undefined {
  return target === undefined ? undefined : patchFunction(target, "connectAsync", label, false);
}

/** Install a process-terminal network tripwire for offline provider SDK inspection. */
export function installOfflineGuard(): OfflineGuardHandle {
  if (installed) {
    return guardHandle;
  }

  const patchedEntryPoints = [
    patchFunction(globalThis, "fetch", "fetch"),
    patchFunction(http, "request", "http.request"),
    patchFunction(http, "get", "http.get"),
    patchFunction(https, "request", "https.request"),
    patchFunction(https, "get", "https.get"),
    patchFunction(net, "connect", "net.connect"),
    patchFunction(net, "createConnection", "net.createConnection"),
    patchFunction(net.Socket.prototype, "connect", "net.Socket.prototype.connect"),
    patchConnectAsync(net, "net.connectAsync"),
    patchConnectAsync(net.Socket.prototype, "net.Socket.prototype.connectAsync"),
    patchFunction(tls, "connect", "tls.connect"),
    patchConnectAsync(tls, "tls.connectAsync"),
    patchConnectAsync(tls.TLSSocket?.prototype, "tls.TLSSocket.prototype.connectAsync"),
  ].filter((entryPoint): entryPoint is PatchedEntryPoint => entryPoint !== undefined);

  try {
    syncBuiltinESMExports();
  } catch {
    installationFailure("node built-in exports");
  }
  for (const entryPoint of patchedEntryPoints) {
    verifyPatched(entryPoint);
  }
  installed = true;
  return guardHandle;
}
