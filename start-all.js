import { spawn } from "node:child_process";

const processes = [
  ["web", "server.js"],
  ["telegram", "telegram-bot.js"],
];

const children = [];

function start(name, script) {
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
  });
  child.on("exit", (code, signal) => {
    console.error(`[${name}] exited: code=${code ?? "null"} signal=${signal ?? "null"}`);
    stopAll();
    process.exit(code || 1);
  });

  children.push(child);
}

function stopAll() {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
}

process.once("SIGINT", () => {
  stopAll();
  process.exit(0);
});

process.once("SIGTERM", () => {
  stopAll();
  process.exit(0);
});

for (const [name, script] of processes) start(name, script);
