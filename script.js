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

// --- ADDED: Store last successfully generated route data ---
let lastGeneratedRouteData = null; 
let globalNodes = null; // Store nodes globally for PDF generation access?

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded and parsed");

    // Check if Leaflet is loaded
    if (typeof L === 'undefined') {
        console.error("Leaflet library not found!");
        return;
    }

    // Initialize the map and assign it to the higher scope variable
    map = L.map('map', {
        preferCanvas: true // Force Canvas renderer - might help leaflet-image capture
    }).setView([54.5, -3], 5); // Center roughly on UK

    // Add the OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        crossOrigin: 'anonymous' // Attempt to enable CORS for tile images
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
        downloadPdfButton.disabled = true;
        downloadPdfButton.textContent = "Select Route First"; 
        downloadPdfButton.addEventListener('click', async () => {
            console.log("Frontend: 'Generate Premium PDF' button clicked - calling backend");
            
            const originalButtonText = downloadPdfButton.textContent;
            downloadPdfButton.textContent = "Sending request..."; 
            downloadPdfButton.disabled = true;

            try {
                // VALIDATE SELECTION
                if (!lastGeneratedRouteData || !lastGeneratedRouteData.routes || lastGeneratedRouteData.routes.length === 0) {
                    throw new Error("No route data available.");
                }
                if (typeof lastGeneratedRouteData.selectedIndex !== 'number') {
                    throw new Error("No route selected from the list.");
                }
                
                // Capture Map Image
                console.log("Frontend: Capturing map image with html2canvas...");
                const mapElement = document.getElementById('map');
                if (!mapElement) throw new Error("Map element not found for capture.");
                if (typeof html2canvas === 'undefined') throw new Error("html2canvas library not loaded.");
                
                const canvas = await html2canvas(mapElement, { 
                    useCORS: true, 
                    logging: false, 
                    scale: 1 
                });
                const mapImageDataUrl = canvas.toDataURL('image/png');
                console.log("Frontend: Map captured. Data URL length:", mapImageDataUrl.length);
                if (mapImageDataUrl.length > 10 * 1024 * 1024) { // Increased check slightly
                    console.warn("Captured map image data may be large.");
                }

                // Prepare data to send (using data sourced from /api/find-routes)
                const dataToSend = { 
                    ...lastGeneratedRouteData, 
                    mapImageDataUrl: mapImageDataUrl 
                    // nodes might be large, but backend might need them for PDF context?
                    // Let's keep sending relevant nodes for now, backend PDF endpoint can ignore if not needed
                }; 
                // Add relevant nodes again just before sending to PDF endpoint
                 const selectedRouteForPDF = dataToSend.routes[dataToSend.selectedIndex];
                 if (globalNodes && selectedRouteForPDF && selectedRouteForPDF.path) {
                     const relevantNodesForPDF = {};
                     selectedRouteForPDF.path.forEach(nodeId => {
                         if (globalNodes[nodeId]) {
                             relevantNodesForPDF[nodeId] = globalNodes[nodeId];
                         }
                     });
                     dataToSend.nodes = relevantNodesForPDF; 
                 } else {
                    dataToSend.nodes = null; // Ensure it's null if we can't get relevant ones
                 }
                
                // Call PDF Backend API
                console.log("Frontend: Sending data to backend endpoint /api/generate-pdf");
                const pdfResponse = await fetch('http://localhost:3000/api/generate-pdf', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(dataToSend),
                });

                // Handle PDF Backend Response 
                downloadPdfButton.textContent = originalButtonText;
                downloadPdfButton.disabled = false;

                if (!pdfResponse.ok) {
                    let errorMsg = `PDF Generation Error: ${pdfResponse.status} ${pdfResponse.statusText}`;
                    try {
                        const errorData = await pdfResponse.json(); 
                        errorMsg = errorData.message || errorMsg; 
                    } catch (e) { console.warn("Could not parse PDF backend error response as JSON."); }
                    throw new Error(errorMsg);
                }

                // Process PDF blob for download
                console.log("Frontend: PDF Backend response OK. Processing as blob...");
                const contentDisposition = pdfResponse.headers.get('content-disposition');
                let filename = 'postcode-walk.pdf'; 
                if (contentDisposition) {
                    const filenameMatch = contentDisposition.match(/filename="?(.+)"?/i);
                    if (filenameMatch && filenameMatch.length > 1) filename = filenameMatch[1];
                }
                console.log(`Frontend: Attempting to download file as: ${filename}`);
                const blob = await pdfResponse.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.style.display = 'none'; a.href = url; a.download = filename; 
                document.body.appendChild(a); a.click();
                window.URL.revokeObjectURL(url); document.body.removeChild(a);
                console.log("Frontend: PDF download initiated.");

            } catch (error) {
                console.error("Frontend: ERROR calling backend PDF generation or processing response:", error);
                downloadPdfButton.textContent = originalButtonText;
                downloadPdfButton.disabled = false;
                alert(`Could not request PDF generation: ${error.message}`);
            }
        });
        console.log("Attached click listener to download-pdf-btn (calls backend)");
    } else {
        console.error("Download PDF button not found!");
    }

    // *** COMMENTED OUT DEBUG log for element check on load ***
    // const initialEndElement = document.getElementById('end_postcode_input');
    // console.log("DEBUG (DOMContentLoaded): Element with ID 'end_postcode_input':", initialEndElement);

});

