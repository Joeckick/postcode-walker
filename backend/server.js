const path = require('path'); // Import path module FIRST
require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); // Load .env from parent directory

const express = require('express');
const cors = require('cors');
const PDFDocument = require('pdfkit'); // Import pdfkit
const fs = require('fs'); // File system module (optional, for saving to file)
// const path = require('path'); // Moved up
// Import routing functions
const routing = require('./routing'); 
const turf = require('@turf/turf'); // Make sure turf is available here too
const { GoogleGenerativeAI } = require("@google/generative-ai"); // Gemini Client

// --- Gemini API Key Setup ---
const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error("ERROR: GOOGLE_API_KEY not found in environment variables. Did you create a .env file?");
  process.exit(1); // Exit if key is missing
}
const genAI = new GoogleGenerativeAI(apiKey);
// --- End Gemini API Key Setup ---

// You can now get the model when needed, e.g., inside route handlers:
// const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- Constants ---
const CACHE_DURATION_MS = 60 * 60 * 1000; // 1 hour cache for graph data
const MAX_ROUTES_TO_RETURN = 3;
const MIN_BEARING_DIFF = 75; // No longer used
const OVERLAP_THRESHOLD = 30.0; // Relaxed overlap threshold further
const LENGTH_TOLERANCE = 0.40; // +/- 40%

// --- Cost Maps ---
const preferredCosts = {
    'path': 1.0, 'footway': 1.0, 'pedestrian': 1.0,
    'track': 1.1, 'bridleway': 1.1,
    'cycleway': 1.2,
    'living_street': 1.5,
    'residential': 1.8, // Higher cost
    'service': 2.0,
    'unclassified': 1.8,
    'tertiary': 2.5,    // Higher cost
    default: 1.8
};

const relaxedCosts = {
    'path': 1.0, 'footway': 1.0, 'pedestrian': 1.0,
    'track': 1.1, 'bridleway': 1.1,
    'cycleway': 1.2,
    'living_street': 1.3, // Lower cost
    'residential': 1.4, // Lower cost
    'service': 1.8,     // Lower cost
    'unclassified': 1.6,
    'tertiary': 2.0,    // Lower cost
    default: 1.6
};

// --- In-memory cache for graph data ---
const graphCache = new Map();

// --- Helper: Define costs per meter for different highway types ---
// Lower values are preferred.
const highwayCosts = {
    // Highly preferred
    'path': 1.0,
    'footway': 1.0,
    'pedestrian': 1.0,
    'track': 1.2, // Slightly less preferred than dedicated paths
    'cycleway': 1.2, // Often shared or parallel to roads
    // Acceptable
    'living_street': 1.5,
    'residential': 1.5,
    'service': 2.0, // Often back alleys, access roads - less pleasant
    'unclassified': 1.8,
    // Less preferred (maybe avoid if possible later?)
    'tertiary': 2.5, 
    // 'primary': 5.0, // Example: Heavily penalize major roads
    // 'secondary': 4.0,
    default: 1.8 // Default cost for unknown/other types included in query
};

