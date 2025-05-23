const express = require('express');
const app = express();
const port = 3000;

// Import the main function
const { main } = require('./index.js');

// Middleware to parse JSON bodies
app.use(express.json());

// Endpoint to trigger the main function
app.post('/trigger', async (req, res) => {
    try {
        // Start the main function
        main().catch(console.error);
        
        // Send immediate response
        res.json({ 
            status: 'success', 
            message: 'Process started successfully' 
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'error', 
            message: error.message 
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Start the server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
}); 