async function findRoutes() {
    console.log("Frontend: Find routes button clicked!"); 
    const startPostcode = document.getElementById('postcode').value.trim();
    const distanceInput = document.getElementById('desired_distance').value;
    const desiredDistanceKm = parseFloat(distanceInput);
    const walkType = document.querySelector('input[name="walk_type"]:checked').value;

    const resultsDiv = document.getElementById('results');
    const spinner = document.getElementById('loading-spinner'); 
    const pdfButton = document.getElementById('download-pdf-btn');
    
    // --- UI Reset --- 
    resultsDiv.innerHTML = '<h2>Results</h2>'; // Clear previous results
    clearRoutes(); // Clear routes from map
    if (pdfButton) { 
        pdfButton.hidden = true; // Hide PDF button
        pdfButton.disabled = true; 
    }
    if (spinner) spinner.classList.remove('hidden'); 
    lastGeneratedRouteData = null; // Clear previous data
    globalNodes = null; // Clear nodes

    // --- Input Validation (Keep on Frontend) ---
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
    console.log(`Frontend: Requesting routes for ${startPostcode}, ${desiredDistanceKm}km, ${walkType}`);

    // --- Call Backend API to Find Routes --- 
    try {
        const response = await fetch('http://localhost:3000/api/find-routes', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ 
                startPostcode,
                desiredDistanceKm,
                walkType 
            }),
        });

        if (!response.ok) {
            let errorMsg = `Route Finding Error: ${response.status} ${response.statusText}`;
            try {
                const errorData = await response.json(); 
                errorMsg = errorData.message || errorMsg; 
            } catch (e) { /* Ignore if body isn't JSON */ }
            throw new Error(errorMsg);
        }

        const result = await response.json();

        if (!result.success || !result.routes || !result.nodes || !result.startCoords) {
            throw new Error(result.message || "Invalid data received from backend.");
        }

        console.log(`Frontend: Received ${result.routes.length} routes from backend.`);
        globalNodes = result.nodes; // Store nodes from backend
        
        // --- Process and Display Results (Using Backend Data) --- 
        
        // Center map on start coords
        map.setView([result.startCoords.latitude, result.startCoords.longitude], 14); 
        L.marker([result.startCoords.latitude, result.startCoords.longitude]).addTo(map)
            .bindPopup(`Start: ${result.startCoords.postcode}`)
            .openPopup();
        
        if (result.routes.length > 0) {
            let routeListHtml = "";
            let combinedBounds = L.latLngBounds([]);
            combinedBounds.extend([result.startCoords.latitude, result.startCoords.longitude]);

            result.routes.forEach((route, index) => {
                const routeLabel = walkType === 'round_trip' ? 'Round Trip' : 'Route';
                // Display length and COST
                routeListHtml += `<li class="route-summary-item" data-route-index="${index}">${routeLabel} ${index + 1} - Length: ${(route.length / 1000).toFixed(1)} km, Cost: ${route.cost.toFixed(0)}</li>`;
                
                // Draw route using backend data
                const routeLayer = drawRoute(route, index); 
                if (routeLayer) {
                    combinedBounds.extend(routeLayer.getBounds());
                }
                 // Add end marker if one-way (using last node from path)
                 if (walkType === 'one_way' && route.path && route.path.length > 0) {
                    const endNodeId = route.path[route.path.length - 1];
                    const endNodeCoords = globalNodes[endNodeId]; // Use globalNodes
                    if(endNodeCoords) {
                        L.marker([endNodeCoords.lat, endNodeCoords.lon]).addTo(map)
                            .bindPopup(`End (${routeLabel} ${index + 1})`);
                        combinedBounds.extend([endNodeCoords.lat, endNodeCoords.lon]);
                    }
                 }
            });

            resultsDiv.innerHTML += `<h3>Found ${result.routes.length} Route(s):</h3><ul id="route-summary-list">${routeListHtml}</ul><hr/><div id="selected-route-instructions"></div>`;
            
            // Add click listener for route selection
            const routeListElement = document.getElementById('route-summary-list');
            if (routeListElement) {
                routeListElement.addEventListener('click', (event) => {
                    if (event.target && event.target.classList.contains('route-summary-item')) {
                        const selectedIndex = parseInt(event.target.getAttribute('data-route-index'));
                        if (!isNaN(selectedIndex)) {
                            // Store data received from backend for the selected route
                            lastGeneratedRouteData = { 
                                startPostcode: startPostcode, // Keep original inputs
                                desiredDistanceKm: desiredDistanceKm,
                                walkType: walkType,
                                routes: result.routes, // Store all routes from backend
                                selectedIndex: selectedIndex,
                                nodes: globalNodes // Store nodes for PDF generation
                            };
                            displaySelectedRoute(selectedIndex); 
                        }
                    }
                });
            }
            
            // Fit map to bounds
            if (combinedBounds.isValid()) {
                 map.fitBounds(combinedBounds.pad(0.1)); 
            }

        } else {
            resultsDiv.innerHTML += `<p>Backend could not find any suitable routes.</p>`;
        }

    } catch (error) {
         console.error("Frontend: Error calling backend or processing results:", error);
         resultsDiv.innerHTML = `<p>Error finding routes: ${error.message}</p>`; 
         // Optionally re-alert or handle differently
         // alert(`An error occurred: ${error.message}`); 
     } finally {
         // Hide spinner
         if (spinner) spinner.classList.add('hidden'); 
     }
} 

