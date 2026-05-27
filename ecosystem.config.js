// PM2 ecosystem config
// Pokrenuti: pm2 start ecosystem.config.js
// Restart: pm2 restart berza
// Logovi: pm2 logs berza

module.exports = {
  apps: [{
    name: 'berza',
    script: 'server.js',
    cwd: '/var/www/berza-katalizatora',
    instances: 1,           // za početak 1; povećaj kad poraste promet
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3002
    },
    env_file: '/var/www/berza-katalizatora/.env',
    error_file: '/var/log/berza/error.log',
    out_file: '/var/log/berza/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    // Restart app svake noći u 3h (čišćenje memorije)
    cron_restart: '0 3 * * *'
  }]
};
