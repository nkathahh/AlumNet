const axios = require('axios');

// One place to call the matching service, with the shared key and a timeout
function mlGet(path, params, timeout = 30000) {
  const base = (process.env.ML_SERVICE_URL || 'http://localhost:5000').replace(/\/$/, '');
  const headers = process.env.ML_API_KEY ? { 'X-API-Key': process.env.ML_API_KEY } : {};
  return axios.get(`${base}${path}`, { params, headers, timeout });
}

function mlPost(path, body, timeout = 30000) {
  const base = (process.env.ML_SERVICE_URL || 'http://localhost:5000').replace(/\/$/, '');
  const headers = process.env.ML_API_KEY ? { 'X-API-Key': process.env.ML_API_KEY } : {};
  return axios.post(`${base}${path}`, body, { headers, timeout });
}

module.exports = { mlGet, mlPost };