// --- UI / Helper Functions (Keep) --- 

function generateInstructions(routeSegments) {
    if (!routeSegments || routeSegments.length === 0) {
        return "No route segments found to generate instructions.";
    }
    let instructionsList = [];
    let currentInstruction = null;
    const MIN_DISTANCE_FOR_INSTRUCTION = 10; 

    routeSegments.forEach((segment, index) => {
        const wayName = segment.wayName || "Unnamed path/road"; 
        const distance = segment.length;

        if (!currentInstruction) {
            if (distance >= MIN_DISTANCE_FOR_INSTRUCTION) {
                 currentInstruction = { wayName: wayName, distance: distance };
            }
        } else if (wayName === currentInstruction.wayName) {
            currentInstruction.distance += distance;
        } else {
            if (currentInstruction.distance >= MIN_DISTANCE_FOR_INSTRUCTION) {
                const roundedDistance = currentInstruction.distance < 100 ? currentInstruction.distance.toFixed(0) : Math.round(currentInstruction.distance / 10) * 10;
                 instructionsList.push(`Continue for approx. ${roundedDistance}m on ${currentInstruction.wayName}`);
            }
             if (distance >= MIN_DISTANCE_FOR_INSTRUCTION) {
                 currentInstruction = { wayName: wayName, distance: distance };
             } else {
                 currentInstruction = null; 
             }
        }
        if (index === routeSegments.length - 1 && currentInstruction && currentInstruction.distance >= MIN_DISTANCE_FOR_INSTRUCTION) {
            const roundedDistance = currentInstruction.distance < 100 ? currentInstruction.distance.toFixed(0) : Math.round(currentInstruction.distance / 10) * 10;
             instructionsList.push(`Continue for approx. ${roundedDistance}m on ${currentInstruction.wayName}`);
        }
    });
     if (instructionsList.length === 0 && currentInstruction && currentInstruction.distance < MIN_DISTANCE_FOR_INSTRUCTION && routeSegments.length === 1) {
          instructionsList.push(`Walk approx. ${currentInstruction.distance.toFixed(0)}m on ${currentInstruction.wayName} (Short segment)`);
     } else if (instructionsList.length === 0 && !currentInstruction && routeSegments.length > 0) {
         instructionsList.push("Route consists of very short segments. No detailed instructions generated.");
     }
    if (instructionsList.length > 0) {
        instructionsList.push("You have reached your destination (or midpoint for round trip).");
        return instructionsList.map((instr, i) => `${i + 1}. ${instr}`).join("\n"); 
    } else {
        return "Could not generate detailed instructions (route may be too short or complex).";
    }
}

function clearRoutes() {
    drawnRouteLayers.forEach(layer => map.removeLayer(layer));
    drawnRouteLayers = [];
    // Optionally clear the results list too, or handle it where search starts
    // document.getElementById('results').innerHTML = '<h2>Results</h2>';
}

