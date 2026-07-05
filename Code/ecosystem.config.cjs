module.exports = {
  apps: [{
    name:            'intelligence-agent',
    script:          'src/telegram-bot/index.js',
    interpreter:     'node',
    interpreter_args: '--experimental-vm-modules',
    cwd:             __dirname,

    // Авто-перезапуск
    autorestart:     true,
    watch:           false,
    max_restarts:    10,
    restart_delay:   3000,      // 3 сек пауза перед рестартом
    min_uptime:      5000,      // считать "упавшим" если жил < 5 сек

    // Логи
    out_file:        '../logs/bot-out.log',
    error_file:      '../logs/bot-err.log',
    merge_logs:      true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',

    // Переменные окружения
    env: {
      NODE_ENV: 'production',
    },
  }],
};
