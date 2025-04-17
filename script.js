// --- Configuration Constants ---
const POSTCODES_IO_API_URL = 'https://api.postcodes.io/postcodes/';
const OVERPASS_API_URL = 'https://overpass-api.de/api/interpreter';
const ROUTE_FINDING_TIMEOUT_MS = 60000; // 60 seconds
const LENGTH_TOLERANCE_PERCENT = 0.20; // +/- 20%
const MAX_ROUTES_TO_FIND = 5;
const ABSOLUTE_MAX_LENGTH_FACTOR = 10.0; // Factor for pruning paths much longer than target
const MAX_DISTANCE_FACTOR = 10.0; // Factor for distance-based pruning (currently high)
const NEAR_START_THRESHOLD_METERS = 50; // For debug graph visualization

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
    const lengthInput = document.getElementById('length').value;
    const desiredLengthMeters = parseInt(lengthInput);

    console.log(`Searching for routes near ${postcode} of length ${desiredLengthMeters}m`);
    const resultsDiv = document.getElementById('results');
    resultsDiv.innerHTML = ''; // Clear previous results

    if (!postcode) {
        alert("Please enter a UK postcode.");
        return;
    }
    if (isNaN(desiredLengthMeters) || desiredLengthMeters <= 0) {
        alert("Please enter a valid desired walk length in meters.");
        return;
    }

    if (!map) {
        console.error("Map is not initialized yet.");
        alert("Map is not ready. Please wait and try again.");
        return;
    }

    resultsDiv.innerHTML = '<p>Looking up postcode...</p>';
    let coords;
    try {
        coords = await lookupPostcodeCoords(postcode);
        console.log(`Coordinates found: Lat: ${coords.latitude}, Lon: ${coords.longitude}`);
        resultsDiv.innerHTML = `<p>Found location for ${coords.postcode}. Fetching map data...</p>`;

        // Center map and add marker
        map.setView([coords.latitude, coords.longitude], 15);
        L.marker([coords.latitude, coords.longitude]).addTo(map)
            .bindPopup(`Start: ${coords.postcode}`)
            .openPopup();

    } catch (error) {
        console.error(error);
        alert(error.message);
        resultsDiv.innerHTML = `<p>${error.message}</p>`;
        return;
    }

    try {
        const osmData = await fetchOsmDataNear(coords.latitude, coords.longitude, desiredLengthMeters);
        if (osmData.elements.length === 0) {
             resultsDiv.innerHTML += '<p>No map features (paths, roads) found in the Overpass response for this area.</p>';
             alert("Map data received, but it contained no usable paths for this specific area.");
             return;
        }
        resultsDiv.innerHTML += `<p>Successfully fetched ${osmData.elements.length} map elements. Processing data...</p>`;

        // Start the processing and routing
        processOsmData(osmData, coords.latitude, coords.longitude, desiredLengthMeters);

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

async function fetchOsmDataNear(lat, lon, desiredLengthMeters) {
    console.log(`Fetching OSM data around ${lat}, ${lon} for length ${desiredLengthMeters}m`);
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

        // Validate data structure
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

// Function to draw the constructed graph for debugging
function _debugDrawGraph(graph, nodes, startLat, startLon) {
    console.log("Debugging: Drawing graph nodes and edges...");
    const drawnEdges = new Set(); // Keep track of edges drawn (node1-node2)
    const startPoint = turf.point([startLon, startLat]);

    // Use a FeatureGroup to add debug layers together for easier management/removal if needed
    const debugLayerGroup = L.featureGroup().addTo(map);
    // Debug layers should NOT be added to drawnRouteLayers, only to their own group

    Object.keys(graph).forEach(nodeIdStr => {
        const nodeId = parseInt(nodeIdStr);
        const nodeData = nodes[nodeId];

        // Draw node marker
        if (nodeData) {
            let markerOptions = {
                radius: 3,
                color: '#ff00ff', // Default: Magenta nodes
                fillOpacity: 0.8
            };

            // Check distance from start
            try {
                const nodePoint = turf.point([nodeData.lon, nodeData.lat]);
                const distance = turf.distance(startPoint, nodePoint, { units: 'meters' });
                // console.log(`Node ${nodeId} distance: ${distance.toFixed(1)}m`); // Temporary log

                if (distance <= NEAR_START_THRESHOLD_METERS) {
                    // console.log(`Node ${nodeId} is NEAR start (${distance.toFixed(1)}m) - applying red style.`); // Temporary log
                    markerOptions.color = '#ff0000'; // Red nodes near start
                    markerOptions.radius = 5;      // Make them slightly larger
                }
            } catch(e) {
                console.warn(`Turf error calculating distance for node ${nodeId}:`, e);
            }

            const marker = L.circleMarker([nodeData.lat, nodeData.lon], markerOptions);
            marker.bindPopup(`Node: ${nodeId}`);
            debugLayerGroup.addLayer(marker); // Add to group
        }

        // Draw edges originating from this node
        const edges = graph[nodeId] || [];
        edges.forEach(edge => {
            const neighborId = edge.neighborId;
            const edgeKey = [nodeId, neighborId].sort((a, b) => a - b).join('-');

            if (!drawnEdges.has(edgeKey)) {
                 if (edge.geometry && edge.geometry.length >= 2) {
                    const leafletCoords = edge.geometry.map(coord => [coord[1], coord[0]]); // lon,lat -> lat,lon
                    const polyline = L.polyline(leafletCoords, {
                        color: '#00ffff', // Cyan edges
                        weight: 1,
                        opacity: 0.6
                    });
                    debugLayerGroup.addLayer(polyline); // Add to group
                    drawnEdges.add(edgeKey);
                 } else {
                     console.warn(`Edge ${edgeKey} has invalid geometry:`, edge.geometry);
                 }
            }
        });
    });
     console.log(`Debugging: Drawn ${Object.keys(graph).length} nodes and ${drawnEdges.size} unique graph edges.`);
}

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
function processOsmData(osmData, startLat, startLon, desiredLengthMeters) {
    console.log("Processing OSM data...");
    const resultsDiv = document.getElementById('results'); // Get results div again or pass it?

    if (typeof turf === 'undefined') {
        console.error("Turf.js library not found!");
        alert("Error: Required geometry library (Turf.js) is missing.");
        resultsDiv.innerHTML += '<p>Error: Missing geometry library.</p>';
        return; // Should ideally throw an error
    }

    // --- 1. Parse OSM Data --- 
    const nodes = {};     // Store node coords { id: { lat: ..., lon: ... } }
    const ways = [];      // Store way objects { id: ..., nodes: [...] }
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
    // Moved node/edge count log into buildGraph
    resultsDiv.innerHTML += `<p>Network graph built (${graphNodeCount} nodes).</p>`;

    // --- 3. Find Closest Start Node --- 
    let startNodeId = null;
    let minDistance = Infinity;
    try {
        const startPoint = turf.point([startLon, startLat]);
        Object.keys(graph).forEach(nodeId => { // Only check nodes actually in the graph
            const nodeData = nodes[nodeId]; // Get coords from original nodes object
            if (nodeData) {
                const nodePoint = turf.point([nodeData.lon, nodeData.lat]);
                const distance = turf.distance(startPoint, nodePoint, { units: 'meters' });
                if (distance < minDistance) {
                    minDistance = distance;
                    startNodeId = parseInt(nodeId);
                }
            }
        });
    } catch (error) {
         console.error("Error finding closest start node:", error);
         alert(`Error linking postcode to path network: ${error.message}`);
         resultsDiv.innerHTML += '<p>Error linking postcode to path network.</p>';
         return;
    }

    if (startNodeId !== null) {
        console.log(`Found starting node: ${startNodeId}. Distance from postcode location: ${minDistance.toFixed(1)}m`);
        resultsDiv.innerHTML += `<p>Found starting point in network (Node ID: ${startNodeId}). Closest node is ${minDistance.toFixed(1)}m away.</p>`;
        
        // --- DEBUG: Visualize the graph --- 
        _debugDrawGraph(graph, nodes, startLat, startLon); // Pass startLat/Lon

        // --- 4. Initiate Route Finding --- 
        console.log("Attempting to call findWalkRoutes...");
        try {
             findWalkRoutes(graph, startNodeId, desiredLengthMeters, nodes[startNodeId].lat, nodes[startNodeId].lon);
             console.log("findWalkRoutes call apparently completed.");
        } catch (error) {
             console.error("Error occurred *during* findWalkRoutes call (full error):", error);
             resultsDiv.innerHTML += `<p>Error during route finding process: ${error.message || 'Unknown error'}.</p>`;
             alert(`Error during route search: ${error.message || 'Unknown error'}. Check console.`);
        }
        console.log("processOsmData finished execution.");
    } else {
        console.error("Could not find a suitable starting node in the graph.");
        resultsDiv.innerHTML += '<p>Error: Could not link postcode location to the path network.</p>';
        alert("Could not find a starting point on the path network near the provided postcode.");
    }
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

// A* Search Implementation (or Dijkstra's currently)
async function findWalkRoutes(graph, startNodeId, targetLength, startLat, startLon) {
    console.log(`Starting A* route search from node ${startNodeId} for target length ${targetLength}m`);
    console.log(`Received graph nodes: ${Object.keys(graph).length}, startNodeId: ${startNodeId}, targetLength: ${targetLength}, startLat: ${startLat}, startLon: ${startLon}`); // Log input parameters
    
    if (!graph || Object.keys(graph).length === 0 || !startNodeId || !targetLength || !startLat || !startLon) {
        console.error("findWalkRoutes called with invalid parameters!");
        return;
    }

    const startTime = Date.now();
    const foundRoutes = [];

    const minLength = targetLength * (1 - LENGTH_TOLERANCE_PERCENT);
    const maxLength = targetLength * (1 + LENGTH_TOLERANCE_PERCENT);
    // We might relax the absolute max length slightly for A*
    const absoluteMaxLength = targetLength * ABSOLUTE_MAX_LENGTH_FACTOR; // Use constant factor

    // Maximum allowed straight-line distance from the start point (as a fraction of target length)
    // This is a key pruning parameter - adjust if needed
    // const MAX_DISTANCE_FACTOR = 0.75; // 75% of target length
    const maxAllowedDistance = targetLength * MAX_DISTANCE_FACTOR;
    console.log(`Max allowed straight-line distance from start: ${maxAllowedDistance.toFixed(0)}m`);

    const startPoint = turf.point([startLon, startLat]);
    const startNodeCoords = [startLon, startLat]; // Assuming startNodeId coords match startLat/startLon passed in

    // Priority Queue (min-heap simulation using sorted array)
    const openSet = [];

    // gScore: cost from start to node
    const gScore = {}; 
    
    try {
        gScore[startNodeId] = 0;
        const initialHeuristic = turf.distance(startPoint, startPoint, {units: 'meters'}) + Math.abs(targetLength - 0);
        openSet.push({ 
            nodeId: startNodeId, 
            f: initialHeuristic, 
            g: 0, 
            path: [startNodeId], 
            geometry: [] 
        });
    } catch (error) {
        // Log the full error object
        console.error("Error during A* initialization (full error):", error);
        document.getElementById('results').innerHTML += `<p>Error initializing route search: ${error.message || 'Unknown error'}.</p>`;
        alert(`Error initializing route search: ${error.message || 'Unknown error'}. Check console.`);
        return;
    }

    let iterations = 0;
    let prunedNodesCount = 0; 

    clearRoutes();
    document.getElementById('results').innerHTML = '<p>Starting route search (A*)...</p>';

    console.log("A* Search: Initial openSet state:", JSON.stringify(openSet)); // Log initial openSet
    if(openSet.length === 0) {
        console.error("A* Search: openSet is empty before starting loop!");
        return;
    }

    while (openSet.length > 0) {
        iterations++;
        // console.log(`Iteration ${iterations} --- OpenSet Size: ${openSet.length}`); // Simple log
        // console.log('OpenSet State BEFORE shift:', JSON.stringify(openSet.map(item => ({ id: item.nodeId, f: item.f.toFixed(1) })))); // Log simplified openSet state

        // Get node with the lowest f score (from the start of the sorted array)
        const current = openSet.shift(); 
        // console.log('--> Current node SHIFTED:', JSON.stringify({ id: current.nodeId, f: current.f.toFixed(1), g: current.g.toFixed(1) })); // Log shifted node

        const currentNodeId = current.nodeId;
        const currentG = current.g;

        // --- Debug Log: Check neighbors if current node is a neighbor of start ---
        // if (currentNodeId === 1178886671 || currentNodeId === 11405372363) { // Hardcoding IDs from previous log for NW1 4RY
        //     console.log(`%cDEBUG: Processing node ${currentNodeId} (a direct neighbor of start node ${startNodeId})`, 'color: purple;');
        //     console.log(`   Neighbors according to graph[${currentNodeId}]:`, graph[currentNodeId] || 'No neighbors listed!');
        // }
        // --- End Debug Log ---

        // DEBUG: Log current node
        // if(iterations % 200 === 0) console.log(`Iter ${iterations}: Processing Node ${currentNodeId}, g=${currentG.toFixed(0)}, f=${current.f.toFixed(0)}, openSet size: ${openSet.length}`);
        // More detailed log
        console.log(`Iter ${iterations}: Processing Node ${currentNodeId}, g=${currentG.toFixed(0)}, f=${current.f.toFixed(0)}, pathLen=${current.path.length}, openSet: ${openSet.length}`);
        // Log the actual path periodically
        if(iterations % 100 === 0 || current.path.length > 15) { // Log every 100 iter or if path gets long
            console.log(` -> Path: ${current.path.join(' -> ')}`);
        }

        // Get current node's coordinates (needed for distance pruning and heuristic)
        // This relies on the geometry stored in the graph edges
        let currentNodeCoords = startNodeCoords; // Default to start coords
        if (current.geometry.length > 0) {
            const lastSegment = current.geometry[current.geometry.length - 1];
            if (lastSegment && lastSegment.length > 0) {
                 currentNodeCoords = lastSegment[lastSegment.length - 1]; // Last point of last segment
            }
        }
        const currentPoint = turf.point(currentNodeCoords);

        // --- Distance-based pruning ---
        const distanceToStart = turf.distance(startPoint, currentPoint, { units: 'meters' });
        if (distanceToStart > maxAllowedDistance && currentNodeId !== startNodeId) { // Don't prune start node
            prunedNodesCount++;
            if (prunedNodesCount % 100 === 0) console.log(`Pruned ${prunedNodesCount} nodes due to distance.`);
            continue; 
        }

        // --- Goal Check --- 
        if (currentNodeId === startNodeId && current.path.length > 1) {
            // DETAILED LOGGING HERE:
            // console.log(`%cDEBUG: Goal Check - Reached start node ${startNodeId}.`, 'color: green; font-weight: bold;');
            // console.log(` -> Path Length (g): ${currentG.toFixed(1)}m`);
            // console.log(` -> Required Range: ${minLength.toFixed(1)}m - ${maxLength.toFixed(1)}m`);
            // console.log(` -> Path Node Count: ${current.path.length}`);
            // console.log(` -> Path Nodes: ${current.path.join(' -> ')}`); // Potentially very long log

            // console.log(`DEBUG: Reached start node ${startNodeId} with length ${currentG.toFixed(0)}`); // Old log, replaced by detailed logs above
            if (currentG >= minLength && currentG <= maxLength) {
                const route = { length: currentG, path: current.path, geometry: current.geometry };
                foundRoutes.push(route);
                console.log(`%cDEBUG: Goal Check - Length is ACCEPTABLE. Storing route.`, 'color: green;'); // Keep this one?
                // console.log(`A* Found route: Length ${currentG.toFixed(0)}m`); // Old log
                document.getElementById('results').innerHTML += `<p>Found potential route: ${currentG.toFixed(0)}m</p>`;
                if (foundRoutes.length >= MAX_ROUTES_TO_FIND) {
                    console.log(`A* Found maximum number of routes (${MAX_ROUTES_TO_FIND}).`);
                    break; // Exit main while loop
                }
            } else {
                 // console.log(`%cDEBUG: Goal Check - Length is UNACCEPTABLE. Discarding path.`, 'color: orange;');
            }
             // Continue searching for other loops even if one is found
             // But don't explore neighbors from the start node once a loop is completed this way
        }

        // --- Explore Neighbors --- 
        const neighbors = graph[currentNodeId] || [];
        console.log(` -> Exploring ${neighbors.length} neighbors of ${currentNodeId}`); // Log neighbor count

        for (const edge of neighbors) {
            const neighborId = edge.neighborId;
            const edgeLength = edge.length;
            const edgeGeometry = edge.geometry;
            const tentativeGScore = currentG + edgeLength;

            console.log(`  --> Considering neighbor ${neighborId} (Edge Length: ${edgeLength.toFixed(0)}, Tentative gScore: ${tentativeGScore.toFixed(0)})`); // Log neighbor consideration

            // Specific check if neighbor is the start node
            // if (neighborId === startNodeId) {
            //      console.log(`%c      Neighbor IS the start node (${startNodeId})! Current path length: ${current.path.length}`, 'color: blue; font-style: italic;');
            // }

            // Pruning based on path length
            if (tentativeGScore > absoluteMaxLength) {
                 console.log(`%c      Pruning neighbor ${neighborId}: Path would exceed very large absolute max length (${tentativeGScore.toFixed(0)} > ${absoluteMaxLength.toFixed(0)})`, 'color: grey');
                 continue;
            }

            // Simple U-turn prevention - Allow returning to start node
            if (current.path.length > 1 && neighborId === current.path[current.path.length - 2] && neighborId !== startNodeId) {
                 console.log(`      Pruning neighbor ${neighborId}: Immediate U-turn (and not the start node)`);
                 continue;
            }

            // Check if this path to neighbor is better than any previous one OR if it's returning to the start node
             const existingGScore = gScore[neighborId] || Infinity;
             // Allow adding the start node back even if the path is longer than the initial gScore (0)
             if (tentativeGScore < existingGScore || neighborId === startNodeId) {
                 // If it's the start node, we don't necessarily update gScore[startNodeId] (it should remain 0 conceptually for future direct starts)
                 // But we DO potentially update it for this specific path instance if this is a shorter loop than a previously found one returning here.
                 // However, the primary goal is to get the state into the openSet for the Goal Check.
                 if (neighborId !== startNodeId) {
                    gScore[neighborId] = tentativeGScore;
                 } else if (tentativeGScore < existingGScore) {
                     // Update gScore for the start node only if this loop path is somehow shorter than 0? 
                     // This case seems unlikely/impossible, but keeps the structure. 
                     // We could also just skip updating gScore[startNodeId] entirely.
                     gScore[neighborId] = tentativeGScore; 
                 }

                // Get neighbor coordinates for heuristic (last point of edge geometry)
                // let neighborCoords = currentNodeCoords;
                // if (edgeGeometry && edgeGeometry.length > 0) {
                //     neighborCoords = edgeGeometry[edgeGeometry.length - 1];
                // }
                // const neighborPoint = turf.point(neighborCoords);
                
                // const h = turf.distance(neighborPoint, startPoint, {units: 'meters'}); // Simpler heuristic
                const h = 0; // Set heuristic to 0 (Dijkstra's algorithm behavior)
                const f = tentativeGScore + h; // f score is now just the path cost
                console.log(`      Adding/Updating neighbor ${neighborId}: New g=${tentativeGScore.toFixed(0)}, h=${h.toFixed(0)}, f=${f.toFixed(0)}`); // Log adding state

                const newPath = [...current.path, neighborId];
                const newGeometry = [...current.geometry, edgeGeometry];
                
                const newState = {
                    nodeId: neighborId,
                    f: f,
                    g: tentativeGScore,
                    path: newPath,
                    geometry: newGeometry
                };

                // Insert into sorted openSet
                const index = findSortedIndex(openSet, newState);
                openSet.splice(index, 0, newState);
            } else {
                 console.log(`      Skipping neighbor ${neighborId}: Worse path found (Existing g=${existingGScore.toFixed(0)}, New g=${tentativeGScore.toFixed(0)})`); // Log skipping due to gScore
             }
        }
    }

    const endTime = Date.now();
    console.log(`A* Route search finished in ${endTime - startTime}ms. Found ${foundRoutes.length} routes.`);
    if (foundRoutes.length > 0) {
        document.getElementById('results').innerHTML += `<h3>Found ${foundRoutes.length} route(s) using A*:</h3><ul>`;
        foundRoutes.forEach((route, index) => {
            console.log(`Route ${index + 1}: Length=${route.length.toFixed(0)}m, Nodes=${route.path.length}`);
            document.getElementById('results').innerHTML += `<li>Route ${index + 1}: ${route.length.toFixed(0)}m</li>`;
            drawRoute(route, index);
        });
        document.getElementById('results').innerHTML += `</ul>`;
    } else {
        document.getElementById('results').innerHTML += `<p>No suitable loops found with A* within the time limit and criteria.</p>`;
        if (Date.now() - startTime < ROUTE_FINDING_TIMEOUT_MS) {
            alert("Could not find any walking loops matching your criteria using A*. Try changing length/postcode.");
        }
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

// Function to draw the constructed graph for debugging
function _debugDrawGraph(graph, nodes, startLat, startLon) {
    console.log("Debugging: Drawing graph nodes and edges...");
    const drawnEdges = new Set(); // Keep track of edges drawn (node1-node2)
    const startPoint = turf.point([startLon, startLat]);

    // Use a FeatureGroup to add debug layers together for easier management/removal if needed
    const debugLayerGroup = L.featureGroup().addTo(map);
    // Debug layers should NOT be added to drawnRouteLayers, only to their own group

    Object.keys(graph).forEach(nodeIdStr => {
        const nodeId = parseInt(nodeIdStr);
        const nodeData = nodes[nodeId];

        // Draw node marker
        if (nodeData) {
            let markerOptions = {
                radius: 3,
                color: '#ff00ff', // Default: Magenta nodes
                fillOpacity: 0.8
            };

            // Check distance from start
            try {
                const nodePoint = turf.point([nodeData.lon, nodeData.lat]);
                const distance = turf.distance(startPoint, nodePoint, { units: 'meters' });
                // console.log(`Node ${nodeId} distance: ${distance.toFixed(1)}m`); // Temporary log

                if (distance <= NEAR_START_THRESHOLD_METERS) {
                    // console.log(`Node ${nodeId} is NEAR start (${distance.toFixed(1)}m) - applying red style.`); // Temporary log
                    markerOptions.color = '#ff0000'; // Red nodes near start
                    markerOptions.radius = 5;      // Make them slightly larger
                }
            } catch(e) {
                console.warn(`Turf error calculating distance for node ${nodeId}:`, e);
            }

            const marker = L.circleMarker([nodeData.lat, nodeData.lon], markerOptions);
            marker.bindPopup(`Node: ${nodeId}`);
            debugLayerGroup.addLayer(marker); // Add to group
        }

        // Draw edges originating from this node
        const edges = graph[nodeId] || [];
        edges.forEach(edge => {
            const neighborId = edge.neighborId;
            const edgeKey = [nodeId, neighborId].sort((a, b) => a - b).join('-');

            if (!drawnEdges.has(edgeKey)) {
                 if (edge.geometry && edge.geometry.length >= 2) {
                    const leafletCoords = edge.geometry.map(coord => [coord[1], coord[0]]); // lon,lat -> lat,lon
                    const polyline = L.polyline(leafletCoords, {
                        color: '#00ffff', // Cyan edges
                        weight: 1,
                        opacity: 0.6
                    });
                    debugLayerGroup.addLayer(polyline); // Add to group
                    drawnEdges.add(edgeKey);
                 } else {
                     console.warn(`Edge ${edgeKey} has invalid geometry:`, edge.geometry);
                 }
            }
        });
    });
     console.log(`Debugging: Drawn ${Object.keys(graph).length} nodes and ${drawnEdges.size} unique graph edges.`);
}

// --- End of File --- 