// Helper Function to Select Diverse Routes (Based on segment overlap)
const selectDiverseRoutes = (candidateRoutes, nodes) => {
    if (!candidateRoutes || candidateRoutes.length === 0) return [];
    candidateRoutes.sort((a, b) => a.cost - b.cost);
    if (candidateRoutes.length <= 1) return candidateRoutes;
    
    const diverseRoutes = [];
    const selectedRouteSegmentSets = [];
    const getSegmentEdgeId = (segment) => {
        if (segment.startNodeId === undefined || segment.endNodeId === undefined) {
             console.error("CRITICAL: Segment missing startNodeId/endNodeId for overlap check!"); return null;
        }
        const u = Math.min(segment.startNodeId, segment.endNodeId);
        const v = Math.max(segment.startNodeId, segment.endNodeId);
        return `${u}_${v}`;
    };

    console.log(`Selecting diverse set from ${candidateRoutes.length} candidates (Max ${OVERLAP_THRESHOLD}% segment overlap)...`);
    const firstRoute = candidateRoutes[0];
    diverseRoutes.push(firstRoute);
    const firstRouteSegments = new Set();
    firstRoute.segments.forEach(seg => {
        const edgeId = getSegmentEdgeId(seg);
        if (edgeId) firstRouteSegments.add(edgeId);
    });
    selectedRouteSegmentSets.push(firstRouteSegments);
    console.log(` -> Selected route 1 (cost ${firstRoute.cost.toFixed(0)}), segments: ${firstRouteSegments.size}`);

    // Iterate through remaining candidates
    for (let i = 1; i < candidateRoutes.length && diverseRoutes.length < MAX_ROUTES_TO_RETURN; i++) {
        const candidate = candidateRoutes[i];
        console.log(`-- Evaluating Candidate ${i+1} (Cost: ${candidate.cost.toFixed(0)}) --`); // LOGGING
        const candidateSegments = new Set();
        candidate.segments.forEach(seg => {
            const edgeId = getSegmentEdgeId(seg);
            if (edgeId) candidateSegments.add(edgeId);
        });

        if (candidateSegments.size === 0) {
            console.log(`   Skipping candidate ${i+1} due to missing segment data.`);
            continue;
        }

        let isDiverseEnough = true; // Assume diverse initially
        // Compare candidate against ALL previously selected routes
        for (let j = 0; j < selectedRouteSegmentSets.length; j++) {
            console.log(`   Comparing Candidate ${i+1} against Selected Route ${j+1}`); // LOGGING
            const selectedSegments = selectedRouteSegmentSets[j];
            let overlapCount = 0;
            for (const candidateEdgeId of candidateSegments) {
                if (selectedSegments.has(candidateEdgeId)) {
                    overlapCount++;
                }
            }
            const overlapPercent = (candidateSegments.size > 0) ? (overlapCount / candidateSegments.size) * 100 : 0;
            
            // DETAILED LOGGING for comparison
            console.log(`     Overlap Count: ${overlapCount}, Candidate Segments: ${candidateSegments.size}`);
            console.log(`     Calculated Overlap: ${overlapPercent.toFixed(3)}%, Threshold: ${OVERLAP_THRESHOLD}%`);
            
            if (overlapPercent > OVERLAP_THRESHOLD) {
                console.log(`     REJECTED: Overlap ${overlapPercent.toFixed(3)}% > ${OVERLAP_THRESHOLD}%`); // LOGGING
                isDiverseEnough = false;
                break; // Stop checking this candidate against others
            } else {
                console.log(`     Overlap OK: ${overlapPercent.toFixed(3)}% <= ${OVERLAP_THRESHOLD}%`); // LOGGING
            }
        }
        
        // LOGGING final decision for this candidate
        console.log(`   Final decision for Candidate ${i+1}: isDiverseEnough = ${isDiverseEnough}`);
        
        if (isDiverseEnough) {
            console.log(` -> SELECTED route ${diverseRoutes.length + 1} (Candidate ${i+1}, Cost ${candidate.cost.toFixed(0)}), segments: ${candidateSegments.size}`);
            diverseRoutes.push(candidate);
            selectedRouteSegmentSets.push(candidateSegments);
        }
    }

    console.log(`Returning ${diverseRoutes.length} selected diverse routes based on segment overlap.`);
    return diverseRoutes;
};

// --- Helper Function: Find Round Trip Routes (encapsulates the core logic) ---
async function findRoundTripSet(startNodeId, graph, nodes, desiredDistanceMeters, runIdentifier) {
    console.log(`--- [${runIdentifier}] Finding Round Trips ---`);
    const outwardTargetDistance = desiredDistanceMeters / 2;
    
    // 1. Find diverse outward paths (Quadrant based)
    console.log(`[${runIdentifier}] Finding diverse outward paths near ${outwardTargetDistance}m`);
    const diverseOutwardPaths = await routing.findWalkNearDistance(graph, nodes, startNodeId, outwardTargetDistance);
    console.log(`[${runIdentifier}] Found ${diverseOutwardPaths.length} quadrant-diverse outward paths.`);
    if (diverseOutwardPaths.length === 0) return []; // No routes found in this run

    // 2. Generate Combined Routes
    console.log(`[${runIdentifier}] Generating combined routes for ${diverseOutwardPaths.length} diverse outward paths...`);
    const combinedRoutes = [];
    for (let i = 0; i < diverseOutwardPaths.length; i++) {
        const outwardRoute = diverseOutwardPaths[i];
        const endNodeId = outwardRoute.path[outwardRoute.path.length - 1];
        // console.log(`[${runIdentifier}] Finding return path for outward route ${i+1}/${diverseOutwardPaths.length}`);
        const returnRoute = await routing.findShortestPathAStar(graph, nodes, endNodeId, startNodeId, outwardRoute.segments);
        if (returnRoute && returnRoute.path.length > 0) {
            const combinedPath = [...outwardRoute.path, ...returnRoute.path.slice(1)];
            const combinedSegments = [...outwardRoute.segments, ...returnRoute.segments];
            const combinedLength = outwardRoute.length + returnRoute.length;
            const combinedCost = outwardRoute.cost + returnRoute.cost;
            combinedRoutes.push({ length: combinedLength, cost: combinedCost, path: combinedPath, segments: combinedSegments });
            // console.log(`  -> [${runIdentifier}] Combined route generated: Length ${combinedLength.toFixed(0)}m, Cost ${combinedCost.toFixed(0)}`);
        } else {
             console.log(`[${runIdentifier}] No return path found for diverse outward route ${i+1}.`);
        }
    }
    console.log(`[${runIdentifier}] Generated ${combinedRoutes.length} combined routes.`);
    return combinedRoutes; 
}

