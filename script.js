console.log("Script loaded.");

// Define map variable in a higher scope
let map;

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded and parsed");

    // Check if Leaflet is loaded
    if (typeof L === 'undefined') {
        console.error("Leaflet library not found!");
        return;
    }

    // Initialize the map and assign it to the higher scope variable
    map = L.map('map').setView([54.5, -3], 5); // Center roughly on UK

    // Add the OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    console.log("Map initialized");

    // Add event listener for the button (functionality to be added later)
    const findButton = document.getElementById('find-routes-btn');
    if (findButton) {
        findButton.addEventListener('click', findRoutes);
    } else {
        console.error("Find routes button not found!");
    }

});

async function findRoutes() {
    console.log("Find routes button clicked!");
    const postcode = document.getElementById('postcode').value.trim();
    const length = document.getElementById('length').value;
    console.log(`Searching for routes near ${postcode} of length ${length}m`);

    if (!postcode) {
        alert("Please enter a UK postcode.");
        return;
    }

    if (!map) {
        console.error("Map is not initialized yet.");
        alert("Map is not ready. Please wait and try again.");
        return;
    }

    // Add a simple loading indicator (optional, can be improved)
    document.getElementById('results').innerHTML = '<p>Looking up postcode...</p>';

    try {
        // Use postcodes.io API
        const response = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
        const data = await response.json();

        if (data.status === 200) {
            const latitude = data.result.latitude;
            const longitude = data.result.longitude;
            console.log(`Coordinates found: Lat: ${latitude}, Lon: ${longitude}`);

            // Center map and add marker
            map.setView([latitude, longitude], 15); // Zoom in closer (level 15)
            L.marker([latitude, longitude]).addTo(map)
                .bindPopup(`Start: ${data.result.postcode}`)
                .openPopup();

            document.getElementById('results').innerHTML = `<p>Found location for ${data.result.postcode}. Next step: Fetch map data.</p>`;

            // --- TODO: Call function to fetch Overpass data here --- 
            fetchOsmData(latitude, longitude, length);

        } else {
            console.error("Postcode not found or invalid:", data.error);
            alert(`Could not find coordinates for postcode: ${postcode}. Error: ${data.error}`);
            document.getElementById('results').innerHTML = '<p>Postcode lookup failed.</p>';
        }
    } catch (error) {
        console.error("Error fetching postcode data:", error);
        alert("An error occurred while looking up the postcode. Please check your connection and try again.");
        document.getElementById('results').innerHTML = '<p>Error during postcode lookup.</p>';
    }

    // Placeholder: Alert the user
    // alert("Route finding not implemented yet."); // Remove or comment out this line
}

async function fetchOsmData(lat, lon, desiredLengthMeters) {
    console.log(`Fetching OSM data around ${lat}, ${lon} for length ${desiredLengthMeters}m`);
    document.getElementById('results').innerHTML += '<p>Fetching walking paths data...</p>';

    // Calculate search radius - desired length / 2 plus a buffer (e.g., 500m)
    // Ensure radius is reasonable, e.g., at least 1000m
    const radius = Math.max(1000, (desiredLengthMeters / 2) + 500);
    console.log(`Using Overpass search radius: ${radius}m`);

    // Overpass query to find walkable ways
    // We look for common walkable highway types
    const query = `
        [out:json][timeout:30];
        (
          way
            ["highway"~"^(footway|path|pedestrian|track|residential|living_street|service|unclassified|tertiary)$"]
            (around:${radius},${lat},${lon});
          // Optionally add ways explicitly tagged for foot traffic
          // way["foot"="yes"](around:${radius},${lat},${lon});
        );
        out body;
        >;
        out skel qt;
    `;
    // Note: "out skel qt;" is efficient for getting nodes and ways needed for geometry
    // Using POST is recommended for larger queries
    const overpassUrl = 'https://overpass-api.de/api/interpreter';

    try {
        const response = await fetch(overpassUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: `data=${encodeURIComponent(query)}`
        });

        if (!response.ok) {
            throw new Error(`Overpass API request failed: ${response.status} ${response.statusText}`);
        }

        const osmData = await response.json();
        console.log("Received OSM data:", osmData);

        // Basic check if we got any elements
        if (osmData.elements && osmData.elements.length > 0) {
             document.getElementById('results').innerHTML += `<p>Successfully fetched ${osmData.elements.length} map elements. Next step: Process data and find routes.</p>`;
             // --- TODO: Call function to process OSM data and build graph --- 
             processOsmData(osmData);
        } else {
            document.getElementById('results').innerHTML += '<p>No walkable paths found in the immediate area via Overpass.</p>';
            alert("Could not find sufficient walking path data in this area. Try a different postcode or adjust length.");
        }

    } catch (error) {
        console.error("Error fetching or processing Overpass data:", error);
        document.getElementById('results').innerHTML += '<p>Error fetching walking path data.</p>';
        alert(`An error occurred while fetching map data: ${error.message}. The Overpass API might be busy. Please try again later.`);
    }
}

