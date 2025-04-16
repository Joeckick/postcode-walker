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

        // Add validation for osmData.elements before proceeding
        if (osmData && Array.isArray(osmData.elements)) {
            if (osmData.elements.length > 0) {
                 document.getElementById('results').innerHTML += `<p>Successfully fetched ${osmData.elements.length} map elements. Next step: Process data and find routes.</p>`;
                 processOsmData(osmData, lat, lon, parseInt(desiredLengthMeters)); 
            } else {
                 document.getElementById('results').innerHTML += '<p>No map features (paths, roads) found in the Overpass response for this area.</p>';
                 alert("Map data received, but it contained no usable paths for this specific area.");
            }
        } else {
            // Handle cases where Overpass returns something unexpected (e.g., error message, timeout structure)
            console.error("Invalid or unexpected data structure received from Overpass API:", osmData);
            document.getElementById('results').innerHTML += '<p>Error: Received invalid map data structure.</p>';
            alert("Failed to process map data. Unexpected response from Overpass API.");
        }

    } catch (error) {
        // Log the full error object
        console.error("Error fetching or processing Overpass data (full error):", error);
        document.getElementById('results').innerHTML += '<p>Error fetching walking path data.</p>';
        // Use error.message but also log full error
        alert(`An error occurred while fetching map data: ${error.message || 'Unknown error'}. Check console for details. The Overpass API might be busy.`);
    }
}

// Main function to process OSM data, build graph, and initiate search
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

    // Ensure these variables are declared at the function scope
    const nodeUsage = {}; // Count how many ways use each node
    const nodes = {};     // Store node coords { id: { lat: ..., lon: ... } }
    const ways = [];      // Store way objects { id: ..., nodes: [...] }

    // Check if osmData.elements exists before trying to iterate
    if (!osmData || !osmData.elements) {
        console.error("Invalid or missing osmData elements!");
        document.getElementById('results').innerHTML += '<p>Error: Invalid osmData structure.</p>';
        alert("Failed to process map data. Invalid osmData structure.");
        return;
    }

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

    const graph = {}; // Adjacency list

    // Wrap main processing loops in try...catch
    try {
        // Identify intersections 
        const significantNodeIds = new Set();
        ways.forEach(way => {
            // Check if way.nodes exists and is an array
            if (way && Array.isArray(way.nodes)) {
                way.nodes.forEach((nodeId, index) => {
                    if (nodeUsage[nodeId] > 1 || index === 0 || index === way.nodes.length - 1) {
                        significantNodeIds.add(nodeId);
                    }
                });
            } else {
                console.warn("Skipping way with missing or invalid nodes property:", way);
            }
        });

        // Build edges between significant nodes
        ways.forEach(way => {
             // Check if way.nodes exists and is an array
            if (way && Array.isArray(way.nodes)) {
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
                                    // Catch Turf.js errors specifically
                                    console.error(`Turf error processing segment ${segmentStartNodeId}-${nodeId}:`, e, currentSegmentCoords);
                                }
                            }
                        }
                        // Start the next segment
                        segmentStartNodeId = nodeId;
                        currentSegmentCoords = [[nodeCoords.lon, nodeCoords.lat]]; // Start new segment with current node
                    }
                });
            } else {
                 console.warn("Skipping way with missing or invalid nodes property during edge building:", way);
            }
        });

    } catch (error) {
        console.error("Error during graph construction loops:", error);
        document.getElementById('results').innerHTML += '<p>Error building path network graph.</p>';
        alert(`Error processing map paths: ${error.message}`);
        return; // Stop processing if graph building fails
    }

    const graphNodeCount = Object.keys(graph).length;
    const graphEdgeCount = Object.values(graph).reduce((sum, edges) => sum + edges.length, 0) / 2;
    console.log(`Graph built: ${graphNodeCount} nodes, ${graphEdgeCount} edges.`); // Log after building
    document.getElementById('results').innerHTML += `<p>Network graph built (${graphNodeCount} nodes, ${graphEdgeCount} edges).</p>`;

    if (graphNodeCount === 0) {
         document.getElementById('results').innerHTML += '<p>Graph construction failed or area has no usable paths.</p>';
         alert("Failed to build a searchable path network for this area.");
         return;
    }

    // --- Find the closest graph node to the start point --- 
    let startNodeId = null;
    let minDistance = Infinity;
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
        console.log(`Found starting node: ${startNodeId}`);
         document.getElementById('results').innerHTML += `<p>Found starting point in network (Node ID: ${startNodeId}).</p>`;
        
        // --- DEBUG: Visualize the graph --- 
        // _debugDrawGraph(graph, nodes); // Temporarily disable debug drawing to reduce noise

        console.log("Attempting to call findWalkRoutes...");
        try {
             findWalkRoutes(graph, startNodeId, desiredLengthMeters, nodes[startNodeId].lat, nodes[startNodeId].lon);
             console.log("findWalkRoutes call apparently completed."); // Changed message slightly
        } catch (error) {
             // Log the full error object
             console.error("Error occurred *during* findWalkRoutes call (full error):", error);
             document.getElementById('results').innerHTML += `<p>Error during route finding process: ${error.message || 'Unknown error'}.</p>`;
             alert(`Error during route search: ${error.message || 'Unknown error'}. Check console.`);
        }
        console.log("processOsmData finished execution."); // Add final log
    } else {
        console.error("Could not find a suitable starting node in the graph.");
         document.getElementById('results').innerHTML += '<p>Error: Could not link postcode location to the path network.</p>';
        alert("Could not find a starting point on the path network near the provided postcode.");
        return;
    }
}

