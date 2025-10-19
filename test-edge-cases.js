#!/usr/bin/env node
/**
 * Edge case testing script for DemBot commands
 * Tests various error conditions and edge cases that could cause crashes
 */

const { Client, GatewayIntentBits, Events } = require('discord.js');
const path = require('path');
const fs = require('fs');

// Mock environment for testing
process.env.DISCORD_TOKEN = 'test_token';
process.env.DISCORD_GUILD_ID = 'test_guild';

// Load the bot's command modules
const commandsPath = path.join(__dirname, 'commands');
const commands = new Map();

if (fs.existsSync(commandsPath)) {
  const files = fs
    .readdirSync(commandsPath)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => !/\.head\.js$/i.test(f) && !/\.backup\.js$/i.test(f));
  
  console.log(`📦 Loading ${files.length} command files for testing...`);
  
  for (const file of files) {
    try {
      const filePath = path.join(commandsPath, file);
      // Clear require cache to avoid issues
      delete require.cache[require.resolve(filePath)];
      const mod = require(filePath);
      if (mod?.data && mod?.execute) {
        commands.set(mod.data.name, mod);
        console.log(`✅ Loaded: ${mod.data.name}`);
      } else {
        console.warn(`⚠️ Skipped ${file}: missing data/execute`);
      }
    } catch (err) {
      console.error(`❌ Failed to load ${file}:`, err.message);
      // Try to load just the help command for testing
      if (file === 'help.js') {
        console.log('🔄 Attempting to load help command directly...');
        try {
          const helpMod = require('./commands/help');
          if (helpMod?.data && helpMod?.execute) {
            commands.set(helpMod.data.name, helpMod);
            console.log(`✅ Loaded help command directly`);
          }
        } catch (helpErr) {
          console.error('❌ Failed to load help command:', helpErr.message);
        }
      }
    }
  }
}

// Mock interaction object for testing
function createMockInteraction(commandName, options = {}) {
  return {
    commandName,
    user: { id: 'test_user_123' },
    guild: { id: 'test_guild_456' },
    channel: { id: 'test_channel_789' },
    type: 2, // CHAT_INPUT_COMMAND
    inGuild: () => true,
    deferred: false,
    replied: false,
    client: {
      commands: commands // Pass the loaded commands
    },
    options: {
      getString: (name) => options[name] || null,
      getBoolean: (name) => options[name] || false,
      getInteger: (name) => options[name] || null,
      getNumber: (name) => options[name] || null,
      getUser: (name) => options[name] || null,
      getChannel: (name) => options[name] || null,
      getRole: (name) => options[name] || null,
    },
    reply: async (content) => {
      console.log(`📤 Reply: ${JSON.stringify(content)}`);
      return { content };
    },
    editReply: async (content) => {
      console.log(`✏️ Edit: ${JSON.stringify(content)}`);
      return { content };
    },
    followUp: async (content) => {
      console.log(`📤 Follow-up: ${JSON.stringify(content)}`);
      return { content };
    },
    deferReply: async () => {
      console.log('⏳ Deferred reply');
      return {};
    },
    _dembotHandledError: false,
  };
}

// Mock the required modules for testing
const mockModules = {
  '../lib/permissions': {
    fetchMember: async () => ({ id: 'test_member', roles: { cache: new Map() } }),
    canManageBot: async () => false,
    canUseDebug: () => false
  },
  '../lib/send-access': {
    getSendLimit: () => 0,
    formatLimit: (limit) => `$${limit}`,
    ROLE_TREASURY_ADMIN: 'treasury_admin',
    BASE_LIMIT: 1000,
    UNLIMITED: -1
  }
};

// Override require for testing
const originalRequire = require;
require = function(id) {
  if (mockModules[id]) {
    return mockModules[id];
  }
  return originalRequire.apply(this, arguments);
};

