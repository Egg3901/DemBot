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
    this.currentActivity = '3';
    this.tooltip = window.tooltip;
    this.modal = window.modal;
    
    this.init();
  }

  async init() {
    try {
      // Check if D3.js is available
      if (typeof d3 === 'undefined') {
        console.warn('D3.js not available, loading state data for fallback display');
        await this.loadStateData();
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
        await this.loadTopoJSON();
        await this.loadStateData();
        this.renderSimpleSVGMap();
        return;
      }
      
      // Load TopoJSON data
      await this.loadTopoJSON();
      
      // Load state statistics
      await this.loadStateData();
      
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
      // Try to load state data for fallback even if map fails
      try {
        await this.loadTopoJSON();
        await this.loadStateData();
        this.renderSimpleSVGMap();
      } catch (fallbackError) {
        console.error('Simple SVG fallback failed, using data table:', fallbackError);
        try {
          await this.loadStateData();
          this.renderFallbackMap();
        } catch (finalError) {
          console.error('All fallbacks failed:', finalError);
          this.showError(`Failed to load map: ${error.message}`);
        }
      }
    }
  }

  async loadTopoJSON() {
    try {
      const response = await fetch('/data/us-states.topojson');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      this.topoData = await response.json();
      
      // Validate the loaded data
      if (!this.topoData || typeof this.topoData !== 'object') {
        throw new Error('Invalid data: not a valid object');
      }
      
      if (!this.topoData.objects || !this.topoData.objects.states) {
        throw new Error('Invalid data: missing states object');
      }
      
      console.log('TopoJSON loaded and validated successfully:', {
        hasObjects: !!this.topoData.objects,
        hasStates: !!this.topoData.objects.states,
        geometriesCount: this.topoData.objects.states.geometries?.length || 0,
        arcsCount: this.topoData.arcs?.length || 0
      });
    } catch (error) {
      console.error('Failed to load TopoJSON:', error);
      // Fallback to a simple SVG if TopoJSON fails
      this.loadFallbackMap();
    }
  }

  loadFallbackMap() {
    // Simple fallback - create basic state shapes
    this.topoData = {
      type: "Topology",
      objects: {
        states: {
          type: "GeometryCollection",
          geometries: this.getFallbackStateGeometries()
        }
      }
    };
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
      this.showError('Unable to load state statistics. Please check if the server is running and data files are available.');
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
      if (typeof topojson !== 'undefined' && this.topoData.arcs) {
        // Real TopoJSON format
        states = topojson.feature(this.topoData, this.topoData.objects.states);
      } else {
        // Our simplified format - treat as GeoJSON
        states = {
          type: "FeatureCollection",
          features: this.topoData.objects.states.geometries.map(geom => ({
            type: "Feature",
            properties: geom.properties || { id: geom.id, name: geom.name || 'Unknown' },
            geometry: {
              type: geom.type,
              coordinates: geom.coordinates
            }
          }))
        };
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
    if (!this.svg || !this.stateData) return;

    const states = this.svg.selectAll('.state');
    
    states.each(function(d) {
      const stateId = d.properties.id;
      const stateKey = this.getStateKey(stateId);
      const stateStats = this.stateData[stateKey];
      
      if (!stateStats) return;

      let value = 0;
      switch (this.currentMetric) {
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

      const heatClass = this.getHeatClass(value, this.currentMetric);
      d3.select(this).attr('class', `state ${heatClass}`);
    }.bind(this));
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
    const stateName = d.properties.name;
    const stateKey = this.getStateKey(d.properties.id);
    const stateStats = this.stateData[stateKey];
    
    if (!stateStats) return;

    const content = `
      <div class="modal-header">
        <h3>${stateName} Players (${stateStats.playerCount || 0})</h3>
        <button class="modal-close" onclick="window.modal.hide()">&times;</button>
      </div>
      <ul class="player-list">
        ${(stateStats.players || []).slice(0, 10).map(player => `
          <li class="player-item">
            <a href="/stats?search=${encodeURIComponent(player.name)}" class="player-link">
              ${player.name}
            </a><br>
            <small class="text-muted">
              ${formatCurrency(parseMoney(player.cash))} | ES: ${formatNumber(parseES(player.es))} | ${player.party || 'Unknown'}
            </small>
          </li>
        `).join('')}
      </ul>
    `;
    
    this.modal.show(content);
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
    if (!this.container || !this.topoData) return;
    
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
      
      this.topoData.objects.states.geometries.forEach((geom) => {
        try {
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
            path.setAttribute('data-state', geom.properties.id);
            path.setAttribute('data-name', geom.properties.name);
            path.setAttribute('fill', '#e0e0e0');
            path.setAttribute('stroke', '#999');
            path.setAttribute('stroke-width', '1');
            path.style.cursor = 'pointer';
            
            // Add hover effect
            path.addEventListener('mouseenter', () => {
              path.setAttribute('fill', '#4CAF50');
            });
            path.addEventListener('mouseleave', () => {
              path.setAttribute('fill', '#e0e0e0');
            });
            
            // Add click handler
            path.addEventListener('click', () => {
              this.showStateDetails({
                properties: {
                  name: geom.properties.name,
                  id: geom.properties.id
                }
              });
            });
            
            svg.appendChild(path);
            successCount++;
          }
        } catch (error) {
          console.error('Error creating path for', geom.properties.name, error);
        }
      });
      
      this.container.innerHTML = '';
      this.container.appendChild(svg);
      
      console.log(`Simple SVG map created: ${successCount} states rendered`);
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
