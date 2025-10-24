// Dashboard 2.0 - Maps functionality

class USMap {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.svg = null;
    this.projection = null;
    this.path = null;
    this.topoData = null;
    this.stateData = null;
    this.currentMetric = 'dem';
    this.currentActivity = '5';
    this.tooltip = window.tooltip;
    this.modal = window.modal;
    
    this.init();
  }

  async init() {
    try {
      // Check if D3.js is available
      if (typeof d3 === 'undefined') {
        console.warn('D3.js not available, loading state data for fallback display');
        await Promise.race([
          this.loadStateData(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout loading state data')), 10000))
        ]);
        this.renderFallbackMap();
        return;
      }

      // Test D3.js functionality before proceeding
      try {
        const testElement = d3.select(document.createElement('div'));
        if (!testElement || typeof testElement.append !== 'function') {
          throw new Error('D3.js not functioning properly');
        }
      } catch (d3Error) {
        console.warn('D3.js test failed, using simple SVG fallback:', d3Error);
        await Promise.race([
          Promise.all([this.loadTopoJSON(), this.loadStateData()]),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout loading map data')), 10000))
        ]);
        this.renderSimpleSVGMap();
        return;
      }

      // Load TopoJSON data and state statistics in parallel with timeout
      await Promise.race([
        Promise.all([this.loadTopoJSON(), this.loadStateData()]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout loading map data')), 10000))
      ]);

      // Setup projection and path
      this.setupProjection();

      // Validate path generator before rendering
      if (!this.path || typeof this.path !== 'function') {
        throw new Error('Path generator not properly initialized');
      }

      // Render the map
      this.renderMap();

      // Setup event listeners
      this.setupEventListeners();

    } catch (error) {
      console.error('Failed to initialize map:', error);
      // Try fallbacks in order of preference
      try {
        await Promise.race([
          Promise.all([this.loadTopoJSON(), this.loadStateData()]),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
        ]);
        this.renderSimpleSVGMap();
      } catch (fallbackError) {
        console.error('Simple SVG fallback failed, using data table:', fallbackError);
        try {
          await Promise.race([
            this.loadStateData(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
          ]);
          this.renderFallbackMap();
        } catch (finalError) {
          console.error('All fallbacks failed:', finalError);
          this.showError(`Failed to load map: ${error.message}`);
        }
      }
    }
  }

  async loadTopoJSON() {
    // Try a high-quality US map first, then fall back to local simplified file
    const tryUrls = [
      'https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json',
      '/data/us-states.topojson'
    ];
    let lastError = null;
    for (const url of tryUrls) {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        const json = await response.json();
        this.topoData = json;
        break;
      } catch (e) {
        lastError = e;
        console.warn('Failed to load map from', url, e);
      }
    }
    if (!this.topoData) throw lastError || new Error('No map data loaded');

      // Validate the loaded data
      if (!this.topoData || typeof this.topoData !== 'object') {
        throw new Error('Invalid data: not a valid object');
      }

      if (!this.topoData.objects || !this.topoData.objects.states) {
        throw new Error('Invalid data: missing states object');
      }

      const geometries = this.topoData.objects.states.geometries;
      if (!geometries || !Array.isArray(geometries) || geometries.length === 0) {
        throw new Error('Invalid data: missing or empty geometries array');
      }

      console.log('TopoJSON loaded and validated successfully:', {
        hasObjects: !!this.topoData.objects,
        hasStates: !!this.topoData.objects.states,
        geometriesCount: geometries.length,
        arcsCount: this.topoData.arcs?.length || 0,
        firstState: geometries[0]?.properties?.name || 'unknown'
      });
    } catch (error) {
      console.error('Failed to load TopoJSON:', error);
      // Fallback to a simple SVG if TopoJSON fails
      this.loadFallbackMap();
    }
  }

  loadFallbackMap() {
    try {
      // Simple fallback - create basic state shapes
      const geometries = this.getFallbackStateGeometries();

      if (!geometries || !Array.isArray(geometries) || geometries.length === 0) {
        throw new Error('Failed to generate fallback geometries');
      }

      this.topoData = {
        type: "Topology",
        objects: {
          states: {
            type: "GeometryCollection",
            geometries: geometries
          }
        }
      };

      console.log('Fallback map data created successfully:', geometries.length, 'states');
    } catch (error) {
      console.error('Failed to create fallback map data:', error);
      this.showError('Unable to create map fallback data');
    }
  }

  getFallbackStateGeometries() {
    // Basic state geometries as fallback
    return [
      {
        type: "Polygon",
        properties: { name: "California", id: "CA" },
        coordinates: [[[200, 300], [250, 280], [300, 290], [320, 320], [310, 350], [280, 360], [240, 340], [200, 300]]]
      },
      {
        type: "Polygon", 
        properties: { name: "Texas", id: "TX" },
        coordinates: [[[400, 400], [500, 380], [550, 400], [540, 450], [480, 460], [420, 450], [400, 400]]]
      },
      {
        type: "Polygon",
        properties: { name: "Florida", id: "FL" },
        coordinates: [[[600, 500], [650, 480], [680, 520], [670, 560], [630, 570], [600, 500]]]
      },
      {
        type: "Polygon",
        properties: { name: "New York", id: "NY" },
        coordinates: [[[700, 200], [750, 180], [780, 220], [760, 250], [720, 240], [700, 200]]]
      },
      {
        type: "Polygon",
        properties: { name: "Pennsylvania", id: "PA" },
        coordinates: [[[650, 250], [700, 230], [730, 270], [710, 300], [670, 290], [650, 250]]]
      }
    ];
  }

  async loadStateData() {
    try {
      const response = await fetch(`/state-stats.json?activity=${this.currentActivity}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      this.stateData = await response.json();
      console.log('State data loaded successfully:', Object.keys(this.stateData).length, 'states');
    } catch (error) {
      console.error('Failed to load state data:', error);
      this.stateData = {};
      // Don't show error immediately, try to render map without data first
      console.warn('Continuing with empty state data - map will show without statistics');
    }
  }

  setupProjection() {
    // Use d3-geo if available, otherwise fallback to simple scaling
    if (typeof d3 !== 'undefined' && d3.geo) {
      this.projection = d3.geoAlbersUsa()
        .scale(1000)
        .translate([500, 300]);
      this.path = d3.geoPath().projection(this.projection);
    } else {
      // Simple fallback projection
      this.projection = {
        scale: 1,
        translate: [0, 0]
      };
      this.path = (feature) => {
        try {
          if (feature && feature.geometry) {
            // Handle GeoJSON format
            const geom = feature.geometry;
            if (geom.type === 'Polygon' && geom.coordinates && geom.coordinates[0]) {
              const coords = geom.coordinates[0];
              return `M ${coords.map(([x, y]) => `${x},${y}`).join(' L ')} Z`;
            }
          } else if (feature && feature.type === 'Polygon' && feature.coordinates) {
            // Handle direct geometry format
            const coords = feature.coordinates[0];
            return `M ${coords.map(([x, y]) => `${x},${y}`).join(' L ')} Z`;
          }
          return '';
        } catch (error) {
          console.error('Error in path generator:', error, feature);
          return '';
        }
      };
    }
  }

  renderMap() {
    if (!this.topoData || !this.container) return;

    // Clear existing map
    this.container.innerHTML = '';

    // Check if D3.js is available
    if (typeof d3 === 'undefined') {
      this.showError('D3.js library failed to load. Please check your internet connection or try refreshing the page.');
      return;
    }

    try {
      // Validate data structure
      if (!this.topoData.objects || !this.topoData.objects.states) {
        throw new Error('Invalid data: missing states object');
      }

      if (!this.topoData.objects.states.geometries || !Array.isArray(this.topoData.objects.states.geometries)) {
        throw new Error('Invalid data: missing or invalid geometries array');
      }

      // Check if it's our simplified format or real TopoJSON
      const isSimplifiedFormat = !this.topoData.arcs && this.topoData.objects.states.geometries[0]?.coordinates;
      console.log('Data format detected:', isSimplifiedFormat ? 'Simplified GeoJSON' : 'TopoJSON');

      console.log('TopoJSON data validated:', {
        hasObjects: !!this.topoData.objects,
        hasStates: !!this.topoData.objects.states,
        geometriesCount: this.topoData.objects.states.geometries?.length || 0
      });

      // Create SVG
      this.svg = d3.select(this.container)
        .append('svg')
        .attr('class', 'map-svg')
        .attr('viewBox', '0 0 1000 600')
        .attr('preserveAspectRatio', 'xMidYMid meet');

      // Validate path generator
      if (!this.path || typeof this.path !== 'function') {
        throw new Error('Path generator not properly initialized');
      }

      // Convert TopoJSON to GeoJSON
      let states;
      const simplifiedFormat = !this.topoData.arcs;
      if (typeof topojson !== 'undefined' && this.topoData.arcs) {
        // Real TopoJSON format
        states = topojson.feature(this.topoData, this.topoData.objects.states);
      } else {
        // Our simplified format - treat as GeoJSON
        states = {
          type: 'FeatureCollection',
          features: this.topoData.objects.states.geometries.map(geom => ({
            type: 'Feature',
            properties: geom.properties || { id: geom.id, name: geom.name || 'Unknown' },
            geometry: { type: geom.type, coordinates: geom.coordinates }
          }))
        };
      }

      // Ensure we have two-letter state IDs when using us-atlas
      const nameToAbbr = {
        'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA','Colorado':'CO','Connecticut':'CT','Delaware':'DE','Florida':'FL','Georgia':'GA','Hawaii':'HI','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA','Kansas':'KS','Kentucky':'KY','Louisiana':'LA','Maine':'ME','Maryland':'MD','Massachusetts':'MA','Michigan':'MI','Minnesota':'MN','Mississippi':'MS','Missouri':'MO','Montana':'MT','Nebraska':'NE','Nevada':'NV','New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND','Ohio':'OH','Oklahoma':'OK','Oregon':'OR','Pennsylvania':'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD','Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT','Virginia':'VA','Washington':'WA','West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY'
      };
      const fipsToAbbr = {
        '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD','47':'TN','48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI','56':'WY'
      };
      const abbrToName = Object.fromEntries(Object.entries(nameToAbbr).map(([n,a])=>[a,n]));
      states.features.forEach(f => {
        if (!f.properties) f.properties = {};
        // us-atlas stores numeric FIPS in feature.id
        const fips = String(f.id || '').padStart(2,'0');
        if (!f.properties.id) {
          if (f.properties.name && nameToAbbr[f.properties.name]) {
            f.properties.id = nameToAbbr[f.properties.name];
          } else if (fipsToAbbr[fips]) {
            f.properties.id = fipsToAbbr[fips];
          }
        }
        if (!f.properties.name && f.properties.id && abbrToName[f.properties.id]) {
          f.properties.name = abbrToName[f.properties.id];
        }
      });

      // If we only have simplified coordinates, draw a basic SVG map instead of projecting
      if (simplifiedFormat) {
        console.warn('Using simplified local geometry; rendering simple SVG map');
        this.topoData = { objects: { states: { geometries: states.features.map(f => ({
          type: f.geometry.type,
          properties: { id: f.properties.id, name: f.properties.name },
          coordinates: f.geometry.coordinates
        })) } } };
        this.renderSimpleSVGMap();
        this.updateColors();
        return;
      }

      console.log('States data prepared:', {
        featuresCount: states.features?.length || 0,
        firstFeature: states.features?.[0]?.properties
      });

      // Render states
      const statePaths = this.svg.selectAll('.state')
        .data(states.features)
        .enter()
        .append('path')
        .attr('class', 'state')
        .attr('d', (d) => {
          try {
            const pathData = this.path(d);
            if (!pathData) {
              console.warn('Empty path data for state:', d.properties?.name || 'Unknown');
            }
            return pathData;
          } catch (error) {
            console.error('Error generating path for state:', d.properties?.name || 'Unknown', error);
            return '';
          }
        })
        .attr('data-state', d => d.properties?.id || 'unknown')
        .attr('data-name', d => d.properties?.name || 'Unknown')
        .attr('tabindex', '0')
        .attr('role', 'button')
        .attr('aria-label', d => `${d.properties?.name || 'Unknown'} state - click for details`);

      // Add event listeners with proper context and error handling
      statePaths
        .on('mouseenter', (event, d) => {
          try {
            this.showTooltip(event, d);
          } catch (error) {
            console.error('Error in mouseenter handler:', error);
          }
        })
        .on('mouseleave', (event, d) => {
          try {
            this.hideTooltip();
          } catch (error) {
            console.error('Error in mouseleave handler:', error);
          }
        })
        .on('click', (event, d) => {
          try {
            this.showStateDetails(d);
          } catch (error) {
            console.error('Error in click handler:', error);
          }
        })
        .on('keydown', (event, d) => {
          try {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              this.showStateDetails(d);
            }
          } catch (error) {
            console.error('Error in keydown handler:', error);
          }
        });

      // Update colors
      this.updateColors();
    } catch (error) {
      console.error('Error rendering map:', error);
      this.showError(`Map rendering failed: ${error.message}`);
    }
  }

  updateColors() {
    if (!this.svg) return;

    const states = this.svg.selectAll('.state');
    const mapInstance = this; // preserve class context without rebinding the DOM element
    
    states.each(function(d) {
      const element = this; // 'this' is the SVG path element
      const stateId = d?.properties?.id;
      if (!stateId || !mapInstance.stateData) {
        d3.select(element).attr('class', 'state heat-0');
        return;
      }

      const stateKey = mapInstance.getStateKey(stateId);
      const stateStats = mapInstance.stateData[stateKey];
      
      if (!stateStats) {
        d3.select(element).attr('class', 'state heat-0');
        return;
      }

      let value = 0;
      switch (mapInstance.currentMetric) {
        case 'dem':
          value = stateStats.demActive || 0;
          break;
        case 'gop':
          value = stateStats.gopActive || 0;
          break;
        case 'es':
          value = stateStats.totalES || 0;
          break;
        case 'cash':
          value = stateStats.avgCash || 0;
          break;
      }

      const heatClass = mapInstance.getHeatClass(value, mapInstance.currentMetric);
      d3.select(element).attr('class', `state ${heatClass}`);
    });
  }

  getStateKey(stateId) {
    // Convert state ID to lowercase key used in stateData
    const stateMap = {
      'CA': 'california', 'TX': 'texas', 'FL': 'florida', 'NY': 'new york',
      'PA': 'pennsylvania', 'IL': 'illinois', 'OH': 'ohio', 'GA': 'georgia',
      'NC': 'north carolina', 'MI': 'michigan', 'NJ': 'new jersey', 'VA': 'virginia',
      'WA': 'washington', 'AZ': 'arizona', 'MA': 'massachusetts', 'TN': 'tennessee',
      'IN': 'indiana', 'MO': 'missouri', 'MD': 'maryland', 'WI': 'wisconsin',
      'CO': 'colorado', 'MN': 'minnesota', 'SC': 'south carolina', 'AL': 'alabama',
      'LA': 'louisiana', 'KY': 'kentucky', 'OR': 'oregon', 'OK': 'oklahoma',
      'CT': 'connecticut', 'UT': 'utah', 'IA': 'iowa', 'NV': 'nevada',
      'AR': 'arkansas', 'MS': 'mississippi', 'KS': 'kansas', 'NM': 'new mexico',
      'NE': 'nebraska', 'WV': 'west virginia', 'ID': 'idaho', 'HI': 'hawaii',
      'NH': 'new hampshire', 'ME': 'maine', 'RI': 'rhode island', 'MT': 'montana',
      'DE': 'delaware', 'SD': 'south dakota', 'ND': 'north dakota', 'AK': 'alaska',
      'VT': 'vermont', 'WY': 'wyoming'
    };
    return stateMap[stateId] || stateId.toLowerCase();
  }

  getHeatClass(value, metric) {
    if (value === 0) return 'heat-0';
    
    // Get max value for this metric
    const maxValue = this.getMaxValue(metric);
    if (maxValue === 0) return 'heat-0';
    
    const ratio = value / maxValue;
    let heatLevel;
    if (ratio <= 0.2) heatLevel = 1;
    else if (ratio <= 0.4) heatLevel = 2;
    else if (ratio <= 0.6) heatLevel = 3;
    else heatLevel = 4;

    const prefix = metric === 'gop' ? 'heat-red' : 
                   metric === 'es' ? 'heat-purple' : 
                   metric === 'cash' ? 'heat-green' : 'heat';
    
    return `${prefix}-${heatLevel}`;
  }

  getMaxValue(metric) {
    if (!this.stateData) return 0;
    
    const values = Object.values(this.stateData).map(stats => {
      switch (metric) {
        case 'dem': return stats.demActive || 0;
        case 'gop': return stats.gopActive || 0;
        case 'es': return stats.totalES || 0;
        case 'cash': return stats.avgCash || 0;
        default: return 0;
      }
    });
    
    return Math.max(...values, 0);
  }

  showTooltip(event, d) {
    const stateName = d.properties.name;
    const stateKey = this.getStateKey(d.properties.id);
    const stateStats = this.stateData[stateKey];
    
    if (!stateStats) return;

    let content = `<strong>${stateName}</strong><br>`;
    
    switch (this.currentMetric) {
      case 'dem':
        content += `Democrats: ${stateStats.demActive || 0} active`;
        break;
      case 'gop':
        content += `Republicans: ${stateStats.gopActive || 0} active`;
        break;
        case 'es':
          content += `Total Election Stamina: ${(stateStats.totalES || 0).toLocaleString()}`;
          break;
      case 'cash':
        content += `Avg Cash: ${formatCurrency(stateStats.avgCash || 0)}`;
        break;
    }
    
    this.tooltip.show(event, content);
  }

  hideTooltip() {
    this.tooltip.hide();
  }

  showStateDetails(d) {
    try {
      const stateName = d.properties?.name || 'Unknown State';
      const stateId = d.properties?.id || 'unknown';
      const stateKey = this.getStateKey(stateId);
      const stateStats = this.stateData[stateKey];

      let content = `
        <div class="modal-header">
          <h3>${stateName} Players</h3>
          <button class="modal-close" onclick="window.modal.hide()">&times;</button>
        </div>
      `;

      if (stateStats && stateStats.playerCount > 0) {
        content += `
          <div class="modal-stats">
            <p><strong>Active Players:</strong> ${stateStats.playerCount}</p>
            <p><strong>Democrats:</strong> ${stateStats.demActive || 0}</p>
            <p><strong>Republicans:</strong> ${stateStats.gopActive || 0}</p>
            <p><strong>Total ES:</strong> ${formatNumber(stateStats.totalES || 0)}</p>
            <p><strong>Avg Cash:</strong> ${formatCurrency(stateStats.avgCash || 0)}</p>
          </div>
          <ul class="player-list">
        `;

        const players = stateStats.players || [];
        const topPlayers = players.slice(0, 10);

        topPlayers.forEach(player => {
          try {
            const cash = parseMoney(player.cash);
            const es = parseES(player.es);
            const party = player.party || 'Unknown';

            content += `
              <li class="player-item">
                <a href="/stats?search=${encodeURIComponent(player.name)}" class="player-link">
                  ${player.name}
                </a><br>
                <small class="text-muted">
                  ${formatCurrency(cash)} | ES: ${formatNumber(es)} | ${party}
                </small>
              </li>
            `;
          } catch (playerError) {
            console.error('Error formatting player data:', playerError, player);
          }
        });

        content += '</ul>';
      } else {
        content += `
          <div class="modal-stats">
            <p class="text-muted">No player data available for this state.</p>
            <p><strong>State ID:</strong> ${stateId}</p>
          </div>
        `;
      }

      this.modal.show(content);
    } catch (error) {
      console.error('Error showing state details:', error);
      this.modal.show(`
        <div class="modal-header">
          <h3>Error</h3>
          <button class="modal-close" onclick="window.modal.hide()">&times;</button>
        </div>
        <p class="text-muted">Unable to load state details.</p>
      `);
    }
  }

  setupEventListeners() {
    // Activity filter dropdown
    const activityFilter = document.getElementById('activityFilter');
    if (activityFilter) {
      activityFilter.addEventListener('change', (e) => {
        this.currentActivity = e.target.value;
        this.loadStateData().then(() => {
          this.updateColors();
          this.updateLegend();
        });
      });
    }

    // Metric selector (if present)
    const metricSelector = document.getElementById('metricSelector');
    if (metricSelector) {
      metricSelector.addEventListener('change', (e) => {
        this.currentMetric = e.target.value;
        this.updateColors();
        this.updateLegend();
      });
    }
  }

  updateLegend() {
    const legend = document.getElementById('map-legend');
    if (!legend) return;

    const maxValue = this.getMaxValue(this.currentMetric);
    const steps = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
    const labels = ['0', 'Low', 'Medium', 'High', 'Max'];
    
    const prefix = this.currentMetric === 'gop' ? 'heat-red' : 
                   this.currentMetric === 'es' ? 'heat-purple' : 
                   this.currentMetric === 'cash' ? 'heat-green' : 'heat';

    const metricName = this.currentMetric === 'dem' ? 'Democratic Activity' :
                      this.currentMetric === 'gop' ? 'Republican Activity' :
                      this.currentMetric === 'es' ? 'Election Stamina' :
                      this.currentMetric === 'cash' ? 'Average Cash' : 'Activity';

    legend.innerHTML = `
      <div class="legend-title" aria-label="Legend for ${metricName}">
        ${metricName} Legend
      </div>
      ${steps.map((step, i) => `
        <div class="legend-item" role="listitem">
          <div class="legend-color ${prefix}-${i}" aria-label="Color intensity level ${i === 0 ? 'zero' : labels[i - 1].toLowerCase()}"></div>
          <span>${i === 0 ? '0' : labels[i - 1]}</span>
        </div>
      `).join('')}
    `;
  }

  showError(message) {
    if (this.container) {
      this.container.innerHTML = `
        <div class="text-center text-muted" style="padding: 40px;">
          <h3>Map Unavailable</h3>
          <p>${message}</p>
          <button onclick="location.reload()" class="btn btn-primary" style="margin-top: 16px;">Retry</button>
        </div>
      `;
    }
  }

  // Fallback map without D3.js
  renderFallbackMap() {
    if (!this.container) return;
    
    this.container.innerHTML = `
      <div style="padding: 20px; text-align: center;">
        <h4>Interactive Map Unavailable</h4>
        <p class="text-muted">D3.js library failed to load. Showing data table instead.</p>
        <div style="margin-top: 20px;">
          ${this.renderStateDataTable()}
        </div>
      </div>
    `;
  }

  // Alternative fallback that creates a simple SVG map
  renderSimpleSVGMap() {
    if (!this.container || !this.topoData) {
      console.warn('Cannot render simple SVG map: missing container or data');
      this.renderFallbackMap();
      return;
    }

    try {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 1000 600');
      svg.setAttribute('class', 'map-svg');
      svg.style.width = '100%';
      svg.style.height = 'auto';
      svg.style.maxHeight = '500px';

      // Simple scale and offset for our coordinates
      const scale = 0.8;
      const offsetX = 100;
      const offsetY = 100;

      let successCount = 0;
      const mapInstance = this; // Preserve reference to USMap instance

      // Validate geometries array
      const geometries = this.topoData.objects?.states?.geometries;
      if (!geometries || !Array.isArray(geometries)) {
        throw new Error('Invalid geometries data');
      }

      geometries.forEach((geom) => {
        try {
          if (!geom || !geom.properties) {
            console.warn('Skipping invalid geometry:', geom);
            return;
          }

          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');

          // Convert coordinates to SVG path
          let pathData = '';
          if (geom.coordinates && Array.isArray(geom.coordinates)) {
            geom.coordinates.forEach(ring => {
              if (Array.isArray(ring)) {
                ring.forEach((coord, i) => {
                  if (Array.isArray(coord) && coord.length >= 2) {
                    const x = coord[0] * scale + offsetX;
                    const y = coord[1] * scale + offsetY;
                    pathData += (i === 0 ? 'M' : 'L') + x + ',' + y + ' ';
                  }
                });
                pathData += 'Z ';
              }
            });
          }

          if (pathData.trim()) {
            path.setAttribute('d', pathData);
            path.setAttribute('class', 'state');
            path.setAttribute('data-state', geom.properties.id || 'unknown');
            path.setAttribute('data-name', geom.properties.name || 'Unknown');
            path.setAttribute('fill', '#e0e0e0');
            path.setAttribute('stroke', '#999');
            path.setAttribute('stroke-width', '1');
            path.style.cursor = 'pointer';

            // Add hover effect with error handling
            path.addEventListener('mouseenter', () => {
              try {
                path.setAttribute('fill', '#4CAF50');
              } catch (e) {
                console.error('Error in mouseenter:', e);
              }
            });
            path.addEventListener('mouseleave', () => {
              try {
                path.setAttribute('fill', '#e0e0e0');
              } catch (e) {
                console.error('Error in mouseleave:', e);
              }
            });

            // Add click handler with proper context and error handling
            path.addEventListener('click', () => {
              try {
                mapInstance.showStateDetails({
                  properties: {
                    name: geom.properties.name || 'Unknown',
                    id: geom.properties.id || 'unknown'
                  }
                });
              } catch (e) {
                console.error('Error in click handler:', e);
              }
            });

            svg.appendChild(path);
            successCount++;
          }
        } catch (error) {
          console.error('Error creating path for', geom?.properties?.name || 'unknown', error);
        }
      });

      this.container.innerHTML = '';
      this.container.appendChild(svg);

      console.log(`Simple SVG map created: ${successCount} states rendered successfully`);

      if (successCount === 0) {
        console.warn('No states were rendered, falling back to data table');
        this.renderFallbackMap();
      }
    } catch (error) {
      console.error('Error creating simple SVG map:', error);
      this.renderFallbackMap();
    }
  }

  renderStateDataTable() {
    if (!this.stateData || Object.keys(this.stateData).length === 0) {
      return '<p class="text-muted">No state data available</p>';
    }

    const states = Object.entries(this.stateData)
      .sort(([,a], [,b]) => (b.demActive + b.gopActive) - (a.demActive + a.gopActive))
      .slice(0, 10);

    let tableHTML = `
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>State</th>
              <th>Democrats</th>
              <th>Republicans</th>
              <th>Total ES</th>
              <th>Avg Cash</th>
            </tr>
          </thead>
          <tbody>
    `;

    states.forEach(([stateName, data]) => {
      const displayName = stateName.charAt(0).toUpperCase() + stateName.slice(1).replace(/([A-Z])/g, ' $1');
      tableHTML += `
        <tr>
          <td><strong>${displayName}</strong></td>
          <td>${data.demActive || 0}</td>
          <td>${data.gopActive || 0}</td>
          <td>${(data.totalES || 0).toLocaleString()}</td>
          <td>$${(data.avgCash || 0).toLocaleString()}</td>
        </tr>
      `;
    });

    tableHTML += '</tbody></table></div>';
    return tableHTML;
  }
}

// Initialize map when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  console.log('Maps page loaded, initializing map...');
  console.log('D3 available:', typeof d3 !== 'undefined');
  console.log('TopoJSON available:', typeof topojson !== 'undefined');
  
  const mapContainer = document.getElementById('us-map');
  if (mapContainer) {
    console.log('Map container found, creating USMap instance...');
    window.usMap = new USMap('us-map');
  } else {
    console.error('Map container not found!');
  }
});

// Export for global access
window.USMap = USMap;
