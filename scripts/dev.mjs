import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const children = new Set();

function spawnChild(command, args) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: process.env
  });

  children.add(child);
  child.on('exit', () => {
    children.delete(child);
  });

  return child;
}

async function waitForBuildOutput(filePath) {
  for (;;) {
    try {
      await access(filePath);
      return;
    } catch {
      await delay(250);
    }
  }
}

function stopChildren() {
  for (const child of children) {
    child.kill('SIGTERM');
  }
}

process.on('SIGINT', () => {
  stopChildren();
  process.exit(130);
});

process.on('SIGTERM', () => {
  stopChildren();
  process.exit(143);
});

const compiler = spawnChild('pnpm', ['exec', 'tsc', '--watch', '--preserveWatchOutput']);

compiler.on('exit', (code) => {
  if (code && code !== 0) {
    stopChildren();
    process.exit(code);
  }
});

await waitForBuildOutput(new URL('../dist/server/index.js', import.meta.url));

const server = spawnChild('node', ['--watch', 'dist/server/index.js']);

server.on('exit', (code) => {
  if (code && code !== 0) {
    stopChildren();
    process.exit(code);
  }
});
