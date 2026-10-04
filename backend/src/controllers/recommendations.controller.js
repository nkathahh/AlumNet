const axios = require('axios');

async function getRecommendations(req, res, next) {
  try {
    const { userId } = req.user;
    const url = `${process.env.ML_SERVICE_URL}/recommend?mentee_id=${userId}`;
    const response = await axios.get(url);
    res.json(response.data);
  } catch (err) {
    if (err.response) return res.status(err.response.status).json(err.response.data);
    next(err);
  }
}

module.exports = { getRecommendations };