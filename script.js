console.log("Script loaded.");

// Define map variable in a higher scope
let map;

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

    // Calculate search radius - desired length / 2 plus a buffer (e.g., 500m)
    // Ensure radius is reasonable, e.g., at least 1000m
    const radius = Math.max(1000, (desiredLengthMeters / 2) + 500);
    console.log(`Using Overpass search radius: ${radius}m`);

    // Overpass query to find walkable ways
    // We look for common walkable highway types
    const query = `
        [out:json][timeout:30];
        (
          way
            ["highway"~"^(footway|path|pedestrian|track|residential|living_street|service|unclassified|tertiary)$"]
            (around:${radius},${lat},${lon});
          // Optionally add ways explicitly tagged for foot traffic
          // way["foot"="yes"](around:${radius},${lat},${lon});
        );
        out body;
        >;
        out skel qt;
    `;
    // Note: "out skel qt;" is efficient for getting nodes and ways needed for geometry
    // Using POST is recommended for larger queries
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

        // Basic check if we got any elements
        if (osmData.elements && osmData.elements.length > 0) {
             document.getElementById('results').innerHTML += `<p>Successfully fetched ${osmData.elements.length} map elements. Next step: Process data and find routes.</p>`;
            // --- TODO: Call function to process OSM data and build graph --- 
        } else {
            document.getElementById('results').innerHTML += '<p>No walkable paths found in the immediate area via Overpass.</p>';
            alert("Could not find sufficient walking path data in this area. Try a different postcode or adjust length.");
        }

    } catch (error) {
        console.error("Error fetching or processing Overpass data:", error);
        document.getElementById('results').innerHTML += '<p>Error fetching walking path data.</p>';
        alert(`An error occurred while fetching map data: ${error.message}. The Overpass API might be busy. Please try again later.`);
    }
} 