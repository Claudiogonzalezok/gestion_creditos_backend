const service  = require('./cronLogs.service');
const response = require('../../utils/response');

// GET /api/admin/cron-logs
const list = async (req, res) => {
  try {
    const rows = await service.list({
      job_name: req.query.job_name,
      since:    req.query.since,
      limit:    req.query.limit,
    });
    return response.success(res, rows);
  } catch (err) {
    return response.serverError(res, err);
  }
};

// GET /api/admin/cron-logs/summary
const summary = async (req, res) => {
  try {
    const rows = await service.summary();
    return response.success(res, rows);
  } catch (err) {
    return response.serverError(res, err);
  }
};

module.exports = { list, summary };
