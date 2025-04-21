const axios = require('axios');
const turf = require('@turf/turf');

// --- Configuration Constants (Copied from script.js) ---
const POSTCODES_IO_API_URL = 'https://api.postcodes.io/postcodes/';
const OVERPASS_API_URL = 'https://overpass-api.de/api/interpreter';
const ROUTE_FINDING_TIMEOUT_MS = 60000; // 60 seconds

// --- Helper: Define costs per meter for different highway types (Moved here) ---
// Lower values are preferred.
// REMOVED highwayCosts definition from here - will be passed in from server.js

// --- Ported Functions from script.js (Adapted for Backend) ---

async function lookupPostcodeCoords(postcode) {
    const url = `${POSTCODES_IO_API_URL}${encodeURIComponent(postcode)}`;
    console.log(`Backend: Looking up postcode: ${url}`);
    try {
        // Use axios instead of fetch
        const response = await axios.get(url);
        const data = response.data; // axios wraps response in data property
        if (data.status === 200 && data.result) {
            console.log(`Backend: Postcode lookup successful for ${data.result.postcode}`);
            return {
                latitude: data.result.latitude,
                longitude: data.result.longitude,
                postcode: data.result.postcode
            };
        } else {
            throw new Error(data.error || 'Postcode not found');
        }
    } catch (error) {
        console.error("Backend: Error fetching postcode data:", error.response ? error.response.data : error.message);
        // Rethrow a cleaner error for the caller
        throw new Error(`Postcode lookup failed: ${error.response?.data?.error || error.message}`);
    }
}

