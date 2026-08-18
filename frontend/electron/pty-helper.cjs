/**
 * PTY helper — runs node-pty in a system Node.js process, communicating
 * with the Electron main process via JSON lines over stdio.
 * This avoids the need to rebuild native modules for Electron's ABI.
 */
const pty = require('node-pty');
const sessions = new Map();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

process.stdin.setEncoding('utf8');
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      handle(msg);
    } catch {
      // ignore malformed lines
    }
  }
});

function handle(msg) {
  switch (msg.type) {
    case 'spawn': {
      const { id, file, args, env, cwd, cols, rows } = msg;
      try {
        const term = pty.spawn(file, args || [], {
          name: 'xterm-256color',
          cols: cols || 80,
          rows: rows || 24,
          cwd: cwd || process.env.USERPROFILE || process.cwd(),
          env: { ...process.env, ...(env || {}) },
        });
        sessions.set(id, term);
        term.onData((data) => send({ type: 'data', id, data }));
        term.onExit(({ exitCode }) => {
          sessions.delete(id);
          send({ type: 'exit', id, code: exitCode });
        });
        send({ type: 'spawned', id, pid: term.pid });
      } catch (err) {
        send({ type: 'error', id, message: String(err.message || err) });
      }
      break;
    }
    case 'write': {
      const term = sessions.get(msg.id);
      if (term) term.write(msg.data);
      break;
    }
    case 'resize': {
      const term = sessions.get(msg.id);
      if (term) term.resize(msg.cols, msg.rows);
      break;
    }
    case 'kill': {
      const term = sessions.get(msg.id);
      if (term) {
        try { term.kill(); } catch {}
        sessions.delete(msg.id);
      }
      break;
    }
    case 'shutdown': {
      for (const [id, term] of sessions) {
        try { term.kill(); } catch {}
      }
      sessions.clear();
      process.exit(0);
      break;
    }
  }
}

process.on('uncaughtException', (err) => {
  send({ type: 'error', id: null, message: String(err.message || err) });
});

process.on('SIGTERM', () => {
  for (const [, term] of sessions) {
    try { term.kill(); } catch {}
  }
  sessions.clear();
  process.exit(0);
});