const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

app.post('/scrape', async (req, res) => {
    const { city, state, limit } = req.body;
    
    if (!city || !state || !limit) {
        return res.status(400).json({ error: 'City, state, and limit are required.' });
    }

    try {
        const response = await axios.get(`https://some-licensing-board.api/${state}/agents`, { params: { city, limit } });
        const agents = response.data;
        return res.json(agents);
    } catch (error) {
        console.error('Error fetching agents:', error);
        return res.status(500).json({ error: 'Failed to fetch data from licensing board.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});