// --- Helper Function: Parse LLM response to get 3 concepts ---
// TODO: Implement robust parsing based on actual LLM output format
function parseLlmConcepts(llmText) {
    console.log("Parsing LLM response...");
    const concepts = [];
    // Split the response into potential concept blocks based on lines starting with "1.", "2.", etc.
    // Allow for potential markdown formatting around the number.
    // Look for DOUBLE newlines between concepts, allowing whitespace around them.
    const blocks = llmText.split(/\s*\n\s*\n\s*(?=\*?\d+\.\s)/).map(block => block.trim());

    for (const block of blocks) {
        if (!block) continue;

        // Attempt to extract name and description using regex that captures title up to first colon
        // Use the block directly as it seems to be a single line from the split
        const match = block.match(/^\\*?(\d+)\.\s+(.*?):\s*(.*)/s); 
        // console.log("   DEBUG: Regex match result:", match); // Keep commented out for now
        
        if (match) {
            // Extract name from group 2 (non-greedy capture up to colon)
            const name = match[2].trim(); 
            // Description is group 3
            const description = match[3].trim(); 

            console.log(`   Parsed Concept: Name="${name}", Desc="${description.substring(0, 50)}..."`); // Log successful parse
            concepts.push({ name, description });
        } else {
            // Fallback if regex doesn't match expected "1. **Name:** Description" format
             console.warn(`Could not parse concept block using regex. Block content: "${block.substring(0, 80)}..."`);
             // As a fallback, let's just take the whole block as description and generate a name
             concepts.push({ name: `Unparsed Concept ${concepts.length + 1}`, description: block });
        }
    }

    console.log(`Parsed ${concepts.length} concepts from LLM response.`);

    // Ensure we always return up to 3 concepts, even if parsing is imperfect
    while (concepts.length < 3) {
        concepts.push({ name: `Concept ${concepts.length + 1} (Parsing Failed)`, description: '' });
    }
    // Slice to ensure exactly 3 concepts if more were somehow parsed
    return concepts.slice(0, 3);
}