async function fetchOsmDataInBbox(bbox) {
    if (!bbox || bbox.length !== 4) {
        throw new Error("Invalid bounding box provided to fetchOsmDataInBbox.");
    }
    const bboxString = `${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]}`; // Overpass format: south,west,north,east
    console.log(`Backend: Fetching OSM data within bbox: ${bboxString}`);

    const query = `
        [out:json][timeout:60];
        (
          way
            ["highway"~"^(footway|path|pedestrian|track|residential|living_street|service|unclassified|tertiary|cycleway|bridleway)$"] // Added bridleway
            (${bboxString});
        );
        out body;
        >;
        out skel qt;
    `;

    try {
        // Use axios POST for Overpass API
        const response = await axios.post(OVERPASS_API_URL, `data=${encodeURIComponent(query)}`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const osmData = response.data;
        console.log(`Backend: Received ${osmData?.elements?.length || 0} OSM elements.`);

        if (!osmData || !Array.isArray(osmData.elements)) {
             console.error("Backend: Invalid or unexpected data structure received from Overpass API:", osmData);
             throw new Error("Received invalid map data structure from Overpass API.");
        }
        return osmData;

    } catch (error) {
        console.error("Backend: Error fetching or processing Overpass data:", error.response ? error.response.data : error.message);
        throw new Error(`Fetching OSM data failed: ${error.response?.data?.error || error.message}`);
    }
}

function buildGraph(nodes, ways, costMap) {
    console.log("Backend: Building graph with provided cost map...");
    const graph = {}; // Adjacency list
    if (!costMap || Object.keys(costMap).length === 0) {
        console.error("CRITICAL: buildGraph called without a valid costMap!");
        // Fallback to a default to avoid crashing, but log error
        costMap = { default: 1.8 }; 
    }
    try {
        ways.forEach(way => {
            if (way && Array.isArray(way.nodes) && way.nodes.length >= 2) {
                for (let i = 0; i < way.nodes.length - 1; i++) {
                    const node1Id = way.nodes[i];
                    const node2Id = way.nodes[i+1];
                    const node1Coords = nodes[node1Id];
                    const node2Coords = nodes[node2Id];

                    if (node1Coords && node2Coords) {
                        const length = turf.distance(
                            turf.point([node1Coords.lon, node1Coords.lat]),
                            turf.point([node2Coords.lon, node2Coords.lat]),
                            { units: 'meters' }
                        );

                        if (length > 0) {
                            const wayName = way.tags?.name || way.tags?.ref || `Way ${way.id}`; 
                            const highwayTag = way.tags?.highway || 'unknown'; 
                            // Use the passed-in costMap here
                            const costFactor = costMap[highwayTag] || costMap.default || 1.8; // Use default from map or fallback
                            const cost = length * costFactor; // Calculate cost here
                            const segmentGeometry = [[node1Coords.lon, node1Coords.lat],[node2Coords.lon, node2Coords.lat]];

                            if (!graph[node1Id]) graph[node1Id] = [];
                            if (!graph[node2Id]) graph[node2Id] = [];

                            // Store edge with calculated cost
                            graph[node1Id].push({ 
                                neighborId: node2Id, length, cost, geometry: segmentGeometry, 
                                wayId: way.id, wayName, highwayTag
                            });
                            graph[node2Id].push({ 
                                neighborId: node1Id, length, cost, geometry: segmentGeometry.slice().reverse(), 
                                wayId: way.id, wayName, highwayTag 
                            });
                        }
                    }
                }
            }
        });
        const graphNodeCount = Object.keys(graph).length;
        console.log(`Backend: Graph built: ${graphNodeCount} nodes.`);
        return graph;
    } catch (error) {
        console.error("Backend: Error during graph construction:", error);
        throw new Error(`Error building path network graph: ${error.message}`);
    }
}

function processOsmData(osmData, startLat, startLon, costMap) {
    console.log("Backend: Processing OSM data...");
    if (typeof startLat !== 'number' || typeof startLon !== 'number') {
        throw new Error("Invalid start coordinates provided for processing.");
    }
    if (typeof turf === 'undefined') {
         throw new Error("Turf.js library not available on backend.");
    }

    // 1. Parse OSM Data
    const nodes = {};
    const ways = [];
    osmData.elements.forEach(element => {
        if (element.type === 'node') {
            nodes[element.id] = { lat: element.lat, lon: element.lon };
        } else if (element.type === 'way' && element.nodes) {
            ways.push({ id: element.id, nodes: element.nodes, tags: element.tags || {} }); 
        }
    });
    console.log(`Backend: Parsed ${Object.keys(nodes).length} nodes and ${ways.length} ways.`);

    // 2. Build Graph (Pass costMap through)
    const graph = buildGraph(nodes, ways, costMap);
    const graphNodeCount = Object.keys(graph).length;
    if (graphNodeCount === 0) {
         throw new Error("Graph construction failed or area has no usable paths.");
    }
    console.log(`Backend: Network graph built (${graphNodeCount} nodes).`);

    // 3. Find Closest Start Node
    let startNodeId = null;
    let minStartDistance = Infinity;
    try {
        const startPoint = turf.point([startLon, startLat]);
        Object.keys(graph).forEach(nodeId => {
            const nodeData = nodes[nodeId];
            if (nodeData && typeof nodeData.lat === 'number' && typeof nodeData.lon === 'number') {
                try { 
                    const nodePoint = turf.point([nodeData.lon, nodeData.lat]);
                    const distToStart = turf.distance(startPoint, nodePoint, { units: 'meters' });
                    if (distToStart < minStartDistance) {
                        minStartDistance = distToStart;
                        startNodeId = parseInt(nodeId);
                    }
                } catch (turfError) {
                     console.warn(`Backend: Turf.js error processing node ${nodeId} data - skipping node.`, turfError);
                }
            }
        });
    } catch (error) {
         throw new Error(`Error finding closest start node to path network: ${error.message}`);
    }

    if (startNodeId === null) {
         throw new Error("Could not link start postcode location to the path network.");
    }
    console.log(`Backend: Found start node: ${startNodeId} (${minStartDistance.toFixed(1)}m away).`);
    
    // Return processed data for the next step
    return { graph, nodes, startNodeId };
}

// Helper for A* priority queue
function findSortedIndex(array, element) {
    let low = 0, high = array.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        // Compare 'f' scores (estimated total cost)
        if (array[mid].f < element.f) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return low;
}

// Helper to calculate initial bearing of a route (Exported)
const calculateInitialBearing = (route, nodes) => {
    if (!route || !route.path || route.path.length < 2 || !nodes) return null;
    const startNodeId = route.path[0];
    const startNode = nodes[startNodeId];
    if (!startNode) return null;

    // Find a point approx 50-150m along the path
    let targetNode = null;
    let currentLength = 0;
    for(let i = 0; i < route.segments.length; i++) {
         currentLength += route.segments[i].length;
         if (currentLength >= 50 && i + 1 < route.path.length) { 
             const nextNodeId = route.path[i + 1];
             targetNode = nodes[nextNodeId];
             break;
         }
         if (i + 1 >= route.path.length) break; 
    }
    if (!targetNode && route.path.length > 1) {
        targetNode = nodes[route.path[1]];
    }
    if (!startNode || !targetNode || (startNode.lat === targetNode.lat && startNode.lon === targetNode.lon)) return null;

    try {
        const bearing = turf.bearing(
            turf.point([startNode.lon, startNode.lat]),
            turf.point([targetNode.lon, targetNode.lat])
        );
        return (bearing < 0) ? bearing + 360 : bearing;
    } catch (e) {
        console.error("Turf bearing calculation error:", e);
        return null;
    }
};

async function findWalkNearDistance(graph, nodes, startNodeId, targetDistance) {
    console.log(`Backend: Searching (DFS) for diverse outward walks near ${targetDistance}m from node ${startNodeId}`);
    const startTime = Date.now();
    
    // Store the single best route found ending in each quadrant (0:NE, 1:SE, 2:SW, 3:NW)
    const bestRouteInQuadrant = {
        0: { route: null, cost: Infinity },
        1: { route: null, cost: Infinity },
        2: { route: null, cost: Infinity },
        3: { route: null, cost: Infinity },
    };
    let routesChecked = 0;
    const startNodeCoords = nodes[startNodeId];

    if (!startNodeCoords) {
        console.error(`Backend: Cannot find coordinates for start node ${startNodeId}. Aborting DFS.`);
        return [];
    }

    const stack = []; 
    if (graph[startNodeId]) {
        stack.push({ 
            nodeId: startNodeId, path: [startNodeId], segments: [], 
            currentLength: 0, currentCost: 0, 
            visited: new Set([startNodeId])
        });
    } else {
        console.error(`Backend: Start node ${startNodeId} not found in graph for DFS.`);
        return []; 
    }

    let iterations = 0;
    const tolerance = targetDistance * 0.2; 
    const lowerBound = targetDistance - tolerance;
    const upperBound = targetDistance + tolerance;

    // Helper to get quadrant from bearing
    const getQuadrant = (bearing) => {
        if (bearing === null || bearing === undefined) return -1; // Invalid
        if (bearing >= 0 && bearing < 90) return 0; // NE
        if (bearing >= 90 && bearing < 180) return 1; // SE
        if (bearing >= 180 && bearing < 270) return 2; // SW
        if (bearing >= 270 && bearing <= 360) return 3; // NW
        return -1; // Should not happen
    };

    while (stack.length > 0) {
        iterations++;
        if (iterations % 20000 === 0) { // Check slightly less often
            const elapsedTime = Date.now() - startTime;
            if (elapsedTime > ROUTE_FINDING_TIMEOUT_MS) {
                console.warn(`Backend: findWalkNearDistance DFS timed out after ${elapsedTime}ms`);
                break; 
            }
            console.log(`  DFS Iteration ${iterations}, Stack size ${stack.length}`);
        }

        const { nodeId, path, segments, currentLength, currentCost, visited } = stack.pop();

        // Check if DISTANCE is within tolerance
        if (currentLength >= lowerBound && currentLength <= upperBound) {
            routesChecked++;
            const endNodeCoords = nodes[nodeId];
            let bearing = null;
            if (endNodeCoords && !(startNodeCoords.lat === endNodeCoords.lat && startNodeCoords.lon === endNodeCoords.lon)) {
                try {
                    bearing = turf.bearing(
                        turf.point([startNodeCoords.lon, startNodeCoords.lat]),
                        turf.point([endNodeCoords.lon, endNodeCoords.lat])
                    );
                    if (bearing < 0) bearing += 360; // Normalize to 0-360
                } catch (e) {
                    console.warn(`Turf bearing calculation failed for end node ${nodeId}: ${e.message}`);
                }
            }

            const quadrant = getQuadrant(bearing);
            // console.log(`  Route found: Len ${currentLength.toFixed(0)}, Cost ${currentCost.toFixed(0)}, Bearing ${bearing?.toFixed(1)}, Quad ${quadrant}`); // Debug
            
            if (quadrant !== -1) {
                 if (currentCost < bestRouteInQuadrant[quadrant].cost) {
                     const newRoute = { 
                         length: currentLength, cost: currentCost, path: path, segments: segments 
                     };
                     bestRouteInQuadrant[quadrant] = { route: newRoute, cost: currentCost };
                     // console.log(`    -> New best for Quadrant ${quadrant}!`);
                 }
            }
        }
        
        // Pruning based on distance (keep this)
        if (currentLength > upperBound) continue; // Prune slightly tighter - if already over max tolerance, stop

        // Explore neighbors
        const neighbors = graph[nodeId] || [];
        for (const edge of neighbors) {
            const neighborId = edge.neighborId;
            if (!visited.has(neighborId)) {
                // Standard DFS push logic...
                const newLength = currentLength + edge.length;
                const newCost = currentCost + edge.cost; 
                const newPath = [...path, neighborId];
                const newSegment = { 
                    geometry: edge.geometry, length: edge.length, cost: edge.cost, 
                    wayId: edge.wayId, wayName: edge.wayName, highwayTag: edge.highwayTag,
                    startNodeId: nodeId, endNodeId: neighborId 
                };
                const newSegments = [...segments, newSegment];
                const newVisited = new Set(visited); 
                newVisited.add(neighborId);
                stack.push({
                    nodeId: neighborId, path: newPath, segments: newSegments,
                    currentLength: newLength, currentCost: newCost, 
                    visited: newVisited
                });
            }
        }
    } // End while loop

    // Collect the best routes from each quadrant
    const finalRoutes = [];
    for (let quad = 0; quad < 4; quad++) {
        if (bestRouteInQuadrant[quad].route) {
            finalRoutes.push(bestRouteInQuadrant[quad].route);
        }
    }

    console.log(`Backend: DFS finished. Checked ${routesChecked} routes within tolerance. Returning ${finalRoutes.length} best routes (one per quadrant).`);
    
    // Sort final routes by cost before returning (optional, but good practice)
    finalRoutes.sort((a, b) => a.cost - b.cost);
    
    return finalRoutes; 
}

async function findShortestPathAStar(graph, nodes, startNodeId, endNodeId, outwardSegments = null) {
    console.log(`Backend: Starting A* path (cost-based, penalty=${outwardSegments ? 'yes' : 'no'}) from ${startNodeId} to ${endNodeId}`);
    const startTime = Date.now();
    const PENALTY_FACTOR = 100.0; // Increased Penalty Factor

    if (!graph || !nodes || !startNodeId || !endNodeId || !graph[startNodeId] || !nodes[endNodeId]) {
         console.error("Backend: findShortestPathAStar called with invalid parameters!");
        return null;
    }

    // --- Create a set of outward edges for quick lookup --- 
    const outwardEdgeSet = new Set();
    if (outwardSegments) {
        console.log(`Backend: A* applying penalty using ${outwardSegments.length} outward segments.`);
        outwardSegments.forEach(segment => {
            // Need to get node IDs from segment geometry
            // Assuming segment.geometry = [[lon1, lat1], [lon2, lat2]]
            // Find the node IDs corresponding to these coords (requires nodes lookup)
            // This is inefficient - ideally graph edge should contain node IDs
            // For now, we'll approximate by stringifying geometry and comparing?
            // OR - Requires edge info to be passed IN segments. Let's assume segments
            // now contain { ..., startNodeId: id1, endNodeId: id2 } ?
            // Let's assume segments have node path info from findWalkNearDistance path
            // outwardSegments is Array<{ geometry, length, cost, wayId, wayName, highwayTag }>
            // We need the node IDs that form this segment. The graph edge HAS this info.
            // Let's require the segments passed in to include node IDs.
            if (segment.startNodeId !== undefined && segment.endNodeId !== undefined) {
                 const u = Math.min(segment.startNodeId, segment.endNodeId);
                 const v = Math.max(segment.startNodeId, segment.endNodeId);
                 outwardEdgeSet.add(`${u}_${v}`);
            } else {
                // Fallback or warning needed if node IDs aren't on segments
                 console.warn("Segment missing node IDs for penalty calculation");
            }
        });
         console.log(`Backend: Outward edge set size: ${outwardEdgeSet.size}`);
    }

    const openSet = []; 
    const cameFrom = {}; 
    const gScore = {}; 

    Object.keys(graph).forEach(nodeId => { gScore[parseInt(nodeId)] = Infinity; });
    gScore[startNodeId] = 0;

    const endNodeData = nodes[endNodeId];
    const endPoint = turf.point([endNodeData.lon, endNodeData.lat]);
    const heuristic = (nodeId) => {
        const nodeData = nodes[nodeId];
        if (!nodeData) return Infinity; 
        const nodePoint = turf.point([nodeData.lon, nodeData.lat]);
        return turf.distance(nodePoint, endPoint, { units: 'meters' }); 
    };

    openSet.push({ nodeId: startNodeId, f: heuristic(startNodeId) });

    let iterations = 0;
    while (openSet.length > 0) {
        iterations++;
        if (iterations % 5000 === 0) {
            const elapsedTime = Date.now() - startTime;
            if (elapsedTime > ROUTE_FINDING_TIMEOUT_MS) {
                console.warn(`Backend: A* shortest path search timed out after ${elapsedTime}ms`);
                return null; 
            }
        }

        const current = openSet.shift(); 
        const u = current.nodeId;

        if (u === endNodeId) {
            console.log(`Backend: A* found path to ${endNodeId} in ${iterations} iterations.`);
            // Reconstruct path
            const segments = [];
            const pathNodes = [];
            let curr = endNodeId;
            let totalLength = 0; // Calculate length separately during reconstruction
            while (cameFrom[curr]) {
                pathNodes.push(curr);
                const predInfo = cameFrom[curr];
                segments.push(predInfo.segment); 
                totalLength += predInfo.segment.length; // Sum length
                curr = predInfo.fromNode;
            }
            pathNodes.push(startNodeId); 
            segments.reverse(); 
            pathNodes.reverse();
            console.log(`Backend: Reconstructed A* path: Segments=${segments.length}, Length=${totalLength.toFixed(0)}m, Cost=${gScore[endNodeId].toFixed(0)}`);
            return { 
                length: totalLength, // Return actual length
                cost: gScore[endNodeId], // Return calculated cost
                segments: segments, 
                path: pathNodes 
            };
        }

        const neighbors = graph[u] || [];
        for (const edge of neighbors) {
            const v = edge.neighborId;
            let edgeCostForSearch = edge.cost; // Start with actual cost

            // Apply penalty if this edge was on the outward path
            if (outwardSegments) {
                const nodeU = Math.min(u, v);
                const nodeV = Math.max(u, v);
                const edgeId = `${nodeU}_${nodeV}`;
                if (outwardEdgeSet.has(edgeId)) {
                    edgeCostForSearch *= PENALTY_FACTOR;
                    // console.log(`Penalizing edge ${edgeId}`); // Debug logging
                }
            }

            // Use the potentially penalized cost for G score calculation
            const tentativeGScore = gScore[u] + edgeCostForSearch; 

            if (tentativeGScore < gScore[v]) {
                // Store the original edge info (with original cost) in cameFrom
                cameFrom[v] = { 
                    fromNode: u, 
                    segment: { 
                        geometry: edge.geometry, length: edge.length, cost: edge.cost, // Store ACTUAL cost 
                        wayId: edge.wayId, wayName: edge.wayName, highwayTag: edge.highwayTag,
                        startNodeId: u, endNodeId: v // Store node IDs for penalty check later
                    } 
                };
                gScore[v] = tentativeGScore; // Store the gScore (potentially penalized)
                const fScore = tentativeGScore + heuristic(v);
                
                // Update priority queue
                const existingIndex = openSet.findIndex(item => item.nodeId === v);
                const newState = { nodeId: v, f: fScore };
                if (existingIndex === -1) {
                    const index = findSortedIndex(openSet, newState); 
                    openSet.splice(index, 0, newState);
                } else if (fScore < openSet[existingIndex].f) { 
                    openSet.splice(existingIndex, 1); 
                    const index = findSortedIndex(openSet, newState);
                    openSet.splice(index, 0, newState); 
                }
            }
        }
    }

    console.log(`Backend: A* failed to find a path from ${startNodeId} to ${endNodeId}.`);
    return null; 
}


// --- Export functions needed by server.js ---
module.exports = {
    lookupPostcodeCoords,
    fetchOsmDataInBbox,
    processOsmData,
    findWalkNearDistance,
    findShortestPathAStar,
    calculateInitialBearing
}; 