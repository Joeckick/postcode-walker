console.log("Script loaded.");

// Map initialization and route finding logic will go here later.

document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM fully loaded and parsed");

    // Check if Leaflet is loaded
    if (typeof L === 'undefined') {
        console.error("Leaflet library not found!");
        return;
    }

    // Initialize the map and set its view to UK coordinates
    const map = L.map('map').setView([54.5, -3], 5); // Center roughly on UK

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

function findRoutes() {
    console.log("Find routes button clicked!");
    // --- Geocoding and route finding logic will go here in Phase 2 ---
    const postcode = document.getElementById('postcode').value;
    const length = document.getElementById('length').value;
    console.log(`Searching for routes near ${postcode} of length ${length}m`);

    // Placeholder: Alert the user
    alert("Route finding not implemented yet.");
} 