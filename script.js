console.log("Script loaded.");

// Define map variable in a higher scope
let map;

// Define globally or in a higher scope to keep track of route layers
let drawnRouteLayers = [];

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

    const radius = Math.max(1000, (desiredLengthMeters / 2) + 500);
    console.log(`Using Overpass search radius: ${radius}m`);

    const query = `
        [out:json][timeout:30];
        (
          way
            ["highway"~"^(footway|path|pedestrian|track|residential|living_street|service|unclassified|tertiary)$"]
            (around:${radius},${lat},${lon});
        );
        out body;
        >;
        out skel qt;
    `;
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

        if (osmData.elements && osmData.elements.length > 0) {
             document.getElementById('results').innerHTML += `<p>Successfully fetched ${osmData.elements.length} map elements. Next step: Process data and find routes.</p>`;
             // Pass lat, lon, and desiredLengthMeters
             processOsmData(osmData, lat, lon, parseInt(desiredLengthMeters)); // Ensure length is number
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

function processOsmData(osmData, startLat, startLon, desiredLengthMeters) {
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
    // Use passed-in startLat, startLon
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
         document.getElementById('results').innerHTML += `<p>Starting route search...</p>`; // Added status update
         // Call the routing algorithm
         findWalkRoutes(graph, startNodeId, desiredLengthMeters); // Pass the graph, start node, and length
    } else {
        console.error("Could not find a suitable starting node in the graph.");
         document.getElementById('results').innerHTML += '<p>Error: Could not link postcode location to the path network.</p>';
        alert("Could not find a starting point on the path network near the provided postcode.");
        return;
    }

    // --- DEBUG: Visualize the graph --- 
    _debugDrawGraph(graph, nodes);

    // Store graph and start node for the routing algorithm
    // e.g., window.walkGraph = graph; window.startNodeId = startNodeId;
    // Or pass them to the next function.

    // --- TODO: Implement routing algorithm (Step 9) --- 
    // findWalkRoutes(graph, startNodeId, desiredLengthMeters);
    // alert("Graph built, but route finding algorithm is not implemented yet."); // REMOVED
}

// --- Step 9: Implement Routing Algorithm --- 
const ROUTE_FINDING_TIMEOUT_MS = 60000; // 60 seconds max search time (Increased from 15s)
const LENGTH_TOLERANCE_PERCENT = 0.10; // +/- 10%
const MAX_ROUTES_TO_FIND = 5;

async function findWalkRoutes(graph, startNodeId, targetLength) {
    console.log(`Starting route search from node ${startNodeId} for target length ${targetLength}m`);
    const startTime = Date.now();
    const foundRoutes = [];

    const minLength = targetLength * (1 - LENGTH_TOLERANCE_PERCENT);
    const maxLength = targetLength * (1 + LENGTH_TOLERANCE_PERCENT);
    const absoluteMaxLength = targetLength * 1.5; // Prune paths significantly longer

    // Stack for iterative DFS: [currentNodeId, pathArray, visitedEdgesSet, currentLength, geometryArray]
    const stack = [];

    // Initial state
    stack.push([startNodeId, [startNodeId], new Set(), 0, []]);

    let iterations = 0;

    // Clear previous routes from map and list before starting search
    clearRoutes();
    document.getElementById('results').innerHTML = '<p>Starting route search...</p>'; // Reset results area

    while (stack.length > 0) {
        iterations++;
        if (iterations % 1000 === 0) { 
             const elapsedTime = Date.now() - startTime;
             if (elapsedTime > ROUTE_FINDING_TIMEOUT_MS) {
                 console.warn(`Route finding timed out after ${elapsedTime}ms`);
                 document.getElementById('results').innerHTML += '<p>Route search timed out (complex area or length).</p>';
                 break; 
             }
        }

        const [currentNodeId, currentPath, visitedEdges, currentLength, currentGeometry] = stack.pop();

        const neighbors = graph[currentNodeId] || [];
        for (const edge of neighbors) {
            const neighborId = edge.neighborId;
            const edgeLength = edge.length;
            const edgeGeometry = edge.geometry;
            const newLength = currentLength + edgeLength;

            // --- Pruning and Checks ---
            if (newLength > absoluteMaxLength) continue;

            if (currentPath.length > 1 && neighborId === currentPath[currentPath.length - 2]) continue; // Prevent immediate U-turn

             if (neighborId === startNodeId && currentPath.length >= 2) { 
                 if (newLength >= minLength && newLength <= maxLength) {
                     const route = {
                         length: newLength,
                         path: [...currentPath, neighborId],
                         geometry: [...currentGeometry, edgeGeometry]
                     };
                     foundRoutes.push(route);
                     console.log(`Found route: Length ${newLength.toFixed(0)}m`);
                     document.getElementById('results').innerHTML += `<p>Found potential route: ${newLength.toFixed(0)}m</p>`;

                     if (foundRoutes.length >= MAX_ROUTES_TO_FIND) {
                         stack.length = 0; 
                         console.log(`Found maximum number of routes (${MAX_ROUTES_TO_FIND}).`);
                         break;
                     }
                 }
                 continue; 
             }

            // --- Prepare for next step ---
            const newPath = [...currentPath, neighborId];
            const newVisitedEdges = new Set(visitedEdges); 
            const newGeometry = [...currentGeometry, edgeGeometry];

            stack.push([neighborId, newPath, newVisitedEdges, newLength, newGeometry]);
        }
         if (foundRoutes.length >= MAX_ROUTES_TO_FIND) break; 
    }

    const endTime = Date.now();
    console.log(`Route search finished in ${endTime - startTime}ms. Found ${foundRoutes.length} routes.`);

    if (foundRoutes.length > 0) {
        document.getElementById('results').innerHTML += `<h3>Found ${foundRoutes.length} route(s):</h3><ul>`;
        foundRoutes.forEach((route, index) => {
            console.log(`Route ${index + 1}: Length=${route.length.toFixed(0)}m, Nodes=${route.path.length}`);
             document.getElementById('results').innerHTML += `<li>Route ${index + 1}: ${route.length.toFixed(0)}m</li>`;
             // --- Draw route on map (Step 11) ---
             drawRoute(route, index); // Pass index for potential color variation
        });
         document.getElementById('results').innerHTML += `</ul>`;
    } else {
         document.getElementById('results').innerHTML += `<p>No suitable loops found within the time limit and criteria.</p>`;
         // Only alert if no routes found and no timeout message was already shown
         if (Date.now() - startTime < ROUTE_FINDING_TIMEOUT_MS) {
            alert("Could not find any walking loops matching your criteria. Try changing the length or postcode, or the area might be too complex.");
         }
    }
}

