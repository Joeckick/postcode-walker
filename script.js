// --- Configuration Constants ---
const POSTCODES_IO_API_URL = 'https://api.postcodes.io/postcodes/';
const OVERPASS_API_URL = 'https://overpass-api.de/api/interpreter';
const ROUTE_FINDING_TIMEOUT_MS = 60000; // 60 seconds
// const LENGTH_TOLERANCE_PERCENT = 0.40; // +/- 40% (Removed - not needed for point-to-point)
const MAX_ROUTES_TO_FIND = 1; // Find only the shortest
// const ABSOLUTE_MAX_LENGTH_FACTOR = 3.0; // Factor for pruning paths much longer than target (Removed - no length pruning)
// const MAX_DISTANCE_FACTOR = 10.0; // Factor for distance-based pruning (Removed - no distance pruning)
// const NEAR_START_THRESHOLD_METERS = 50; // For debug graph visualization (COMMENTED OUT)

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

    // Add event listener for the button
    const findButton = document.getElementById('find-routes-btn');
    if (findButton) {
        findButton.addEventListener('click', findRoutes);
        console.log("Attached click listener to find-routes-btn");
    } else {
        console.error("Find routes button not found!");
    }

    // *** COMMENTED OUT DEBUG log for element check on load ***
    // const initialEndElement = document.getElementById('end_postcode_input');
    // console.log("DEBUG (DOMContentLoaded): Element with ID 'end_postcode_input':", initialEndElement);

});

async function findRoutes() {
    console.log("Find routes button clicked!");
    const startPostcode = document.getElementById('postcode').value.trim();
    // *** COMMENTED OUT DEBUG log for element check on click ***
    const endPostcodeElement = document.getElementById('end_postcode_input');
    // console.log("DEBUG (findRoutes): Element with ID 'end_postcode_input':", endPostcodeElement); // Removed debug log
    if (!endPostcodeElement) { // Add a check here just in case
        console.error("Could not find the end postcode input element!");
        alert("Error: Could not find the end postcode input element.");
        return;
    }
    const endPostcode = endPostcodeElement.value.trim(); // Get end postcode using correct ID
    // const desiredLengthMeters = parseInt(lengthInput); // Removed length input

    console.log(`Searching for route from ${startPostcode} to ${endPostcode}`);
    const resultsDiv = document.getElementById('results');
    resultsDiv.innerHTML = ''; // Clear previous results

    if (!startPostcode || !endPostcode) { // Check both postcodes
        alert("Please enter both a start and end UK postcode.");
        return;
    }
    // Removed length validation

    if (!map) {
        console.error("Map is not initialized yet.");
        alert("Map is not ready. Please wait and try again.");
        return;
    }

    resultsDiv.innerHTML = '<p>Looking up postcodes...</p>';
    let startCoords, endCoords;
    try {
        // Lookup both postcodes
        startCoords = await lookupPostcodeCoords(startPostcode);
        endCoords = await lookupPostcodeCoords(endPostcode);
        console.log(`Start Coords: Lat: ${startCoords.latitude}, Lon: ${startCoords.longitude}`);
        console.log(`End Coords: Lat: ${endCoords.latitude}, Lon: ${endCoords.longitude}`);
        resultsDiv.innerHTML = `<p>Found locations for ${startCoords.postcode} and ${endCoords.postcode}. Fetching map data...</p>`;

        // Clear previous map markers/routes if necessary (clearRoutes might need adjustment)
        clearRoutes();

        // Center map roughly between start and end? Or just on start?
        // Let's fit bounds later after finding the route.
        map.setView([startCoords.latitude, startCoords.longitude], 13); // Adjust zoom?
        L.marker([startCoords.latitude, startCoords.longitude]).addTo(map)
            .bindPopup(`Start: ${startCoords.postcode}`)
            .openPopup();
        L.marker([endCoords.latitude, endCoords.longitude]).addTo(map)
            .bindPopup(`End: ${endCoords.postcode}`);

    } catch (error) {
        console.error(error);
        alert(error.message);
        resultsDiv.innerHTML = `<p>${error.message}</p>`;
        return;
    }

    // Fetch OSM Data - Use a bounding box or just radius around start?
    // For now, keep radius around start, but make it larger or dependent on distance?
    // Let's use a fixed large radius for simplicity first.
    const fetchRadius = 5000; // Use a fixed radius around the start point
    try {
        // Pass only start coords for fetching
        const osmData = await fetchOsmDataNear(startCoords.latitude, startCoords.longitude, fetchRadius);
        if (osmData.elements.length === 0) {
             resultsDiv.innerHTML += '<p>No map features (paths, roads) found in the Overpass response for this area.</p>';
             alert("Map data received, but it contained no usable paths for this specific area.");
             return;
        }
        resultsDiv.innerHTML += `<p>Successfully fetched ${osmData.elements.length} map elements. Processing data...</p>`;

        // Start the processing and routing - pass both start and end coords
        processOsmData(osmData, startCoords.latitude, startCoords.longitude, endCoords.latitude, endCoords.longitude);

    } catch (error) {
         console.error(error);
         alert(error.message);
         resultsDiv.innerHTML += `<p>${error.message}. The Overpass API might be busy.</p>`;
    }
}

