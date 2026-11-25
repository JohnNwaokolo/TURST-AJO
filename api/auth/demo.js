'use strict';

// Keep the public demo sign-in endpoint explicit so Vercel routes this nested
// auth path to the app handler instead of resolving it as a missing static path.
module.exports = require('../../server.js');
