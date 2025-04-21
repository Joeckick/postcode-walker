const express = require('express');
const cors = require('cors');
const PDFDocument = require('pdfkit'); // Import pdfkit
const fs = require('fs'); // File system module (optional, for saving to file)

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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

// --- Graph Building Function (Example - needs integration) ---
// This function would replace or augment graph building if done on backend.
// For now, we assume graph comes from frontend, but we need tags.
// We will MODIFY the route finding logic below to USE costs if graph has them.

// NOTE: For this to work, the `segments` data sent from the frontend
// MUST include the `wayName` and ideally the original `highway` tag.
// The current `script.js` adds `wayName` but not the raw tag.
// We might need to adjust the frontend data preparation first.

// PDF generation endpoint
app.post('/api/generate-pdf', (req, res) => {
    console.log("Received POST request on /api/generate-pdf");
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
        doc.font('Helvetica-Oblique').text(` ${selectedRoute.cost.toFixed(0)} ${missingCostInfo ? '(estimated)' : ''}`); // Display cost
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
        console.error("!!! ERROR during PDF generation:", error);
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