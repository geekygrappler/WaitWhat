import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function codexSubscriptionEnvironment(source = process.env) {
  const environment = { ...source };
  // Never let this workflow silently switch from the ChatGPT subscription to
  // usage-based API authentication because a shell happens to export a key.
  delete environment.OPENAI_API_KEY;
  delete environment.CODEX_API_KEY;
  delete environment.CODEX_ACCESS_TOKEN;
  return environment;
}

export function isChatGptLoginStatus(output) {
  return /logged in using chatgpt/i.test(String(output || ""));
}

export async function assertCodexSubscriptionLogin({
  command = process.env.WAITWHAT_CODEX_COMMAND || "codex",
  cwd = process.cwd(),
  environment = process.env,
} = {}) {
  let result;
  try {
    result = await capture(command, ["login", "status"], {
      cwd,
      env: codexSubscriptionEnvironment(environment),
      timeoutMs: 30_000,
    });
  } catch (error) {
    throw new Error(`The local Codex runtime is unavailable (${error.message}). Sign in with \`codex login\`, then retry the episode update.`);
  }
  const status = `${result.stdout}\n${result.stderr}`.trim();
  if (!isChatGptLoginStatus(status)) {
    throw new Error(`The local Codex runtime is not signed in with ChatGPT${status ? ` (${status})` : ""}. Run \`codex login\` and choose ChatGPT subscription access, then retry.`);
  }
  return status;
}

export async function requestCodexStructuredAnalysis({
  model,
  schema,
  instructions,
  input,
  command = process.env.WAITWHAT_CODEX_COMMAND || "codex",
  environment = process.env,
  timeoutMs = Number(process.env.WAITWHAT_CODEX_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  reasoningEffort = process.env.WAITWHAT_CODEX_REASONING_EFFORT || "high",
}) {
  const workingDirectory = await mkdtemp(path.join(tmpdir(), "waitwhat-codex-analysis-"));
  const schemaPath = path.join(workingDirectory, "output-schema.json");
  const outputPath = path.join(workingDirectory, "result.json");
  await writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);

  const prompt = `${instructions}\n\nAnalyze only the supplied transcript. Do not inspect files, run commands, browse, or use tools. Return only the JSON object required by the output schema.\n\n${input}`;
  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--model", String(model),
    "--config", `model_reasoning_effort=${JSON.stringify(String(reasoningEffort))}`,
    "--output-schema", schemaPath,
    "--output-last-message", outputPath,
    "-",
  ];

  try {
    await run(command, args, {
      cwd: workingDirectory,
      env: codexSubscriptionEnvironment(environment),
      input: prompt,
      timeoutMs,
    });
    const output = await readFile(outputPath, "utf8");
    try {
      return JSON.parse(output);
    } catch (error) {
      throw new Error(`Codex returned invalid structured output: ${error.message}`);
    }
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

function run(command, args, { cwd, env, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Codex analysis timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    child.stdout.resume();
    child.on("error", (error) => finish(new Error(`Could not start ${command}: ${error.message}`)));
    child.on("exit", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`${command} exec stopped with ${signal ? `signal ${signal}` : `status ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") finish(error);
    });
    child.stdin.end(input);
  });
}

function capture(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`${command} login status timed out`));
    }, timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => code === 0
      ? finish()
      : finish(new Error(`${command} login status exited with status ${code}: ${stderr.trim()}`)));
  });
}
