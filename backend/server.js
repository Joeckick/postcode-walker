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

    // 3. Waypoint Routing incorporating Target Distance
    try {
        console.log(`   Routing: Start -> Waypoint (${startNodeId} -> ${waypointNodeId})`);
        // Path 1: Start to Waypoint
        const routeToWaypoint = await routing.findShortestPathAStar(graph, nodes, startNodeId, waypointNodeId, []);
        if (!routeToWaypoint || routeToWaypoint.path.length <= 1) { 
             console.log(`   Failed to route from start ${startNodeId} to waypoint ${waypointNodeId}.`);
             return null;
        }
        console.log(`   Outward path length: ${routeToWaypoint.length.toFixed(0)}m`);

        // Check if outward path is roughly half the desired total distance
        const halfDesired = desiredDistanceMeters / 2;
        const minHalfLength = halfDesired * (1 - LENGTH_TOLERANCE); // Use same tolerance
        const maxHalfLength = halfDesired * (1 + LENGTH_TOLERANCE);

        if (routeToWaypoint.length < minHalfLength || routeToWaypoint.length > maxHalfLength) {
            console.log(`   --> Outward path length ${routeToWaypoint.length.toFixed(0)}m is outside tolerance [${minHalfLength.toFixed(0)}m - ${maxHalfLength.toFixed(0)}m] for half distance.`);
            return null; // Outward path isn't the right scale
        }

        console.log(`   Outward path OK. Routing: Waypoint -> Start (${waypointNodeId} -> ${startNodeId})`);
        // Path 2: Waypoint to Start (Pass outward segments for potential penalty/context)
        const routeFromWaypoint = await routing.findShortestPathAStar(graph, nodes, waypointNodeId, startNodeId, routeToWaypoint.segments); 
         if (!routeFromWaypoint || routeFromWaypoint.path.length <= 1) { 
             console.log(`   Failed to route from waypoint ${waypointNodeId} back to start ${startNodeId}.`);
             return null;
         }

        // Combine
        const combinedPath = [...routeToWaypoint.path, ...routeFromWaypoint.path.slice(1)]; // Avoid duplicating waypoint node
        const combinedSegments = [...routeToWaypoint.segments, ...routeFromWaypoint.segments];
        const combinedLength = routeToWaypoint.length + routeFromWaypoint.length;
        const combinedCost = routeToWaypoint.cost + routeFromWaypoint.cost; // Simple cost addition

         console.log(`   Combined route length: ${combinedLength.toFixed(0)}m`);

        // 4. Check FINAL Length (using minLength and maxLength for the *full* desired distance)
        if (combinedLength >= minLength && combinedLength <= maxLength) {
            console.log(`   --> Concept "${concept.name}" validated! Length: ${combinedLength.toFixed(0)}m`);
            // Return the combined route object
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
         console.log(`   Routing error during simple waypoint validation: ${routingError.message}`);
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

// --- API Endpoint: Find Routes (Modified for LLM First) --- 
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
    console.log("Backend: Received POST request on /api/generate-pdf");
    console.log("Request Body (summary):", {
        startPostcode: req.body.startPostcode,
        desiredDistanceKm: req.body.desiredDistanceKm,
        walkType: req.body.walkType,
        routeCount: req.body.routes?.length,
        selectedIndex: req.body.selectedIndex,
        nodesReceived: !!req.body.nodes
    });

    try {
        const routeData = req.body;
        const nodes = routeData.nodes; // Get nodes if sent (needed for future backend routing)

        // --- Basic Input Validation ---
        if (!routeData || !routeData.routes || routeData.routes.length === 0 || 
            typeof routeData.selectedIndex !== 'number' || routeData.selectedIndex < 0 || 
            routeData.selectedIndex >= routeData.routes.length) {
            console.error("Invalid or missing route data received.");
            return res.status(400).json({ success: false, message: "Invalid route data received by backend." });
        }

        const selectedRoute = routeData.routes[routeData.selectedIndex];
        const routeNumber = routeData.selectedIndex + 1;
        const safePostcode = (routeData.startPostcode || 'unknown').replace(/\W+/g, '-');
        const filename = `Postcode-Walker-Route-${routeNumber}-${safePostcode}.pdf`;

        // --- RECALCULATE Route Cost (if segment data allows) ---
        // This demonstrates how cost would be used, assuming segment data has way types
        // Ideally, the routing algorithm itself would optimize for cost.
        let calculatedCost = 0;
        let missingCostInfo = false;
        if (selectedRoute.segments) {
            selectedRoute.segments.forEach(segment => {
                // TODO: Need segment.highwayTag for this to work!
                const tag = segment.highwayTag || 'default'; // Placeholder
                const costFactor = highwayCosts[tag] || highwayCosts.default;
                calculatedCost += segment.length * costFactor;
                if (!segment.highwayTag) missingCostInfo = true;
            });
        } else {
            missingCostInfo = true;
        }
        // For now, just log it - display/use later
        if (!missingCostInfo) {
             console.log(`Recalculated route cost based on way types: ${calculatedCost.toFixed(0)}`);
        } else {
            console.warn("Cannot accurately calculate route cost - segment highway tags missing from frontend data.");
            // Fallback: estimate cost based on average factor?
            calculatedCost = selectedRoute.length * highwayCosts.default;
            console.log(`Estimated route cost (fallback): ${calculatedCost.toFixed(0)}`);
        }
        // Store it for potential display
        selectedRoute.cost = calculatedCost; 

        // --- PDF Generation using pdfkit ---
        const doc = new PDFDocument({ 
            size: 'A4', 
            margins: { top: 50, bottom: 50, left: 72, right: 72 },
            bufferPages: true // Enable page buffering for header/footer calculation
        });

        // --- Header and Footer Setup --- 
        const pageMargin = doc.page.margins.left; // Use left margin for consistency
        const pageBottom = doc.page.height - doc.page.margins.bottom;
        const headerText = `Postcode Walker Route Plan - Route ${routeNumber}`;
        
        doc.on('pageAdded', () => {
            // Page Header
            doc.page.margins.top = 50; // Re-apply margin if needed
            doc.fontSize(8).fillColor('grey')
               .text(headerText, pageMargin, doc.page.margins.top / 2, { width: doc.page.width - pageMargin * 2, align: 'center' });
            doc.moveDown(0.5); // Space below header
            // Ensure content starts below header space
            // Note: Content start position is implicitly handled by margins
        });

        // --- Set headers to prompt download ---
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        // Pipe the PDF output directly to the response stream
        doc.pipe(res);

        // --- Add Content to PDF (First Page) ---
        // Move title slightly lower to account for header space
        doc.fontSize(20).fillColor('black').text(`Route ${routeNumber}: ${routeData.startPostcode || 'Unknown Start'}`, 
            pageMargin, // Start at left margin
            doc.page.margins.top + 10, // Position below header space 
            { align: 'center' });
        doc.moveDown(2); // More space after title

        // --- At-a-Glance Section --- 
        const boxMargin = 10;
        const boxY = doc.y;
        const boxWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / 2 - boxMargin / 2;
        
        // Column 1: Basic Info
        doc.fontSize(11).fillColor('black'); 
        doc.text(`Start Postcode:`, { continued: true });
        doc.font('Helvetica-Bold').text(` ${routeData.startPostcode || 'N/A'}`);
        doc.font('Helvetica');
        doc.text(`Desired Distance:`, { continued: true });
        doc.font('Helvetica-Bold').text(` ${routeData.desiredDistanceKm || 'N/A'} km`);
        doc.font('Helvetica');
        const walkTypeText = routeData.walkType === 'one_way' ? 'One Way' : 'Round Trip';
        doc.text(`Walk Type:`, { continued: true });
        doc.font('Helvetica-Bold').text(` ${walkTypeText}`);
        doc.font('Helvetica');
        
        const column1EndY = doc.y;
        doc.y = boxY; // Reset Y for second column

        // Column 2: Route Stats
        const column2X = doc.page.margins.left + boxWidth + boxMargin;
        const meters = selectedRoute.length;
        const km = meters / 1000;
        const avgWalkingSpeedKmh = 4.5; // km/h (adjust as needed)
        const estimatedHours = km / avgWalkingSpeedKmh;
        const totalMinutes = Math.round(estimatedHours * 60);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        const estimatedTimeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
        
        doc.text(`Actual Length:`, column2X, boxY, { continued: true });
        doc.font('Helvetica-Bold').text(` ${km.toFixed(2)} km (${meters.toFixed(0)} m)`);
        doc.font('Helvetica');
        doc.text(`Estimated Time:`, column2X, doc.y, { continued: true });
        doc.font('Helvetica-Bold').text(` ~${estimatedTimeStr} (at ${avgWalkingSpeedKmh} km/h)`);
        doc.font('Helvetica');
        doc.text(`Route Cost:`, column2X, doc.y, { continued: true });
        doc.font('Helvetica-Oblique').text(` ${selectedRoute.cost ? selectedRoute.cost.toFixed(0) : '(N/A)'}`); 
        doc.font('Helvetica');
        doc.text(`Difficulty:`, column2X, doc.y, { continued: true });
        doc.font('Helvetica-Oblique').text(` [Placeholder]`); // Placeholder
        doc.font('Helvetica');
        doc.text(`Terrain:`, column2X, doc.y, { continued: true });
        doc.font('Helvetica-Oblique').text(` [Placeholder]`); // Placeholder
        doc.font('Helvetica');
        doc.text(`Accessibility:`, column2X, doc.y, { continued: true });
        doc.font('Helvetica-Oblique').text(` [Placeholder]`); // Placeholder
        doc.font('Helvetica');

        // Move below the taller column before drawing box/line
        doc.y = Math.max(column1EndY, doc.y) + boxMargin; 
        
        // Optional: Draw a box around the section or a line below
        doc.strokeColor('#cccccc')
           .lineWidth(1)
           .lineCap('round')
           .moveTo(doc.page.margins.left, doc.y)
           .lineTo(doc.page.width - doc.page.margins.right, doc.y)
           .stroke();
        doc.moveDown(1.5);
        
        // --- Add Map Image --- 
        const mapImageData = routeData.mapImageDataUrl;
        const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
        let imageYPos = doc.y;

        if (mapImageData && typeof mapImageData === 'string' && mapImageData.startsWith('data:image/png;base64,')) {
            try {
                console.log("Embedding map image (full width)...");
                // Estimate available height or set a max height 
                const availableHeight = doc.page.height - doc.y - doc.page.margins.bottom - 20; // Space for potential instructions title below
                const maxImageHeight = doc.page.height * 0.5; // Max 50% of page height for map
                
                // Embed the image, fitting it proportionally within the content width
                doc.image(mapImageData, doc.page.margins.left, imageYPos, {
                    fit: [contentWidth, Math.min(availableHeight, maxImageHeight)], // Fit within width and calculated max height
                    align: 'center',
                    valign: 'top'
                });
                // doc.y is automatically updated by image placement
                doc.moveDown(1.5); // Space after image
                console.log("Map image embedded.");
            } catch (imgError) {
                console.error("!!! ERROR embedding map image:", imgError);
                // Add text to PDF indicating image error
                doc.fillColor('red').fontSize(10).text("[Error embedding map image]", { align: 'center' });
                doc.moveDown(2); // Ensure space even on error
            }
        } else {
            console.warn("Map image data URL not provided or invalid.");
            // Add text to PDF indicating missing image
            doc.fillColor('orange').fontSize(10).text("[Map image not available]", { align: 'center' });
            doc.moveDown(2); // Ensure space even if no image
        }
        
        // --- Instructions Section (Below Map) --- 
        // Make sure we are definitely below the image + added space
        doc.fillColor('black'); // Reset color
        doc.fontSize(14).text('Instructions:', doc.page.margins.left, doc.y, { width: contentWidth, underline: true }); 
        doc.moveDown(0.5);
        doc.fontSize(10);
        const instructionTextOptions = { width: contentWidth, align: 'left' };

        if (selectedRoute.segments && selectedRoute.segments.length > 0) {
            let instructionCount = 1;
            let currentWay = null;
            let currentDistance = 0;

            selectedRoute.segments.forEach((segment, index) => {
                const wayName = segment.wayName || "Unnamed path/road";
                const distance = segment.length;
                if (currentWay === null) {
                    currentWay = wayName;
                    currentDistance = distance;
                } else if (wayName === currentWay) {
                    currentDistance += distance;
                } else {
                    // Print previous instruction (if distance is significant)
                    if (currentDistance > 10) { // Basic filtering
                         doc.text(`${instructionCount}. Continue for ${currentDistance.toFixed(0)}m on ${currentWay}`, instructionTextOptions);
                         instructionCount++;
                    }
                    // Start new instruction
                    currentWay = wayName;
                    currentDistance = distance;
                }
                // Print last instruction
                if (index === selectedRoute.segments.length - 1 && currentDistance > 10) {
                     doc.text(`${instructionCount}. Continue for ${currentDistance.toFixed(0)}m on ${currentWay}`, instructionTextOptions);
                }
            });
              doc.moveDown(0.5);
              doc.text(`${instructionCount + 1}. You have reached your destination (or midpoint).`, instructionTextOptions);

        } else {
            doc.text('No instruction segments available.', instructionTextOptions);
        }
       
        // --- Move below instructions before finalizing --- 
        doc.y = doc.y + 20; // Add some padding after instructions

        // Ensure we haven't run off the page 
        if (doc.y > doc.page.height - doc.page.margins.bottom) {
            // Potentially add page if needed, though less likely now
        }

        // --- Finalize the PDF (Handles Page Numbering) --- 
        // Manually add page numbers in footer before finalizing
        const range = doc.bufferedPageRange(); // Get page range
        for (let i = range.start; i < range.start + range.count; i++) {
            doc.switchToPage(i);
            // Page Footer (Page Number)
            doc.fontSize(8).fillColor('grey')
               .text(`Page ${i + 1}`, pageMargin, pageBottom + 10, { width: doc.page.width - pageMargin * 2, align: 'center' });
        }

        // Finalize the document and end the stream
        doc.end();
        console.log(`Successfully generated and streamed PDF: ${filename}`);

    } catch (error) {
        console.error("Backend: !!! ERROR during PDF generation:", error);
        // Ensure response isn't already sent before sending error
        if (!res.headersSent) {
             res.status(500).json({ success: false, message: "Internal server error during PDF generation." });
        }
    }
});

// Simple root route for testing
app.get('/', (req, res) => {
  res.send('Postcode Walker Backend is running!');
});

app.listen(port, () => {
  console.log(`Backend server listening on http://localhost:${port}`);
}); 