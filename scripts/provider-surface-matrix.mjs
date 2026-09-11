import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const catalogPath = join(repositoryRoot, "tests", "provider-surface-intervals.json");
const outputPath = process.env.GITHUB_OUTPUT;

if (outputPath === undefined)
  throw new Error("GITHUB_OUTPUT is required for the provider surface matrix");

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const include =
  process.env.GITHUB_EVENT_NAME === "schedule"
    ? catalog.include
        .filter((cell) => cell.interval === "latest")
        .map((cell) => ({
          ...cell,
          packages: cell.packages.map((packageName) => packageName.replace(/@[0-9].*$/, "@latest")),
        }))
    : catalog.include;

await appendFile(outputPath, `include=${JSON.stringify(include)}\n`);