// Function to clear existing routes from the map
function clearRoutes() {
    drawnRouteLayers.forEach(layer => map.removeLayer(layer));
    drawnRouteLayers = [];
    // Optionally clear the results list too, or handle it where search starts
    // document.getElementById('results').innerHTML = '<h2>Results</h2>';
}

// Implement the drawRoute function
function drawRoute(route, index) {
    if (!route || !route.geometry || route.geometry.length === 0) {
        console.error("Invalid route data for drawing:", route);
        return;
    }

    // Combine geometry segments into a single coordinate array
    // Segments are [[lon, lat], [lon, lat], ...]
    let fullCoords = [];
    route.geometry.forEach((segment, segmentIndex) => {
        // First segment: add all points
        // Subsequent segments: skip the first point (it's the same as the last point of the previous segment)
        const pointsToAdd = segmentIndex === 0 ? segment : segment.slice(1);
        fullCoords = fullCoords.concat(pointsToAdd);
    });

    // Convert to Leaflet's [lat, lon] format
    const leafletCoords = fullCoords.map(coord => [coord[1], coord[0]]);

    if (leafletCoords.length >= 2) {
        // Define route colors (add more if needed)
        const colors = ['#FF0000', '#0000FF', '#008000', '#FFA500', '#800080']; // Red, Blue, Green, Orange, Purple
        const color = colors[index % colors.length]; // Cycle through colors

        const polyline = L.polyline(leafletCoords, {
            color: color,
            weight: 4,
            opacity: 0.8
        }).addTo(map);

        // Add popup showing route length
        polyline.bindPopup(`Route ${index + 1}: ${route.length.toFixed(0)}m`);

        // Store layer to allow clearing later
        drawnRouteLayers.push(polyline);

        // Optionally fit map view to the first route found
        if (index === 0) {
            map.fitBounds(polyline.getBounds());
        }
    } else {
        console.warn(`Route ${index + 1} has insufficient coordinates to draw.`);
    }
}

// Function to draw the constructed graph for debugging
function _debugDrawGraph(graph, nodes) {
    console.log("Debugging: Drawing graph nodes and edges...");
    const drawnEdges = new Set(); // Keep track of edges drawn (node1-node2)

    Object.keys(graph).forEach(nodeIdStr => {
        const nodeId = parseInt(nodeIdStr);
        const nodeData = nodes[nodeId];

        // Draw node marker
        if (nodeData) {
            const marker = L.circleMarker([nodeData.lat, nodeData.lon], {
                radius: 3,
                color: '#ff00ff', // Magenta nodes
                fillOpacity: 0.8
            }).addTo(map);
             marker.bindPopup(`Node: ${nodeId}`);
             drawnRouteLayers.push(marker); // Add marker to layers to be cleared
        }

        // Draw edges originating from this node
        const edges = graph[nodeId] || [];
        edges.forEach(edge => {
            const neighborId = edge.neighborId;

            // Create a unique key for the edge pair to avoid double drawing
            const edgeKey = [nodeId, neighborId].sort((a, b) => a - b).join('-');

            if (!drawnEdges.has(edgeKey)) {
                 if (edge.geometry && edge.geometry.length >= 2) {
                    const leafletCoords = edge.geometry.map(coord => [coord[1], coord[0]]); // lon,lat -> lat,lon
                    const polyline = L.polyline(leafletCoords, {
                        color: '#00ffff', // Cyan edges
                        weight: 1,
                        opacity: 0.6
                    }).addTo(map);
                    drawnRouteLayers.push(polyline); // Add edge to layers to be cleared
                    drawnEdges.add(edgeKey);
                 } else {
                     console.warn(`Edge ${edgeKey} has invalid geometry:`, edge.geometry);
                 }
            }
        });
    });
     console.log(`Debugging: Drawn ${drawnEdges.size} unique graph edges.`);
} 