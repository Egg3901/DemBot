#!/usr/bin/env node
/**
 * Quick helper to update PPUSA_COOKIE (and optional cf_clearance) in .env.
 * Usage: npm run cookie:update
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ENV_PATH = path.resolve(__dirname, '..', '.env');
const COOKIE_KEY = 'PPUSA_COOKIE';

function ensureEnvFile() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`.env file not found at ${ENV_PATH}`);
  }
}

function readEnvLines() {
  ensureEnvFile();
  return fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
}

function writeEnvLines(lines) {
  fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
}

function buildCookieString(session, clearance) {
  const parts = [];
  if (session) parts.push(`ppusa_session=${session}`);
  if (clearance) parts.push(`cf_clearance=${clearance}`);
  return parts.join('; ');
}

async function prompt(query, { mask = false } = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  return new Promise((resolve) => {
    if (!mask) {
      rl.question(query, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
      return;
    }

    process.stdout.write(query);
    let input = '';
    const onData = (char) => {
      char = char + '';
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004':
          process.stdout.write('\n');
          process.stdin.removeListener('data', onData);
          rl.close();
          resolve(input.trim());
          break;
        case '\u0003':
          process.stdout.write('\n');
          process.exit(1);
          break;
        default:
          process.stdout.write('*');
          input += char;
          break;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  console.log('=== Update PPUSA Cookie ===');
  console.log('Paste the fresh values from a browser session that used the same IP as this bot.');
  console.log('Leave a field blank if you do not have it.\n');

  const sessionRaw = await prompt('ppusa_session= ');
  const clearanceRaw = await prompt('cf_clearance= ');

  if (!sessionRaw) {
    console.error('No ppusa_session provided. Aborting.');
    process.exit(1);
  }

  let cookieString;\n  if (sessionRaw.includes('=') || sessionRaw.includes(';')) {\n    // User pasted full cookie(s) like 'ppusa_session=...; cf_clearance=...'\n    cookieString = sessionRaw;\n  } else {\n    cookieString = buildCookieString(sessionRaw, clearanceRaw);\n  }\n  // Normalize accidental double 'ppusa_session=ppusa_session=VALUE'\n  cookieString = cookieString.replace(/ppusa_session=ppusa_session=/i, 'ppusa_session=');
  const lines = readEnvLines();
  let foundIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${COOKIE_KEY}=`)) {
      foundIndex = i;
      break;
    }
  }

  const newLine = `${COOKIE_KEY}=${cookieString}`;
  if (foundIndex >= 0) {
    lines[foundIndex] = newLine;
  } else {
    lines.push('');
    lines.push(newLine);
  }

  writeEnvLines(lines);
  console.log(`Updated ${COOKIE_KEY} in .env`);
  console.log('Restart the bot so it loads the new cookie.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});


