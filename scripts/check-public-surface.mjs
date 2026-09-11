#!/usr/bin/env node

/**
 * Public-release policy scanner.
 *
 * This checks repository-specific leak signatures and filesystem references. It is not a
 * credential scanner: release verification must also run a real secret scanner and include a
 * manual content review.
 *
 * The only content allowlist is deliberately narrow. In this file alone, a line containing one
 * quoted policy value followed by `// public-surface-policy-literal` is exempt from text matching.
 * No file or directory is skipped by that allowlist.
 */
import { execFileSync } from "node:child_process";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const SCANNER_RELATIVE_PATH = "scripts/check-public-surface.mjs";
const POLICY_LITERAL_MARKER = "// public-surface-policy-literal";
const MARKDOWN_EXTENSION = /\.mdx?$/iu;
const HTML_EXTENSION = /\.html?$/iu;
const SOURCE_MAP_EXTENSION = /\.map$/iu;
const SAFE_BINARY_EXTENSION =
  /\.(?:7z|avif|bmp|br|eot|gif|gz|ico|jpe?g|mp3|mp4|otf|pdf|png|tar|tgz|ttf|wasm|wav|webm|webp|woff2?|zip)$/iu;
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/iu;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/iu;
const MAX_INLINE_SOURCE_MAP_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_MAP_DEPTH = 64;
const HTML_RAW_TEXT_ELEMENTS = new Set([
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);

const INTERNAL_PATH_LITERALS = [
  "docs/porting", // public-surface-policy-literal
  "docs/reviews", // public-surface-policy-literal
  "core/shared", // public-surface-policy-literal
];
const INACCURATE_CLAIM_LITERALS = [
  "never computes cost", // public-surface-policy-literal
  "never sees your prompts", // public-surface-policy-literal
  "prompts never leave", // public-surface-policy-literal
];
const PLANNING_SIGNATURE_LITERALS = [
  "solwyn-typescript-public-launch-execution-plan.md", // public-surface-policy-literal
  "Planning baseline:", // public-surface-policy-literal
  "private old-to-new commit mapping", // public-surface-policy-literal
];
const PERSONAL_PATH_EXAMPLES = [
  "/Users/christian", // public-surface-policy-literal
];
const ALLOWED_POLICY_LITERAL_DECLARATIONS = new Set(
  [
    ...INTERNAL_PATH_LITERALS,
    ...INACCURATE_CLAIM_LITERALS,
    ...PLANNING_SIGNATURE_LITERALS,
    ...PERSONAL_PATH_EXAMPLES,
  ].map((literal) => `${JSON.stringify(literal)}, ${POLICY_LITERAL_MARKER}`),
);

const PROHIBITED_LITERAL_RULES = [
  ...INTERNAL_PATH_LITERALS.map((literal) => ({
    literal,
    message: "prohibited internal path",
  })),
  ...INACCURATE_CLAIM_LITERALS.map((literal) => ({
    literal,
    message: "prohibited inaccurate public claim",
  })),
  ...PLANNING_SIGNATURE_LITERALS.map((literal) => ({
    literal,
    message: "prohibited private planning signature",
  })),
].map((rule) => ({ ...rule, normalizedLiteral: rule.literal.toLowerCase() }));

const unixHomePrefix = ["Users", "home"].join("|");
const personalPathBoundary = `[\\s'"${String.fromCodePoint(96)}(=:\\[>]`;
const PERSONAL_UNIX_PATH = new RegExp(
  `(?:^|${personalPathBoundary})/(?:${unixHomePrefix})/[^/\\s'"<>]+`,
  "iu",
);
const PERSONAL_UNIX_URI = new RegExp(
  `(?:^|[^a-z\\d+.-])[a-z][a-z\\d+.-]*:/{2,3}(?:${unixHomePrefix})/[^/\\s'"<>]+`,
  "iu",
);
const PERSONAL_WINDOWS_PATH = new RegExp(
  `(?:^|${personalPathBoundary})[a-z]:[\\\\/]${"Users"}[\\\\/][^\\\\/\\s'"<>]+`,
  "iu",
);
const PERSONAL_WINDOWS_URI = new RegExp(
  `(?:^|[^a-z\\d+.-])[a-z][a-z\\d+.-]*:/{2,3}[a-z]:[\\\\/]${"Users"}[\\\\/][^\\\\/\\s'"<>]+`,
  "iu",
);
const PUBLIC_HTTP_URL = /\bhttps?:\/\/[^\s'"<>`]+/giu;

function escapeForDisplay(value) {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      escaped += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else escaped += character;
  }
  return escaped;
}

function normalizePath(value) {
  return value.split(sep).join("/");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiresUtf8(relativePath) {
  const pathParts = relativePath.split("/");
  const filename = pathParts.at(-1) ?? "";
  return !SAFE_BINARY_EXTENSION.test(filename);
}

function isWithinRoot(root, candidate) {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`))
  );
}

function buildCandidatePaths(entries) {
  const candidates = new Set([""]);
  for (const entry of entries) {
    let candidate = entry.relativePath;
    while (candidate !== "") {
      candidates.add(candidate);
      const separator = candidate.lastIndexOf("/");
      candidate = separator === -1 ? "" : candidate.slice(0, separator);
    }
  }
  return candidates;
}

function isCandidatePath(context, absolutePath) {
  if (!isWithinRoot(context.root, absolutePath)) return false;
  return context.candidatePaths.has(normalizePath(relative(context.root, absolutePath)));
}

function lineNumberAt(contents, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (contents.codePointAt(index) === 10) line += 1;
  }
  return line;
}

function isAllowedPolicyLiteral(relativePath, line) {
  return (
    relativePath === SCANNER_RELATIVE_PATH && ALLOWED_POLICY_LITERAL_DECLARATIONS.has(line.trim())
  );
}

function prohibitedMessage(value) {
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  for (const rule of PROHIBITED_LITERAL_RULES) {
    if (normalized.includes(rule.normalizedLiteral)) return rule.message;
  }
  for (const match of value.matchAll(PUBLIC_HTTP_URL)) {
    const query = match[0].indexOf("?");
    const fragment = match[0].indexOf("#");
    const dataIndexes = [query, fragment].filter((index) => index !== -1);
    if (dataIndexes.length === 0) continue;
    let decodedData = match[0].slice(Math.min(...dataIndexes));
    try {
      decodedData = decodeURIComponent(decodedData);
    } catch {
      // Raw query/fragment data is still checked below.
    }
    if (containsPersonalPath(decodedData)) return "prohibited personal absolute path";
  }
  const localText = value.replace(PUBLIC_HTTP_URL, "");
  if (containsPersonalPath(localText)) return "prohibited personal absolute path";
  return undefined;
}

function containsPersonalPath(value) {
  if (
    PERSONAL_UNIX_PATH.test(value) ||
    PERSONAL_UNIX_URI.test(value) ||
    PERSONAL_WINDOWS_PATH.test(value) ||
    PERSONAL_WINDOWS_URI.test(value)
  ) {
    return true;
  }
  return false;
}

function inspectProhibitedText(relativePath, contents, findings) {
  const lines = contents.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (isAllowedPolicyLiteral(relativePath, line)) continue;
    const message = prohibitedMessage(line);
    if (message !== undefined) findings.push({ relativePath, line: index + 1, message });
  }
}

function parseMarkdownDestination(rawDestination) {
  const trimmed = rawDestination.trim();
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">");
    return end === -1 ? undefined : trimmed.slice(1, end);
  }
  return trimmed.match(/^\S+/u)?.[0];
}

function stripQueryAndFragment(value) {
  const query = value.indexOf("?");
  const fragment = value.indexOf("#");
  const indexes = [query, fragment].filter((index) => index !== -1);
  return indexes.length === 0 ? value : value.slice(0, Math.min(...indexes));
}

function findFencedCodeRanges(contents) {
  const ranges = [];
  let activeFence;
  let offset = 0;
  while (offset <= contents.length) {
    const newline = contents.indexOf("\n", offset);
    const lineEnd = newline === -1 ? contents.length : newline;
    const line = contents.slice(offset, lineEnd).replace(/\r$/u, "");
    const marker = line.match(/^[ ]{0,3}(`{3,}|~{3,})(.*)$/u);
    if (marker !== null) {
      const fence = marker[1];
      if (activeFence === undefined) {
        if (fence[0] !== "`" || !marker[2].includes("`")) {
          activeFence = { character: fence[0], length: fence.length, start: offset };
        }
      } else if (
        fence[0] === activeFence.character &&
        fence.length >= activeFence.length &&
        marker[2].trim() === ""
      ) {
        ranges.push({ start: activeFence.start, end: newline === -1 ? lineEnd : newline + 1 });
        activeFence = undefined;
      }
    }
    if (newline === -1) break;
    offset = newline + 1;
  }
  if (activeFence !== undefined) ranges.push({ start: activeFence.start, end: contents.length });
  return ranges;
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else merged.push({ ...range });
  }
  return merged;
}

