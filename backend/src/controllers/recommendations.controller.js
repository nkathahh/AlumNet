const axios = require('axios');

async function getRecommendations(req, res, next) {
  try {
    const { userId } = req.user;
    const url = `${process.env.ML_SERVICE_URL}/recommend?mentee_id=${userId}`;
    // The shared key stops anyone else calling the ML service directly once it is online
    const headers = process.env.ML_API_KEY ? { 'X-API-Key': process.env.ML_API_KEY } : {};
    const response = await axios.get(url, { headers, timeout: 30000 });
    res.json(response.data);
  } catch (err) {
    if (err.response) return res.status(err.response.status).json(err.response.data);
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNABORTED') {
      return res.status(503).json({ error: 'The matching service is starting up. Please try again in a minute.' });
    }
    next(err);
  }
}

module.exports = { getRecommendations };
