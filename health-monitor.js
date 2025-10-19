#!/usr/bin/env node
/**
 * DemBot Health Monitor
 * Monitors bot health, detects crashes, and provides diagnostics
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class BotHealthMonitor {
  constructor() {
    this.statusFile = path.join(process.cwd(), 'data', 'status.json');
    this.logFile = path.join(process.cwd(), 'bot-health.log');
    this.crashThreshold = 3;
    this.restartDelay = 5000; // 5 seconds
    this.maxRestarts = 5;
    this.restartCount = 0;
    this.lastHeartbeat = null;
    this.isMonitoring = false;
  }

  log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}`;
    console.log(logMessage);
    
    try {
      fs.appendFileSync(this.logFile, logMessage + '\n');
    } catch (err) {
      console.error('Failed to write to log file:', err.message);
    }
  }

  getBotStatus() {
    try {
      if (!fs.existsSync(this.statusFile)) {
        return { bot: { ready: false }, commands: [], errors: [] };
      }
      
      const data = fs.readFileSync(this.statusFile, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      this.log(`Failed to read status file: ${err.message}`, 'ERROR');
      return { bot: { ready: false }, commands: [], errors: [] };
    }
  }

  checkBotHealth() {
    const status = this.getBotStatus();
    const now = new Date();
    
    // Check if bot is ready
    if (!status.bot.ready) {
      this.log('Bot is not ready', 'WARN');
      return false;
    }
    
    // Check last heartbeat
    if (status.bot.lastHeartbeat) {
      const lastHeartbeat = new Date(status.bot.lastHeartbeat);
      const timeSinceHeartbeat = now - lastHeartbeat;
      
      if (timeSinceHeartbeat > 300000) { // 5 minutes
        this.log(`No heartbeat for ${Math.round(timeSinceHeartbeat / 1000)}s`, 'WARN');
        return false;
      }
    }
    
    // Check for recent errors
    const recentErrors = status.errors.filter(error => {
      const errorTime = new Date(error.timestamp);
      return (now - errorTime) < 300000; // Last 5 minutes
    });
    
    if (recentErrors.length > 10) {
      this.log(`Too many recent errors: ${recentErrors.length}`, 'ERROR');
      return false;
    }
    
    // Check for system crashes
    const systemCrashes = recentErrors.filter(error => 
      error.command === 'SYSTEM_CRASH'
    );
    
    if (systemCrashes.length > 0) {
      this.log(`System crashes detected: ${systemCrashes.length}`, 'ERROR');
      return false;
    }
    
    return true;
  }

  analyzeErrors() {
    const status = this.getBotStatus();
    const now = new Date();
    
    // Group errors by command
    const errorGroups = {};
    status.errors.forEach(error => {
      const command = error.command || 'unknown';
      if (!errorGroups[command]) {
        errorGroups[command] = [];
      }
      errorGroups[command].push(error);
    });
    
    // Find problematic commands
    const problematicCommands = [];
    Object.entries(errorGroups).forEach(([command, errors]) => {
      const recentErrors = errors.filter(error => {
        const errorTime = new Date(error.timestamp);
        return (now - errorTime) < 3600000; // Last hour
      });
      
      if (recentErrors.length > 5) {
        problematicCommands.push({
          command,
          errorCount: recentErrors.length,
          lastError: recentErrors[0].timestamp,
          commonMessage: this.getMostCommonMessage(recentErrors)
        });
      }
    });
    
    return problematicCommands;
  }

  getMostCommonMessage(errors) {
    const messages = {};
    errors.forEach(error => {
      const msg = error.message || 'Unknown error';
      messages[msg] = (messages[msg] || 0) + 1;
    });
    
    return Object.entries(messages)
      .sort(([,a], [,b]) => b - a)[0]?.[0] || 'Unknown';
  }

  generateHealthReport() {
    const status = this.getBotStatus();
    const problematicCommands = this.analyzeErrors();
    const memoryUsage = process.memoryUsage();
    
    const report = {
      timestamp: new Date().toISOString(),
      bot: {
        ready: status.bot.ready,
        uptime: status.bot.uptimeMs,
        lastHeartbeat: status.bot.lastHeartbeat,
        loginError: status.bot.loginError
      },
      system: {
        memory: {
          rss: Math.round(memoryUsage.rss / 1024 / 1024),
          heap: Math.round(memoryUsage.heapUsed / 1024 / 1024),
          external: Math.round(memoryUsage.external / 1024 / 1024)
        },
        uptime: process.uptime(),
        pid: process.pid
      },
      commands: {
        total: status.commands.length,
        problematic: problematicCommands
      },
      errors: {
        total: status.errors.length,
        recent: status.errors.filter(error => {
          const errorTime = new Date(error.timestamp);
          return (new Date() - errorTime) < 3600000; // Last hour
        }).length
      }
    };
    
    return report;
  }

  async startMonitoring() {
    if (this.isMonitoring) {
      this.log('Monitor already running', 'WARN');
      return;
    }
    
    this.isMonitoring = true;
    this.log('Starting bot health monitoring...');
    
    // Check health every 30 seconds
    const healthCheckInterval = setInterval(() => {
      if (!this.isMonitoring) {
        clearInterval(healthCheckInterval);
        return;
      }
      
      const isHealthy = this.checkBotHealth();
      
      if (!isHealthy) {
        this.log('Bot health check failed', 'ERROR');
        this.handleUnhealthyBot();
      } else {
        this.log('Bot health check passed', 'DEBUG');
      }
    }, 30000);
    
    // Generate reports every 5 minutes
    const reportInterval = setInterval(() => {
      if (!this.isMonitoring) {
        clearInterval(reportInterval);
        return;
      }
      
      const report = this.generateHealthReport();
      this.log(`Health Report: ${JSON.stringify(report, null, 2)}`, 'INFO');
    }, 300000);
    
    // Handle process signals
    process.on('SIGINT', () => {
      this.log('Received SIGINT, stopping monitor...');
      this.stopMonitoring();
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      this.log('Received SIGTERM, stopping monitor...');
      this.stopMonitoring();
      process.exit(0);
    });
  }

  stopMonitoring() {
    this.isMonitoring = false;
    this.log('Stopped bot health monitoring');
  }

  handleUnhealthyBot() {
    this.log('Bot appears unhealthy, analyzing...', 'WARN');
    
    const report = this.generateHealthReport();
    const problematicCommands = report.commands.problematic;
    
    if (problematicCommands.length > 0) {
      this.log('Problematic commands detected:', 'ERROR');
      problematicCommands.forEach(cmd => {
        this.log(`  - ${cmd.command}: ${cmd.errorCount} errors, last: ${cmd.lastError}`, 'ERROR');
        this.log(`    Common error: ${cmd.commonMessage}`, 'ERROR');
      });
    }
    
    // Check if we should restart
    if (this.restartCount < this.maxRestarts) {
      this.log(`Attempting restart #${this.restartCount + 1}...`, 'WARN');
      this.restartBot();
    } else {
      this.log('Maximum restart attempts reached, manual intervention required', 'ERROR');
    }
  }

  restartBot() {
    this.restartCount++;
    this.log(`Restarting bot in ${this.restartDelay}ms...`, 'WARN');
    
    setTimeout(() => {
      try {
        // Try to restart the bot process
        const botProcess = spawn('node', ['index.js'], {
          stdio: 'inherit',
          detached: false
        });
        
        botProcess.on('error', (err) => {
          this.log(`Failed to restart bot: ${err.message}`, 'ERROR');
        });
        
        botProcess.on('exit', (code) => {
          this.log(`Bot process exited with code ${code}`, 'INFO');
        });
        
        this.log('Bot restart initiated', 'INFO');
      } catch (err) {
        this.log(`Failed to restart bot: ${err.message}`, 'ERROR');
      }
    }, this.restartDelay);
  }

  async runDiagnostics() {
    this.log('Running bot diagnostics...');
    
    const report = this.generateHealthReport();
    const status = this.getBotStatus();
    
    console.log('\n🔍 DemBot Health Diagnostics');
    console.log('============================');
    
    console.log(`\n📊 Bot Status:`);
    console.log(`   Ready: ${report.bot.ready ? '✅' : '❌'}`);
    console.log(`   Uptime: ${report.bot.uptime ? Math.round(report.bot.uptime / 1000) + 's' : 'Unknown'}`);
    console.log(`   Last Heartbeat: ${report.bot.lastHeartbeat || 'Never'}`);
    
    if (report.bot.loginError) {
      console.log(`   Login Error: ${report.bot.loginError.message}`);
    }
    
    console.log(`\n💾 System Resources:`);
    console.log(`   Memory RSS: ${report.system.memory.rss}MB`);
    console.log(`   Memory Heap: ${report.system.memory.heap}MB`);
    console.log(`   Memory External: ${report.system.memory.external}MB`);
    console.log(`   Process Uptime: ${Math.round(report.system.uptime)}s`);
    console.log(`   Process PID: ${report.system.pid}`);
    
    console.log(`\n📈 Commands:`);
    console.log(`   Total Commands: ${report.commands.total}`);
    
    if (report.commands.problematic.length > 0) {
      console.log(`   Problematic Commands:`);
      report.commands.problematic.forEach(cmd => {
        console.log(`     - ${cmd.command}: ${cmd.errorCount} errors`);
        console.log(`       Last Error: ${cmd.lastError}`);
        console.log(`       Common: ${cmd.commonMessage}`);
      });
    } else {
      console.log(`   ✅ No problematic commands detected`);
    }
    
    console.log(`\n❌ Errors:`);
    console.log(`   Total Errors: ${report.errors.total}`);
    console.log(`   Recent Errors (1h): ${report.errors.recent}`);
    
    // Show recent errors
    const recentErrors = status.errors.slice(0, 5);
    if (recentErrors.length > 0) {
      console.log(`   Recent Error Details:`);
      recentErrors.forEach((error, index) => {
        console.log(`     ${index + 1}. ${error.command}: ${error.message}`);
        console.log(`        Time: ${error.timestamp}`);
      });
    }
    
    console.log(`\n📋 Recommendations:`);
    
    if (!report.bot.ready) {
      console.log(`   ❌ Bot is not ready - check login credentials and network`);
    }
    
    if (report.system.memory.rss > 1000) {
      console.log(`   ⚠️ High memory usage (${report.system.memory.rss}MB) - consider restart`);
    }
    
    if (report.commands.problematic.length > 0) {
      console.log(`   ⚠️ Problematic commands detected - review error patterns`);
    }
    
    if (report.errors.recent > 10) {
      console.log(`   ⚠️ High error rate (${report.errors.recent} in last hour) - investigate`);
    }
    
    if (report.bot.ready && report.system.memory.rss < 500 && report.errors.recent < 5) {
      console.log(`   ✅ Bot appears healthy`);
    }
    
    console.log('\n');
  }
}

// CLI interface
if (require.main === module) {
  const monitor = new BotHealthMonitor();
  const command = process.argv[2];
  
  switch (command) {
    case 'monitor':
      monitor.startMonitoring();
      break;
    case 'diagnose':
      monitor.runDiagnostics();
      break;
    case 'report':
      const report = monitor.generateHealthReport();
      console.log(JSON.stringify(report, null, 2));
      break;
    default:
      console.log('Usage: node health-monitor.js [monitor|diagnose|report]');
      console.log('  monitor  - Start continuous monitoring');
      console.log('  diagnose - Run one-time diagnostics');
      console.log('  report   - Generate health report (JSON)');
      process.exit(1);
  }
}

module.exports = BotHealthMonitor;