function rangeContaining(offset, ranges) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = ranges[middle];
    if (offset < range.start) high = middle - 1;
    else if (offset >= range.end) low = middle + 1;
    else return range;
  }
  return undefined;
}

function isInsideRanges(offset, ranges) {
  return rangeContaining(offset, ranges) !== undefined;
}

function markdownIndent(value, initialWidth = 0) {
  let characters = 0;
  let width = initialWidth;
  while (characters < value.length) {
    if (value[characters] === " ") width += 1;
    else if (value[characters] === "\t") width += 4 - (width % 4);
    else break;
    characters += 1;
  }
  return { characters, width };
}

function markdownListMarker(line, activeListIndents) {
  const leading = markdownIndent(line);
  const remainder = line.slice(leading.characters);
  const marker = remainder.match(/^([-+*]|\d{1,9}[.)])(?=[ \t]|$)/u)?.[1];
  if (
    marker === undefined ||
    (leading.width > 3 && !activeListIndents.some((indent) => indent <= leading.width))
  ) {
    return undefined;
  }
  const afterMarker = remainder.slice(marker.length);
  const padding = markdownIndent(afterMarker, leading.width + marker.length);
  const paddingWidth = padding.width - leading.width - marker.length;
  return {
    contentIndent:
      leading.width + marker.length + (paddingWidth === 0 || paddingWidth > 4 ? 1 : paddingWidth),
    leadingWidth: leading.width,
  };
}

