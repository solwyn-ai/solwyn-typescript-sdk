import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const catalogPath = join(repositoryRoot, "tests", "provider-surface-intervals.json");
const outputPath = process.env.GITHUB_OUTPUT;
const eventName = process.env.GITHUB_EVENT_NAME;

if (outputPath === undefined)
  throw new Error("GITHUB_OUTPUT is required for the provider surface matrix");

if (eventName === "workflow_dispatch" && process.env.GITHUB_REF !== "refs/heads/main")
  throw new Error("Manual CI canary dispatches must target refs/heads/main");

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const include =
  eventName === "schedule" || eventName === "workflow_dispatch"
    ? catalog.include
        .filter((cell) => cell.interval === "latest")
        .map((cell) => ({
          ...cell,
          packages: cell.packages.map((packageName) => packageName.replace(/@[0-9].*$/, "@latest")),
        }))
    : catalog.include;

await appendFile(outputPath, `include=${JSON.stringify(include)}\n`);
