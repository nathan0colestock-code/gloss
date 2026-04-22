const { AsyncLocalStorage } = require('async_hooks');

// Shared request context — holds per-user db, userDataDir, geminiKey for the duration
// of each HTTP request and any async continuations (Gemini calls, setImmediate, etc.).
const store = new AsyncLocalStorage();
module.exports = store;
