/**
 * PM2 config for the Discord bot.
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup        # then run exactly the line it prints
 */
const base = {
  cwd: __dirname,
  interpreter: 'node',
  // No --env-file-if-exists: the entry loads .env itself (src/core/env.js), which keeps the
  // Node >= 20.6 floor from package.json engines.
  autorestart: true,
  max_restarts: 20,
  restart_delay: 3000,
  max_memory_restart: '400M',
  time: true,
  env: {
    NODE_ENV: 'production',
  },
};

module.exports = {
  apps: [{ ...base, name: 'discord-bot', script: 'src/discord.js' }],
};