// Test cases for edge cases
const testCases = [
  {
    name: 'Help command - no arguments',
    command: 'help',
    options: {},
    description: 'Test help command with no arguments'
  },
  {
    name: 'Help command - invalid command',
    command: 'help',
    options: { command: 'nonexistent_command_xyz' },
    description: 'Test help command with non-existent command name'
  },
  {
    name: 'Help command - empty string command',
    command: 'help',
    options: { command: '' },
    description: 'Test help command with empty string'
  },
  {
    name: 'Help command - null command',
    command: 'help',
    options: { command: null },
    description: 'Test help command with null value'
  },
  {
    name: 'Help command - very long command name',
    command: 'help',
    options: { command: 'a'.repeat(1000) },
    description: 'Test help command with extremely long command name'
  },
  {
    name: 'Help command - special characters',
    command: 'help',
    options: { command: '!@#$%^&*()' },
    description: 'Test help command with special characters'
  },
  {
    name: 'Help command - unicode characters',
    command: 'help',
    options: { command: '🚀🎉💯' },
    description: 'Test help command with unicode characters'
  },
  {
    name: 'Help command - SQL injection attempt',
    command: 'help',
    options: { command: "'; DROP TABLE users; --" },
    description: 'Test help command with SQL injection attempt'
  },
  {
    name: 'Help command - XSS attempt',
    command: 'help',
    options: { command: '<script>alert("xss")</script>' },
    description: 'Test help command with XSS attempt'
  },
  {
    name: 'Help command - public flag true',
    command: 'help',
    options: { public: true },
    description: 'Test help command with public flag set to true'
  },
  {
    name: 'Help command - public flag false',
    command: 'help',
    options: { public: false },
    description: 'Test help command with public flag set to false'
  },
  {
    name: 'Help command - public flag null',
    command: 'help',
    options: { public: null },
    description: 'Test help command with public flag set to null'
  }
];

// Additional test cases for other commands
const additionalTestCases = [
  {
    name: 'Treasury command - no options',
    command: 'treasury',
    options: {},
    description: 'Test treasury command with no options'
  },
  {
    name: 'Treasury command - invalid party',
    command: 'treasury',
    options: { party: 'invalid_party' },
    description: 'Test treasury command with invalid party'
  },
  {
    name: 'Treasury command - debug true',
    command: 'treasury',
    options: { debug: true },
    description: 'Test treasury command with debug enabled'
  },
  {
    name: 'Primary command - no options',
    command: 'primary',
    options: {},
    description: 'Test primary command with no options'
  },
  {
    name: 'Primary command - invalid state',
    command: 'primary',
    options: { state: 'invalid_state_xyz' },
    description: 'Test primary command with invalid state'
  },
  {
    name: 'Primary command - invalid race',
    command: 'primary',
    options: { state: 'ca', race: 'invalid_race' },
    description: 'Test primary command with invalid race'
  }
];

// Run test cases
async function runTests() {
  console.log('\n🧪 Starting edge case tests...\n');
  
  let passed = 0;
  let failed = 0;
  
  for (const testCase of [...testCases, ...additionalTestCases]) {
    console.log(`\n🔍 Testing: ${testCase.name}`);
    console.log(`📝 Description: ${testCase.description}`);
    
    const command = commands.get(testCase.command);
    if (!command) {
      console.log(`❌ Command '${testCase.command}' not found`);
      failed++;
      continue;
    }
    
    const mockInteraction = createMockInteraction(testCase.command, testCase.options);
    
    try {
      // Set a timeout for command execution
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Test timeout (10s)')), 10000)
      );
      
      const executionPromise = command.execute(mockInteraction);
      await Promise.race([executionPromise, timeoutPromise]);
      
      console.log(`✅ PASSED: ${testCase.name}`);
      passed++;
    } catch (error) {
      console.log(`❌ FAILED: ${testCase.name}`);
      console.log(`   Error: ${error.message}`);
      console.log(`   Stack: ${error.stack?.split('\n')[0]}`);
      failed++;
    }
  }
  
  console.log(`\n📊 Test Results:`);
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📈 Success Rate: ${Math.round((passed / (passed + failed)) * 100)}%`);
  
  if (failed > 0) {
    console.log(`\n⚠️ Some tests failed. Review the errors above.`);
    process.exit(1);
  } else {
    console.log(`\n🎉 All tests passed!`);
    process.exit(0);
  }
}

// Test memory usage and resource cleanup
function testMemoryUsage() {
  console.log('\n💾 Testing memory usage...');
  
  const initialMemory = process.memoryUsage();
  console.log(`Initial memory: RSS=${Math.round(initialMemory.rss/1024/1024)}MB, Heap=${Math.round(initialMemory.heapUsed/1024/1024)}MB`);
  
  // Run garbage collection if available
  if (global.gc) {
    global.gc();
    const afterGC = process.memoryUsage();
    console.log(`After GC: RSS=${Math.round(afterGC.rss/1024/1024)}MB, Heap=${Math.round(afterGC.heapUsed/1024/1024)}MB`);
  }
}

// Main execution
if (require.main === module) {
  console.log('🚀 DemBot Edge Case Tester');
  console.log('========================');
  
  testMemoryUsage();
  
  runTests().catch((error) => {
    console.error('💥 Test runner crashed:', error);
    process.exit(1);
  });
}

module.exports = { runTests, testMemoryUsage, createMockInteraction };