// --- Step 9: Implement Routing Algorithm --- 
const ROUTE_FINDING_TIMEOUT_MS = 60000; // 60 seconds max search time (Increased from 15s)
const LENGTH_TOLERANCE_PERCENT = 0.10; // +/- 10%
const MAX_ROUTES_TO_FIND = 5;

// Function to find the index to insert into a sorted array (by f score)
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

// A* Search Implementation
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
    const absoluteMaxLength = targetLength * 1.75;

    // Maximum allowed straight-line distance from the start point (as a fraction of target length)
    // This is a key pruning parameter - adjust if needed
    // const MAX_DISTANCE_FACTOR = 0.75; // 75% of target length
    const MAX_DISTANCE_FACTOR = 10.0; // Temporarily disable pruning by setting a very large factor
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
        if (iterations % 500 === 0) { // Check timeout less often maybe?
            const elapsedTime = Date.now() - startTime;
            if (elapsedTime > ROUTE_FINDING_TIMEOUT_MS) {
                console.warn(`A* Route finding timed out after ${elapsedTime}ms`);
                document.getElementById('results').innerHTML += '<p>Route search timed out (A*).</p>';
                break; 
            }
            // Sort openSet periodically to keep it roughly ordered if insertion sort is too slow
            // openSet.sort((a, b) => a.f - b.f);
        }

        // Get node with the lowest f score (from the start of the sorted array)
        const current = openSet.shift(); 
        const currentNodeId = current.nodeId;
        const currentG = current.g;
        // DEBUG: Log current node
        if(iterations % 200 === 0) console.log(`Iter ${iterations}: Processing Node ${currentNodeId}, g=${currentG.toFixed(0)}, f=${current.f.toFixed(0)}, openSet size: ${openSet.length}`);

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
            console.log(`DEBUG: Reached start node ${startNodeId} with length ${currentG.toFixed(0)}`); // Log goal reach
            if (currentG >= minLength && currentG <= maxLength) {
                const route = { length: currentG, path: current.path, geometry: current.geometry };
                foundRoutes.push(route);
                console.log(`A* Found route: Length ${currentG.toFixed(0)}m`);
                document.getElementById('results').innerHTML += `<p>Found potential route: ${currentG.toFixed(0)}m</p>`;
                if (foundRoutes.length >= MAX_ROUTES_TO_FIND) {
                    console.log(`A* Found maximum number of routes (${MAX_ROUTES_TO_FIND}).`);
                    break; // Exit main while loop
                }
            }
             // Continue searching for other loops even if one is found
             // But don't explore neighbors from the start node once a loop is completed this way
             continue; 
        }

        // --- Explore Neighbors --- 
        const neighbors = graph[currentNodeId] || [];
        for (const edge of neighbors) {
            const neighborId = edge.neighborId;
            const edgeLength = edge.length;
            const edgeGeometry = edge.geometry;
            const tentativeGScore = currentG + edgeLength;

            // Pruning based on path length
            if (tentativeGScore > absoluteMaxLength) continue;

            // Simple U-turn prevention
            if (current.path.length > 1 && neighborId === current.path[current.path.length - 2]) continue;

            // Check if this path to neighbor is better than any previous one
            if (tentativeGScore < (gScore[neighborId] || Infinity)) {
                gScore[neighborId] = tentativeGScore;

                // Get neighbor coordinates for heuristic (last point of edge geometry)
                let neighborCoords = currentNodeCoords;
                if (edgeGeometry && edgeGeometry.length > 0) {
                    neighborCoords = edgeGeometry[edgeGeometry.length - 1];
                }
                const neighborPoint = turf.point(neighborCoords);
                
                // Heuristic calculation
                const h = turf.distance(neighborPoint, startPoint, {units: 'meters'}) + Math.abs(targetLength - tentativeGScore);
                const f = tentativeGScore + h;
                // DEBUG: Log neighbor score
                // console.log(`  -> Neighbor ${neighborId}: g=${tentativeGScore.toFixed(0)}, h=${h.toFixed(0)}, f=${f.toFixed(0)}`);

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
// ... (existing _debugDrawGraph code) ...

// Main function to process OSM data, build graph, and initiate search
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

    // Ensure these variables are declared at the function scope
    const nodeUsage = {}; // Count how many ways use each node
    const nodes = {};     // Store node coords { id: { lat: ..., lon: ... } }
    const ways = [];      // Store way objects { id: ..., nodes: [...] }

    // Check if osmData.elements exists before trying to iterate
    if (!osmData || !osmData.elements) {
        console.error("Invalid or missing osmData elements!");
        document.getElementById('results').innerHTML += '<p>Error: Invalid osmData structure.</p>';
        alert("Failed to process map data. Invalid osmData structure.");
        return;
    }

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

    const graph = {}; // Adjacency list

    // Wrap main processing loops in try...catch
    try {
        // Identify intersections 
        const significantNodeIds = new Set();
        ways.forEach(way => {
            // Check if way.nodes exists and is an array
            if (way && Array.isArray(way.nodes)) {
                way.nodes.forEach((nodeId, index) => {
                    if (nodeUsage[nodeId] > 1 || index === 0 || index === way.nodes.length - 1) {
                        significantNodeIds.add(nodeId);
                    }
                });
            } else {
                console.warn("Skipping way with missing or invalid nodes property:", way);
            }
        });

        // Build edges between significant nodes
        ways.forEach(way => {
             // Check if way.nodes exists and is an array
            if (way && Array.isArray(way.nodes)) {
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
                                    // Catch Turf.js errors specifically
                                    console.error(`Turf error processing segment ${segmentStartNodeId}-${nodeId}:`, e, currentSegmentCoords);
                                }
                            }
                        }
                        // Start the next segment
                        segmentStartNodeId = nodeId;
                        currentSegmentCoords = [[nodeCoords.lon, nodeCoords.lat]]; // Start new segment with current node
                    }
                });
            } else {
                 console.warn("Skipping way with missing or invalid nodes property during edge building:", way);
            }
        });

    } catch (error) {
        console.error("Error during graph construction loops:", error);
        document.getElementById('results').innerHTML += '<p>Error building path network graph.</p>';
        alert(`Error processing map paths: ${error.message}`);
        return; // Stop processing if graph building fails
    }

    const graphNodeCount = Object.keys(graph).length;
    const graphEdgeCount = Object.values(graph).reduce((sum, edges) => sum + edges.length, 0) / 2;
    console.log(`Graph built: ${graphNodeCount} nodes, ${graphEdgeCount} edges.`); // Log after building
    document.getElementById('results').innerHTML += `<p>Network graph built (${graphNodeCount} nodes, ${graphEdgeCount} edges).</p>`;

    if (graphNodeCount === 0) {
         document.getElementById('results').innerHTML += '<p>Graph construction failed or area has no usable paths.</p>';
         alert("Failed to build a searchable path network for this area.");
         return;
    }

    // --- Find the closest graph node to the start point --- 
    let startNodeId = null;
    let minDistance = Infinity;
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
        console.log(`Found starting node: ${startNodeId}`);
         document.getElementById('results').innerHTML += `<p>Found starting point in network (Node ID: ${startNodeId}).</p>`;
        
        // --- DEBUG: Visualize the graph --- 
        // _debugDrawGraph(graph, nodes); // Temporarily disable debug drawing to reduce noise

        console.log("Attempting to call findWalkRoutes...");
        try {
             findWalkRoutes(graph, startNodeId, desiredLengthMeters, nodes[startNodeId].lat, nodes[startNodeId].lon);
             console.log("findWalkRoutes call apparently completed."); // Changed message slightly
        } catch (error) {
             // Log the full error object
             console.error("Error occurred *during* findWalkRoutes call (full error):", error);
             document.getElementById('results').innerHTML += `<p>Error during route finding process: ${error.message || 'Unknown error'}.</p>`;
             alert(`Error during route search: ${error.message || 'Unknown error'}. Check console.`);
        }
        console.log("processOsmData finished execution."); // Add final log
    } else {
        console.error("Could not find a suitable starting node in the graph.");
        document.getElementById('results').innerHTML += '<p>Error: Could not link postcode location to the path network.</p>';
        alert("Could not find a starting point on the path network near the provided postcode.");
        return;
    }
} 