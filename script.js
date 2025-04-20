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

// Reference to the download button
let downloadPdfButton = null;

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

    // Get reference to the download button and add listener
    downloadPdfButton = document.getElementById('download-pdf-btn');
    if (downloadPdfButton) {
        downloadPdfButton.addEventListener('click', () => {
            console.log("Download PDF button clicked!");
            // --- Basic PDF Generation --- 
            try {
                // Ensure jsPDF is loaded
                if (typeof window.jspdf === 'undefined') {
                    console.error("jsPDF library not found!");
                    alert("PDF generation library is not loaded.");
                    return;
                }
                const { jsPDF } = window.jspdf;
                
                console.log("Creating jsPDF document...");
                const doc = new jsPDF();
                
                doc.text("Postcode Walker PDF Test", 10, 10);
                
                console.log("Saving PDF...");
                doc.save('postcode-walk-test.pdf');
                console.log("PDF save initiated.");

            } catch (error) {
                console.error("Error generating basic PDF:", error);
                alert("An error occurred while generating the PDF.");
            }
        });
        console.log("Attached click listener to download-pdf-btn");
    } else {
        console.error("Download PDF button not found!");
    }

    // *** COMMENTED OUT DEBUG log for element check on load ***
    // const initialEndElement = document.getElementById('end_postcode_input');
    // console.log("DEBUG (DOMContentLoaded): Element with ID 'end_postcode_input':", initialEndElement);

});

