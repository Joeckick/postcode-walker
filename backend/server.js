const express = require('express');
const cors = require('cors');
const PDFDocument = require('pdfkit'); // Import pdfkit
const fs = require('fs'); // File system module (optional, for saving to file)
const path = require('path');
// Import routing functions
const routing = require('./routing'); 
const turf = require('@turf/turf'); // Make sure turf is available here too

const app = express();
const port = process.env.PORT || 3000;

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

// --- API Endpoint: Find Routes --- 
app.post('/api/find-routes', async (req, res) => {
    console.log("Backend: Received POST request on /api/find-routes");
    const { startPostcode, desiredDistanceKm, walkType } = req.body;
    
    // --- Input Validation ---
    if (!startPostcode || typeof desiredDistanceKm !== 'number' || desiredDistanceKm <= 0 || !walkType) {
        return res.status(400).json({ success: false, message: "Missing or invalid input parameters." });
    }
    const desiredDistanceMeters = desiredDistanceKm * 1000;
    let finalFoundRoutes = [];
    let allNodes = {}; // To store nodes for the final response
    let allCombinedRoutes = []; // Initialize combined results array

    try {
        console.log(`Backend: Finding routes for ${startPostcode}, ${desiredDistanceKm}km, ${walkType}`);
        // --- Geocode --- 
        const startCoords = await routing.lookupPostcodeCoords(startPostcode);
        
        // --- Calculate BBox (Moved back here!) ---
        const bufferFactor = 1.5; 
        const approxRadiusLat = (desiredDistanceMeters * bufferFactor) / 111000; 
        const approxRadiusLon = approxRadiusLat / Math.cos(startCoords.latitude * Math.PI / 180);
        const searchBbox = [
            startCoords.longitude - approxRadiusLon, startCoords.latitude - approxRadiusLat,
            startCoords.longitude + approxRadiusLon, startCoords.latitude + approxRadiusLat
        ];

        // --- Fetch OSM Data Once --- 
        console.log("Fetching OSM data...");
        const osmData = await routing.fetchOsmDataInBbox(searchBbox);
        if (osmData.elements.length === 0) {
             throw new Error("No map features (paths, roads) found for the area.");
        }
        console.log(`Fetched ${osmData.elements.length} OSM elements.`);

        // --- Run 1: Preferred Costs --- 
        console.log("--- Starting Run 1 (Preferred Costs) ---");
        let graphDataRun1 = routing.processOsmData(osmData, startCoords.latitude, startCoords.longitude, preferredCosts);
        allNodes = graphDataRun1.nodes; // Store nodes from this run initially
        let combinedRoutesRun1 = [];
        if (walkType === 'round_trip') {
             combinedRoutesRun1 = await findRoundTripSet(graphDataRun1.startNodeId, graphDataRun1.graph, graphDataRun1.nodes, desiredDistanceMeters, "Run 1");
        } else { 
             console.log("[Run 1] Finding one-way routes...");
             combinedRoutesRun1 = await routing.findWalkNearDistance(graphDataRun1.graph, graphDataRun1.nodes, graphDataRun1.startNodeId, desiredDistanceMeters);
        }
        console.log(`--- Finished Run 1: Found ${combinedRoutesRun1.length} candidate routes ---`);

        allCombinedRoutes = [...combinedRoutesRun1]; // Initialize with Run 1 results
        let needsRun2 = false;

        // --- Simplified Check & Decision for Run 2 (Round Trips Only) ---
        if (walkType === 'round_trip') {
             // Check how many routes from Run 1 meet the length criteria
             const minTotalLength = desiredDistanceMeters * (1 - LENGTH_TOLERANCE);
             const maxTotalLength = desiredDistanceMeters * (1 + LENGTH_TOLERANCE);
             const lengthFilteredRun1Count = combinedRoutesRun1.filter(r => r.length >= minTotalLength && r.length <= maxTotalLength).length;
             
             // Trigger Run 2 if Run 1 produced fewer length-compliant routes than desired
             if (lengthFilteredRun1Count < MAX_ROUTES_TO_RETURN) { 
                  console.log(`Run 1 yielded only ${lengthFilteredRun1Count} routes within length tolerance. Triggering Run 2 (Relaxed Costs).`);
                  needsRun2 = true;
             } else {
                  console.log(`Run 1 yielded sufficient (${lengthFilteredRun1Count}) length-compliant routes. Skipping Run 2.`);
             }
        }
       
        // --- Run 2: Relaxed Costs (Conditional) --- 
        if (needsRun2 && walkType === 'round_trip') { 
             console.log("--- Starting Run 2 (Relaxed Costs) ---");
             // Re-process OSM data with relaxed costs
             let graphDataRun2 = routing.processOsmData(osmData, startCoords.latitude, startCoords.longitude, relaxedCosts);
             allNodes = graphDataRun2.nodes; // Use nodes from the latest run 
             let combinedRoutesRun2 = await findRoundTripSet(graphDataRun2.startNodeId, graphDataRun2.graph, graphDataRun2.nodes, desiredDistanceMeters, "Run 2");
             console.log(`--- Finished Run 2: Found ${combinedRoutesRun2.length} candidate routes ---`);
             
             // --- Add Run 2 results to the combined pool --- 
             // Make sure not to add duplicates if a route is identical between runs
             const run1RouteIds = new Set(combinedRoutesRun1.map(r => r.path.join('-'))); // Simple ID based on path
             combinedRoutesRun2.forEach(route2 => {
                 const route2Id = route2.path.join('-');
                 if (!run1RouteIds.has(route2Id)) {
                     allCombinedRoutes.push(route2);
                 }
             });
             console.log(`Total combined routes after Run 2: ${allCombinedRoutes.length}`);
        }

        // --- Final Processing: Tiered Selection to Guarantee 3 Routes ---
        console.log(`--- Final Tiered Selection on ${allCombinedRoutes.length} Total Combined Candidates ---`);
        if (allCombinedRoutes.length === 0) {
             throw new Error("No candidate routes generated from any run.");
        }
        
        // Sort all candidates primarily by cost
        allCombinedRoutes.sort((a, b) => a.cost - b.cost);

        finalFoundRoutes = []; // Reset final routes
        const selectedSegmentSets = []; // Track segments for overlap check
        const selectedRouteIds = new Set(); // Track IDs to prevent adding duplicates across tiers

        const finalMinLength = desiredDistanceMeters * (1 - LENGTH_TOLERANCE);
        const finalMaxLength = desiredDistanceMeters * (1 + LENGTH_TOLERANCE);
        const getSegmentEdgeId = (segment) => { // Re-use helper from selectDiverseRoutes
             if (segment.startNodeId === undefined || segment.endNodeId === undefined) return null;
             const u = Math.min(segment.startNodeId, segment.endNodeId);
             const v = Math.max(segment.startNodeId, segment.endNodeId);
             return `${u}_${v}`;
         };
        
        // --- Tier 1: Length OK & Diverse (< OVERLAP_THRESHOLD) ---
        console.log(`Selecting Tier 1: Length within [${finalMinLength.toFixed(0)}m - ${finalMaxLength.toFixed(0)}m] AND Overlap <= ${OVERLAP_THRESHOLD}%`);
        for (const candidate of allCombinedRoutes) {
            if (finalFoundRoutes.length >= MAX_ROUTES_TO_RETURN) break;
            const routeId = candidate.path.join('-'); // Simple ID
            if (selectedRouteIds.has(routeId)) continue; // Skip if already selected

            // Check Length
            if (candidate.length >= finalMinLength && candidate.length <= finalMaxLength) {
                // Check Diversity
                let isDiverseEnough = true;
                const candidateSegments = new Set();
                candidate.segments.forEach(seg => { const id = getSegmentEdgeId(seg); if(id) candidateSegments.add(id); });
                if (candidateSegments.size === 0) continue; // Cannot check diversity

                for (const selectedSegments of selectedSegmentSets) {
                    let overlapCount = 0;
                    for (const edgeId of candidateSegments) {
                        if (selectedSegments.has(edgeId)) overlapCount++;
                    }
                    const overlapPercent = (overlapCount / candidateSegments.size) * 100;
                    if (overlapPercent > OVERLAP_THRESHOLD) {
                        isDiverseEnough = false;
                        break;
                    }
                }

                // Add if length and diversity criteria met
                if (isDiverseEnough) {
                    console.log(` -> Tier 1 Adding: Route Cost ${candidate.cost.toFixed(0)}, Length ${candidate.length.toFixed(0)}m`);
                    finalFoundRoutes.push(candidate);
                    selectedSegmentSets.push(candidateSegments);
                    selectedRouteIds.add(routeId);
                }
            }
        }
        console.log(` Tier 1 Selection Complete. Found ${finalFoundRoutes.length} routes.`);

        // --- Tier 2: Length OK (Relaxed Diversity) ---
        if (finalFoundRoutes.length < MAX_ROUTES_TO_RETURN) {
            console.log(`Selecting Tier 2: Length OK, ignoring overlap (Already have ${finalFoundRoutes.length})`);
            for (const candidate of allCombinedRoutes) {
                if (finalFoundRoutes.length >= MAX_ROUTES_TO_RETURN) break;
                const routeId = candidate.path.join('-');
                if (selectedRouteIds.has(routeId)) continue; // Skip if already selected in Tier 1

                // Check Length ONLY
                if (candidate.length >= finalMinLength && candidate.length <= finalMaxLength) {
                     console.log(` -> Tier 2 Adding: Route Cost ${candidate.cost.toFixed(0)}, Length ${candidate.length.toFixed(0)}m`);
                     finalFoundRoutes.push(candidate);
                     // No need to add segments here as diversity is ignored for filling slots
                     selectedRouteIds.add(routeId);
                }
            }
             console.log(` Tier 2 Selection Complete. Found ${finalFoundRoutes.length} routes.`);
        }

        // --- Tier 3: Closest Length (Ignore Diversity, Cost, Strict Length Tolerance) ---
         if (finalFoundRoutes.length < MAX_ROUTES_TO_RETURN) {
            console.log(`Selecting Tier 3: Closest length, ignoring all other criteria (Already have ${finalFoundRoutes.length})`);
            // Get remaining candidates not already selected
            const remainingCandidates = allCombinedRoutes.filter(candidate => !selectedRouteIds.has(candidate.path.join('-')));
            // Sort remaining by absolute difference from target length
            remainingCandidates.sort((a, b) => Math.abs(a.length - desiredDistanceMeters) - Math.abs(b.length - desiredDistanceMeters));
            
            const needed = MAX_ROUTES_TO_RETURN - finalFoundRoutes.length;
            for (let i = 0; i < needed && i < remainingCandidates.length; i++) {
                const candidate = remainingCandidates[i];
                 console.log(` -> Tier 3 Adding: Route Cost ${candidate.cost.toFixed(0)}, Length ${candidate.length.toFixed(0)}m (Diff: ${Math.abs(candidate.length - desiredDistanceMeters).toFixed(0)}m)`);
                 finalFoundRoutes.push(candidate);
                 selectedRouteIds.add(candidate.path.join('-')); // Prevent duplicates if somehow needed > remaining
            }
             console.log(` Tier 3 Selection Complete. Found ${finalFoundRoutes.length} routes.`);
         }

        // --- Final Output --- 
        // Ensure we don't somehow exceed 3 routes
        if (finalFoundRoutes.length > MAX_ROUTES_TO_RETURN) {
             console.warn(`Selection logic resulted in ${finalFoundRoutes.length} routes, trimming to ${MAX_ROUTES_TO_RETURN}.`);
             // Re-sort by cost before trimming (or keep existing order? Tier 1 preferred)
             // Let's just take the first 3 based on the order they were added (Tier 1 first)
             finalFoundRoutes = finalFoundRoutes.slice(0, MAX_ROUTES_TO_RETURN);
        }
        
        if (finalFoundRoutes.length < MAX_ROUTES_TO_RETURN) {
             // This shouldn't happen with Tier 3 unless allCombinedRoutes was empty initially
             console.error(`CRITICAL: Could not fulfill request for ${MAX_ROUTES_TO_RETURN} routes. Only found ${finalFoundRoutes.length}.`);
              throw new Error(`Failed to generate the required ${MAX_ROUTES_TO_RETURN} routes.`);
        }
        
        console.log(`Backend: Found ${finalFoundRoutes.length} final routes after tiered selection.`);

        // --- Prepare and Send Response --- 
        res.json({
            success: true,
            message: `Found ${finalFoundRoutes.length} routes.`,
            startCoords: startCoords, 
            routes: finalFoundRoutes, 
            nodes: allNodes 
        });

    } catch (error) {
        console.error("Backend: Error in /api/find-routes:", error);
        console.error(error.stack); // Log stack trace
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