function findMarkdownCodeRanges(contents) {
  const fencedRanges = findFencedCodeRanges(contents);
  const indentedRanges = [];
  const activeListIndents = [];
  let blankLines = 0;
  let lineOffset = 0;
  while (lineOffset < contents.length) {
    const newline = contents.indexOf("\n", lineOffset);
    const lineEnd = newline === -1 ? contents.length : newline + 1;
    const line = contents.slice(lineOffset, lineEnd);
    if (!isInsideRanges(lineOffset, fencedRanges)) {
      const contentLine = line.replace(/\r?\n$/u, "");
      if (contentLine.trim() === "") {
        blankLines += 1;
        if (blankLines >= 2) activeListIndents.length = 0;
      } else {
        blankLines = 0;
        const leading = markdownIndent(contentLine);
        while ((activeListIndents.at(-1) ?? -1) > leading.width) activeListIndents.pop();
        const listMarker = markdownListMarker(contentLine, activeListIndents);
        if (listMarker !== undefined) {
          while ((activeListIndents.at(-1) ?? -1) > listMarker.leadingWidth) {
            activeListIndents.pop();
          }
          activeListIndents.push(listMarker.contentIndent);
        } else {
          const listIndent = activeListIndents.at(-1);
          const codeIndent = (listIndent ?? 0) + 4;
          if (leading.width >= codeIndent) {
            indentedRanges.push({ start: lineOffset, end: lineEnd });
          }
          if (listIndent === undefined || leading.width < listIndent) activeListIndents.length = 0;
        }
      }
    }
    lineOffset = lineEnd;
  }
  const blockRanges = mergeRanges([...fencedRanges, ...indentedRanges]);
  const backtickRuns = [];
  const lastRunByLength = new Map();
  let offset = 0;
  while (offset < contents.length) {
    const range = rangeContaining(offset, blockRanges);
    if (range !== undefined) {
      lastRunByLength.clear();
      offset = range.end;
      continue;
    }
    const candidate = contents.indexOf("`", offset);
    if (candidate === -1) break;
    const containingRange = rangeContaining(candidate, blockRanges);
    if (containingRange !== undefined) {
      lastRunByLength.clear();
      offset = containingRange.end;
      continue;
    }
    let markerLength = 1;
    while (contents[candidate + markerLength] === "`") markerLength += 1;
    if (isEscapedCharacter(contents, candidate)) {
      offset = candidate + markerLength;
      continue;
    }
    const run = {
      end: candidate + markerLength,
      index: backtickRuns.length,
      length: markerLength,
      nextSameLength: undefined,
      start: candidate,
    };
    const previous = lastRunByLength.get(markerLength);
    if (previous !== undefined) previous.nextSameLength = run;
    backtickRuns.push(run);
    lastRunByLength.set(markerLength, run);
    offset = candidate + markerLength;
  }
  const inlineRanges = [];
  let runIndex = 0;
  while (runIndex < backtickRuns.length) {
    const opening = backtickRuns[runIndex];
    const closing = opening.nextSameLength;
    if (closing === undefined) runIndex += 1;
    else {
      inlineRanges.push({ start: opening.start, end: closing.end });
      runIndex = closing.index + 1;
    }
  }
  return mergeRanges([...blockRanges, ...inlineRanges]);
}

