const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record, key) {
  return Object.hasOwn(record, key);
}

export function parseVersion(value) {
  const match = typeof value === "string" ? VERSION_PATTERN.exec(value) : null;
  requireCondition(match !== null, `Noncanonical registry SemVer: ${value}`);
  const prerelease = match[4]?.split(".") ?? [];
  for (const identifier of prerelease) {
    requireCondition(identifier.length > 0, `Empty prerelease identifier: ${value}`);
    if (/^\d+$/.test(identifier)) {
      requireCondition(
        identifier === "0" || !identifier.startsWith("0"),
        `Noncanonical prerelease identifier: ${value}`,
      );
    }
  }
  return {
    main: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: prerelease.map((identifier) =>
      /^\d+$/.test(identifier) ? BigInt(identifier) : identifier,
    ),
  };
}

export function validatePublishableVersion(value) {
  const version = parseVersion(value);
  requireCondition(value !== "0.0.0", "Placeholder release version 0.0.0 is not publishable");
  return version;
}

export function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  for (let index = 0; index < 3; index += 1) {
    const leftPart = left.main[index];
    const rightPart = right.main[index];
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      if (leftPart === rightPart) return 0;
      return leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "bigint" && typeof rightPart !== "bigint") return -1;
    if (typeof leftPart !== "bigint" && typeof rightPart === "bigint") return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function releaseChannel(version) {
  return validatePublishableVersion(version).prerelease.length === 0 ? "latest" : "next";
}

export function validateReleasePolicy(input) {
  requireCondition(isRecord(input), "Invalid release policy input");
  const { candidate, packument } = input;
  const channel = releaseChannel(candidate);
  requireCondition(isRecord(packument), "Invalid packument");
  requireCondition(packument.name === "@solwyn/sdk", "Unexpected package name in packument");
  requireCondition(isRecord(packument.versions), "Invalid packument versions");
  requireCondition(isRecord(packument["dist-tags"]), "Invalid packument dist-tags");
  requireCondition(!hasOwn(packument.versions, candidate), `Version ${candidate} already exists`);

  const tags = packument["dist-tags"];
  for (const name of ["latest", "next"]) {
    if (!hasOwn(tags, name)) continue;
    const current = tags[name];
    requireCondition(typeof current === "string", `Invalid ${name} dist-tag`);
    requireCondition(hasOwn(packument.versions, current), `${name} points to an unknown version`);
    parseVersion(current);
  }

  const guardedChannels = channel === "next" ? ["latest", "next"] : ["latest"];
  for (const name of guardedChannels) {
    if (!hasOwn(tags, name)) continue;
    const current = tags[name];
    requireCondition(
      compareVersions(candidate, current) > 0,
      `${candidate} would roll back ${name} from ${current}`,
    );
  }
  return { channel };
}