// drawRoute needs to work with route object from backend
function drawRoute(route, index, isSelected = false) {
    if (!route || !route.segments || route.segments.length === 0) { 
        console.error("Frontend: Invalid route data for drawing:", route);
        return null; 
    }
    let fullCoords = [];
    route.segments.forEach((segment, segmentIndex) => {
        const pointsToAdd = segmentIndex === 0 ? segment.geometry : segment.geometry.slice(1);
        if (pointsToAdd) {
        fullCoords = fullCoords.concat(pointsToAdd);
        }
    });
    const leafletCoords = fullCoords.map(coord => {
        if (Array.isArray(coord) && coord.length === 2) {
            return [coord[1], coord[0]]; 
        } else {
            console.warn("Skipping invalid coordinate pair during drawing:", coord);
            return null; 
        }
    }).filter(coord => coord !== null); 

    if (leafletCoords.length >= 2) {
        const colors = ['#FF0000', '#0000FF', '#008000', '#FFA500', '#800080'];
        const color = colors[index % colors.length];
        const defaultWeight = 4;
        const selectedWeight = 7;
        const defaultOpacity = 0.6; 
        const selectedOpacity = 0.9;

        const polyline = L.polyline(leafletCoords, {
            color: color,
            weight: isSelected ? selectedWeight : defaultWeight,
            opacity: isSelected ? selectedOpacity : defaultOpacity
        }).addTo(map);
        polyline.bindPopup(`Route ${index + 1}: ${route.length.toFixed(0)}m (Cost: ${route.cost.toFixed(0)})`);// Add cost to popup
        drawnRouteLayers.push(polyline);
        return polyline; 
    } else {
        console.warn(`Route ${index + 1} has insufficient coordinates to draw.`);
        return null; 
    }
}

// displaySelectedRoute needs to use backend data stored in lastGeneratedRouteData
function displaySelectedRoute(selectedIndex) {
    console.log(`Frontend: Displaying details for route index: ${selectedIndex}`);
    if (!lastGeneratedRouteData || !lastGeneratedRouteData.routes || selectedIndex < 0 || selectedIndex >= lastGeneratedRouteData.routes.length) {
        console.error("Frontend: Invalid index or no route data available to display.");
        const instructionsDiv = document.getElementById('selected-route-instructions');
        if (instructionsDiv) instructionsDiv.innerHTML = ''; 
        document.querySelectorAll('.route-summary-item').forEach(item => item.classList.remove('selected-route'));
        if (downloadPdfButton) downloadPdfButton.disabled = true; 
        return;
    }

    const selectedRoute = lastGeneratedRouteData.routes[selectedIndex];
    // lastGeneratedRouteData.selectedIndex is already set before calling this

    // Update Map
    clearRoutes();
    let selectedBounds = L.latLngBounds([]);
    lastGeneratedRouteData.routes.forEach((route, index) => {
        const isSelected = (index === selectedIndex);
        const layer = drawRoute(route, index, isSelected); 
        if (isSelected && layer) {
            selectedBounds.extend(layer.getBounds());
        } 
    });
    // Re-add start marker (might be cleared by clearRoutes)
    const startCoords = lastGeneratedRouteData.routes[0]?.segments[0]?.geometry[0]; //Approx
    if(startCoords) { 
        // This relies on start coord being first point of first segment - better to get from initial lookup?
        // L.marker([startCoords[1], startCoords[0]]).addTo(map)... 
    }
    // Re-add end markers?

    if (selectedBounds.isValid()) {
        try { map.fitBounds(selectedBounds.pad(0.1)); } 
        catch(e) { console.warn("Error fitting bounds to selected route", e); }
    }

    // Update Instructions Display
    const instructionsDiv = document.getElementById('selected-route-instructions');
    if (instructionsDiv) {
        const instructionsText = generateInstructions(selectedRoute.segments);
        instructionsDiv.innerHTML = `<h3>Route ${selectedIndex + 1} Instructions:</h3><pre class="route-instruction-text">${instructionsText}</pre>`;
    } else {
        console.error("Could not find #selected-route-instructions div.");
    }
    
    // Update Summary List Highlight
    document.querySelectorAll('.route-summary-item').forEach((item) => {
        if (parseInt(item.getAttribute('data-route-index')) === selectedIndex) {
            item.classList.add('selected-route'); 
        } else {
            item.classList.remove('selected-route');
        }
    });

    // Enable PDF Button 
    if (downloadPdfButton) {
        downloadPdfButton.disabled = false; 
        downloadPdfButton.hidden = false; // Make sure it's visible
        downloadPdfButton.textContent = "Generate Premium PDF"; 
    }
}

// --- End of File --- 