function isEscapedCharacter(contents, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && contents[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function findMarkdownLabelClosings(contents, codeRanges) {
  const openings = [];
  const closings = new Set();
  let lineHasContent = false;
  let sawLineBreak = false;
  let offset = 0;
  while (offset < contents.length) {
    const codeRange = rangeContaining(offset, codeRanges);
    if (codeRange !== undefined) {
      const code = contents.slice(codeRange.start, codeRange.end);
      if (code.includes("\n")) {
        openings.length = 0;
        lineHasContent = false;
        sawLineBreak = true;
      } else if (code.trim() !== "") lineHasContent = true;
      offset = codeRange.end;
      continue;
    }
    if (contents[offset] === "\\") {
      lineHasContent = true;
      offset += 2;
      continue;
    }
    if (contents[offset] === "\n") {
      if (sawLineBreak && !lineHasContent) openings.length = 0;
      lineHasContent = false;
      sawLineBreak = true;
      offset += 1;
      continue;
    }
    if (!/\s/u.test(contents[offset])) lineHasContent = true;
    if (contents[offset] === "[") openings.push(offset);
    else if (contents[offset] === "]") {
      const opening = openings.pop();
      if (opening !== undefined) closings.add(offset);
    }
    offset += 1;
  }
  return closings;
}

function findClosingMarkdownParentheses(contents, codeRanges) {
  const openingParentheses = [];
  const closingByOpening = new Map();
  let offset = 0;
  while (offset < contents.length) {
    const codeRange = rangeContaining(offset, codeRanges);
    if (codeRange !== undefined) {
      offset = codeRange.end;
      continue;
    }
    if (contents[offset] === "\\") {
      offset += 2;
      continue;
    }
    if (contents[offset] === "(") openingParentheses.push(offset);
    else if (contents[offset] === ")") {
      const opening = openingParentheses.pop();
      if (opening !== undefined) closingByOpening.set(opening, offset);
    }
    offset += 1;
  }
  return closingByOpening;
}

function findMarkdownDestinations(contents, codeRanges) {
  const matches = [];
  const labelClosings = findMarkdownLabelClosings(contents, codeRanges);
  const closingByOpening = findClosingMarkdownParentheses(contents, codeRanges);
  let marker = contents.indexOf("](");
  while (marker !== -1) {
    if (isInsideRanges(marker, codeRanges) || !labelClosings.has(marker)) {
      marker = contents.indexOf("](", marker + 2);
      continue;
    }
    const start = marker + 2;
    if (contents[start] === "<") {
      let pointyEnd = start + 1;
      while (
        pointyEnd < contents.length &&
        contents[pointyEnd] !== ">" &&
        contents[pointyEnd] !== "\n" &&
        contents[pointyEnd] !== "\r"
      ) {
        pointyEnd += 1;
      }
      if (contents[pointyEnd] === ">") {
        let closing = pointyEnd + 1;
        while (/\s/u.test(contents[closing] ?? "")) closing += 1;
        const titleDelimiter = contents[closing];
        if (titleDelimiter === '"' || titleDelimiter === "'") {
          closing += 1;
          while (
            closing < contents.length &&
            (contents[closing] !== titleDelimiter || isEscapedCharacter(contents, closing))
          ) {
            closing += 1;
          }
          if (contents[closing] === titleDelimiter) closing += 1;
          while (/\s/u.test(contents[closing] ?? "")) closing += 1;
        }
        if (contents[closing] === ")") {
          matches.push({ destination: contents.slice(start, pointyEnd + 1), index: marker });
        }
      }
      marker = contents.indexOf("](", marker + 2);
      continue;
    }
    const closing = closingByOpening.get(marker + 1);
    if (closing !== undefined) {
      matches.push({ destination: contents.slice(start, closing), index: marker });
    }
    marker = contents.indexOf("](", marker + 2);
  }

  for (const match of contents.matchAll(/^[\t ]{0,3}\[[^\]\n]+\]:[\t ]*(<[^>\n]+>|\S+)/gmu)) {
    if (!isInsideRanges(match.index, codeRanges)) {
      matches.push({ destination: match[1], index: match.index });
    }
  }
  return matches.sort((left, right) => left.index - right.index);
}

async function inspectMarkdownLinks(
  context,
  absolutePath,
  relativePath,
  contents,
  findings,
  codeRanges,
) {
  const { root } = context;
  for (const match of contents.matchAll(/<([^<>\n]+)>/gu)) {
    if (!isInsideRanges(match.index, codeRanges) && match[1].toLowerCase().startsWith("file:")) {
      findings.push({
        relativePath,
        line: lineNumberAt(contents, match.index),
        message: "prohibited file URL Markdown target",
      });
    }
  }
  const destinationMatches = findMarkdownDestinations(contents, codeRanges);
  for (const match of destinationMatches) {
    const destination = parseMarkdownDestination(match.destination);
    if (destination?.toLowerCase().startsWith("file:")) {
      findings.push({
        relativePath,
        line: lineNumberAt(contents, match.index),
        message: "prohibited file URL Markdown target",
      });
      continue;
    }
    if (
      destination === undefined ||
      destination === "" ||
      destination.startsWith("#") ||
      destination.startsWith("/") ||
      destination.startsWith("//") ||
      URI_SCHEME.test(destination)
    ) {
      continue;
    }

    const localReference = stripQueryAndFragment(destination).replaceAll(/\\([\\()[\]])/gu, "$1");
    if (localReference === "") continue;
    if (prohibitedMessage(localReference) !== undefined) {
      findings.push({
        relativePath,
        line: lineNumberAt(contents, match.index),
        message: "prohibited signature in Markdown target",
      });
      continue;
    }

    let decodedReference;
    try {
      decodedReference = decodeURIComponent(localReference);
    } catch {
      findings.push({
        relativePath,
        line: lineNumberAt(contents, match.index),
        message: "invalid repository-relative Markdown target",
      });
      continue;
    }
    if (prohibitedMessage(decodedReference) !== undefined) {
      findings.push({
        relativePath,
        line: lineNumberAt(contents, match.index),
        message: "prohibited signature in Markdown target",
      });
      continue;
    }

    const targetPath = resolve(dirname(absolutePath), decodedReference);
    if (!isWithinRoot(root, targetPath)) {
      findings.push({
        relativePath,
        line: lineNumberAt(contents, match.index),
        message: "repository-relative Markdown target escapes scan root",
      });
      continue;
    }

    try {
      const resolvedTarget = await realpath(targetPath);
      if (!isWithinRoot(root, resolvedTarget)) {
        findings.push({
          relativePath,
          line: lineNumberAt(contents, match.index),
          message: "repository-relative Markdown target escapes scan root",
        });
      } else if (
        !isCandidatePath(context, targetPath) ||
        !isCandidatePath(context, resolvedTarget)
      ) {
        findings.push({
          relativePath,
          line: lineNumberAt(contents, match.index),
          message: "repository-relative Markdown target is outside the candidate surface",
        });
      }
    } catch {
      findings.push({
        relativePath,
        line: lineNumberAt(contents, match.index),
        message: "missing repository-relative Markdown target",
      });
    }
  }
}

function decodeHtmlCharacterReferences(value) {
  const namedReferences = new Map([
    ["amp", "&"],
    ["apos", "'"],
    ["bsol", "\\"],
    ["colon", ":"],
    ["gt", ">"],
    ["lt", "<"],
    ["period", "."],
    ["quot", '"'],
    ["sol", "/"],
  ]);
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/giu,
    (reference, decimal, hexadecimal, name) => {
      if (name !== undefined) return namedReferences.get(name.toLowerCase()) ?? reference;
      const codePoint = Number.parseInt(decimal ?? hexadecimal, decimal === undefined ? 16 : 10);
      if (
        !Number.isSafeInteger(codePoint) ||
        codePoint <= 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return reference;
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

function findHtmlRawTextClosing(lowerContents, tagName, start) {
  if (tagName === "plaintext") return undefined;
  const closingPrefix = `</${tagName}`;
  let candidate = lowerContents.indexOf(closingPrefix, start);
  while (candidate !== -1) {
    const boundary = lowerContents[candidate + closingPrefix.length];
    if (boundary === undefined || /[\t\n\f\r />]/u.test(boundary)) return candidate;
    candidate = lowerContents.indexOf(closingPrefix, candidate + closingPrefix.length);
  }
  return undefined;
}

function findHtmlTargets(contents) {
  const matches = [];
  const lowerContents = contents.toLowerCase();
  let cursor = 0;
  while (cursor < contents.length) {
    const tagStart = contents.indexOf("<", cursor);
    if (tagStart === -1) break;
    if (contents.startsWith("<!--", tagStart)) {
      const commentEnd = contents.indexOf("-->", tagStart + 4);
      cursor = commentEnd === -1 ? contents.length : commentEnd + 3;
      continue;
    }

    let quote;
    let tagEnd = tagStart + 1;
    for (; tagEnd < contents.length; tagEnd += 1) {
      const character = contents[tagEnd];
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (tagEnd === contents.length) break;

    const tag = contents.slice(tagStart + 1, tagEnd);
    const tagName = tag.match(/^([a-z][^\t\n\f\r />]*)/iu)?.[1].toLowerCase();
    if (/^\/?[a-z]/iu.test(tag)) {
      const attributePattern =
        /(?:^|[\t\n\f\r ])(xlink:href|formaction|srcset|poster|action|href|src|data)[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r "'=<>`]+))/giu;
      for (const attribute of tag.matchAll(attributePattern)) {
        matches.push({
          attribute: attribute[1].toLowerCase(),
          destination: attribute[2] ?? attribute[3] ?? attribute[4] ?? "",
          index: tagStart + 1 + attribute.index,
        });
      }
    }
    if (
      tagName !== undefined &&
      HTML_RAW_TEXT_ELEMENTS.has(tagName) &&
      !tag.trimEnd().endsWith("/")
    ) {
      const closing = findHtmlRawTextClosing(lowerContents, tagName, tagEnd + 1);
      cursor = closing ?? contents.length;
      continue;
    }
    cursor = tagEnd + 1;
  }
  return matches;
}

function findSrcsetCandidates(value) {
  const candidates = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (cursor < value.length && (/[\t\n\f\r ]/u.test(value[cursor]) || value[cursor] === ",")) {
      cursor += 1;
    }
    if (cursor === value.length) break;
    const start = cursor;
    while (cursor < value.length && !/[\t\n\f\r ]/u.test(value[cursor])) cursor += 1;
    let destination = value.slice(start, cursor);
    const endedWithComma = destination.endsWith(",");
    if (endedWithComma) destination = destination.replace(/,+$/u, "");
    if (destination !== "") candidates.push(destination);
    if (endedWithComma) continue;

    let parentheses = 0;
    while (cursor < value.length) {
      if (value[cursor] === "(") parentheses += 1;
      else if (value[cursor] === ")" && parentheses > 0) parentheses -= 1;
      else if (value[cursor] === "," && parentheses === 0) {
        cursor += 1;
        break;
      }
      cursor += 1;
    }
  }
  return candidates;
}

async function inspectHtmlDestination(
  context,
  absolutePath,
  relativePath,
  contents,
  findings,
  destination,
  index,
) {
  const { root } = context;
  const line = lineNumberAt(contents, index);
  if (destination.toLowerCase().startsWith("file:")) {
    findings.push({ relativePath, line, message: "prohibited file URL HTML target" });
    return;
  }
  if (prohibitedMessage(destination) !== undefined) {
    findings.push({ relativePath, line, message: "prohibited signature in HTML target" });
    return;
  }
  if (
    destination === "" ||
    destination.startsWith("#") ||
    destination.startsWith("/") ||
    URI_SCHEME.test(destination)
  ) {
    return;
  }

  const localReference = stripQueryAndFragment(destination);
  if (localReference === "") return;
  let decodedReference;
  try {
    decodedReference = decodeURIComponent(localReference);
  } catch {
    findings.push({
      relativePath,
      line,
      message: "invalid source-relative HTML target",
    });
    return;
  }
  if (decodedReference.toLowerCase().startsWith("file:")) {
    findings.push({ relativePath, line, message: "prohibited file URL HTML target" });
    return;
  }
  if (prohibitedMessage(decodedReference) !== undefined) {
    findings.push({ relativePath, line, message: "prohibited signature in HTML target" });
    return;
  }

  const targetPath = resolve(dirname(absolutePath), decodedReference);
  if (!isWithinRoot(root, targetPath)) {
    findings.push({
      relativePath,
      line,
      message: "source-relative HTML target escapes scan root",
    });
    return;
  }
  try {
    const resolvedTarget = await realpath(targetPath);
    if (!isWithinRoot(root, resolvedTarget)) {
      findings.push({
        relativePath,
        line,
        message: "source-relative HTML target escapes scan root",
      });
    } else if (!isCandidatePath(context, targetPath) || !isCandidatePath(context, resolvedTarget)) {
      findings.push({
        relativePath,
        line,
        message: "source-relative HTML target is outside the candidate surface",
      });
    }
  } catch {
    findings.push({
      relativePath,
      line,
      message: "missing source-relative HTML target",
    });
  }
}

async function inspectHtmlTargets(
  context,
  absolutePath,
  relativePath,
  contents,
  findings,
  codeRanges,
) {
  for (const match of findHtmlTargets(contents)) {
    if (isInsideRanges(match.index, codeRanges)) continue;
    const destination = decodeHtmlCharacterReferences(match.destination.trim());
    const destinations =
      match.attribute === "srcset" ? findSrcsetCandidates(destination) : [destination];
    for (const candidate of destinations) {
      await inspectHtmlDestination(
        context,
        absolutePath,
        relativePath,
        contents,
        findings,
        candidate,
        match.index,
      );
    }
  }
}

function isAbsoluteFilesystemReference(value) {
  return (
    isAbsolute(value) ||
    WINDOWS_ABSOLUTE_PATH.test(value) ||
    value.toLowerCase().startsWith("file:")
  );
}

function isNonFileUrl(value) {
  return (
    value.startsWith("//") || (URI_SCHEME.test(value) && !value.toLowerCase().startsWith("file:"))
  );
}

function inspectSourceMapDocument(relativePath, sourceMap, findings, depth = 0) {
  if (depth > MAX_SOURCE_MAP_DEPTH) {
    findings.push({
      relativePath,
      message: `source map nesting exceeds the ${MAX_SOURCE_MAP_DEPTH}-level limit`,
    });
    return;
  }
  if (sourceMap === null || typeof sourceMap !== "object" || Array.isArray(sourceMap)) {
    findings.push({ relativePath, message: "invalid source map document" });
    return;
  }

  if (sourceMap.sourceRoot !== undefined && typeof sourceMap.sourceRoot !== "string") {
    findings.push({ relativePath, message: "invalid source map document" });
  } else if (typeof sourceMap.sourceRoot === "string") {
    inspectProhibitedText(relativePath, sourceMap.sourceRoot, findings);
    if (isAbsoluteFilesystemReference(sourceMap.sourceRoot)) {
      findings.push({ relativePath, message: "source map contains an absolute local source path" });
    }
  }

  if (sourceMap.sources !== undefined && !Array.isArray(sourceMap.sources)) {
    findings.push({ relativePath, message: "invalid source map document" });
  } else if (Array.isArray(sourceMap.sources)) {
    for (const source of sourceMap.sources) {
      if (typeof source !== "string") {
        findings.push({ relativePath, message: "invalid source map document" });
        continue;
      }
      inspectProhibitedText(relativePath, source, findings);
      if (isAbsoluteFilesystemReference(source)) {
        findings.push({
          relativePath,
          message: "source map contains an absolute local source path",
        });
      }
    }
  }

  if (sourceMap.sourcesContent !== undefined && !Array.isArray(sourceMap.sourcesContent)) {
    findings.push({ relativePath, message: "invalid source map document" });
  } else if (Array.isArray(sourceMap.sourcesContent)) {
    for (const sourceContent of sourceMap.sourcesContent) {
      if (sourceContent !== null && typeof sourceContent !== "string") {
        findings.push({ relativePath, message: "invalid source map document" });
      } else if (typeof sourceContent === "string") {
        inspectProhibitedText(relativePath, sourceContent, findings);
      }
    }
  }

  if (sourceMap.sections !== undefined && !Array.isArray(sourceMap.sections)) {
    findings.push({ relativePath, message: "invalid indexed source map" });
  } else if (Array.isArray(sourceMap.sections)) {
    for (const section of sourceMap.sections) {
      if (
        section === null ||
        typeof section !== "object" ||
        Array.isArray(section) ||
        !("map" in section)
      ) {
        findings.push({ relativePath, message: "invalid indexed source map" });
      } else inspectSourceMapDocument(relativePath, section.map, findings, depth + 1);
    }
  }
}

function inspectSourceMap(relativePath, contents, findings) {
  let sourceMap;
  try {
    sourceMap = JSON.parse(contents);
  } catch {
    findings.push({ relativePath, message: "invalid source map JSON" });
    return;
  }
  inspectSourceMapDocument(relativePath, sourceMap, findings);
}

function inspectJson(relativePath, contents, findings) {
  let document;
  try {
    document = JSON.parse(contents);
  } catch {
    findings.push({ relativePath, message: "invalid JSON document" });
    return;
  }

  const pending = [document];
  while (pending.length !== 0) {
    const value = pending.pop();
    if (typeof value === "string") inspectProhibitedText(relativePath, value, findings);
    else if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        inspectProhibitedText(relativePath, key, findings);
        pending.push(child);
      }
    }
  }
}

function inlineSourceMapError(message) {
  return { error: message };
}

function decodedPercentPayloadSize(payload) {
  let bytes = 0;
  for (let index = 0; index < payload.length; ) {
    if (payload[index] === "%") {
      if (!/^[\da-f]{2}$/iu.test(payload.slice(index + 1, index + 3))) return undefined;
      bytes += 1;
      index += 3;
    } else {
      const codePoint = payload.codePointAt(index);
      const character = String.fromCodePoint(codePoint);
      bytes += Buffer.byteLength(character);
      index += character.length;
    }
    if (bytes > MAX_INLINE_SOURCE_MAP_BYTES) return bytes;
  }
  return bytes;
}

function decodeInlineSourceMap(reference) {
  const comma = reference.indexOf(",");
  if (comma === -1) return inlineSourceMapError("malformed inline source map data URL");
  const metadata = reference.slice(5, comma).split(";");
  const mediaType = metadata.shift()?.toLowerCase();
  if (mediaType !== "application/json") {
    return inlineSourceMapError("unsupported inline source map data URL");
  }

  let isBase64 = false;
  for (const rawParameter of metadata) {
    const parameter = rawParameter.toLowerCase();
    if (parameter === "base64" && !isBase64) isBase64 = true;
    else if (parameter !== "charset=utf-8" && parameter !== "charset=utf8") {
      return inlineSourceMapError("unsupported inline source map data URL");
    }
  }

  const payload = reference.slice(comma + 1);
  let decodedBuffer;
  if (isBase64) {
    const maximumBase64Length = Math.ceil(MAX_INLINE_SOURCE_MAP_BYTES / 3) * 4 + 4;
    if (payload.length > maximumBase64Length) {
      return inlineSourceMapError(
        `inline source map exceeds the ${MAX_INLINE_SOURCE_MAP_BYTES}-byte limit`,
      );
    }
    if (!/^[a-z\d+/]*={0,2}$/iu.test(payload) || payload.length % 4 === 1) {
      return inlineSourceMapError("malformed inline source map data URL");
    }
    decodedBuffer = Buffer.from(payload, "base64");
    const canonicalPayload = decodedBuffer.toString("base64").replace(/=+$/u, "");
    if (canonicalPayload !== payload.replace(/=+$/u, "")) {
      return inlineSourceMapError("malformed inline source map data URL");
    }
  } else {
    const decodedSize = decodedPercentPayloadSize(payload);
    if (decodedSize === undefined) {
      return inlineSourceMapError("malformed inline source map data URL");
    }
    if (decodedSize > MAX_INLINE_SOURCE_MAP_BYTES) {
      return inlineSourceMapError(
        `inline source map exceeds the ${MAX_INLINE_SOURCE_MAP_BYTES}-byte limit`,
      );
    }
    try {
      decodedBuffer = Buffer.from(decodeURIComponent(payload), "utf8");
    } catch {
      return inlineSourceMapError("malformed inline source map data URL");
    }
  }

  if (decodedBuffer.byteLength > MAX_INLINE_SOURCE_MAP_BYTES) {
    return inlineSourceMapError(
      `inline source map exceeds the ${MAX_INLINE_SOURCE_MAP_BYTES}-byte limit`,
    );
  }
  const contents = decodeText(decodedBuffer);
  if (contents === undefined) {
    return inlineSourceMapError("malformed inline source map data URL");
  }
  return { contents };
}

async function inspectSourceMapReferences(context, absolutePath, relativePath, contents, findings) {
  const { root } = context;
  const referencePattern = /(?:\/\/[#@]|\/\*[#@])\s*sourceMappingURL=([^\s*]+)/gu;
  for (const match of contents.matchAll(referencePattern)) {
    const reference = match[1].replace(/["']$/u, "");
    if (reference.toLowerCase().startsWith("data:")) {
      const decoded = decodeInlineSourceMap(reference);
      if (decoded.error !== undefined) {
        findings.push({
          relativePath,
          line: lineNumberAt(contents, match.index),
          message: decoded.error,
        });
      } else {
        inspectProhibitedText(relativePath, decoded.contents, findings);
        inspectSourceMap(relativePath, decoded.contents, findings);
      }
      continue;
    }
    if (isNonFileUrl(reference)) continue;
    if (isAbsoluteFilesystemReference(reference)) {
      findings.push({
        relativePath,
        line: lineNumberAt(contents, match.index),
        message: "source map URL is an absolute local path",
      });
      continue;
    }
    const mapPath = resolve(dirname(absolutePath), stripQueryAndFragment(reference));
    if (!isWithinRoot(root, mapPath)) {
      findings.push({
        relativePath,
        line: lineNumberAt(contents, match.index),
        message: "source map URL escapes scan root",
      });
      continue;
    }
    try {
      const resolvedMapPath = await realpath(mapPath);
      if (!isWithinRoot(root, resolvedMapPath)) {
        findings.push({
          relativePath,
          line: lineNumberAt(contents, match.index),
          message: "source map URL escapes scan root",
        });
      } else if (!isCandidatePath(context, mapPath) || !isCandidatePath(context, resolvedMapPath)) {
        findings.push({
          relativePath,
          line: lineNumberAt(contents, match.index),
          message: "source map is outside the candidate surface",
        });
      }
    } catch {
      findings.push({
        relativePath,
        line: lineNumberAt(contents, match.index),
        message: "missing source map",
      });
    }
  }
}

async function inspectSymlink(context, absolutePath, relativePath, findings, indexedTarget) {
  const { root } = context;
  let rawTarget = indexedTarget;
  if (rawTarget === undefined) {
    try {
      rawTarget = await readlink(absolutePath);
    } catch {
      findings.push({ relativePath, message: "unreadable symlink" });
      return;
    }
  }
  if (isAbsoluteFilesystemReference(rawTarget)) {
    findings.push({ relativePath, message: "absolute symlink target" });
    return;
  }
  if (prohibitedMessage(rawTarget) !== undefined) {
    findings.push({ relativePath, message: "prohibited signature in symlink target" });
    return;
  }
  try {
    const lexicalTarget = resolve(dirname(absolutePath), rawTarget);
    const resolvedTarget = await realpath(lexicalTarget);
    if (!isWithinRoot(root, resolvedTarget)) {
      findings.push({ relativePath, message: "symlink escapes scan root" });
    } else if (!rawSymlinkComponentsAreCandidates(context, absolutePath, rawTarget)) {
      findings.push({
        relativePath,
        message: "symlink resolution component is outside the candidate surface",
      });
    } else if (
      !isCandidatePath(context, lexicalTarget) ||
      !isCandidatePath(context, resolvedTarget)
    ) {
      findings.push({ relativePath, message: "symlink target is outside the candidate surface" });
    }
  } catch {
    findings.push({ relativePath, message: "broken symlink" });
  }
}

function rawSymlinkComponentsAreCandidates(context, absolutePath, rawTarget) {
  let currentPath = dirname(absolutePath);
  const components = rawTarget.split("/");
  for (const [index, component] of components.entries()) {
    if (component === "" || component === ".") continue;
    if (component === "..") currentPath = dirname(currentPath);
    else {
      currentPath = resolve(currentPath, component);
      const hasLaterResolutionComponent = components
        .slice(index + 1)
        .some((candidate) => candidate !== "" && candidate !== ".");
      if (hasLaterResolutionComponent && !isCandidatePath(context, currentPath)) return false;
    }
  }
  return true;
}

function decodeText(buffer) {
  if (buffer.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

async function inspectEntry(context, entry, findings) {
  if (entry.relativePath.split("/").includes(".git")) {
    findings.push({
      relativePath: entry.relativePath,
      message: "prohibited Git metadata path",
    });
    return;
  }
  const pathMessage = prohibitedMessage(entry.relativePath);
  if (pathMessage !== undefined)
    findings.push({ relativePath: entry.relativePath, message: pathMessage });

  let metadata;
  try {
    metadata = await lstat(entry.absolutePath);
  } catch {
    findings.push({ relativePath: entry.relativePath, message: "candidate path is unreadable" });
    return;
  }
  if (entry.indexMode === "120000") {
    let worktreeTarget;
    try {
      if (metadata.isSymbolicLink()) worktreeTarget = await readlink(entry.absolutePath);
      else {
        const targetBuffer = await readFile(entry.absolutePath);
        worktreeTarget = decodeText(targetBuffer);
      }
    } catch {
      worktreeTarget = undefined;
    }
    if (entry.indexTarget === undefined || worktreeTarget === undefined) {
      findings.push({ relativePath: entry.relativePath, message: "unreadable symlink" });
      return;
    }
    for (const target of new Set([entry.indexTarget, worktreeTarget])) {
      await inspectSymlink(context, entry.absolutePath, entry.relativePath, findings, target);
    }
    return;
  }
  if (metadata.isSymbolicLink()) {
    await inspectSymlink(context, entry.absolutePath, entry.relativePath, findings);
    return;
  }
  if (!metadata.isFile()) {
    findings.push({ relativePath: entry.relativePath, message: "unsupported filesystem entry" });
    return;
  }

  let buffer;
  try {
    buffer = await readFile(entry.absolutePath);
  } catch {
    findings.push({ relativePath: entry.relativePath, message: "candidate file is unreadable" });
    return;
  }
  inspectProhibitedText(entry.relativePath, buffer.toString("latin1"), findings);
  const contents = decodeText(buffer);
  if (contents === undefined) {
    if (requiresUtf8(entry.relativePath)) {
      findings.push({
        relativePath: entry.relativePath,
        message: "text file is not valid UTF-8",
      });
    }
    return;
  }

  inspectProhibitedText(entry.relativePath, contents, findings);
  const isMarkdown = MARKDOWN_EXTENSION.test(entry.relativePath);
  const markdownCodeRanges = isMarkdown ? findMarkdownCodeRanges(contents) : [];
  if (isMarkdown) {
    await inspectMarkdownLinks(
      context,
      entry.absolutePath,
      entry.relativePath,
      contents,
      findings,
      markdownCodeRanges,
    );
  }
  if (isMarkdown || HTML_EXTENSION.test(entry.relativePath)) {
    await inspectHtmlTargets(
      context,
      entry.absolutePath,
      entry.relativePath,
      contents,
      findings,
      markdownCodeRanges,
    );
  }
  if (SOURCE_MAP_EXTENSION.test(entry.relativePath)) {
    inspectSourceMap(entry.relativePath, contents, findings);
  } else if (/\.json$/iu.test(entry.relativePath)) {
    inspectJson(entry.relativePath, contents, findings);
  }
  await inspectSourceMapReferences(
    context,
    entry.absolutePath,
    entry.relativePath,
    contents,
    findings,
  );
}

function runGit(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    if (cause !== null && typeof cause === "object" && cause.code === "ENOENT") {
      throw new Error("Git executable is unavailable", { cause });
    }
    throw new Error(`Git command failed: ${args[0] ?? "unknown"}`, { cause });
  }
}

function splitNullTerminated(output) {
  return output.split("\0").filter((value) => value !== "");
}

function collectIndexEntries(root) {
  const entries = new Map();
  const records = splitNullTerminated(runGit(root, ["ls-files", "--stage", "--full-name", "-z"]));
  for (const record of records) {
    const separator = record.indexOf("\t");
    if (separator === -1) continue;
    const [mode, objectId] = record.slice(0, separator).split(" ");
    const path = record.slice(separator + 1);
    entries.set(path, {
      mode,
      indexTarget: mode === "120000" ? runGit(root, ["cat-file", "blob", objectId]) : undefined,
    });
  }
  return entries;
}

function collectIndexVisibilityViolations(root) {
  const violations = [];
  const records = splitNullTerminated(runGit(root, ["ls-files", "-v", "--full-name", "-z"]));
  for (const record of records) {
    const tag = record[0];
    if (tag === "S" || tag !== tag.toUpperCase()) violations.push(normalizePath(record.slice(2)));
  }
  return violations.sort();
}

function collectRepositoryEntries(startDirectory) {
  let root;
  try {
    root = runGit(startDirectory, ["rev-parse", "--show-toplevel"]).trim();
  } catch (error) {
    if (error instanceof Error && error.message === "Git executable is unavailable") throw error;
    throw new Error("unable to resolve Git work tree", { cause: error });
  }
  const indexEntries = collectIndexEntries(root);
  const deleted = new Set(
    splitNullTerminated(runGit(root, ["ls-files", "--deleted", "--full-name", "-z"])),
  );
  const candidates = splitNullTerminated(
    runGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "-z"]),
  );
  const relativePaths = [...new Set(candidates)].filter((path) => !deleted.has(path)).sort();
  const stagedPaths = new Set(
    splitNullTerminated(runGit(root, ["diff", "--cached", "--name-only", "-z", "--"])),
  );
  const worktreePaths = new Set(
    splitNullTerminated(runGit(root, ["diff", "--name-only", "-z", "--"])),
  );
  return {
    root,
    indexVisibilityViolations: collectIndexVisibilityViolations(root),
    stagedMismatches: [...stagedPaths]
      .filter((path) => worktreePaths.has(path))
      .map(normalizePath)
      .sort(),
    entries: relativePaths.map((relativePath) => {
      const indexEntry = indexEntries.get(relativePath);
      return {
        absolutePath: resolve(root, relativePath),
        indexMode: indexEntry?.mode,
        indexTarget: indexEntry?.indexTarget,
        relativePath: normalizePath(relativePath),
      };
    }),
  };
}

async function collectArtifactEntries(root) {
  const entries = [];

  async function visit(directory) {
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (cause) {
      throw new Error("unable to read artifact directory", { cause });
    }
    children.sort((left, right) => compareText(left.name, right.name));
    for (const child of children) {
      const absolutePath = resolve(directory, child.name);
      const relativePath = normalizePath(relative(root, absolutePath));
      if (child.isDirectory() && child.name !== ".git") await visit(absolutePath);
      else entries.push({ absolutePath, relativePath });
    }
  }

  await visit(root);
  return entries;
}

async function resolveScan(argv) {
  if (argv.length === 0) return collectRepositoryEntries(process.cwd());
  if (argv.length !== 2 || argv[0] !== "--artifact-dir" || argv[1].trim() === "") {
    throw new Error("usage: node scripts/check-public-surface.mjs [--artifact-dir <directory>]");
  }
  const requestedRoot = resolve(process.cwd(), argv[1]);
  let root;
  try {
    root = await realpath(requestedRoot);
    const metadata = await lstat(root);
    if (!metadata.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error("artifact directory is not a readable directory");
  }
  return {
    root,
    entries: await collectArtifactEntries(root),
    indexVisibilityViolations: [],
    stagedMismatches: [],
  };
}

function formatFinding(finding) {
  const location = `${escapeForDisplay(finding.relativePath)}${
    finding.line === undefined ? "" : `:${finding.line}`
  }`;
  return `${location}: ${finding.message}`;
}

async function main() {
  const scan = await resolveScan(process.argv.slice(2));
  const root = await realpath(scan.root);
  const entries = scan.entries.map((entry) => ({
    ...entry,
    absolutePath: resolve(root, entry.relativePath),
  }));
  const context = { root, entries, candidatePaths: buildCandidatePaths(entries) };
  const findings = [
    ...scan.indexVisibilityViolations.map((relativePath) => ({
      relativePath,
      message: "prohibited Git index visibility flag",
    })),
    ...scan.stagedMismatches.map((relativePath) => ({
      relativePath,
      message: "staged index entry differs from worktree",
    })),
  ];
  for (const entry of entries) await inspectEntry(context, entry, findings);
  const uniqueFindings = [
    ...new Map(
      findings.map((finding) => [
        `${finding.relativePath}\0${finding.line ?? ""}\0${finding.message}`,
        finding,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      compareText(left.relativePath, right.relativePath) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      compareText(left.message, right.message),
  );

  if (uniqueFindings.length !== 0) {
    for (const finding of uniqueFindings) process.stderr.write(`${formatFinding(finding)}\n`);
    process.stderr.write(`[public-surface] FAIL ${uniqueFindings.length} policy violation(s)\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`[public-surface] PASS ${entries.length} candidate path(s) checked\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "unexpected scanner failure";
  process.stderr.write(`[public-surface] FAIL ${escapeForDisplay(message)}\n`);
  process.exitCode = 1;
}