// --- Helper Function: Attempt to validate a single LLM concept (Simplified Version) ---
async function validateLlmConcept(concept, startNodeId, graph, nodes, desiredDistanceMeters, minLength, maxLength) {
    console.log(`Attempting to validate concept: "${concept.name}"`);

    // 1. Improved Feature Extraction: Find potential landmarks
    console.log("   DEBUG: Input description:", JSON.stringify(concept.description));
    let targetLocationName = null;

    // Expanded list of common words/verbs unlikely to be specific landmarks
    const excludedWords = new Set([
        "Starting", "Beginning", "Explore", "Head", "This", "Return", "Continue", "Via",
        "Past", "Enjoy", "Discover", "Escape", "Walk", "Stroll", "Ramble", "Meander",
        "Take", "Pass", "Passing", "Leads", "Offers", "Showcasing", "Incorporates",
        "Features", "Provides", "You'll", "Weaves", "Winds", "Expect", "See", "Admiring",
        "Soaking", "London", "UK", "Area", "City", "Side", "Part", "Route", "Way",
        "Path", "Atmosphere", "Vibes", "Views", "Glimpse", "Activity", "Scenery",
        "North", "South", "East", "West", "Central", "Towards", "Near", "Around",
        "Before", "After", "Then", "Next", "Also", "Along", "Back", "Through", "With",
        "From", "Just", "Iconic", "Grand", "Impressive", "Historic", "Historical",
        "Charming", "Pretty", "Quiet", "Quieter", "Elegant", "Upscale", "Majestic",
        "Different", "Unique", "Local", "Scenic", "Refreshing", "Vibrant", "Gothic",
        "Magnificence", "Picturesque", "Open", "Mature", "Green", "Tranquil", "Regal",
        "Residential", "Various", "Notable", "Famous", "Well-Known", "Known", "Key",
        "Includes", "Involves", "Behind", "Like", "It"
        // Add more as needed
    ]);

    // Keywords indicating a likely place name
    const placeKeywords = new Set([
        "Park", "Street", "Road", "Avenue", "Lane", "Mews", "Place", "Square", "Gardens",
        "Abbey", "Church", "Cathedral", "Palace", "Castle", "House", "Hall",
        "Bridge", "Embankment", "Wharf", "Dock", "Canal", "River", "Thames",
        "Museum", "Gallery", "Library", "Theatre", "Cinema",
        "Station", "Market", "Centre", "Building", "Tower", "Gate", "Circus",
        "Common", "Green", "Heath", "Fields", "Wood", "Observatory", "Parade",
        "Hospital", "School", "University", "College", "Embassy"
        // Add more specific London terms if relevant (e.g., specific park names unlikely to be verbs)
    ]);

    // Regex to find sequences of capitalized words (incl. possessives, hyphens)
    const landmarkRegex = /\b[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)*\b/g;
    let potentialLandmarks = concept.description.match(landmarkRegex);
    console.log(`   DEBUG: Raw potential landmarks:`, potentialLandmarks);

    let bestCandidate = null;
    let maxPriority = -1; // 0: Single word, 1: Multi-word, 2: Keyword match

    if (potentialLandmarks) {
        potentialLandmarks = potentialLandmarks.filter(p => p.length > 1 && !excludedWords.has(p)); // Basic filtering
        console.log(`   DEBUG: Filtered potential landmarks:`, potentialLandmarks);

        for (const candidate of potentialLandmarks) {
            let currentPriority = 0;
            const words = candidate.split(' ');

            if (words.length > 1) {
                currentPriority = 1; // Prioritize multi-word
            }

            // Check if any word in the candidate (or the whole candidate) is a keyword
            if (words.some(word => placeKeywords.has(word)) || placeKeywords.has(candidate)) {
                 currentPriority = 2; // Highest priority for keyword match
            }

            // If this candidate is better than the current best, update
            if (currentPriority > maxPriority) {
                maxPriority = currentPriority;
                bestCandidate = candidate;
            }
            // Optional: If priorities are equal, maybe prefer longer names? Or first encountered?
            // Sticking with first-best for now.
        }
    }

    targetLocationName = bestCandidate; // Assign the best one found

    if (targetLocationName) {
        console.log(`   Selected landmark: "${targetLocationName}" (Priority: ${maxPriority})`);
    } else {
        console.log(`   No usable landmarks found after filtering and prioritization.`);
        return null; // Cannot proceed without a landmark
    }

    // 2. Geocode Landmark & Find Nearest Graph Node
    let waypointNodeId = null;
    try {
        console.log(`   Attempting to geocode landmark: ${targetLocationName}`);
        
        // --- Geocoding using Nominatim --- 
        const geocodeQuery = encodeURIComponent(targetLocationName + ", London, UK"); // Add context
        // IMPORTANT: Add a valid User-Agent header for Nominatim
        const nominatimUrl = `https://nominatim.openstreetmap.org/search?q=${geocodeQuery}&format=json&limit=1`;
        console.log(`   Nominatim URL: ${nominatimUrl}`);
        const geoResponse = await fetch(nominatimUrl, {
            headers: { 'User-Agent': 'PostcodeWalker/1.0 (github.com/your-repo/postcode-walker; contact@example.com)' } // Replace with real info
        });

        if (!geoResponse.ok) {
            throw new Error(`Nominatim API request failed: ${geoResponse.statusText}`);
        }
        const geoResults = await geoResponse.json();

        if (!geoResults || geoResults.length === 0 || !geoResults[0].lat || !geoResults[0].lon) {
            console.warn(`   Geocoding failed for "${targetLocationName}" or returned no coordinates.`);
            return null; // Cannot proceed without coordinates
        }

        const landmarkLat = parseFloat(geoResults[0].lat);
        const landmarkLon = parseFloat(geoResults[0].lon);
        console.log(`   Geocoded "${targetLocationName}" to: Lat ${landmarkLat.toFixed(5)}, Lon ${landmarkLon.toFixed(5)}`);
        const landmarkPoint = turf.point([landmarkLon, landmarkLat]); // Turf uses [lon, lat]

        // --- Find Nearest Node --- 
        let minDistance = Infinity;
        let nearestNodeId = null;

        for (const nodeId in nodes) {
            // Avoid comparing the start node itself as the waypoint, unless it's the only option
            if (nodeId === String(startNodeId)) continue; 
            
            const node = nodes[nodeId];
            if (!node || typeof node.lat !== 'number' || typeof node.lon !== 'number') {
                // console.warn(`   Skipping node ${nodeId} due to missing coordinates.`);
                continue;
            }
            const nodePoint = turf.point([node.lon, node.lat]);
            const distance = turf.distance(landmarkPoint, nodePoint, { units: 'meters' });

            if (distance < minDistance) {
                minDistance = distance;
                nearestNodeId = nodeId;
            }
        }

        if (nearestNodeId) {
            console.log(`   Nearest node found: ${nearestNodeId} (Distance: ${minDistance.toFixed(1)}m)`);
            waypointNodeId = nearestNodeId;
        } else {
            console.warn(`   Could not find any suitable nearest node for landmark "${targetLocationName}".`);
            return null; // Cannot proceed
        }
        // --- End Geocoding & Nearest Node --- 

    } catch (geoError) {
        console.error(`   Error during geocoding/nearest node finding for "${targetLocationName}":`, geoError);
        return null; // Cannot proceed
    }

    // Ensure waypointNodeId was actually found before routing
    if (!waypointNodeId) {
        console.log(`   No valid waypointNodeId found after geocoding/nearest node search.`);
        return null;
    }

    // --- NEW Strategy: Use Directed DFS for Outward Path --- 
    try {
        // Calculate bearing from start to waypoint
        const startNodeCoords = nodes[startNodeId];
        const waypointCoords = nodes[waypointNodeId]; 
        if (!startNodeCoords || !waypointCoords) {
            console.error(`   Cannot get coordinates for bearing calculation (Start: ${!!startNodeCoords}, Waypoint: ${!!waypointCoords})`);
            return null;
        }
        let targetBearing = null;
        try {
            targetBearing = turf.bearing(
                turf.point([startNodeCoords.lon, startNodeCoords.lat]),
                turf.point([waypointCoords.lon, waypointCoords.lat])
            );
            if (targetBearing < 0) targetBearing += 360;
            console.log(`   Calculated bearing to waypoint: ${targetBearing.toFixed(1)}°`);
        } catch (bearingError) {
            console.error(`   Error calculating bearing: ${bearingError.message}`);
            return null; // Cannot proceed without a bearing
        }
        
        // Path 1: Find walk towards bearing, aiming for half distance
        const halfDesired = desiredDistanceMeters / 2;
        const outwardRoute = await routing.findDirectedWalkNearDistance(
            graph, nodes, startNodeId, 
            halfDesired, // Target distance for this DFS run
            targetBearing // Target direction
            // Default bearing tolerance (e.g., 45 degrees) is used within the function
        );

        if (!outwardRoute) {
            console.log(`   Failed to find outward route towards bearing ${targetBearing.toFixed(1)}° near ${halfDesired.toFixed(0)}m.`);
            return null;
        }
        console.log(`   Found directed outward path: Length ${outwardRoute.length.toFixed(0)}m`);
        
        // Determine the actual end node of the outward path
        const actualEndNodeId = outwardRoute.path[outwardRoute.path.length - 1];
        console.log(`   Actual end node: ${actualEndNodeId}`);

        console.log(`   Routing return path: ${actualEndNodeId} -> ${startNodeId}`);
        // Path 2: Route back from the actual end node using A*
        const returnRoute = await routing.findShortestPathAStar(
            graph, nodes, 
            actualEndNodeId, // Route back from where the directed walk ended
            startNodeId, 
            outwardRoute.segments // Pass outward segments for penalty
        ); 

         if (!returnRoute || returnRoute.path.length <= 1) { 
             console.log(`   Failed to route back from directed path end node ${actualEndNodeId} to start ${startNodeId}.`);
             return null;
         }
         console.log(`   Found return path: Length ${returnRoute.length.toFixed(0)}m`);

        // Combine
        const combinedPath = [...outwardRoute.path, ...returnRoute.path.slice(1)]; 
        const combinedSegments = [...outwardRoute.segments, ...returnRoute.segments];
        const combinedLength = outwardRoute.length + returnRoute.length;
        const combinedCost = outwardRoute.cost + returnRoute.cost; 

         console.log(`   Combined route length: ${combinedLength.toFixed(0)}m`);

        // Check FINAL Length against the original full distance tolerance
        if (combinedLength >= minLength && combinedLength <= maxLength) {
            console.log(`   --> Concept "${concept.name}" validated! Length: ${combinedLength.toFixed(0)}m`);
            return {
                length: combinedLength,
                cost: combinedCost,
                path: combinedPath,
                segments: combinedSegments,
                llmConceptName: concept.name, 
                llmConceptDescription: concept.description
            };
        } else {
            console.log(`   --> Concept "${concept.name}" failed FINAL length validation. Length ${combinedLength.toFixed(0)}m not in [${minLength.toFixed(0)}m - ${maxLength.toFixed(0)}m]`);
            return null;
        }

    } catch (routingError) {
         console.log(`   Routing error during directed validation: ${routingError.message}`);
         return null;
    }
}

