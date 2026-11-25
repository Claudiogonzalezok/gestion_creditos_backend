const router = require('express').Router();
const controller = require('./health.controller');

// Público: lo consultan PM2 y monitores externos sin token.
router.get('/', controller.check);

module.exports = router;