async function lookupPostcodeCoords(postcode) {
    const url = `${POSTCODES_IO_API_URL}${encodeURIComponent(postcode)}`;
    console.log(`Looking up postcode: ${url}`);
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.status === 200) {
            return {
                latitude: data.result.latitude,
                longitude: data.result.longitude,
                postcode: data.result.postcode
            };
        } else {
            throw new Error(data.error || 'Postcode not found');
        }
    } catch (error) {
        console.error("Error fetching postcode data:", error);
        throw new Error(`Postcode lookup failed: ${error.message}`);
    }
}

async function fetchOsmDataNear(lat, lon, radius) { // Simplified parameters
    console.log(`Fetching OSM data around ${lat}, ${lon} with radius ${radius}m`);
    // Removed radius calculation based on length

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

    try {
        const response = await fetch(OVERPASS_API_URL, {
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

        if (!osmData || !Array.isArray(osmData.elements)) {
             console.error("Invalid or unexpected data structure received from Overpass API:", osmData);
             throw new Error("Received invalid map data structure from Overpass API.");
        }
        return osmData;

    } catch (error) {
        console.error("Error fetching or processing Overpass data (full error):", error);
        throw new Error(`Fetching OSM data failed: ${error.message || 'Unknown error'}`);
    }
}

// *** COMMENTED OUT _debugDrawGraph function ***
// function _debugDrawGraph(graph, nodes, startLat, startLon) {
//     console.log("Debugging: Drawing graph nodes and edges...");
//     const drawnEdges = new Set(); // Keep track of edges drawn (node1-node2)
//     const startPoint = turf.point([startLon, startLat]);
//     ...
//     console.log(`Debugging: Drawn ${Object.keys(graph).length} nodes and ${drawnEdges.size} unique graph edges.`);
// }

// --- Step 5: Map Data Processing & Graph Building ---

function buildGraph(nodes, ways) {
    console.log("Building graph from nodes and ways...");
    const graph = {}; // Adjacency list
    try {
        // Build graph by connecting consecutive nodes within ways
        ways.forEach(way => {
            if (way && Array.isArray(way.nodes) && way.nodes.length >= 2) {
                for (let i = 0; i < way.nodes.length - 1; i++) {
                    const node1Id = way.nodes[i];
                    const node2Id = way.nodes[i+1];
                    const node1Coords = nodes[node1Id];
                    const node2Coords = nodes[node2Id];

                    // Ensure both nodes exist
                    if (node1Coords && node2Coords) {
                        try {
                            const point1 = turf.point([node1Coords.lon, node1Coords.lat]);
                            const point2 = turf.point([node2Coords.lon, node2Coords.lat]);
                            const length = turf.distance(point1, point2, { units: 'meters' });

                            // Geometry for this segment
                            const segmentGeometry = [
                                [node1Coords.lon, node1Coords.lat],
                                [node2Coords.lon, node2Coords.lat]
                            ];

                            // Add edge in both directions
                            if (!graph[node1Id]) graph[node1Id] = [];
                            if (!graph[node2Id]) graph[node2Id] = [];

                            // Check for zero length edges which can cause issues
                            if (length > 0) {
                                graph[node1Id].push({ neighborId: node2Id, length: length, geometry: segmentGeometry });
                                graph[node2Id].push({ neighborId: node1Id, length: length, geometry: segmentGeometry.slice().reverse() });
                            } else {
                                console.warn(`Skipping zero-length edge between ${node1Id} and ${node2Id}`);
                            }
                        } catch (e) {
                            console.error(`Turf error processing segment between ${node1Id}-${node2Id}:`, e);
                        }
                    }
                }
            } else if (way && Array.isArray(way.nodes)) {
                // Log ways that are too short to form segments
                // console.log(`Skipping way ${way.id} with less than 2 nodes.`);
            } else {
                 console.warn("Skipping way with missing or invalid nodes property during edge building:", way);
            }
        });
        const graphNodeCount = Object.keys(graph).length;
        const graphEdgeCount = Object.values(graph).reduce((sum, edges) => sum + edges.length, 0) / 2; // Divided by 2 for undirected edges
        console.log(`Graph built: ${graphNodeCount} nodes, ${graphEdgeCount} unique edges.`);
        return graph;

    } catch (error) {
        console.error("Error during graph construction loops:", error);
        throw new Error(`Error building path network graph: ${error.message}`);
    }
}

// Parses raw OSM data and finds the graph node nearest to the start coordinates.
function processOsmData(osmData, startLat, startLon, endLat, endLon) {
    console.log("Processing OSM data...");
    const resultsDiv = document.getElementById('results');

    if (typeof turf === 'undefined') {
        console.error("Turf.js library not found!");
        alert("Error: Required geometry library (Turf.js) is missing.");
        resultsDiv.innerHTML += '<p>Error: Missing geometry library.</p>';
        return; // Should ideally throw an error
    }

    // --- 1. Parse OSM Data --- 
    const nodes = {};
    const ways = [];
    osmData.elements.forEach(element => {
        if (element.type === 'node') {
            nodes[element.id] = { lat: element.lat, lon: element.lon };
        } else if (element.type === 'way' && element.nodes) {
            ways.push({ id: element.id, nodes: element.nodes });
            // We don't need nodeUsage anymore with the current graph build approach
            // element.nodes.forEach(nodeId => {
            //     nodeUsage[nodeId] = (nodeUsage[nodeId] || 0) + 1;
            // });
        }
    });
    console.log(`Parsed ${Object.keys(nodes).length} nodes and ${ways.length} ways.`);

    // --- 2. Build Graph --- 
    let graph;
    try {
        graph = buildGraph(nodes, ways);
    } catch (error) {
        console.error(error);
        alert(error.message);
        resultsDiv.innerHTML += `<p>${error.message}</p>`;
        return;
    }

    const graphNodeCount = Object.keys(graph).length;
    if (graphNodeCount === 0) {
         resultsDiv.innerHTML += '<p>Graph construction failed or area has no usable paths.</p>';
         alert("Failed to build a searchable path network for this area.");
         return;
    }
    resultsDiv.innerHTML += `<p>Network graph built (${graphNodeCount} nodes).</p>`;

    // --- 3. Find Closest Start and End Nodes --- 
    let startNodeId = null;
    let endNodeId = null;
    let minStartDistance = Infinity;
    let minEndDistance = Infinity;
    let startNodeActualCoords = null;
    let endNodeActualCoords = null; // Store actual coords of the found nodes

    try {
        const startPoint = turf.point([startLon, startLat]);
        const endPoint = turf.point([endLon, endLat]);

        Object.keys(graph).forEach(nodeId => {
            const nodeData = nodes[nodeId];
            if (nodeData) {
                const nodePoint = turf.point([nodeData.lon, nodeData.lat]);
                // Check distance to start
                const distToStart = turf.distance(startPoint, nodePoint, { units: 'meters' });
                if (distToStart < minStartDistance) {
                    minStartDistance = distToStart;
                    startNodeId = parseInt(nodeId);
                    startNodeActualCoords = { lat: nodeData.lat, lon: nodeData.lon };
                }
                // Check distance to end
                const distToEnd = turf.distance(endPoint, nodePoint, { units: 'meters' });
                if (distToEnd < minEndDistance) {
                    minEndDistance = distToEnd;
                    endNodeId = parseInt(nodeId);
                    endNodeActualCoords = { lat: nodeData.lat, lon: nodeData.lon };
                }
            }
        });
    } catch (error) {
         console.error("Error finding closest start/end nodes:", error);
         alert(`Error linking postcode to path network: ${error.message}`);
         resultsDiv.innerHTML += '<p>Error linking postcode to path network.</p>';
         return;
    }

    if (startNodeId === null || endNodeId === null) {
         const missing = startNodeId === null ? "start" : "end";
         console.error(`Could not find a suitable ${missing} node in the graph.`);
         resultsDiv.innerHTML += `<p>Error: Could not link ${missing} postcode location to the path network.</p>`;
         alert(`Could not find a starting/ending point on the path network near the provided ${missing} postcode.`);
         return;
    }
    
    console.log(`Found start node: ${startNodeId}. Distance: ${minStartDistance.toFixed(1)}m`);
    console.log(`Found end node: ${endNodeId}. Distance: ${minEndDistance.toFixed(1)}m`);
    resultsDiv.innerHTML += `<p>Found network points: Start Node ${startNodeId} (${minStartDistance.toFixed(1)}m away), End Node ${endNodeId} (${minEndDistance.toFixed(1)}m away).</p>`;
    
    // *** COMMENTED OUT call to _debugDrawGraph ***
    // _debugDrawGraph(graph, nodes, startLat, startLon);

    // --- 4. Initiate Route Finding --- 
    console.log("Attempting to call findWalkRoutes...");
    try {
        // Pass startNodeId, endNodeId, and actual coordinates of endNode for heuristic
        // *** Also pass the nodes object for heuristic calculations inside A* ***
        findWalkRoutes(graph, nodes, startNodeId, endNodeId, endNodeActualCoords.lat, endNodeActualCoords.lon);
        console.log("findWalkRoutes call apparently completed.");
    } catch (error) {
        console.error("Error occurred *during* findWalkRoutes call (full error):", error);
        resultsDiv.innerHTML += `<p>Error during route finding process: ${error.message || 'Unknown error'}.</p>`;
        alert(`Error during route search: ${error.message || 'Unknown error'}. Check console.`);
    }
    console.log("processOsmData finished execution.");
}

// --- Step 6: Routing Algorithm ---
// Note: findSortedIndex is a helper for findWalkRoutes
function findSortedIndex(array, element) {
    let low = 0, high = array.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (array[mid].f < element.f) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return low;
}

// A* Search Implementation for Point-to-Point
async function findWalkRoutes(graph, nodes, startNodeId, endNodeId, endLat, endLon) { // Added nodes parameter
    console.log(`Starting A* route search from node ${startNodeId} to node ${endNodeId}`);
    // Removed targetLength, startLat, startLon from params/logs
    console.log(`Received graph nodes: ${Object.keys(graph).length}, node data entries: ${Object.keys(nodes).length}, startNodeId: ${startNodeId}, endNodeId: ${endNodeId}`); // Log nodes count
    
    // Updated parameter check
    if (!graph || Object.keys(graph).length === 0 || !nodes || Object.keys(nodes).length === 0 || !startNodeId || !endNodeId || !endLat || !endLon) { // Check nodes
        console.error("findWalkRoutes called with invalid parameters!");
        return;
    }

    const startTime = Date.now();
    const foundRoutes = []; // Keep array in case we want top N shortest later

    // Define end point for heuristic calculation
    const endPoint = turf.point([endLon, endLat]);

    // --- REMOVE Length tolerance, absolute max length, distance pruning ---
    // const minLength = ...
    // const maxLength = ...
    // const absoluteMaxLength = ...
    // const maxAllowedDistance = ...

    // Priority Queue
    const openSet = [];
    // gScore: cost from start to node
    const gScore = {}; 
    
    // Initialize starting state
    try {
        gScore[startNodeId] = 0;
        // Calculate initial heuristic h: distance from startNode to endPoint
        const startNodeData = nodes[startNodeId]; // Need nodes globally or passed in?
        if (!startNodeData) throw new Error(`Start node ${startNodeId} data not found`);
        const startNodePoint = turf.point([startNodeData.lon, startNodeData.lat]);
        const initialHeuristic = turf.distance(startNodePoint, endPoint, {units: 'meters'});
        
        openSet.push({ 
            nodeId: startNodeId, 
            f: initialHeuristic, // f = g (0) + h
            g: 0, 
            path: [startNodeId], 
            geometry: [] 
        });
    } catch (error) {
        console.error("Error during A* initialization (full error):", error);
        document.getElementById('results').innerHTML += `<p>Error initializing route search: ${error.message || 'Unknown error'}.</p>`;
        alert(`Error initializing route search: ${error.message || 'Unknown error'}. Check console.`);
        return;
    }

    let iterations = 0;
    clearRoutes(); // Clear previous routes/debug graph
    document.getElementById('results').innerHTML = '<p>Starting route search (A*)...</p>';

    while (openSet.length > 0) {
        iterations++;
        // Basic timeout check still useful
        if (iterations % 1000 === 0) { // Check less frequently
            const elapsedTime = Date.now() - startTime;
            if (elapsedTime > ROUTE_FINDING_TIMEOUT_MS) {
                console.warn(`A* Route finding timed out after ${elapsedTime}ms`);
                document.getElementById('results').innerHTML += '<p>Route search timed out (A*).</p>';
                break; 
            }
        }

        // Get node with the lowest f score
        const current = openSet.shift(); 
        const currentNodeId = current.nodeId;
        const currentG = current.g;

        // --- Goal Check --- 
        if (currentNodeId === endNodeId) {
            console.log(`%cDEBUG: Goal Check - Reached END node ${endNodeId}!`, 'color: green; font-weight: bold;');
            console.log(` -> Path Length (g): ${currentG.toFixed(1)}m`);
            const route = { length: currentG, path: current.path, geometry: current.geometry };
            foundRoutes.push(route);
            console.log(`%cDEBUG: Found shortest route. Length: ${currentG.toFixed(1)}m. Storing route.`, 'color: green;');
            break; // Found the shortest path, exit loop
        }

        // --- Explore Neighbors --- 
        const neighbors = graph[currentNodeId] || [];
        for (const edge of neighbors) {
            const neighborId = edge.neighborId;
            const edgeLength = edge.length;
            const edgeGeometry = edge.geometry;
            const tentativeGScore = currentG + edgeLength;

            // --- REMOVE absolute path length pruning ---

            // --- REMOVE U-turn prevention? (Usually desired for shortest path) ---
            // Let's keep it for now
            if (current.path.length > 1 && neighborId === current.path[current.path.length - 2]) {
                 continue;
            }

            // Check if this path is better 
             const existingGScore = gScore[neighborId] || Infinity;
             if (tentativeGScore < existingGScore) {
                gScore[neighborId] = tentativeGScore;

                // Calculate HEURISTIC (h): distance from neighbor to endPoint
                let h = 0;
                const neighborNodeData = nodes[neighborId]; // Need nodes globally or passed in?
                if (neighborNodeData) {
                    const neighborPoint = turf.point([neighborNodeData.lon, neighborNodeData.lat]);
                    h = turf.distance(neighborPoint, endPoint, {units: 'meters'});
                } else {
                    console.warn(`Node data missing for neighbor ${neighborId} during heuristic calculation.`);
                }

                const f = tentativeGScore + h; // f = g + h

                const newPath = [...current.path, neighborId];
                const newGeometry = [...current.geometry, edgeGeometry];
                const newState = {
                    nodeId: neighborId,
                    f: f, g: tentativeGScore,
                    path: newPath, geometry: newGeometry
                };
                const index = findSortedIndex(openSet, newState);
                openSet.splice(index, 0, newState);
            }
        }
    }

    // --- Log reason for loop termination ---
    const endTime = Date.now();
    let terminationReason = "Unknown";
    if (foundRoutes.length > 0) { // Check if we found the route
        terminationReason = "Found shortest path to end node";
    } else if (Date.now() - startTime >= ROUTE_FINDING_TIMEOUT_MS) {
        terminationReason = "Timeout reached";
    } else if (openSet.length === 0) {
        terminationReason = "OpenSet became empty (End node unreachable?)";
    }
    console.log(`A* Route search finished in ${endTime - startTime}ms. Reason: ${terminationReason}. Found ${foundRoutes.length} route(s).`);

    // --- Process and display the single shortest route --- 
    if (foundRoutes.length > 0) {
        const shortestRoute = foundRoutes[0]; // Should only be one
        document.getElementById('results').innerHTML += `<h3>Found Route:</h3><ul>`;
        console.log(`Shortest Route: Length=${shortestRoute.length.toFixed(0)}m, Nodes=${shortestRoute.path.length}`);
        document.getElementById('results').innerHTML += `<li>Route Length: ${shortestRoute.length.toFixed(0)}m</li>`;
        drawRoute(shortestRoute, 0); // Draw the single route
        document.getElementById('results').innerHTML += `</ul>`;
        // Fit map to the route bounds
        try {
            const routeLine = L.polyline(shortestRoute.geometry.map(seg => seg.map(coord => [coord[1], coord[0]])).flat());
            if (routeLine.getLatLngs().length > 0) {
                 map.fitBounds(routeLine.getBounds());
            }
        } catch (e) {
            console.error("Error fitting map bounds to route:", e);
        }

    } else {
        document.getElementById('results').innerHTML += `<p>Could not find a route between the start and end points.</p>`;
        alert("Could not find a route. The points may not be connected on the path network, or the search timed out.");
    }
}

// --- Step 7: Map Utilities ---

// Function to clear existing routes from the map
function clearRoutes() {
    drawnRouteLayers.forEach(layer => map.removeLayer(layer));
    drawnRouteLayers = [];
    // Optionally clear the results list too, or handle it where search starts
    // document.getElementById('results').innerHTML = '<h2>Results</h2>';
}

// Implement the drawRoute function to display a found route
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

// *** COMMENTED OUT second _debugDrawGraph function definition ***
// function _debugDrawGraph(graph, nodes, startLat, startLon) {
//     console.log("Debugging: Drawing graph nodes and edges...");
//     const drawnEdges = new Set(); // Keep track of edges drawn (node1-node2)
//     ...
//      console.log(`Debugging: Drawn ${Object.keys(graph).length} nodes and ${drawnEdges.size} unique graph edges.`);
// }

// --- End of File --- 