// --- Helper Function: Generate fallback routes (using original logic) ---
async function generateFallbackRoutes(count, existingRoutes, graphData, desiredDistanceMeters, minLength, maxLength, walkType) {
    console.log(`Generating ${count} fallback routes using original algorithm...`);
    const fallbackCandidates = [];
    let baseGraphData = graphData; // Use preferred graph by default

    // Option 1: Use original Run 1 + Run 2 combined logic if available (complex to refactor here)
    // Option 2: Simpler - just run findRoundTripSet/findWalkNearDistance again

    if (walkType === 'round_trip') {
        // Try preferred costs first
        let candidates = await findRoundTripSet(baseGraphData.startNodeId, baseGraphData.graph, baseGraphData.nodes, desiredDistanceMeters, "Fallback-Pref");
        fallbackCandidates.push(...candidates);
        // If still not enough potential candidates, try relaxed (need to re-process graph)
        // For simplicity, we might skip the relaxed run in fallback or assume graphData contains combined results

    } else { // one_way
        let candidates = await routing.findWalkNearDistance(baseGraphData.graph, baseGraphData.nodes, baseGraphData.startNodeId, desiredDistanceMeters);
        fallbackCandidates.push(...candidates);
    }

    // Filter and select diverse fallbacks
    fallbackCandidates.sort((a, b) => a.cost - b.cost); // Sort by cost

    const finalFallbacks = [];
    const existingRouteIds = new Set(existingRoutes.map(r => r.path.join('-'))); // Avoid duplicates
    const selectedFallbackSegmentSets = existingRoutes.map(r => { // Include existing for diversity check
        const segments = new Set();
        r.segments.forEach(seg => {
            const u = Math.min(seg.startNodeId, seg.endNodeId);
            const v = Math.max(seg.startNodeId, seg.endNodeId);
            segments.add(`${u}_${v}`);
        });
        return segments;
    });

    for (const candidate of fallbackCandidates) {
        if (finalFallbacks.length >= count) break;
        const routeId = candidate.path.join('-');
        if (existingRouteIds.has(routeId)) continue; // Skip exact duplicates

        // Check length
        if (candidate.length >= minLength && candidate.length <= maxLength) {
            // Check diversity against already selected routes (validated LLM + previous fallbacks)
            let isDiverseEnough = true;
            const candidateSegments = new Set();
            candidate.segments.forEach(seg => {
                 const u = Math.min(seg.startNodeId, seg.endNodeId);
                 const v = Math.max(seg.startNodeId, seg.endNodeId);
                 candidateSegments.add(`${u}_${v}`);
            });
             if (candidateSegments.size === 0) continue;

            for (const selectedSegments of selectedFallbackSegmentSets) {
                let overlapCount = 0;
                for (const edgeId of candidateSegments) {
                    if (selectedSegments.has(edgeId)) overlapCount++;
                }
                const overlapPercent = (overlapCount / candidateSegments.size) * 100;
                if (overlapPercent > OVERLAP_THRESHOLD) { // Use same overlap threshold
                    isDiverseEnough = false;
                    break;
                }
            }

            if (isDiverseEnough) {
                console.log(` -> Fallback Adding: Route Cost ${candidate.cost.toFixed(0)}, Length ${candidate.length.toFixed(0)}m`);
                finalFallbacks.push(candidate);
                selectedFallbackSegmentSets.push(candidateSegments);
                existingRouteIds.add(routeId); // Add to prevent re-selection
            }
        }
    }
    
    // If still not enough after diversity check, take closest length regardless of overlap
    if (finalFallbacks.length < count) {
        console.log(`Fallback diversity check insufficient (${finalFallbacks.length}/${count}), adding closest length...`);
        const remainingNeeded = count - finalFallbacks.length;
        const remainingCandidates = fallbackCandidates.filter(candidate => !existingRouteIds.has(candidate.path.join('-')));
        remainingCandidates.sort((a, b) => Math.abs(a.length - desiredDistanceMeters) - Math.abs(b.length - desiredDistanceMeters));
        for(let i = 0; i < remainingNeeded && i < remainingCandidates.length; i++) {
             const candidate = remainingCandidates[i];
             console.log(` -> Fallback Adding (Closest Length): Route Cost ${candidate.cost.toFixed(0)}, Length ${candidate.length.toFixed(0)}m`);
             finalFallbacks.push(candidate);
        }
    }

    console.log(`Generated ${finalFallbacks.length} fallback routes.`);
    return finalFallbacks;
}