function processOsmData(osmData) {
    console.log("Processing OSM data...");
    document.getElementById('results').innerHTML += '<p>Processing map data...</p>';

    // Check if Turf.js is loaded
    if (typeof turf === 'undefined') {
        console.error("Turf.js library not found!");
        alert("Error: Required geometry library (Turf.js) is missing.");
        document.getElementById('results').innerHTML += '<p>Error: Missing geometry library.</p>';
        return;
    }

    // --- Step 8: Build Graph Representation --- 
    console.log("Building graph representation...");
    document.getElementById('results').innerHTML += '<p>Building path network graph...</p>';

    const nodeUsage = {}; // Count how many ways use each node
    const nodes = {};     // Store node coords { id: { lat: ..., lon: ... } }
    const ways = [];      // Store way objects { id: ..., nodes: [...] }

    osmData.elements.forEach(element => {
        if (element.type === 'node') {
            nodes[element.id] = { lat: element.lat, lon: element.lon };
        } else if (element.type === 'way' && element.nodes) {
            ways.push({ id: element.id, nodes: element.nodes });
            element.nodes.forEach(nodeId => {
                nodeUsage[nodeId] = (nodeUsage[nodeId] || 0) + 1;
            });
        }
    });

    const graph = {}; // Adjacency list: { nodeId: [ { neighborId: ..., length: ..., geometry: [[lon, lat], ...] }, ... ] }

    // Identify intersections (nodes used by >1 way) or endpoints (nodes used by 1 way at the end)
    const significantNodeIds = new Set();
    ways.forEach(way => {
        way.nodes.forEach((nodeId, index) => {
            if (nodeUsage[nodeId] > 1 || index === 0 || index === way.nodes.length - 1) {
                significantNodeIds.add(nodeId);
            }
        });
    });

    // Build edges between significant nodes
    ways.forEach(way => {
        let segmentStartNodeId = null;
        let currentSegmentCoords = [];

        way.nodes.forEach((nodeId, index) => {
            const nodeCoords = nodes[nodeId];
            if (!nodeCoords) return; // Skip if node data is missing

            currentSegmentCoords.push([nodeCoords.lon, nodeCoords.lat]);

            // If this node is significant, it marks the end of a segment
            if (significantNodeIds.has(nodeId)) {
                if (segmentStartNodeId !== null && segmentStartNodeId !== nodeId) { // We have a valid segment
                    if (currentSegmentCoords.length >= 2) {
                        try {
                            const line = turf.lineString(currentSegmentCoords);
                            const length = turf.length(line, { units: 'meters' });

                            // Add edge in both directions
                            if (!graph[segmentStartNodeId]) graph[segmentStartNodeId] = [];
                            if (!graph[nodeId]) graph[nodeId] = [];

                            graph[segmentStartNodeId].push({ neighborId: nodeId, length: length, geometry: currentSegmentCoords });
                            graph[nodeId].push({ neighborId: segmentStartNodeId, length: length, geometry: currentSegmentCoords.slice().reverse() }); // Reverse for the other direction

                        } catch (e) {
                            console.error(`Turf error processing segment ${segmentStartNodeId}-${nodeId}:`, e);
                        }
                    }
                }
                // Start the next segment
                segmentStartNodeId = nodeId;
                currentSegmentCoords = [[nodeCoords.lon, nodeCoords.lat]]; // Start new segment with current node
            }
        });
    });

    const graphNodeCount = Object.keys(graph).length;
    const graphEdgeCount = Object.values(graph).reduce((sum, edges) => sum + edges.length, 0) / 2; // Each edge counted twice
    console.log(`Graph built: ${graphNodeCount} nodes (intersections/ends), ${graphEdgeCount} edges (segments).`);
    document.getElementById('results').innerHTML += `<p>Network graph built (${graphNodeCount} nodes, ${graphEdgeCount} edges).</p>`;

    if (graphNodeCount === 0) {
         document.getElementById('results').innerHTML += '<p>Graph construction failed or area has no usable paths.</p>';
         alert("Failed to build a searchable path network for this area.");
         return;
    }

    // --- Find the closest graph node to the start point --- 
    let startNodeId = null;
    let minDistance = Infinity;
    // Get start coordinates from the map marker if available, otherwise need to pass them in
    // For now, let's assume we passed lat/lon to this function (or retrieve from a global var)
    // Needs refinement: Get lat/lon from the geocoding step reliably.
    // We should pass the geocoded lat/lon into processOsmData.
    const startLat = map.getCenter().lat; // Temporary way to get start lat/lon
    const startLon = map.getCenter().lng;
    const startPoint = turf.point([startLon, startLat]);

    Object.keys(graph).forEach(nodeId => {
        const nodeData = nodes[nodeId];
        if (nodeData) {
            const nodePoint = turf.point([nodeData.lon, nodeData.lat]);
            const distance = turf.distance(startPoint, nodePoint, { units: 'meters' });
            if (distance < minDistance) {
                minDistance = distance;
                startNodeId = parseInt(nodeId); // Ensure it's a number if keys were stringified
            }
        }
    });

    if (startNodeId !== null) {
        console.log(`Starting node for routing (closest to postcode): ${startNodeId} (Distance: ${minDistance.toFixed(2)}m)`);
         document.getElementById('results').innerHTML += `<p>Found starting point in network (Node ID: ${startNodeId}). Ready for route finding.</p>`;
    } else {
        console.error("Could not find a suitable starting node in the graph.");
         document.getElementById('results').innerHTML += '<p>Error: Could not link postcode location to the path network.</p>';
        alert("Could not find a starting point on the path network near the provided postcode.");
        return;
    }

    // Store graph and start node for the routing algorithm
    // e.g., window.walkGraph = graph; window.startNodeId = startNodeId;
    // Or pass them to the next function.

    // --- TODO: Implement routing algorithm (Step 9) --- 
    // findWalkRoutes(graph, startNodeId, desiredLengthMeters);
    alert("Graph built, but route finding algorithm is not implemented yet.");
} 