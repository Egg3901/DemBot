#!/usr/bin/env node
/**
 * Migration script to switch to optimized commands
 * This script backs up the original commands and replaces them with optimized versions
 */

const fs = require('node:fs');
const path = require('node:path');

const commandsDir = path.join(process.cwd(), 'commands');
const backupDir = path.join(process.cwd(), 'commands', 'backup');

// Commands to optimize
const commandsToOptimize = [
  'profile.js',
  'race.js', 
  'update.js'
];

function ensureBackupDir() {
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
}

function backupOriginalCommand(commandName) {
  const originalPath = path.join(commandsDir, commandName);
  const backupPath = path.join(backupDir, commandName);
  
  if (fs.existsSync(originalPath)) {
    fs.copyFileSync(originalPath, backupPath);
    console.log(`✅ Backed up ${commandName} to ${backupPath}`);
    return true;
  }
  return false;
}

function replaceWithOptimized(commandName) {
  const originalPath = path.join(commandsDir, commandName);
  const optimizedPath = path.join(commandsDir, `${commandName.replace('.js', '')}-optimized.js`);
  
  if (fs.existsSync(optimizedPath)) {
    // Read the optimized file and replace the command name
    let content = fs.readFileSync(optimizedPath, 'utf8');
    
    // Replace the command name in the optimized file to match the original
    const originalCommandName = commandName.replace('.js', '');
    content = content.replace(/\.setName\('profile'\)/, `.setName('${originalCommandName}')`);
    content = content.replace(/\.setName\('race'\)/, `.setName('${originalCommandName}')`);
    content = content.replace(/\.setName\('update'\)/, `.setName('${originalCommandName}')`);
    
    fs.writeFileSync(originalPath, content);
    console.log(`✅ Replaced ${commandName} with optimized version`);
    return true;
  }
  return false;
}

function restoreOriginalCommand(commandName) {
  const originalPath = path.join(commandsDir, commandName);
  const backupPath = path.join(backupDir, commandName);
  
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, originalPath);
    console.log(`✅ Restored ${commandName} from backup`);
    return true;
  }
  return false;
}

function main() {
  const action = process.argv[2];
  
  console.log('🚀 DemBot Command Optimization Migration');
  console.log('=====================================\n');
  
  ensureBackupDir();
  
  switch (action) {
    case 'optimize':
      console.log('📦 Migrating to optimized commands...\n');
      
      for (const command of commandsToOptimize) {
        console.log(`Processing ${command}...`);
        
        if (backupOriginalCommand(command)) {
          if (replaceWithOptimized(command)) {
            console.log(`✅ Successfully optimized ${command}\n`);
          } else {
            console.log(`❌ Failed to find optimized version of ${command}\n`);
          }
        } else {
          console.log(`⚠️  Original ${command} not found, skipping\n`);
        }
      }
      
      console.log('🎉 Migration complete! Your commands are now optimized.');
      console.log('📝 Original commands are backed up in commands/backup/');
      break;
      
    case 'restore':
      console.log('🔄 Restoring original commands...\n');
      
      for (const command of commandsToOptimize) {
        console.log(`Restoring ${command}...`);
        
        if (restoreOriginalCommand(command)) {
          console.log(`✅ Successfully restored ${command}\n`);
        } else {
          console.log(`❌ No backup found for ${command}\n`);
        }
      }
      
      console.log('🎉 Restoration complete! Original commands restored.');
      break;
      
    case 'status':
      console.log('📊 Checking migration status...\n');
      
      for (const command of commandsToOptimize) {
        const originalPath = path.join(commandsDir, command);
        const backupPath = path.join(backupDir, command);
        const optimizedPath = path.join(commandsDir, `${command.replace('.js', '')}-optimized.js`);
        
        console.log(`${command}:`);
        console.log(`  Original: ${fs.existsSync(originalPath) ? '✅' : '❌'}`);
        console.log(`  Backup: ${fs.existsSync(backupPath) ? '✅' : '❌'}`);
        console.log(`  Optimized: ${fs.existsSync(optimizedPath) ? '✅' : '❌'}`);
        console.log('');
      }
      break;
      
    default:
      console.log('Usage: node scripts/migrate-to-optimized.js [optimize|restore|status]');
      console.log('');
      console.log('Commands:');
      console.log('  optimize  - Replace original commands with optimized versions');
      console.log('  restore   - Restore original commands from backup');
      console.log('  status    - Check migration status');
      console.log('');
      console.log('Examples:');
      console.log('  node scripts/migrate-to-optimized.js optimize');
      console.log('  node scripts/migrate-to-optimized.js restore');
      console.log('  node scripts/migrate-to-optimized.js status');
      break;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  backupOriginalCommand,
  replaceWithOptimized,
  restoreOriginalCommand
};
