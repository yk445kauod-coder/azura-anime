/** Run the Python IGNIS pipeline (agent, compare, search) from the API layer. */
import { spawn } from "node:child_process";
import path from "node:path";

const PIPELINE = path.join(process.cwd(), "pipeline", "ask.py");
const PYTHON = process.env.IGNIS_PYTHON || "python3";

export async function runPipeline<T = unknown>(
  payload: Record<string, unknown>,
  timeoutMs = 180_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const child = spawn(PYTHON, [PIPELINE], {
      cwd: process.cwd(),
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pipeline timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`pipeline exited ${code}: ${stderr.slice(-600)}`));
        return;
      }
      const line = stdout.trim().split("\n").filter(Boolean).pop();
      if (!line) {
        reject(new Error("pipeline produced no output"));
        return;
      }
      try {
        resolve(JSON.parse(line) as T);
      } catch {
        reject(new Error(`invalid pipeline JSON: ${line.slice(0, 300)}`));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}
