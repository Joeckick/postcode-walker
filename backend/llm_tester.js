require('dotenv').config(); // Load .env from current working directory (project root)
console.log("DEBUG: dotenv loaded. Checking for GOOGLE_API_KEY..."); // Added for debugging
console.log("DEBUG: process.env.GOOGLE_API_KEY is:", process.env.GOOGLE_API_KEY); // Added for debugging

const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- Configuration ---
const TEST_CASES = [
    { postcode: "SW1A 0AA", distanceKm: 5 },
    { postcode: "M21 9BU", distanceKm: 3 }, // Example suburban
    { postcode: "EH1 1RE", distanceKm: 8 }, // Example city center
    // Add more test cases as needed
];

// --- Gemini API Key Setup ---
const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) {
  console.error("ERROR: GOOGLE_API_KEY not found. Make sure you have a .env file in the project root with your key.");
  process.exit(1); // Exit if key is missing
}
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });

// --- Prompt Crafting ---
function createPrompt(postcode, distanceKm) {
    // Example Prompt - Experiment with different versions!
    return `
        You are suggesting walking routes for someone who has just moved to a new area.
        They want interesting and varied walks starting near the postcode ${postcode}.
        The desired total distance is approximately ${distanceKm} km.

        Suggest THREE distinct walk CONCEPTS or THEMES.
        For each concept, provide:
        1. A short, appealing name/theme (e.g., "Park Explorer", "Local Shops Loop", "Canal Path Discovery").
        2. A brief text description highlighting key features, landmarks, or street types involved.
        3. Ensure the concepts are significantly different from each other (e.g., focus on different environments like green space vs. residential vs. commercial, or head in different primary directions).

        Do NOT provide turn-by-turn directions. Focus on the overall idea and key points of interest for each walk concept.
    `;
}

// --- Main Execution Logic ---
async function runTests() {
    console.log("--- Starting Gemini Route Concept Generation Test ---");

    for (const testCase of TEST_CASES) {
        console.log(`\n--------------------------------------------------`);
        console.log(`Testing Postcode: ${testCase.postcode}, Distance: ${testCase.distanceKm} km`);
        console.log(`--------------------------------------------------`);

        const prompt = createPrompt(testCase.postcode, testCase.distanceKm);
        // console.log("\n--- Prompt Sent to Gemini ---");
        // console.log(prompt);
        // console.log("---------------------------\n");

        try {
            console.log("Calling Gemini API...");
            const result = await model.generateContent(prompt);
            const response = result.response;

            console.log("\n--- Gemini Response Text ---");
            if (response && response.text) {
                console.log(response.text());
            } else {
                console.log("No response text received.");
                // Log safety ratings or other feedback if available
                if (response && response.promptFeedback) {
                    console.warn("Prompt Feedback:", JSON.stringify(response.promptFeedback, null, 2));
                }
            }
            console.log("--------------------------\n");

        } catch (error) {
            console.error(`Error calling Gemini API for ${testCase.postcode}:`, error);
        }
        // Optional: Add a small delay between API calls if needed
        // await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log("--- Test Complete ---");
}

// Run the tests
runTests(); 