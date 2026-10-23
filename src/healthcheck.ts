const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65_535) process.exit(1);
try {
  const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(3_000) });
  process.exitCode = response.ok ? 0 : 1;
} catch { process.exitCode = 1; }