// --- Main API Endpoint: Find Routes --- 
app.post('/api/find-routes', async (req, res) => {
    console.log("Backend: Received POST request on /api/find-routes (LLM First)");
    const { startPostcode, desiredDistanceKm, walkType } = req.body;
    
    // --- Input Validation ---
    if (!startPostcode || typeof desiredDistanceKm !== 'number' || desiredDistanceKm <= 0 || !walkType) {
        return res.status(400).json({ success: false, message: "Missing or invalid input parameters." });
    }
    const desiredDistanceMeters = desiredDistanceKm * 1000;
    const finalMinLength = desiredDistanceMeters * (1 - LENGTH_TOLERANCE);
    const finalMaxLength = desiredDistanceMeters * (1 + LENGTH_TOLERANCE);
    let finalFoundRoutes = [];
    let allNodes = {};
    let graphData = null; // Will hold processed graph data

    try {
        console.log(`Finding routes for ${startPostcode}, ${desiredDistanceKm}km, ${walkType} using LLM First approach.`);
        // --- Geocode, BBox, Fetch OSM Data (Same as before) --- 
        const startCoords = await routing.lookupPostcodeCoords(startPostcode);
        const bufferFactor = 1.5; 
        const approxRadiusLat = (desiredDistanceMeters * bufferFactor) / 111000; 
        const approxRadiusLon = approxRadiusLat / Math.cos(startCoords.latitude * Math.PI / 180);
        const searchBbox = [
            startCoords.longitude - approxRadiusLon, startCoords.latitude - approxRadiusLat,
            startCoords.longitude + approxRadiusLon, startCoords.latitude + approxRadiusLat
        ];
        const osmData = await routing.fetchOsmDataInBbox(searchBbox);
        if (osmData.elements.length === 0) throw new Error("No map features found.");
        console.log(`Fetched ${osmData.elements.length} OSM elements.`);

        // --- Process Graph Data Once (e.g., with preferred costs) ---
        // We need this graph data for validation and fallback
        console.log("Processing OSM data into graph (using preferred costs)...");
        graphData = routing.processOsmData(osmData, startCoords.latitude, startCoords.longitude, preferredCosts);
        allNodes = graphData.nodes;
        const startNodeId = graphData.startNodeId;
        const graph = graphData.graph;
        if (!startNodeId) throw new Error("Could not find a starting node near the postcode.");

        // --- LLM Call for 3 Concepts ---
        console.log("DEBUG: Preparing to call LLM...");
        let llmConcepts = [];
        let llmCallAttempted = false;
        try {
            console.log("DEBUG: Entering LLM try block...");
            llmCallAttempted = true;
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" }); 
            const prompt = `
                You are suggesting walking routes for someone who has just moved to a new area.
                They want interesting and varied walks starting near the postcode ${startPostcode}.
                The desired total distance is approximately ${desiredDistanceKm} km.
                The walk type should be ${walkType === 'one_way' ? 'one way' : 'a round trip'}.

                Suggest THREE distinct walk CONCEPTS or THEMES.
                For each concept, provide:
                1. A short, appealing name/theme (e.g., "Park Explorer", "Local Shops Loop", "Canal Path Discovery").
                2. A brief text description highlighting key features, landmarks, or street types involved.
                3. Ensure the concepts are significantly different from each other.

                Do NOT provide turn-by-turn directions. Focus on the overall idea and key points of interest for each walk concept.
            `;
            
            console.log("DEBUG: Calling model.generateContent...");
            const result = await model.generateContent(prompt);
            const response = result.response;
            console.log("DEBUG: LLM response received (or not). Checking text...");

            if (response && response.text) {
                console.log("DEBUG: LLM response has text. Parsing concepts...");
                llmConcepts = parseLlmConcepts(response.text());
            } else {
                console.warn("LLM did not return text. Proceeding with fallback.");
                 // Trigger fallback immediately if LLM fails
                 finalFoundRoutes = await generateFallbackRoutes(MAX_ROUTES_TO_RETURN, [], graphData, desiredDistanceMeters, finalMinLength, finalMaxLength, walkType);
                 if (finalFoundRoutes.length < MAX_ROUTES_TO_RETURN) {
                      throw new Error(`Failed to generate sufficient routes even with fallback.`);
                 }
            }
        } catch (llmError) {
            console.error("Error calling Gemini API:", llmError);
            console.warn("LLM call failed. Proceeding with fallback.");
             // Trigger fallback immediately if LLM fails
             finalFoundRoutes = await generateFallbackRoutes(MAX_ROUTES_TO_RETURN, [], graphData, desiredDistanceMeters, finalMinLength, finalMaxLength, walkType);
             if (finalFoundRoutes.length < MAX_ROUTES_TO_RETURN) {
                  throw new Error(`Failed to generate sufficient routes even with fallback.`);
             }
        }
        console.log(`DEBUG: LLM try/catch block finished. llmCallAttempted=${llmCallAttempted}, llmConcepts.length=${llmConcepts.length}, finalFoundRoutes.length=${finalFoundRoutes.length}`);

        // --- Attempt to Validate LLM Concepts (if LLM call succeeded and fallback wasn't triggered) ---
        if (llmCallAttempted && llmConcepts.length > 0 && finalFoundRoutes.length === 0) {
            console.log("Attempting validation of LLM concepts...");
            const validationPromises = llmConcepts.map(concept => 
                validateLlmConcept(concept, startNodeId, graph, allNodes, desiredDistanceMeters, finalMinLength, finalMaxLength)
            );
            const validationResults = await Promise.all(validationPromises);
            
            // Filter out null results (failed validations)
            const successfullyValidated = validationResults.filter(r => r !== null);
            console.log(`Successfully validated ${successfullyValidated.length} LLM concepts.`);
            
            // TODO: Add diversity check among validated LLM routes here?
            finalFoundRoutes.push(...successfullyValidated);
        }

        // --- Fallback if Needed ---
        const routesNeeded = MAX_ROUTES_TO_RETURN - finalFoundRoutes.length;
        if (routesNeeded > 0) {
            console.log(`Need ${routesNeeded} more routes. Calling fallback generator...`);
            const fallbackRoutes = await generateFallbackRoutes(routesNeeded, finalFoundRoutes, graphData, desiredDistanceMeters, finalMinLength, finalMaxLength, walkType);
            finalFoundRoutes.push(...fallbackRoutes);
        }

        // --- Final Output --- 
        if (finalFoundRoutes.length < MAX_ROUTES_TO_RETURN) {
             console.error(`CRITICAL: Could not fulfill request for ${MAX_ROUTES_TO_RETURN} routes. Only found ${finalFoundRoutes.length}.`);
              throw new Error(`Failed to generate the required ${MAX_ROUTES_TO_RETURN} routes.`);
        }
         // Trim if somehow we got more than needed (unlikely with current logic)
         if (finalFoundRoutes.length > MAX_ROUTES_TO_RETURN) { 
             finalFoundRoutes = finalFoundRoutes.slice(0, MAX_ROUTES_TO_RETURN);
         }
        
        console.log(`Backend: Sending ${finalFoundRoutes.length} final routes.`);

        // --- Prepare and Send Response --- 
        res.json({
            success: true,
            message: `Found ${finalFoundRoutes.length} routes.`,
            startCoords: startCoords, 
            routes: finalFoundRoutes, 
            nodes: allNodes 
        });

    } catch (error) {
        console.error("Backend: Error in /api/find-routes (LLM First):", error);
        console.error(error.stack);
        res.status(500).json({ success: false, message: error.message || "An error occurred while finding routes." });
    }
});

// --- API Endpoint: Generate PDF --- 
app.post('/api/generate-pdf', (req, res) => {
    // ... PDF generation logic ...
});

// Simple root route for testing
app.get('/', (req, res) => {
  res.send('Postcode Walker Backend is running!');
});

app.listen(port, () => {
  console.log(`Backend server listening on http://localhost:${port}`);
}); 