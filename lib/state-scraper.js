/**
 * Project: DemBot (Discord automation for Power Play USA)
 * File: lib/state-scraper.js
 * Version: 1.0
 * Purpose: Scrape and parse state-level data (electoral votes, positions, officials)
 * Author: AI Assistant
 * Created: 2025-10-20
 */

const cheerio = require('cheerio');
const { normalizeStateName, US_STATE_ABBR } = require('./state-utils');

/**
 * Extract state data from a state overview page
 * @param {string} html - HTML content from /states/:id page
 * @param {number} stateId - Numeric state ID
 * @returns {object|null} State data object with officials, seats, EV, etc.
 */
function parseStateData(html, stateId) {
  if (!html || !stateId) return null;
  
  const $ = cheerio.load(html);
  const result = {
    id: Number(stateId),
    name: null,
    electoralVotes: null,
    houseSeats: null,
    governor: null,
    senators: [],
    representatives: [],
    legislatureSeats: { democratic: 0, republican: 0 },
    updatedAt: new Date().toISOString(),
  };

  // Extract state name from page title or navbar dropdown
  const title = $('title').text() || '';
  const titleMatch = title.match(/^([^|]+)/);
  if (titleMatch) {
    result.name = titleMatch[1].trim();
  }
  
  // If not found in title, try navbar dropdown
  if (!result.name) {
    const navText = $('#stateDropdown').text().trim();
    if (navText) result.name = navText;
  }

  // Extract electoral votes and house seats from state info table
  $('table tbody tr').each((_, tr) => {
    const row = $(tr);
    const header = row.find('th').text().trim().toLowerCase();
    const value = row.find('td').text().trim();
    
    if (header.includes('electoral') && header.includes('vote')) {
      const match = value.match(/(\d+)/);
      if (match) result.electoralVotes = Number(match[1]);
    }
    
    if (header.includes('house') && header.includes('seat')) {
      const match = value.match(/(\d+)/);
      if (match) result.houseSeats = Number(match[1]);
    }
  });

  // Helper to extract official data from position sections
  const extractOfficial = (section) => {
    const nameLink = section.find('a[href*="/users/"]').first();
    const href = nameLink.attr('href') || '';
    const idMatch = href.match(/\/users\/(\d+)/);
    const name = nameLink.find('h6').text().trim() || nameLink.text().trim();
    const partyText = section.find('h6.ppusa-ava-color, h6.ppusa-bmc-color').first().text().trim();
    
    // Check if vacant
    if (name.toLowerCase() === 'vacant' || !idMatch) {
      return { name: 'Vacant', userId: null, party: null, vacant: true };
    }
    
    return {
      name: name || null,
      userId: idMatch ? Number(idMatch[1]) : null,
      party: partyText || null,
      vacant: false,
    };
  };

  // Extract Governor
  $('h4').each((_, el) => {
    const heading = $(el).text().trim().toLowerCase();
    if (heading === 'governor') {
      const section = $(el).closest('.row');
      result.governor = extractOfficial(section);
      return false; // break
    }
  });

  // Extract Senators (up to 2)
  $('h4').each((_, el) => {
    const heading = $(el).text().trim().toLowerCase();
    if (heading === 'senator') {
      const section = $(el).closest('.col-sm-6, .row');
      const official = extractOfficial(section);
      if (official) result.senators.push(official);
    }
  });

  // Extract Representatives (can be multiple, each with seat counts)
  $('h4').each((_, el) => {
    const heading = $(el).text().trim().toLowerCase();
    if (heading === 'representative') {
      const section = $(el).closest('.col-sm-6, .row');
      const official = extractOfficial(section);
      
      // Extract seat count if present
      const seatText = section.find('.font-weight-light').text().trim();
      const seatMatch = seatText.match(/(\d+)\s*seat/i);
      if (seatMatch) {
        official.seats = Number(seatMatch[1]);
      }
      
      if (official) result.representatives.push(official);
    }
  });

  // Extract state legislature party breakdown (table with "Party" and "Seats" headers)
  $('table').each((_, table) => {
    const $table = $(table);
    const headers = $table.find('thead th').map((_, th) => $(th).text().trim().toLowerCase()).get();
    
    if (headers.includes('party') && headers.includes('seats')) {
      $table.find('tbody tr').each((_, tr) => {
        const row = $(tr);
        const cells = row.find('td');
        if (cells.length >= 2) {
          const party = $(cells[0]).text().trim().toLowerCase();
          const seatsText = $(cells[1]).text().trim();
          const seatsMatch = seatsText.match(/(\d+)/);
          
          if (seatsMatch) {
            const count = Number(seatsMatch[1]);
            if (party.includes('democrat')) result.legislatureSeats.democratic = count;
            if (party.includes('republican')) result.legislatureSeats.republican = count;
          }
        }
      });
    }
  });

  return result;
}

/**
 * Get all state names and IDs to iterate
 * @returns {Array<{name: string, code: string}>} Array of state info
 */
function getAllStatesList() {
  // Returns all US states from the state utils mapping
  return Object.entries(US_STATE_ABBR).map(([code, name]) => ({
    code: code.toUpperCase(),
    name,
  }));
}

/**
 * Load states data from JSON file
 * @param {string} [jsonPath] - Optional path to states.json
 * @returns {object|null} States database object or null if not found
 */
function loadStatesData(jsonPath) {
  const fs = require('node:fs');
  const path = require('node:path');
  
  const filePath = jsonPath || path.join(process.cwd(), 'data', 'states.json');
  
  if (!fs.existsSync(filePath)) {
    return null;
  }
  
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const db = JSON.parse(raw);
    return db && typeof db === 'object' ? db : null;
  } catch (err) {
    console.error('Error loading states.json:', err.message);
    return null;
  }
}

module.exports = {
  parseStateData,
  getAllStatesList,
  loadStatesData,
};

