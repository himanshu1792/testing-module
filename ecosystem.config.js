// PM2 process definitions for the headless testing app.
//
// Two long-lived processes:
//   - web:    the Next.js server (`npm start` -> `next start`)
//   - worker: the Postgres-queue worker, run via tsx
//
// Start both:   pm2 start ecosystem.config.js
//
// NOTE: real secrets (DATABASE_URL, AI keys, encryption key, etc.) come from
// `.env` — both processes load it (dotenv in lib/prisma.ts and as the worker's
// first import). The `env` blocks below only set non-secret runtime knobs;
// never put credentials here.

module.exports = {
  apps: [
    {
      name: "web",
      script: "npm",
      args: "start",
      cwd: __dirname,
      autorestart: true,
      env: {
        PORT: 3000,
      },
    },
    {
      name: "worker",
      script: "npx",
      args: "tsx worker/index.ts",
      cwd: __dirname,
      autorestart: true,
      max_memory_restart: "1500M",
      env: {
        WORKER_CONCURRENCY: "3",
        POLL_INTERVAL_MS: "10000",
      },
    },
  ],
};