async function findRoutes() {
    console.log("Find walk button clicked!"); 
    const startPostcode = document.getElementById('postcode').value.trim();
    const distanceInput = document.getElementById('desired_distance').value;
    const desiredDistanceKm = parseFloat(distanceInput);
    const walkType = document.querySelector('input[name="walk_type"]:checked').value;

    const resultsDiv = document.getElementById('results');
    const spinner = document.getElementById('loading-spinner'); 
    
    // Clear previous results and show spinner
    if (spinner) spinner.classList.remove('hidden'); 

    // --- Input Validation ---
    if (!startPostcode) {
        if (spinner) spinner.classList.add('hidden');
        alert("Please enter a start UK postcode.");
        return;
    }
    if (isNaN(desiredDistanceKm) || desiredDistanceKm <= 0) {
        if (spinner) spinner.classList.add('hidden');
        alert("Please enter a valid positive number for the desired distance.");
        return;
    }
    const desiredDistanceMeters = desiredDistanceKm * 1000;
    console.log(`Looking for ${walkType} walk starting from ${startPostcode}, aiming for approx. ${desiredDistanceKm} km (${desiredDistanceMeters}m)`); // Updated log

    if (!map) {
        console.error("Map is not initialized yet.");
        if (spinner) spinner.classList.add('hidden');
        alert("Map is not ready. Please wait and try again.");
        return;
    }
    
    // --- Fetch OSM Data & Process (Common Logic) --- 
    let graph, nodes, startNodeId; // Define variables in outer scope
    try {
        // Hide download button at the start of a new search
        if(downloadPdfButton) downloadPdfButton.hidden = true;
        
        resultsDiv.innerHTML += `<p>Looking up start postcode...</p>`;
        let startCoords;
        try {
            startCoords = await lookupPostcodeCoords(startPostcode);
            console.log(`Start Coords: Lat: ${startCoords.latitude}, Lon: ${startCoords.longitude}`);
            clearRoutes();
            map.setView([startCoords.latitude, startCoords.longitude], 14); 
            L.marker([startCoords.latitude, startCoords.longitude]).addTo(map)
                .bindPopup(`Start: ${startCoords.postcode}`)
                .openPopup();
        } catch (error) {
            console.error(error);
            resultsDiv.innerHTML = `<p>${error.message}</p>`;
            alert(error.message);
            if (spinner) spinner.classList.add('hidden');
            return; 
        }
        
        resultsDiv.innerHTML += `<p>Calculating search area...</p>`;
        let searchBbox;
        try {
            const bufferFactor = 1.5; 
            const approxRadiusLat = (desiredDistanceMeters * bufferFactor) / 111000; 
            const approxRadiusLon = approxRadiusLat / Math.cos(startCoords.latitude * Math.PI / 180);
            searchBbox = [
                startCoords.longitude - approxRadiusLon,
                startCoords.latitude - approxRadiusLat,
                startCoords.longitude + approxRadiusLon,
                startCoords.latitude + approxRadiusLat
            ];
            console.log("Calculated search bbox:", searchBbox);
        } catch(e) {
            console.error("Error calculating bounding box:", e);
            resultsDiv.innerHTML = `<p>Error calculating map area.</p>`;
            alert("Could not calculate the area to search for map data.");
            if (spinner) spinner.classList.add('hidden');
            return; 
        }

        resultsDiv.innerHTML += `<p>Fetching map data for the area...</p>`;
        const osmData = await fetchOsmDataInBbox(searchBbox);
        if (osmData.elements.length === 0) {
             resultsDiv.innerHTML = '<p>No map features (paths, roads) found for the area.</p>';
             alert("No map data found for this area.");
             if (spinner) spinner.classList.add('hidden');
             return; 
        }
        resultsDiv.innerHTML += `<p>Fetched ${osmData.elements.length} map elements. Processing data...</p>`;
        
        // Assign processed data to outer scope variables
        ({ graph, nodes, startNodeId } = processOsmData(osmData, startCoords.latitude, startCoords.longitude));

        // --- Branch based on walk type --- 
        if (walkType === 'one_way') {
            console.log("Finding one-way walk...");
            resultsDiv.innerHTML += `<p>Searching for a one-way walk near ${desiredDistanceKm} km...</p>`;
            const route = await findWalkNearDistance(graph, nodes, startNodeId, desiredDistanceMeters);

            // Process route result (existing logic)
            if (route && route.segments && route.segments.length > 0) {
                 console.log(`Found walk: Length=${route.length.toFixed(0)}m, Segments=${route.segments.length}`);
                 resultsDiv.innerHTML += `<h3>Found Walk:</h3><ul>`;
                 resultsDiv.innerHTML += `<li>Approx. Length: ${(route.length / 1000).toFixed(1)} km (${route.length.toFixed(0)}m)</li>`;
                 if (nodes && route.path && route.path.length > 0) {
                      const endNodeId = route.path[route.path.length - 1];
                      const endNodeCoords = nodes[endNodeId];
                      if(endNodeCoords) {
                          L.marker([endNodeCoords.lat, endNodeCoords.lon]).addTo(map)
                              .bindPopup(`End (Node ${endNodeId})`);
                      }
                 }
                 drawRoute(route, 0);
                 resultsDiv.innerHTML += `</ul>`;
                 const instructionsHtml = generateInstructions(route.segments);
                 document.getElementById('results').innerHTML += instructionsHtml;
                 // Show download button
                 console.log("Before attempting to show PDF button (one-way)"); // DEBUG
                 if(downloadPdfButton) downloadPdfButton.hidden = false;
                 console.log("After attempting to show PDF button (one-way). Hidden state:", downloadPdfButton ? downloadPdfButton.hidden : 'Button not found'); // DEBUG
                 try {
                     const routeLine = L.polyline(route.segments.map(seg => seg.geometry.map(coord => [coord[1], coord[0]])).flat());
                     if (routeLine.getLatLngs().length > 0) {
                          map.fitBounds(routeLine.getBounds().pad(0.1)); 
                     }
                 } catch (e) {
                     console.error("Error fitting map bounds to route:", e);
                 }
            } else {
                 resultsDiv.innerHTML = `<p>Could not find a suitable one-way walk near ${desiredDistanceKm} km.</p>`;
                 alert(`Could not find a walk. Try a different distance or start point.`);
            }

        } else if (walkType === 'round_trip') {
            console.log("Finding round trip walk...");
            const outwardTargetDistance = desiredDistanceMeters / 2;
            resultsDiv.innerHTML += `<p>Searching for outward path near ${(outwardTargetDistance / 1000).toFixed(1)} km...</p>`;
            
            const outwardRoute = await findWalkNearDistance(graph, nodes, startNodeId, outwardTargetDistance);

            if (outwardRoute && outwardRoute.segments && outwardRoute.segments.length > 0) {
                console.log(`Found outward path: Length=${outwardRoute.length.toFixed(0)}m`);
                // Display outward path temporarily or keep it? Let's clear it before drawing combined.
                // drawRoute(outwardRoute, 1); 
                // resultsDiv.innerHTML += `<h3>Found Outward Path...</h3>`;
                
                // --- Find Return Path using A* --- 
                resultsDiv.innerHTML += `<p>Searching for return path...</p>`;
                const midpointNodeId = outwardRoute.path[outwardRoute.path.length - 1];
                console.log(`Finding return path from midpoint node ${midpointNodeId} to start node ${startNodeId}`);
                
                const returnRoute = await findShortestPathAStar(graph, nodes, midpointNodeId, startNodeId);

                if (returnRoute && returnRoute.segments && returnRoute.segments.length > 0) {
                    console.log(`Found return path: Length=${returnRoute.length.toFixed(0)}m`);
                    
                    // Combine Routes
                    const totalLength = outwardRoute.length + returnRoute.length;
                    const combinedSegments = outwardRoute.segments.concat(returnRoute.segments);
                    // Combine paths for potential future use, though not strictly needed for drawing/instructions
                    const combinedPath = outwardRoute.path.concat(returnRoute.path.slice(1)); // Avoid duplicating midpoint
                    const combinedRoute = { length: totalLength, segments: combinedSegments, path: combinedPath };

                    console.log(`Combined round trip: Length=${totalLength.toFixed(0)}m, Segments=${combinedSegments.length}`);
                    resultsDiv.innerHTML += `<h3>Round Trip Found:</h3><ul>`;
                    resultsDiv.innerHTML += `<li>Total Approx. Length: ${(totalLength / 1000).toFixed(1)} km (${totalLength.toFixed(0)}m)</li>`;
                    
                    // Clear previous single path drawing before drawing combined
                    clearRoutes(); 
                    L.marker([startCoords.latitude, startCoords.longitude]).addTo(map)
                        .bindPopup(`Start/End: ${startCoords.postcode}`)
                        .openPopup(); // Re-add start marker if cleared

                    drawRoute(combinedRoute, 0); // Draw combined route in red
                    console.log("DEBUG: After drawRoute(combinedRoute)"); // DEBUG
                    resultsDiv.innerHTML += `</ul>`;
                    console.log("DEBUG: After adding closing ul"); // DEBUG
                    
                    const instructionsHtml = generateInstructions(combinedSegments);
                    console.log("DEBUG: After generateInstructions"); // DEBUG
                    document.getElementById('results').innerHTML += instructionsHtml;
                    console.log("DEBUG: After adding instructionsHtml"); // DEBUG
                    
                    // Show download button
                    console.log("Before attempting to show PDF button (round-trip)"); // Existing DEBUG
                    if(downloadPdfButton) downloadPdfButton.hidden = false;
                    console.log("After attempting to show PDF button (round-trip). Hidden state:", downloadPdfButton ? downloadPdfButton.hidden : 'Button not found'); // Existing DEBUG

                    // Fit map
                    console.log("DEBUG: Before map.fitBounds try block"); // DEBUG
                    try {
                         const routeLine = L.polyline(combinedRoute.segments.map(seg => seg.geometry.map(coord => [coord[1], coord[0]])).flat());
                         if (routeLine.getLatLngs().length > 0) {
                              map.fitBounds(routeLine.getBounds().pad(0.1)); 
                         }
                     } catch (e) {
                         console.error("Error fitting map bounds to combined route:", e);
                     }

                } else {
                    // Found outward, but no return path
                    resultsDiv.innerHTML = `<p>Found an outward path of approx. ${(outwardRoute.length/1000).toFixed(1)} km, but could not find a path back to the start.</p>`;
                    alert("Could not find a return path back to the start point.");
                    // Keep the outward path drawn in this case
                    drawRoute(outwardRoute, 1); 
                }
                // --- End Return Path Logic ---

            } else {
                // No outward path found
                resultsDiv.innerHTML = `<p>Could not find a suitable outward path near ${(outwardTargetDistance / 1000).toFixed(1)} km.</p>`; 
                alert(`Could not find an outward path. Try a different distance or start point.`);
            }
        
        } else {
            console.error("Unknown walk type selected:", walkType);
            resultsDiv.innerHTML = `<p>Error: Unknown walk type selected.</p>`;
            alert("An unexpected error occurred with the walk type selection.");
        }
        // --- End branch ---

    } catch (error) {
         // Catch errors from common processing or specific walk type logic
         console.error("Error during walk finding process:", error);
         // Ensure resultsDiv shows the error if not already set by specific catch blocks
         if (!resultsDiv.innerHTML.includes("Error") && !resultsDiv.innerHTML.includes("Could not find")) {
             resultsDiv.innerHTML = `<p>An unexpected error occurred: ${error.message}</p>`; 
         }
         // Optionally re-alert or handle differently
         // alert(`An error occurred during processing: ${error.message}`); 
     } finally {
         // Ensure spinner is hidden when done (success or error)
         if (spinner) { // Check if spinner element exists
             spinner.classList.add('hidden'); 
         }
     }
} // End of findRoutes function

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

