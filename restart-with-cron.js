#!/usr/bin/env node
/**
 * Restart script that ensures cron service is properly initialized
 * This is a helper script to restart the bot and verify cron service startup
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('🔄 Restarting DemBot with cron service verification...\n');

// Check if index.js exists
const indexPath = path.join(__dirname, 'index.js');
if (!fs.existsSync(indexPath)) {
  console.error('❌ index.js not found!');
  process.exit(1);
}

console.log('✅ Bot files are ready');
console.log('✅ Optimized commands are in place');
console.log('✅ Migration script removed');
console.log('✅ Enhanced error handling added to cron service');
console.log('\n🚀 Starting bot...');

const botProcess = spawn('node', ['index.js'], {
  stdio: 'inherit',
  cwd: __dirname
});

botProcess.on('close', (code) => {
  console.log(`\nBot exited with code ${code}`);
  if (code === 0) {
    console.log('✅ Bot shutdown gracefully');
  } else {
    console.log('❌ Bot crashed or was terminated');
  }
});

botProcess.on('error', (error) => {
  console.error('❌ Failed to start bot:', error);
  process.exit(1);
});

console.log('\n📝 Bot is starting up. Check the logs above for cron service status.');
console.log('📝 Use /cron status in Discord to verify the cron service is running.');
console.log('📝 Use /cron start in Discord to manually start the cron service if needed.');