// Renamed function and changed parameters
async function fetchOsmDataInBbox(bbox) { 
    // Bbox is expected as [minLon, minLat, maxLon, maxLat]
    if (!bbox || bbox.length !== 4) {
        throw new Error("Invalid bounding box provided to fetchOsmDataInBbox.");
    }
    const bboxString = `${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]}`; // Overpass format: south,west,north,east
    console.log(`Fetching OSM data within bbox: ${bboxString}`);
    
    // Updated Overpass query to use bbox
    const query = `
        [out:json][timeout:60]; // Increased timeout slightly
        (
          way
            ["highway"~"^(footway|path|pedestrian|track|residential|living_street|service|unclassified|tertiary)$"]
            (${bboxString}); // Use bbox directly
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
                                // Get way name (use ref if name is not available)
                                const wayName = way.tags?.name || way.tags?.ref || `Way ${way.id}`; 
                                
                                // Add edge with way info
                                graph[node1Id].push({ 
                                    neighborId: node2Id, 
                                    length: length, 
                                    geometry: segmentGeometry, 
                                    wayId: way.id, 
                                    wayName: wayName 
                                });
                                graph[node2Id].push({ 
                                    neighborId: node1Id, 
                                    length: length, 
                                    geometry: segmentGeometry.slice().reverse(), 
                                    wayId: way.id, 
                                    wayName: wayName 
                                });
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
function processOsmData(osmData, startLat, startLon) {
    console.log("Processing OSM data...");
    const resultsDiv = document.getElementById('results');

    // Validate start coordinates FIRST
    if (typeof startLat !== 'number' || typeof startLon !== 'number') {
        console.error("Invalid start coordinates received:", { startLat, startLon });
        throw new Error("Invalid start coordinates provided for processing.");
    }

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
            // Store the way ID, node list, and tags
            ways.push({ id: element.id, nodes: element.nodes, tags: element.tags || {} }); 
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
    let minStartDistance = Infinity;
    let startNodeActualCoords = null;

    try {
        const startPoint = turf.point([startLon, startLat]);

        Object.keys(graph).forEach(nodeId => {
            const nodeData = nodes[nodeId];
            // RE-ADD check for valid nodeData and numeric coordinates INSIDE LOOP
            if (nodeData && typeof nodeData.lat === 'number' && typeof nodeData.lon === 'number') {
                try { 
                    const nodePoint = turf.point([nodeData.lon, nodeData.lat]);
                    // Calculate distance ONLY if nodePoint is valid
                    const distToStart = turf.distance(startPoint, nodePoint, { units: 'meters' }); 
                    if (distToStart < minStartDistance) {
                        minStartDistance = distToStart;
                        startNodeId = parseInt(nodeId);
                        startNodeActualCoords = { lat: nodeData.lat, lon: nodeData.lon };
                    }
                } catch (turfError) {
                     // Catch errors specifically from turf.point or turf.distance
                     console.warn(`Turf.js error processing node ${nodeId} data - skipping node.`, turfError);
                }
            } else {
                // Log nodes with missing/invalid data
                if (nodeId !== undefined) { 
                     console.warn(`Skipping node ${nodeId} due to missing or non-numeric lat/lon:`, nodeData);
                }
            }
        });
    } catch (error) {
         // Catch errors from creating startPoint or other general errors
         const errorMsg = "Error finding closest start node to path network.";
         console.error(errorMsg, error);
         alert(errorMsg);
         resultsDiv.innerHTML += `<p>${errorMsg}: ${error.message}</p>`;
         return;
    }

    if (startNodeId === null) {
         console.error(`Could not find a suitable start node in the graph.`);
         resultsDiv.innerHTML += `<p>Error: Could not link start postcode location to the path network.</p>`;
         alert(`Could not find a starting point on the path network near the provided start postcode.`);
         return;
    }
    
    console.log(`Found start node: ${startNodeId}. Distance: ${minStartDistance.toFixed(1)}m`);
    resultsDiv.innerHTML += `<p>Found network points: Start Node ${startNodeId} (${minStartDistance.toFixed(1)}m away).</p>`;
    
    // *** COMMENTED OUT call to _debugDrawGraph ***
    // _debugDrawGraph(graph, nodes, startLat, startLon);

    // --- 4. Initiate Route Finding --- 
    //console.log("Attempting to call findWalkRoutes...");
    //try {
        // Pass startNodeId, and actual coordinates of startNode for heuristic
        // *** Also pass the nodes object for heuristic calculations inside A* ***
       // findWalkRoutes(graph, nodes, startNodeId, startNodeActualCoords.lat, startNodeActualCoords.lon);
        //console.log("findWalkRoutes call apparently completed.");
    // } catch (error) {
        //console.error("Error occurred *during* findWalkRoutes call (full error):", error);
        //resultsDiv.innerHTML += `<p>Error during route finding process: ${error.message || 'Unknown error'}.</p>`;
        // alert(`Error during route search: ${error.message || 'Unknown error'}. Check console.`);
       return { graph, nodes, startNodeId };
    // }
   // console.log("processOsmData finished execution.");
}

// --- Step 6b: Find Walk Near Distance (DFS) ---
async function findWalkNearDistance(graph, nodes, startNodeId, targetDistance) {
    console.log(`Searching for walk near ${targetDistance}m starting from node ${startNodeId}`);
    const startTime = Date.now();
    let bestRoute = null;
    let minDiff = Infinity; // Minimum difference found so far

    // Use a stack for DFS: stores { nodeId, path, segments, currentLength }
    const stack = []; 
    
    // Initial state
    if (graph[startNodeId]) {
        stack.push({ 
            nodeId: startNodeId, 
            path: [startNodeId], 
            segments: [], 
            currentLength: 0, 
            visited: new Set([startNodeId]) // Keep track of visited nodes *in the current path*
        });
    } else {
        console.error(`Start node ${startNodeId} not found in graph for DFS.`);
        return null; // Cannot start search
    }

    let iterations = 0;
    const tolerance = targetDistance * 0.2; // Allow +/- 20% deviation? (Adjustable)
    const lowerBound = targetDistance - tolerance;
    const upperBound = targetDistance + tolerance;

    while (stack.length > 0) {
        iterations++;
        if (iterations % 5000 === 0) { // Timeout check
            const elapsedTime = Date.now() - startTime;
            if (elapsedTime > ROUTE_FINDING_TIMEOUT_MS) {
                console.warn(`findWalkNearDistance DFS timed out after ${elapsedTime}ms`);
                break; // Stop searching
            }
             console.log(`DFS iteration ${iterations}, stack size ${stack.length}`);
        }

        const { nodeId, path, segments, currentLength, visited } = stack.pop();

        // Check if current path is a candidate
        const diff = Math.abs(currentLength - targetDistance);
        if (currentLength >= lowerBound && currentLength <= upperBound) {
            // Found a path within tolerance
            if (diff < minDiff) {
                 console.log(`Found candidate route: Length ${currentLength.toFixed(0)}m (Diff: ${diff.toFixed(0)}m)`);
                minDiff = diff;
                bestRoute = { length: currentLength, path: path, segments: segments };
                // Could potentially stop here if we only need the first acceptable route
                // Or continue searching for one closer to the target distance
            }
        }
        
        // If current path is already much longer than target, prune this branch
        // (Add a more generous upper bound for pruning to allow finding routes slightly over)
        if (currentLength > targetDistance * 1.5) { // e.g. Prune if > 150% of target
            continue; 
        }

        // Explore neighbors
        const neighbors = graph[nodeId] || [];
        // Shuffle neighbors to explore different directions randomly? (Optional)
        // neighbors.sort(() => Math.random() - 0.5); 

        for (const edge of neighbors) {
            const neighborId = edge.neighborId;

            // Avoid cycles in the current path
            if (!visited.has(neighborId)) {
                const newLength = currentLength + edge.length;
                const newPath = [...path, neighborId];
                const newSegment = { 
                    geometry: edge.geometry, 
                    length: edge.length, 
                    wayId: edge.wayId, 
                    wayName: edge.wayName 
                };
                const newSegments = [...segments, newSegment];
                const newVisited = new Set(visited); // Create a new visited set for the new path
                newVisited.add(neighborId);

                stack.push({
                    nodeId: neighborId,
                    path: newPath,
                    segments: newSegments,
                    currentLength: newLength,
                    visited: newVisited
                });
            }
        }
    } // End while loop

    const endTime = Date.now();
    if (bestRoute) {
        console.log(`DFS finished in ${endTime - startTime}ms. Best route found: Length ${bestRoute.length.toFixed(0)}m (Target: ${targetDistance}m)`);
    } else {
         console.log(`DFS finished in ${endTime - startTime}ms. No suitable route found near ${targetDistance}m.`);
    }
    
    return bestRoute;
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
async function findWalkRoutes(graph, nodes, startNodeId, endLat, endLon) { // Added endLat, endLon
    console.log(`Starting A* route search from node ${startNodeId} to end point (${endLat}, ${endLon})`);
    // Removed targetLength, startLat, startLon from params/logs
    console.log(`Received graph nodes: ${Object.keys(graph).length}, node data entries: ${Object.keys(nodes).length}, startNodeId: ${startNodeId}`); // Log nodes count
    
    // Updated parameter check
    if (!graph || Object.keys(graph).length === 0 || !nodes || Object.keys(nodes).length === 0 || !startNodeId || !endLat || !endLon) { // Check nodes
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
            segments: [] // Initialize segments array
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
        if (currentNodeId === startNodeId) {
            console.log(`%cDEBUG: Goal Check - Reached START node ${startNodeId}!`, 'color: green; font-weight: bold;');
            console.log(` -> Path Length (g): ${currentG.toFixed(1)}m`);
            // Include segments in the final route object
            const route = { length: currentG, path: current.path, segments: current.segments }; 
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
            const edgeWayId = edge.wayId; // Get way info from edge
            const edgeWayName = edge.wayName; // Get way info from edge
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
                // const newGeometry = [...current.geometry, edgeGeometry]; // Replaced by segments
                // Add new segment details to the list
                const newSegment = { 
                    geometry: edgeGeometry, 
                    length: edgeLength, 
                    wayId: edgeWayId, 
                    wayName: edgeWayName 
                };
                const newSegments = [...current.segments, newSegment];
                
                const newState = {
                    nodeId: neighborId,
                    f: f, g: tentativeGScore,
                    path: newPath, 
                    // geometry: newGeometry, // Replaced by segments
                    segments: newSegments // Store the updated segments list
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
        console.log(`Shortest Route: Length=${shortestRoute.length.toFixed(0)}m, Nodes=${shortestRoute.path.length}, Segments=${shortestRoute.segments.length}`); // Log segment count
        document.getElementById('results').innerHTML += `<li>Route Length: ${shortestRoute.length.toFixed(0)}m</li>`;
        drawRoute(shortestRoute, 0); // Draw the single route
        resultsDiv.innerHTML += `</ul>`;
        
        // Generate and display instructions
        const instructionsHtml = generateInstructions(shortestRoute.segments);
        document.getElementById('results').innerHTML += instructionsHtml;

        // Fit map to the route bounds
        try {
            // Update to use route.segments for geometry
            const routeLine = L.polyline(shortestRoute.segments.map(seg => seg.geometry.map(coord => [coord[1], coord[0]])).flat());
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

// --- Step 6c: A* Implementation for Point-to-Point Routing ---

async function findShortestPathAStar(graph, nodes, startNodeId, endNodeId) {
    console.log(`Starting A* shortest path search from node ${startNodeId} to node ${endNodeId}`);
    const startTime = Date.now();

    // Basic parameter check
    if (!graph || !nodes || !startNodeId || !endNodeId || !graph[startNodeId] ) {
        console.error("findShortestPathAStar called with invalid parameters!", 
            { graphExists: !!graph, nodesExists: !!nodes, startNodeId, endNodeId, startInGraph: !!graph?.[startNodeId] });
        return null;
    }
    // Check if end node actually exists in the graph nodes data (heuristic needs it)
    if (!nodes[endNodeId]) {
        console.error(`End node ${endNodeId} data not found in nodes object.`);
        // We could technically proceed without heuristic, but it's usually required
        return null; 
    }

    const openSet = []; // Priority Queue (using sorted array)
    const cameFrom = {}; // Stores { fromNode, segment } 
    const gScore = {}; // Cost from start to node

    // Initialize scores
    Object.keys(graph).forEach(nodeId => {
        gScore[parseInt(nodeId)] = Infinity;
    });
    gScore[startNodeId] = 0;

    // Heuristic function (straight-line distance to end)
    const endNodeData = nodes[endNodeId];
    const endPoint = turf.point([endNodeData.lon, endNodeData.lat]);
    const heuristic = (nodeId) => {
        const nodeData = nodes[nodeId];
        if (!nodeData) return Infinity; // Should not happen if graph is consistent
        const nodePoint = turf.point([nodeData.lon, nodeData.lat]);
        return turf.distance(nodePoint, endPoint, { units: 'meters' });
    };

    // Add start node to PQ
    openSet.push({ nodeId: startNodeId, f: heuristic(startNodeId) });

    let iterations = 0;

    while (openSet.length > 0) {
        iterations++;
        // Simple timeout check
        if (iterations % 2000 === 0) {
            const elapsedTime = Date.now() - startTime;
            if (elapsedTime > ROUTE_FINDING_TIMEOUT_MS) { // Use standard timeout
                console.warn(`A* shortest path search timed out after ${elapsedTime}ms`);
                return null; // Indicate timeout/failure
            }
        }

        // Get node with lowest f score 
        const current = openSet.shift();
        const u = current.nodeId;

        // --- Goal Check ---
        if (u === endNodeId) {
            console.log(`A* found path to ${endNodeId} in ${iterations} iterations.`);
            // Reconstruct path
            const segments = [];
            const pathNodes = [];
            let curr = endNodeId;
            while (cameFrom[curr]) {
                pathNodes.push(curr);
                const predInfo = cameFrom[curr];
                segments.push(predInfo.segment); // Store the segment used to reach curr
                curr = predInfo.fromNode;
            }
            pathNodes.push(startNodeId); 
            segments.reverse(); 
            pathNodes.reverse();
            console.log(`Reconstructed A* path: ${segments.length} segments, ${pathNodes.length} nodes.`);
            return { length: gScore[endNodeId], segments: segments, path: pathNodes };
        }

        // --- Explore Neighbors ---
        const neighbors = graph[u] || [];
        for (const edge of neighbors) {
            const v = edge.neighborId;
            const tentativeGScore = gScore[u] + edge.length;

            if (tentativeGScore < gScore[v]) {
                // This path to neighbor is better than any previous one. Record it!
                cameFrom[v] = { 
                    fromNode: u, 
                    segment: { // Store details needed for reconstruction
                        geometry: edge.geometry, 
                        length: edge.length, 
                        wayId: edge.wayId, 
                        wayName: edge.wayName 
                    } 
                };
                gScore[v] = tentativeGScore;
                const fScore = tentativeGScore + heuristic(v);
                
                // Add neighbor to priority queue (if not already present with lower f)
                // Simple check: does it exist in openSet already?
                const existingIndex = openSet.findIndex(item => item.nodeId === v);
                if (existingIndex === -1) {
                    const newState = { nodeId: v, f: fScore };
                    const index = findSortedIndex(openSet, newState); // Use helper
                    openSet.splice(index, 0, newState);
                } else {
                    // If it exists but this path is better (lower f), update it
                    // (More complex PQ needed for efficient update, this is approximation)
                    if (fScore < openSet[existingIndex].f) {
                        openSet.splice(existingIndex, 1); // Remove old one
                        const newState = { nodeId: v, f: fScore };
                        const index = findSortedIndex(openSet, newState);
                        openSet.splice(index, 0, newState); // Add new one
                    }
                }
            }
        }
    }

    // Open set is empty but goal was never reached
    console.log(`A* failed to find a path from ${startNodeId} to ${endNodeId} after ${iterations} iterations.`);
    return null;
}

// --- Step 8: Instruction Generation ---

function generateInstructions(routeSegments) {
    if (!routeSegments || routeSegments.length === 0) {
        return "<p>No route segments found to generate instructions.</p>";
    }

    let instructions = [];
    let currentInstruction = null;

    routeSegments.forEach((segment, index) => {
        const wayName = segment.wayName || "Unnamed path";
        const distance = segment.length;

        if (!currentInstruction) {
            // Start of the route
            currentInstruction = { wayName: wayName, distance: distance };
        } else if (wayName === currentInstruction.wayName) {
            // Continue on the same way
            currentInstruction.distance += distance;
        } else {
            // Changed way - finalize previous instruction and start new one
            instructions.push(`Walk approx. ${currentInstruction.distance.toFixed(0)}m on ${currentInstruction.wayName}`);
            currentInstruction = { wayName: wayName, distance: distance };
        }

        // Add the last instruction if it exists
        if (index === routeSegments.length - 1 && currentInstruction) {
             instructions.push(`Walk approx. ${currentInstruction.distance.toFixed(0)}m on ${currentInstruction.wayName}`);
        }
    });

    if (instructions.length === 0 && currentInstruction) {
        // Handle cases where the entire route is on a single way
        instructions.push(`Walk approx. ${currentInstruction.distance.toFixed(0)}m on ${currentInstruction.wayName}`);
    }

    // Format as an HTML list
    if (instructions.length > 0) {
        return "<h3>Instructions:</h3><ol><li>" + instructions.join("</li><li>") + "</li></ol>";
    } else {
        return "<p>Could not generate instructions from route segments.</p>";
    }
}

// --- Step 7: Map Utilities ---

// Function to clear existing routes from the map
function clearRoutes() {
    drawnRouteLayers.forEach(layer => map.removeLayer(layer));
    drawnRouteLayers = [];
    // Hide download button when routes are cleared
    if(downloadPdfButton) downloadPdfButton.hidden = true;
    // Optionally clear the results list too, or handle it where search starts
    // document.getElementById('results').innerHTML = '<h2>Results</h2>';
}

// Implement the drawRoute function to display a found route
function drawRoute(route, index) {
    // Check for route.segments
    if (!route || !route.segments || route.segments.length === 0) { 
        console.error("Invalid route data for drawing:", route);
        return;
    }

    // Combine segments' geometry into a single coordinate array
    let fullCoords = [];
    route.segments.forEach((segment, segmentIndex) => {
        // First segment: add all points from its geometry
        // Subsequent segments: skip the first point of its geometry
        const pointsToAdd = segmentIndex === 0 ? segment.geometry : segment.geometry.slice(1);
        if (pointsToAdd) {
            fullCoords = fullCoords.concat(pointsToAdd);
        }
    });

    // Convert to Leaflet's [lat, lon] format
    const leafletCoords = fullCoords.map(coord => {
        // Add check for valid coordinate structure
        if (Array.isArray(coord) && coord.length === 2) {
            return [coord[1], coord[0]]; 
        } else {
            console.warn("Skipping invalid coordinate pair during drawing:", coord);
            return null; // Filter out invalid coords later
        }
    }).filter(coord => coord !== null); // Remove any nulls from invalid pairs

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